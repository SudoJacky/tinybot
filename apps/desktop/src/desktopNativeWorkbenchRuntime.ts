import {
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  type AgentUiForm,
} from "./agentUiEvents";
import {
  createDesktopChatSessionController,
  type ChatSubmitResult,
  type DesktopChatSessionController,
  type DesktopChatSessionControllerApi,
} from "./desktopChatSessionController";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";
import { buildDesktopAgentUiApprovalTaskOperations } from "./desktopTaskCenterSources";
import type { DesktopNativeChatModel } from "./desktopWorkbenchShell";
import { logDesktopNativeDebug, summarizeDebugText } from "./desktopNativeChatDebug";
import type { NormalizedGatewayEvent } from "./gatewayWebSocketClient";
import { appendUserMessage, applyChatEvent, type NativeChatMessage, type NativeChatReference } from "./nativeChat";

export interface DesktopNativeWorkbenchRuntimeOptions {
  api: DesktopChatSessionControllerApi;
  sendSocketMessage(message: unknown): void;
  agentRoute?: "gateway" | "ts-agent";
  runTsAgent?: (spec: DesktopTsAgentRunSpec) => Promise<DesktopTsAgentRunResult>;
  cancelTsAgent?: (runId: string) => Promise<unknown>;
  restoreTsAgentCheckpoint?: (sessionId: string) => Promise<DesktopTsAgentRestoreCheckpointResult>;
  now?: () => string;
}

export type DesktopTsAgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type DesktopTsAgentRunSpec = {
  runId: string;
  sessionId: string;
  messages: DesktopTsAgentMessage[];
  model: string;
  maxIterations: number;
  stream: boolean;
  metadata: Record<string, unknown>;
};

export type DesktopTsAgentRunResult = {
  finalContent: string;
  stopReason: string;
  messages?: DesktopTsAgentMessage[];
  toolsUsed?: string[];
  error?: string;
};

export type DesktopTsAgentRestoreCheckpointResult = {
  sessionId: string;
  checkpoint?: Record<string, unknown> | null;
};

export type DesktopTsAgentWorkerEventName =
  | "agent.delta"
  | "agent.reasoning_delta"
  | "agent.tool_call.delta"
  | "agent.tool.start"
  | "agent.tool.result"
  | "agent.usage"
  | "agent.checkpoint"
  | "agent.awaiting_form"
  | "agent.awaiting_approval"
  | "agent.memory_reference"
  | "agent.cancelled"
  | "agent.done"
  | "agent.error";

export interface DesktopNativeWorkbenchRuntime {
  readonly chat: DesktopNativeChatModel;
  readonly chatController: DesktopChatSessionController;
  readonly agentUiForms: AgentUiForm[];
  readonly approvalOperations: DesktopTaskSourceOperation[];
  loadInitialChatState(): Promise<void>;
  setRuntimeMetadata(metadata: NonNullable<DesktopNativeChatModel["runtime"]>): void;
  selectChatSession(sessionKey: string, chatId: string): Promise<void>;
  startNewChat(): void;
  deleteChatSession(sessionKey: string): Promise<void>;
  setPersistentRag(enabled: boolean): void;
  submitComposerMessage(content: string, usePersistentRag?: boolean): ChatSubmitResult;
  interruptActiveChat(): boolean;
  handleGatewayEvent(event: NormalizedGatewayEvent): Promise<void>;
  handleTsAgentWorkerEvent(eventName: DesktopTsAgentWorkerEventName, payload: unknown): void;
}

