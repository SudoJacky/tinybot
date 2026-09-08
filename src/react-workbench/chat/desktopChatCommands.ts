import type { DesktopChatSessionController } from "../../app-core/chat/desktopChatSessionController";
import type { DesktopCommand, DesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
import { createThreadAgentCancelCommand, type ThreadCommand } from "../../app-core/chat/threadCommand";
import { readDefaultChatModelPreference } from "../../app-core/chat/chatModelPreference";
import { agentInputAttachmentKind, type AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { createDesktopNativeThreadsApi, NativeThreadRecord } from "../../app-core/native/desktopNativeThreads";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatEvent, SessionSummary } from "../services";
import type { ReactChatMessage } from "./messageActions";

type Dependencies = {
  initialize(): Promise<void>;
  controller: DesktopChatSessionController;
  nativeThreads(): ReturnType<typeof createDesktopNativeThreadsApi>;
  notifySession(sessionId: string, event: ChatEvent): void;
  notifyTerminalTimelineState(sessionId: string, timeline: ChatTimelineSnapshot): void;
  mapSession(thread: NativeThreadRecord, responding: boolean, fallbackPayload?: unknown): SessionSummary;
};

export function createDesktopChatCommands({ initialize, controller, nativeThreads, notifySession, notifyTerminalTimelineState, mapSession }: Dependencies) {
  async function dispatchThreadCommand(command: ThreadCommand): Promise<void> {
    await initialize();
    const thread = controller.state.threads.find((item) => item.threadId === command.target.sessionId);
    if (thread && controller.state.activeThreadId !== thread.threadId) {
      await controller.selectSession(thread.threadId);
    }
    const threadId = thread?.threadId || command.target.threadId || command.target.sessionId;
    if (command.kind === "agent.cancel") {
      await nativeThreads().interrupt({
        threadId,
        turnId: command.target.turnId,
        clientEventId: command.commandId,
        reason: "user_requested",
      });
    } else if (command.kind === "form.submit" || command.kind === "form.cancel") {
      await nativeThreads().submitForm({
        commandId: command.commandId,
        threadId,
        formId: command.form.formId,
        source: command.source,
        target: { ...command.target, threadId },
        values: command.kind === "form.submit" ? command.form.values : {},
        action: command.kind === "form.submit" ? "submit" : "cancel",
      });
    } else {
      await nativeThreads().retryOperation({
        commandId: command.commandId,
        source: command.source,
        sourceItemId: command.operation.itemId,
        sourceTurnId: command.operation.turnId,
        targetTurnId: command.target.turnId,
        threadId,
      });
    }
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.accepted" });
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.canonical-updated" });
  }

  async function dispatchTurnSubmit(command: DesktopTurnSubmitCommand): Promise<void> {
    await initialize();
    const sessionId = command.target.sessionId;
    const thread = controller.state.threads.find((item) => item.threadId === sessionId);
    if (!thread) throw new Error(`Cannot send to unknown Thread ${sessionId}`);
    if (controller.state.activeThreadId !== thread.threadId) {
      await controller.selectSession(thread.threadId);
    }
    const input = command.input;
    const preference = readDefaultChatModelPreference();
    const threadExtra = isRecord(thread.metadata?.extra) ? thread.metadata.extra : {};
    const threadModel = stringValue(thread.metadata?.model);
    const threadProvider = stringValue(threadExtra.modelProvider);
    const model = stringValue(input.model) || threadModel || preference?.modelId || "";
    const provider = stringValue(input.provider)
      || (model === threadModel ? threadProvider : "")
      || (model === preference?.modelId ? preference.providerId ?? "" : "");
    if (model && (model !== threadModel || provider !== threadProvider)) {
      await controller.patchSession(sessionId, {
        model,
        metadata: withModelProvider(threadExtra, provider),
      });
    }
    const result = await controller.submitMessage(sessionId, input.text, {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      ...(input.selectedSkills?.length ? { selectedSkills: input.selectedSkills } : {}),
      ...(input.selectedTools ? { selectedTools: input.selectedTools } : {}),
      clientEventId: command.commandId,
    });
    const optimisticText = result.status === "sent" ? result.content : "";
    const optimisticMessage = result.status === "empty"
      ? undefined
      : createOptimisticUserMessage(result.clientEventId, optimisticText, input.references);
    notifySession(sessionId, {
      type: "message-sent",
      ...(optimisticMessage ? { message: optimisticMessage } : {}),
    });
    if (result.status === "sent") {
      void result.completion
        .then((timeline) => {
          notifySession(sessionId, { type: "timeline.patch", timeline });
          notifyTerminalTimelineState(sessionId, timeline);
        })
        .catch(async (error) => {
          let recoveryError = "";
          try {
            const timeline = await controller.reloadTimeline(sessionId);
            notifySession(sessionId, { type: "timeline.patch", timeline });
            notifyTerminalTimelineState(sessionId, timeline);
          } catch (timelineError) {
            recoveryError = timelineError instanceof Error ? timelineError.message : String(timelineError);
          }
          const message = error instanceof Error ? error.message : String(error);
          notifySession(sessionId, {
            type: "timeline.error",
            error: recoveryError
              ? `${message}; failed to reload terminal timeline state: ${recoveryError}`
              : message,
          });
        });
    }
  }

  async function dispatchDesktopCommand(command: DesktopCommand): Promise<void> {
    if (command.kind === "turn.submit") {
      await dispatchTurnSubmit(command);
      return;
    }
    if (command.kind === "agent.stop") {
      await initialize();
      const sessionId = command.target.sessionId;
      const timeline = await controller.loadTimeline(sessionId);
      const turn = [...timeline.turns].reverse().find((candidate) => (
        candidate.status === "pending"
        || candidate.status === "running"
        || candidate.status === "awaiting_user"
      ));
      if (!turn) throw new Error("Cannot cancel: the session has no active turn");
      const cancelCommand = createThreadAgentCancelCommand({
        commandId: command.commandId,
        issuedAt: command.issuedAt,
        sessionId,
        source: command.source,
        threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
        turnId: turn.id,
      });
      notifySession(sessionId, { command: cancelCommand, type: "command.dispatched" });
      await dispatchThreadCommand(cancelCommand);
      return;
    }
    if (command.kind === "context.compact") {
      await initialize();
      const sessionId = command.target.sessionId;
      const thread = controller.state.threads.find((candidate) => candidate.threadId === sessionId);
      if (!thread) throw new Error(`Cannot compact unknown Thread ${sessionId}`);
      if (controller.state.activeThreadId !== sessionId) {
        await controller.selectSession(sessionId);
      }
      await nativeThreads().compact({
        threadId: sessionId,
        clientEventId: command.commandId,
      });
      const timeline = await controller.loadTimeline(sessionId);
      notifySession(sessionId, { type: "timeline.patch", timeline });
      notifyTerminalTimelineState(sessionId, timeline);
      return;
    }
    await dispatchThreadCommand(command);
  }

  async function resolveForkSequence(threadId: string, itemIds: Set<string>): Promise<number | undefined> {
    let cursor = "";
    const seenCursors = new Set<string>();
    while (true) {
      const payload = await nativeThreads().read({
        threadId,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(payload)) {
        throw new Error(`Thread ${threadId} returned an invalid read result while resolving a fork boundary`);
      }
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const value of items) {
        if (!isRecord(value)) continue;
        const kind = isRecord(value.kind) ? value.kind : {};
        const itemPayload = isRecord(kind.payload) ? kind.payload : {};
        const itemId = stringValue(value.itemId ?? value.item_id);
        const messageId = stringValue(itemPayload.messageId ?? itemPayload.message_id);
        if (!itemIds.has(itemId) && !itemIds.has(messageId)) continue;
        const sequence = numberValue(value.sequence);
        if (sequence === undefined) {
          throw new Error(`Thread item ${itemId || messageId} is missing its canonical sequence`);
        }
        return sequence;
      }
      const nextCursor = stringValue(
        payload.nextCursor
        ?? payload.next_cursor
        ?? (isRecord(payload.pagination)
          ? payload.pagination.nextCursor ?? payload.pagination.next_cursor
          : undefined),
      );
      if (!nextCursor) return undefined;
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Thread ${threadId} returned a repeated pagination cursor while resolving a fork boundary`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async function branchFromMessage(sessionId: string, messageId: string): Promise<SessionSummary> {
        await initialize();
        const sourceThread = controller.state.threads.find((thread) => thread.threadId === sessionId);
        if (!sourceThread) {
          throw new Error(`Cannot branch from unknown Thread ${sessionId}`);
        }
        const timeline = await controller.loadTimeline(sessionId);
        const canonicalItem = timeline.turns
          .flatMap((turn) => turn.canonicalItems ?? [])
          .find((item) => (
            item.itemId === messageId
            || stringValue(item.data.messageId ?? item.data.message_id) === messageId
          ));
        if (!canonicalItem) {
          throw new Error(`Cannot fork Thread ${sessionId} at unknown canonical message ${messageId}`);
        }
        const sourceThreadId = sourceThread.threadId;
        const forkAfterSequence = await resolveForkSequence(sourceThreadId, new Set([
          messageId,
          canonicalItem.itemId,
          stringValue(canonicalItem.data.messageId ?? canonicalItem.data.message_id),
        ].filter(Boolean)));
        if (forkAfterSequence === undefined) {
          throw new Error(`Cannot resolve persisted fork boundary for canonical message ${messageId}`);
        }
        const title = `${sourceThread.title} · 分叉`;
        const forkedThread = await nativeThreads().fork({
          threadId: sourceThreadId,
          clientEventId: `fork:${sourceThreadId}:${messageId}`,
          title,
          forkAfterSequence,
        });
        await controller.loadSessions();
        const branchThread = controller.state.threads.find((thread) => (
          thread.threadId === forkedThread.threadId
        ));
        if (!branchThread) {
          throw new Error(`Forked Thread ${forkedThread.threadId} is missing from the Thread list`);
        }
        return mapSession(branchThread, false, forkedThread);
  }

  return { dispatch: dispatchDesktopCommand, branchFromMessage };
}

function createOptimisticUserMessage(clientEventId: string, text: string, references: AgentInputReference[] = []): ReactChatMessage {
  return {
    id: clientEventId,
    role: "user",
    createdAtMs: Date.now(),
    text,
    status: "complete",
    ...(references.length ? {
      contextReferences: references.map((reference, index) => {
        const attachmentKind = agentInputAttachmentKind(reference);
        const attachment = Boolean(attachmentKind) && Boolean(reference.rawPath) && !reference.sourcePath;
        return {
          ...(attachment ? {
            attachmentKind,
            ...(attachmentKind === "image" && reference.rawPath
              ? { attachmentPreviewPath: reference.rawPath }
              : {}),
          } : {}),
          detail: reference.detail,
          id: reference.evidenceId || `reference-${index}`,
          kind: reference.kind,
          presentation: attachment ? "attachment" as const : "context" as const,
          sourceLine: reference.sourceLine,
          sourcePath: reference.sourcePath,
          title: reference.title,
        };
      }),
    } : {}),
  };
}

function withModelProvider(extra: Record<string, unknown>, provider?: string): Record<string, unknown> {
  const next = { ...extra };
  delete next.modelProvider;
  if (provider?.trim()) {
    next.modelProvider = provider.trim();
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

