import { useRef, useState } from "react";
import type { TFunction } from "i18next";
import { createDesktopCompactCommand, createDesktopTurnSubmitCommand } from "../../app-core/chat/desktopCommand";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatInput, ChatStore, SessionSummary, SettingsStore, WorkspaceStore } from "../services";
import type { ReactChatMessage } from "./messageActions";
import { prepareArtifactReviews } from "./prepareArtifactReviews";
import { prepareChatSubmission, type PrepareChatSubmissionInput } from "./chatSubmission";
import type { ChatTurnApplication } from "./chatTurnApplication";
import { deriveSessionTitle, isDefaultSessionTitle } from "./sessionTitle";

type Options = {
  chatStore: ChatStore;
  settingsStore?: SettingsStore;
  artifactReviews?: WorkspaceStore["artifactReviews"];
  sessionId: string;
  now(): number;
  t: TFunction<"chat">;
  reload(): Promise<void>;
  refreshSessions(preserveSession?: SessionSummary): Promise<SessionSummary[]>;
  materializeDraft(): Promise<SessionSummary | null>;
  previewSession(session: SessionSummary): void;
  consumeDraft(sessionId: string): void;
};
const EMPTY_MESSAGES: ReactChatMessage[] = [];

export function useChatSubmission(options: Options) {
  const { chatStore, artifactReviews, now, t } = options;
  const [messages, setMessages] = useState(new Map<string, ReactChatMessage[]>());
  const [compactingSessionId, setCompactingSessionId] = useState("");
  const [artifactReviewEpoch, setArtifactReviewEpoch] = useState(0);
  const modelSave = useRef<Promise<void>>(Promise.resolve());

  function updateMessages(sessionId: string, update: (current: ReactChatMessage[]) => ReactChatMessage[]) {
    setMessages((current) => {
      const nextMessages = update(current.get(sessionId) ?? EMPTY_MESSAGES);
      if (nextMessages === current.get(sessionId) || (!nextMessages.length && !current.has(sessionId))) return current;
      const next = new Map(current);
      if (nextMessages.length) next.set(sessionId, nextMessages);
      else next.delete(sessionId);
      return next;
    });
  }

  async function submitTurn(sessionId: string, input: ChatInput, control: string, optimisticText?: string) {
    const command = createDesktopTurnSubmitCommand({ message: input, sessionId, source: { control, surface: "chat" } });
    if (await prepareArtifactReviews(input.references, artifactReviews, sessionId, command.commandId)) {
      setArtifactReviewEpoch((value) => value + 1);
    }
    if (optimisticText) updateMessages(sessionId, (current) => [...current, {
      createdAtMs: now(), id: command.commandId, role: "user", status: "complete", text: optimisticText,
    }]);
    try {
      await chatStore.dispatch(command);
    } catch (error) {
      if (optimisticText) updateMessages(sessionId, (current) => current.filter((message) => message.id !== command.commandId));
      throw error;
    }
  }

  return {
    optimisticMessages: messages.get(options.sessionId) ?? EMPTY_MESSAGES,
    compactingSessionId,
    artifactReviewEpoch,
    submitTurn,
    saveDefaultModel(modelId: string, providerId?: string): Promise<void> {
      const persistence = modelSave.current.catch(() => undefined).then(() => {
        if (!options.settingsStore?.saveDefaultChatModel || !providerId) {
          throw new Error("Native default Provider/model persistence is unavailable.");
        }
        return options.settingsStore.saveDefaultChatModel({ modelId, providerId });
      });
      modelSave.current = persistence;
      return persistence;
    },
    async send(
      input: Omit<PrepareChatSubmissionInput, "now" | "queuedInputs" | "loadSessionTranscript" | "t">,
      session: SessionSummary | undefined,
      queue: ChatTurnApplication,
    ) {
      const prepared = await prepareChatSubmission({
        ...input, now: queue.nextInputTimestamp, queuedInputs: queue.queue(options.sessionId).inputs,
        loadSessionTranscript: chatStore.copyMarkdown, t,
      });
      if (prepared.kind === "compact") {
        if (!session) throw new Error(t("errors.compactNeedsSession"));
        options.consumeDraft(session.id);
        setCompactingSessionId(session.id);
        try {
          await chatStore.dispatch(createDesktopCompactCommand({ sessionId: session.id, source: { control: "slash-compact", surface: "chat" } }));
          await options.reload();
          await options.refreshSessions(session);
        } catch (error) {
          console.error("[chat] context.compact.failed", { sessionId: session.id, error: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          setCompactingSessionId((current) => current === session.id ? "" : current);
        }
        return;
      }
      if (prepared.kind === "empty") return;
      if (prepared.kind === "queue_limit_reached") { queue.reportQueueLimit(options.sessionId); return; }
      await modelSave.current;
      const sendSession = session ?? await options.materializeDraft();
      if (!sendSession) return;
      if (prepared.kind === "queue_input") { queue.enqueue(sendSession.id, prepared.input); return; }
      const preview = isDefaultSessionTitle(sendSession.title)
        ? { ...sendSession, title: deriveSessionTitle(prepared.visibleText, t) } : sendSession;
      if (preview !== sendSession) options.previewSession(preview);
      await submitTurn(sendSession.id, prepared.turnInput, "composer-send", session ? undefined : prepared.visibleText);
      await options.refreshSessions(preview);
      if (!session) options.consumeDraft(sendSession.id);
    },
    fork(sessionId: string, messageId: string) { return chatStore.branchFromMessage(sessionId, messageId); },
    receiveTimeline(sessionId: string, timeline: ChatTimelineSnapshot) {
      updateMessages(sessionId, (current) => {
        const remaining = current.filter((message) => !timeline.turns.some((turn) => turn.userMessage.clientEventId === message.id));
        return remaining.length === current.length ? current : remaining;
      });
    },
    receiveMessage(sessionId: string, message: ReactChatMessage) {
      updateMessages(sessionId, (current) => current.some((candidate) => candidate.id === message.id)
        ? current.map((candidate) => candidate.id === message.id ? { ...candidate, ...message } : candidate)
        : [...current, message]);
    },
    forgetSession(sessionId: string) { updateMessages(sessionId, () => []); },
    replaceSession(previousSessionId: string, sessionId: string) {
      setMessages((current) => {
        if (!current.has(previousSessionId) || previousSessionId === sessionId) return current;
        const next = new Map(current);
        next.set(sessionId, next.get(previousSessionId)!);
        next.delete(previousSessionId);
        return next;
      });
    },
  };
}