export function createDesktopNativeWorkbenchRuntime({
  api,
  sendSocketMessage,
  agentRoute = "gateway",
  runTsAgent,
  cancelTsAgent,
  restoreTsAgentCheckpoint,
  now,
}: DesktopNativeWorkbenchRuntimeOptions): DesktopNativeWorkbenchRuntime {
  const chatController = createDesktopChatSessionController({
    api,
    sendSocketMessage,
    now,
  });
  let chatStatus = "Loading sessions.";
  let usePersistentRag = true;
  let composerState: DesktopNativeChatModel["composerState"] = "idle";
  let runtimeMetadata: NonNullable<DesktopNativeChatModel["runtime"]> = {};
  const agentUiState = createAgentUiEventState();
  const activeTsAgentRuns = new Map<string, string>();
  const activeTsAgentToolCallDeltas = new Map<string, {
    argumentsText: string;
    toolCallId: string;
    toolName: string;
  }>();

  async function loadInitialChatState(): Promise<void> {
    logDesktopNativeDebug("runtime.load.start", summarizeRuntimeState());
    const count = await chatController.loadSessions();
    chatStatus = count ? `Loaded ${count} ${count === 1 ? "session" : "sessions"} from gateway.` : "No sessions yet.";
    await restoreActiveTsAgentCheckpoint();
    logDesktopNativeDebug("runtime.load.complete", {
      ...summarizeRuntimeState(),
      loadedCount: count,
    });
  }

  async function restoreActiveTsAgentCheckpoint(): Promise<void> {
    if (agentRoute !== "ts-agent" || !restoreTsAgentCheckpoint || !chatController.state.activeSessionKey) {
      clearTsAgentCheckpointMetadata();
      return;
    }
    try {
      const restored = await restoreTsAgentCheckpoint(chatController.state.activeSessionKey);
      if (!restored.checkpoint) {
        clearTsAgentCheckpointMetadata();
        return;
      }
      setRuntimeMetadata({ tsAgentCheckpoint: formatTsAgentCheckpoint(restored.checkpoint) });
      chatStatus = "TS agent checkpoint restored.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chatStatus = `TS agent checkpoint restore failed: ${message}`;
      logDesktopNativeDebug("runtime.restoreCheckpoint.failed", {
        ...summarizeRuntimeState(),
        error: message,
      });
    }
  }

  async function selectChatSession(sessionKey: string, chatId: string): Promise<void> {
    logDesktopNativeDebug("runtime.select.start", {
      ...summarizeRuntimeState(),
      chatId,
      sessionKey,
    });
    await chatController.selectSession(sessionKey, chatId);
    chatStatus = "Session loaded from gateway.";
    await restoreActiveTsAgentCheckpoint();
    logDesktopNativeDebug("runtime.select.complete", summarizeRuntimeState());
  }

  function startNewChat(): void {
    chatController.startNewChat();
    clearTsAgentCheckpointMetadata();
    chatStatus = "Creating chat session.";
    logDesktopNativeDebug("runtime.newChat", summarizeRuntimeState());
  }

  async function deleteChatSession(sessionKey: string): Promise<void> {
    logDesktopNativeDebug("runtime.delete.start", {
      ...summarizeRuntimeState(),
      sessionKey,
    });
    const result = await chatController.deleteSession(sessionKey);
    if (result.status === "deleted") {
      chatStatus = result.nextSessionKey ? "Session deleted. Next chat loaded." : "Session deleted.";
      composerState = "idle";
      logDesktopNativeDebug("runtime.delete.complete", {
        ...summarizeRuntimeState(),
        deletedSessionKey: result.deletedSessionKey,
        nextSessionKey: result.nextSessionKey,
      });
      return;
    }
    chatStatus = result.status === "unavailable" ? "Session deletion is unavailable." : "Session not found.";
    logDesktopNativeDebug("runtime.delete.skipped", {
      ...summarizeRuntimeState(),
      status: result.status,
    });
  }

  function setPersistentRag(enabled: boolean): void {
    usePersistentRag = enabled;
    chatStatus = `Persistent RAG ${enabled ? "enabled" : "disabled"}.`;
    logDesktopNativeDebug("runtime.rag.change", {
      ...summarizeRuntimeState(),
      enabled,
    });
  }

  function setRuntimeMetadata(metadata: NonNullable<DesktopNativeChatModel["runtime"]>): void {
    runtimeMetadata = { ...runtimeMetadata, ...metadata };
    logDesktopNativeDebug("runtime.metadata.update", {
      keys: Object.keys(metadata),
      runtime: runtimeMetadata,
    });
  }

  function clearTsAgentCheckpointMetadata(): void {
    if (!("tsAgentCheckpoint" in runtimeMetadata)) {
      return;
    }
    const nextMetadata = { ...runtimeMetadata };
    delete nextMetadata.tsAgentCheckpoint;
    runtimeMetadata = nextMetadata;
    logDesktopNativeDebug("runtime.metadata.clear", {
      key: "tsAgentCheckpoint",
      runtime: runtimeMetadata,
    });
  }

  function submitComposerMessage(content: string, nextUsePersistentRag = usePersistentRag): ChatSubmitResult {
    usePersistentRag = nextUsePersistentRag;
    if (agentRoute === "ts-agent" && runTsAgent) {
      return submitTsAgentComposerMessage(content, usePersistentRag);
    }
    const result = chatController.submitMessage(content, usePersistentRag);
    if (result.status === "empty") {
      chatStatus = "Enter a message or attach a file before sending.";
      composerState = "idle";
    } else if (result.status === "creating") {
      chatStatus = "Creating chat session before sending.";
      composerState = "queued";
    } else {
      chatStatus = "Message sent.";
      composerState = "sending";
    }
    logDesktopNativeDebug("runtime.submit", {
      ...summarizeRuntimeState(),
      content: summarizeDebugText(content.trim()),
      resultStatus: result.status,
      usePersistentRag,
    });
    return result;
  }

  function submitTsAgentComposerMessage(content: string, nextUsePersistentRag: boolean): ChatSubmitResult {
    const trimmed = content.trim();
    if (!trimmed) {
      chatStatus = "Enter a message or attach a file before sending.";
      composerState = "idle";
      return { status: "empty" };
    }

    const state = chatController.state;
    if (!state.activeChatId || !state.activeSessionKey) {
      const result = chatController.submitMessage(trimmed, nextUsePersistentRag);
      chatStatus = result.status === "creating" ? "Creating chat session before sending." : "Message sent.";
      composerState = result.status === "creating" ? "queued" : result.status === "sent" ? "sending" : "idle";
      return result;
    }

    appendUserMessage(state, trimmed, now?.() ?? new Date().toISOString());
    const spec = buildDesktopTsAgentRunSpec({
      chatId: state.activeChatId,
      messages: state.messages.get(state.activeSessionKey) ?? [],
      model: runtimeMetadata?.model,
      now: now ?? (() => new Date().toISOString()),
      sessionId: state.activeSessionKey,
      usePersistentRag: nextUsePersistentRag,
    });
    composerState = "sending";
    chatStatus = "Message sent to TS agent.";
    logDesktopNativeDebug("runtime.submit.tsAgent", {
      ...summarizeRuntimeState(),
      content: summarizeDebugText(trimmed),
      runId: spec.runId,
      usePersistentRag: nextUsePersistentRag,
    });
    activeTsAgentRuns.set(spec.runId, state.activeChatId);
    void runSubmittedTsAgent(spec, state.activeChatId);
    return { status: "sent", chatId: state.activeChatId, content: trimmed };
  }

  async function runSubmittedTsAgent(spec: DesktopTsAgentRunSpec, chatId: string): Promise<void> {
    if (!runTsAgent) {
      return;
    }
    try {
      const result = await runTsAgent(spec);
      const streamMessageExists = chatController.state.streamMessageKeys.has(spec.runId);
      if (!streamMessageExists && result.finalContent.trim()) {
        applyChatEvent(chatController.state, {
          kind: "message.completed",
          chatId,
          messageId: spec.runId,
          text: result.finalContent,
          raw: {
            event: "message",
            chat_id: chatId,
            content: result.finalContent,
            message_id: spec.runId,
            source: "ts-agent-worker",
            stop_reason: result.stopReason,
          },
        });
      }
      completeTsAgentRun(spec.runId, chatId);
      composerState = "idle";
      chatStatus = result.error ? `TS agent stopped: ${result.error}` : "TS agent response received.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applyChatEvent(chatController.state, { kind: "error", message, raw: { event: "error", message } });
      activeTsAgentRuns.delete(spec.runId);
      composerState = "idle";
      chatStatus = `TS agent failed: ${message}`;
    }
  }

  function handleTsAgentWorkerEvent(eventName: DesktopTsAgentWorkerEventName, payload: unknown): void {
    const frame = isRecord(payload) ? payload : {};
    const runId = stringValue(frame.runId);
    const chatId = activeTsAgentRuns.get(runId) || chatController.state.activeChatId;
    if (!runId || !chatId) {
      return;
    }
    if (eventName === "agent.awaiting_form") {
      projectTsAgentAwaitingForm(frame, runId, chatId);
      return;
    }
    if (eventName === "agent.awaiting_approval") {
      projectTsAgentAwaitingApproval(frame, runId, chatId);
      return;
    }
    if (eventName === "agent.memory_reference") {
      projectTsAgentMemoryReferences(frame, runId, chatId);
      return;
    }
    if (eventName === "agent.delta" || eventName === "agent.reasoning_delta") {
      applyChatEvent(chatController.state, {
        kind: "message.delta",
        chatId,
        messageId: runId,
        text: stringValue(frame.delta),
        reasoning: eventName === "agent.reasoning_delta",
        raw: {
          event: eventName,
          chat_id: chatId,
          delta: stringValue(frame.delta),
          message_id: runId,
          source: "ts-agent-worker",
        },
      });
      composerState = "sending";
      return;
    }
    if (eventName === "agent.tool_call.delta") {
      const index = numberValue(frame.index) ?? 0;
      const deltaKey = tsAgentToolCallDeltaKey(runId, index);
      const current = activeTsAgentToolCallDeltas.get(deltaKey);
      const toolCallId = stringValue(frame.toolCallId ?? frame.tool_call_id) || current?.toolCallId || `${runId}:tool-${index}`;
      const toolName = stringValue(frame.toolName ?? frame.tool_name) || current?.toolName || "tool";
      const argumentsText = `${current?.argumentsText ?? ""}${stringValue(frame.deltaText ?? frame.delta_text ?? frame.argumentsDelta ?? frame.arguments_delta)}`;
      activeTsAgentToolCallDeltas.set(deltaKey, { argumentsText, toolCallId, toolName });
      applyChatEvent(chatController.state, {
        kind: "message.completed",
        chatId,
        messageId: `${runId}:${toolCallId}:args`,
        text: formatTsAgentToolCallText(toolName, argumentsText),
        raw: {
          event: eventName,
          chat_id: chatId,
          content: formatTsAgentToolCallText(toolName, argumentsText),
          message_id: `${runId}:${toolCallId}:args`,
          source: "ts-agent-worker",
          status: "running",
          _tool_call_id: toolCallId,
          _tool_detail: true,
          _tool_hint: true,
          _tool_name: toolName,
        },
      });
      composerState = "sending";
      return;
    }
    if (eventName === "agent.tool.start") {
      const toolCallId = stringValue(frame.toolCallId ?? frame.tool_call_id) || `${runId}:tool`;
      const cachedToolCall = findTsAgentToolCallDelta(runId, toolCallId);
      const toolName = cachedToolCall?.toolName || stringValue(frame.toolName ?? frame.tool_name) || "tool";
      const toolText = formatTsAgentToolCallText(toolName, cachedToolCall?.argumentsText ?? "");
      applyChatEvent(chatController.state, {
        kind: "message.completed",
        chatId,
        messageId: `${runId}:${toolCallId}:start`,
        text: toolText,
        raw: {
          event: eventName,
          chat_id: chatId,
          content: toolText,
          message_id: `${runId}:${toolCallId}:start`,
          source: "ts-agent-worker",
          status: "running",
          _tool_call_id: toolCallId,
          _tool_detail: true,
          _tool_hint: true,
          _tool_name: toolName,
        },
      });
      composerState = "sending";
      return;
    }
    if (eventName === "agent.tool.result") {
      const toolCallId = stringValue(frame.toolCallId ?? frame.tool_call_id) || `${runId}:tool`;
      const toolName = stringValue(frame.toolName ?? frame.tool_name) || "tool";
      const content = stringValue(frame.content ?? frame.result ?? frame.output);
      applyChatEvent(chatController.state, {
        kind: "message.completed",
        chatId,
        messageId: `${runId}:${toolCallId}:result`,
        text: content,
        raw: {
          event: eventName,
          chat_id: chatId,
          content,
          message_id: `${runId}:${toolCallId}:result`,
          source: "ts-agent-worker",
          status: "completed",
          tool_call_id: toolCallId,
          _tool_name: toolName,
          _tool_result: true,
        },
      });
      deleteTsAgentToolCallDelta(runId, toolCallId);
      composerState = "sending";
      return;
    }
    if (eventName === "agent.usage") {
      setRuntimeMetadata({
        tokenUsage: formatTsAgentTokenUsage(frame.usage, frame.contextWindowTokens ?? frame.context_window_tokens),
      });
      chatStatus = "TS agent usage updated.";
      return;
    }
    if (eventName === "agent.checkpoint") {
      const checkpoint = formatTsAgentCheckpoint(frame);
      setRuntimeMetadata({ tsAgentCheckpoint: checkpoint });
      chatStatus = `TS agent checkpoint: ${labelTsAgentCheckpointPhase(frame.phase)}.`;
      return;
    }
    if (eventName === "agent.cancelled") {
      completeTsAgentRun(runId, chatId);
      composerState = "idle";
      chatStatus = "TS agent cancelled.";
      return;
    }
    if (eventName === "agent.done") {
      completeTsAgentRun(runId, chatId);
      composerState = "idle";
      chatStatus = "TS agent response received.";
      return;
    }
    if (eventName === "agent.error") {
      const message = stringValue(frame.message) || "TS agent error";
      applyChatEvent(chatController.state, { kind: "error", message, raw: { event: "error", message } });
      activeTsAgentRuns.delete(runId);
      clearTsAgentToolCallDeltas(runId);
      composerState = "idle";
      chatStatus = message;
    }
  }

  function projectTsAgentAwaitingForm(frame: Record<string, unknown>, runId: string, chatId: string): void {
    const form = isRecord(frame.form) ? frame.form : {};
    const formId = stringValue(frame.formId ?? frame.form_id ?? form.form_id);
    if (!formId) {
      chatStatus = "TS agent awaiting form input, but form id is missing.";
      return;
    }
    const correlation = isRecord(form.correlation) ? form.correlation : {};
    const payload = {
      ...form,
      form_id: formId,
      correlation: {
        ...correlation,
        chat_id: stringValue(correlation.chat_id) || chatId,
        form_id: stringValue(correlation.form_id) || formId,
        run_id: stringValue(correlation.run_id) || runId,
        session_id: stringValue(correlation.session_id) || chatController.state.activeSessionKey,
      },
    };
    for (const agentUiEvent of normalizeAgentUiEvents({
      event: "agent_ui_event",
      agent_ui_event: {
        event_type: "ui.form.requested",
        chat_id: chatId,
        payload,
      },
    })) {
      reduceAgentUiEventState(agentUiState, agentUiEvent);
    }
    chatStatus = "TS agent awaiting form input.";
  }

  function projectTsAgentAwaitingApproval(frame: Record<string, unknown>, runId: string, chatId: string): void {
    const approvalId = stringValue(frame.approvalId ?? frame.approval_id);
    if (!approvalId) {
      chatStatus = "TS agent awaiting approval, but approval id is missing.";
      return;
    }
    const operation = isRecord(frame.operation) ? frame.operation : {};
    const toolName = stringValue(operation.toolName ?? operation.tool_name ?? frame.toolName ?? frame.tool_name) || "approval";
    const content = stringValue(frame.content) || `Approval required: ${toolName}`;
    applyChatEvent(chatController.state, {
      kind: "message.completed",
      chatId,
      messageId: `${runId}:${approvalId}:approval`,
      text: content,
      raw: {
        event: "agent.awaiting_approval",
        chat_id: chatId,
        content,
        message_id: `${runId}:${approvalId}:approval`,
        source: "ts-agent-worker",
        status: "blocked",
        _approval_id: approvalId,
        _approval_status: "approval_required",
        _tool_call_id: approvalId,
        _tool_name: toolName,
        _tool_result: true,
      },
    });
    composerState = "idle";
    chatStatus = "TS agent awaiting approval.";
  }

  function projectTsAgentMemoryReferences(frame: Record<string, unknown>, runId: string, chatId: string): void {
    const references = normalizeTsAgentMemoryReferences(frame.references);
    if (!references.length) {
      return;
    }
    const state = chatController.state;
    const sessionKey = state.sessions.find((session) => session.chatId === chatId || session.key === chatId)?.key || state.activeSessionKey;
    if (!sessionKey) {
      return;
    }
    const bucket = state.messages.get(sessionKey) ?? [];
    state.messages.set(sessionKey, bucket);
    let message = bucket.find((item) => item.messageId === runId && item.role === "assistant");
    if (!message) {
      message = {
        role: "assistant",
        content: "",
        reasoningContent: "",
        timestamp: new Date().toISOString(),
        messageId: runId,
      };
      bucket.push(message);
    }
    message.references = [...(message.references ?? []), ...references];
    chatStatus = "TS agent memory references updated.";
  }

  function completeTsAgentRun(runId: string, chatId: string): void {
    applyChatEvent(chatController.state, {
      kind: "message.stream.completed",
      chatId,
      messageId: runId,
      raw: {
        event: "stream_end",
        chat_id: chatId,
        message_id: runId,
        source: "ts-agent-worker",
      },
    });
    activeTsAgentRuns.delete(runId);
    clearTsAgentToolCallDeltas(runId);
  }

  function findTsAgentToolCallDelta(runId: string, toolCallId: string): { argumentsText: string; toolName: string } | null {
    for (const [key, value] of activeTsAgentToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        return { argumentsText: value.argumentsText, toolName: value.toolName };
      }
    }
    return null;
  }

  function deleteTsAgentToolCallDelta(runId: string, toolCallId: string): void {
    for (const [key, value] of activeTsAgentToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        activeTsAgentToolCallDeltas.delete(key);
      }
    }
  }

  function clearTsAgentToolCallDeltas(runId: string): void {
    for (const key of activeTsAgentToolCallDeltas.keys()) {
      if (key.startsWith(`${runId}:`)) {
        activeTsAgentToolCallDeltas.delete(key);
      }
    }
  }

  function interruptActiveChat(): boolean {
    if (agentRoute === "ts-agent" && cancelTsAgent && activeTsAgentRuns.size > 0) {
      const activeRunIds = Array.from(activeTsAgentRuns.keys());
      const runId = activeRunIds[activeRunIds.length - 1];
      if (!runId) {
        chatStatus = "No active chat to interrupt.";
        return false;
      }
      void cancelTsAgent(runId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        applyChatEvent(chatController.state, { kind: "error", message, raw: { event: "error", message } });
        chatStatus = `TS agent interrupt failed: ${message}`;
      });
      chatStatus = "TS agent interrupt requested.";
      logDesktopNativeDebug("runtime.interrupt.tsAgent", {
        ...summarizeRuntimeState(),
        runId,
      });
      return true;
    }
    const interrupted = chatController.interruptActiveChat();
    chatStatus = interrupted ? "Interrupt requested." : "No active chat to interrupt.";
    logDesktopNativeDebug("runtime.interrupt", {
      ...summarizeRuntimeState(),
      interrupted,
    });
    return interrupted;
  }

  async function handleGatewayEvent(event: NormalizedGatewayEvent): Promise<void> {
    logDesktopNativeDebug("runtime.gatewayEvent.start", summarizeGatewayEvent(event));
    if (event.kind === "usage") {
      setRuntimeMetadata({ tokenUsage: event.tokenUsage });
      logDesktopNativeDebug("runtime.gatewayEvent.complete", {
        ...summarizeRuntimeState(),
        kind: event.kind,
      });
      return;
    }

    if (event.kind === "agent-ui.form" || event.kind === "agent-ui.event") {
      for (const agentUiEvent of normalizeAgentUiEvents(event.raw)) {
        reduceAgentUiEventState(agentUiState, agentUiEvent);
      }
      chatStatus = agentUiState.forms.size ? "Agent UI form requested." : "Agent UI event received.";
      logDesktopNativeDebug("runtime.gatewayEvent.complete", {
        ...summarizeRuntimeState(),
        formCount: agentUiState.forms.size,
        kind: event.kind,
      });
      return;
    }

    const result = await chatController.handleGatewayEvent(event);
    if (event.kind === "error") {
      chatStatus = event.message;
      composerState = "idle";
      logDesktopNativeDebug("runtime.gatewayEvent.error", {
        ...summarizeRuntimeState(),
        message: event.message,
      });
      return;
    }
    if (result.pendingMessageSent) {
      chatStatus = "Queued message sent.";
      composerState = "sending";
      return;
    }
    if (result.loadedMessagesForChatId) {
      chatStatus = "Session loaded from gateway.";
      return;
    }
    if (event.kind === "message.delta") {
      composerState = "sending";
      return;
    }
    if (event.kind === "message.completed") {
      composerState = "idle";
      return;
    }
    if (event.kind === "message.stream.completed" || event.kind === "interrupted") {
      composerState = "idle";
      return;
    }
    if (result.reloadedSessions) {
      chatStatus = "Sessions refreshed.";
    }
    logDesktopNativeDebug("runtime.gatewayEvent.complete", {
      ...summarizeRuntimeState(),
      kind: event.kind,
      loadedMessagesForChatId: result.loadedMessagesForChatId,
      pendingMessageSent: result.pendingMessageSent,
      reloadedSessions: result.reloadedSessions,
    });
  }

  return {
    get chat() {
      const state = chatController.state;
      return {
        sessions: state.sessions,
        activeSessionKey: state.activeSessionKey,
        activeChatId: state.activeChatId,
        messages: state.messages.get(state.activeSessionKey) ?? [],
        status: chatStatus || state.error,
        responding: state.activeSessionKey ? state.respondingSessionKeys.has(state.activeSessionKey) : false,
        usePersistentRag,
        composerState,
        runtime: runtimeMetadata,
      };
    },
    chatController,
    get agentUiForms() {
      return [...agentUiState.forms.values()];
    },
    get approvalOperations() {
      return buildDesktopAgentUiApprovalTaskOperations(agentUiState);
    },
    loadInitialChatState,
    setRuntimeMetadata,
    selectChatSession,
    startNewChat,
    deleteChatSession,
    setPersistentRag,
    submitComposerMessage,
    interruptActiveChat,
    handleGatewayEvent,
    handleTsAgentWorkerEvent,
  };

  function summarizeRuntimeState(): Record<string, unknown> {
    const state = chatController.state;
    return {
      activeChatId: state.activeChatId,
      activeSessionKey: state.activeSessionKey,
      composerState,
      responding: state.activeSessionKey ? state.respondingSessionKeys.has(state.activeSessionKey) : false,
      sessionCount: state.sessions.length,
      status: chatStatus,
    };
  }

  function summarizeGatewayEvent(event: NormalizedGatewayEvent): Record<string, unknown> {
    return {
      chatId: "chatId" in event ? event.chatId : "",
      kind: event.kind,
      messageId: "messageId" in event ? event.messageId : "",
      text: "text" in event ? summarizeDebugText(event.text) : undefined,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tsAgentToolCallDeltaKey(runId: string, index: number): string {
  return `${runId}:${index}`;
}

function formatTsAgentToolCallText(toolName: string, argumentsText: string): string {
  return `${toolName}(${argumentsText})`;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatTsAgentTokenUsage(value: unknown, contextWindowValue?: unknown): string {
  const usage = isRecord(value) ? value : {};
  const explicitPercent = numberValue(
    usage.percent ?? usage.percentage ?? usage.token_usage_percent ?? usage.tokenUsagePercent,
  );
  if (explicitPercent !== null) {
    return `${boundedPercent(explicitPercent)}%`;
  }
  const total = numberValue(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  const contextWindow = numberValue(
    usage.contextWindowTokens ??
      usage.context_window_tokens ??
      usage.contextWindow ??
      usage.context_window ??
      usage.maxContextTokens ??
      usage.max_context_tokens ??
      contextWindowValue,
  );
  if (total !== null && contextWindow !== null) {
    return contextWindow <= 0 ? "0%" : `${boundedPercent((total / contextWindow) * 100)}%`;
  }
  if (total !== null) {
    return `${Math.round(total).toLocaleString("en-US")} tokens`;
  }
  return "-";
}

function formatTsAgentCheckpoint(frame: Record<string, unknown>): string {
  const phase = labelTsAgentCheckpointPhase(frame.phase);
  const iteration = numberValue(frame.iteration);
  const pendingCount = Array.isArray(frame.pendingToolCalls) ? frame.pendingToolCalls.length : 0;
  const completedCount = Array.isArray(frame.completedToolResults) ? frame.completedToolResults.length : 0;
  const parts = [phase];
  if (iteration !== null) {
    parts.push(`iteration ${iteration + 1}`);
  }
  if (pendingCount > 0) {
    parts.push(`${pendingCount} pending ${pendingCount === 1 ? "tool" : "tools"}`);
  }
  if (completedCount > 0) {
    parts.push(`${completedCount} completed ${completedCount === 1 ? "tool" : "tools"}`);
  }
  return parts.join(" · ");
}

function labelTsAgentCheckpointPhase(value: unknown): string {
  const phase = stringValue(value).trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!phase) {
    return "Checkpoint";
  }
  return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
}

function normalizeTsAgentMemoryReferences(value: unknown): NativeChatReference[] {
  return arrayRecords(value).map((row) => {
    const title = stringValue(row.title ?? row.name ?? row.note_id ?? row.id ?? row.file) || "memory";
    const detail = stringValue(row.detail ?? row.summary ?? row.excerpt ?? row.content ?? row.file);
    const sourcePath = stringValue(row.view_file ?? row.source_file ?? row.file ?? row.path);
    const rawPath = stringValue(row.file ?? row.path);
    const sourceLine = numberValue(row.view_line ?? row.line ?? row.cursor);
    const rawLine = numberValue(row.line ?? row.cursor);
    const sourceText = sourcePath || sourceLine !== null
      ? stringValue(row.source_text ?? row.excerpt ?? row.content ?? row.summary ?? row.detail)
      : "";
    const noteId = stringValue(row.note_id);
    const scope = stringValue(row.scope);
    const type = stringValue(row.type);
    return {
      kind: "memory",
      title,
      detail,
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceLine !== null ? { sourceLine } : {}),
      ...(sourceText ? { sourceText } : {}),
      ...(rawPath && rawPath !== sourcePath ? { rawPath } : {}),
      ...(rawLine !== null && rawLine !== sourceLine ? { rawLine } : {}),
      ...(noteId ? { noteId } : {}),
      ...(scope ? { scope } : {}),
      ...(type ? { type } : {}),
    };
  });
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return isRecord(value) ? [value] : [];
}

function buildDesktopTsAgentRunSpec({
  chatId,
  messages,
  model,
  now,
  sessionId,
  usePersistentRag,
}: {
  chatId: string;
  messages: NativeChatMessage[];
  model: unknown;
  now: () => string;
  sessionId: string;
  usePersistentRag: boolean;
}): DesktopTsAgentRunSpec {
  const runId = `desktop-ts-agent-${stableRunIdPart(now())}`;
  return {
    runId,
    sessionId,
    messages: messages.map(desktopMessageToTsAgentMessage).filter((message) => message.content.trim().length > 0),
    model: typeof model === "string" && model.trim() ? model : "default",
    maxIterations: 8,
    stream: true,
    metadata: {
      chatId,
      route: "desktop-native-ts-agent",
      usePersistentRag,
    },
  };
}

function desktopMessageToTsAgentMessage(message: NativeChatMessage): DesktopTsAgentMessage {
  return {
    role: desktopMessageRoleToTsAgentRole(message.role),
    content: message.content || message.reasoningContent || "",
  };
}

function desktopMessageRoleToTsAgentRole(role: string): DesktopTsAgentMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  return "assistant";
}

function stableRunIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
