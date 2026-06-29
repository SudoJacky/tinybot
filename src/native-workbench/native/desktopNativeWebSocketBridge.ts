import type { NativeTransportApi, NativeTransportWebSocketDispatchRequest } from "./desktopNativeTransport";
import { logDesktopNativeDebug, summarizeDebugText } from "./desktopNativeChatDebug";
import { toDesktopNativeTauriEventName } from "./desktopNativeTauriEvents";
import type { NativeBackendWebSocketAgentEventName } from "./nativeBackendContract";

export type DesktopNativeWebSocketOptions = {
  url: string | URL;
  protocols?: string | string[];
  nativeTransport: NativeTransportApi;
  clientId?: string;
  editablePaths?: string[];
  resolveSessionExists?: (sessionId: string) => Promise<boolean | undefined> | boolean | undefined;
  listenToAgentEvent?: DesktopNativeWebSocketAgentEventListener;
};

type Listener = (event: Event) => void;
type DesktopNativeCoworkEventName =
  | "cowork_updated"
  | "cowork_state"
  | "cowork_stream"
  | "cowork_mailbox_stream";
export type DesktopNativeWebSocketAgentEventName = NativeBackendWebSocketAgentEventName | DesktopNativeCoworkEventName;
export type DesktopNativeWebSocketAgentEventHandler = (payload: unknown) => void;
export type DesktopNativeWebSocketAgentEventListener = (
  eventName: string,
  handler: DesktopNativeWebSocketAgentEventHandler,
) => Promise<() => void> | (() => void) | void;

const AGENT_EVENT_NAMES: DesktopNativeWebSocketAgentEventName[] = [
  "agent.delta",
  "agent.reasoning_delta",
  "agent.tool_call.delta",
  "agent.tool.start",
  "agent.tool.result",
  "agent.usage",
  "agent.awaiting_form",
  "agent.awaiting_approval",
  "agent.memory_reference",
  "agent.task_progress",
  "agent.delegate.started",
  "agent.delegate.running",
  "agent.delegate.message_queued",
  "agent.delegate.awaiting_approval",
  "agent.delegate.tool.approval_required",
  "agent.delegate.tool.completed",
  "agent.delegate.trace.updated",
  "agent.delegate.completed",
  "agent.delegate.failed",
  "agent.delegate.interrupted",
  "agent.delegate.closed",
  "agent.browser_frame",
  "cowork_updated",
  "cowork_state",
  "cowork_stream",
  "cowork_mailbox_stream",
  "agent.cancelled",
  "agent.done",
  "agent.error",
];

type ActiveRun = {
  chatId: string;
  sessionId?: string;
  messageId: string;
  streamed: boolean;
};

type ActiveToolCallDelta = {
  argumentsText: string;
  toolCallId: string;
  toolName: string;
};

export function createDesktopNativeWebSocket(options: DesktopNativeWebSocketOptions): WebSocket {
  return new DesktopNativeWebSocket(options) as unknown as WebSocket;
}

class DesktopNativeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState = DesktopNativeWebSocket.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  private readonly nativeTransport: NativeTransportApi;
  private readonly clientId: string;
  private readonly editablePaths?: string[];
  private readonly resolveSessionExists?: DesktopNativeWebSocketOptions["resolveSessionExists"];
  private readonly listenToAgentEvent?: DesktopNativeWebSocketAgentEventListener;
  private readonly agentEventUnlisteners: Array<() => void> = [];
  private readonly pendingAgentEvents = new Map<string, Array<{ eventName: DesktopNativeWebSocketAgentEventName; payload: Record<string, unknown> }>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeToolCallDeltas = new Map<string, ActiveToolCallDelta>();
  private readonly completedStreamedRunIds = new Set<string>();
  private readonly completedStreamedRunIdsByChat = new Map<string, string>();
  private readonly startedAgentRunIds = new Set<string>();
  private readonly lastUserMessageByChat = new Map<string, string>();
  private agentEventSequence = 0;
  private attachedChatId?: string;

  constructor(options: DesktopNativeWebSocketOptions) {
    super();
    this.url = String(options.url);
    this.nativeTransport = options.nativeTransport;
    this.clientId = options.clientId ?? createClientId();
    this.editablePaths = options.editablePaths ?? ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "memory/MEMORY.md"];
    this.resolveSessionExists = options.resolveSessionExists;
    this.listenToAgentEvent = options.listenToAgentEvent;
    void this.openWhenAgentEventListenersReady();
  }

  private async openWhenAgentEventListenersReady(): Promise<void> {
    await this.registerAgentEventListeners();
    if (this.readyState !== DesktopNativeWebSocket.CONNECTING) {
      return;
    }
    this.readyState = DesktopNativeWebSocket.OPEN;
    this.emit("open", new Event("open"));
    this.emitJson({ event: "ready", client_id: this.clientId });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== DesktopNativeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    if (typeof data !== "string") {
      this.emitJson({ event: "error", message: "unsupported websocket payload" });
      return;
    }
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      frame = isRecord(parsed) ? parsed : {};
    } catch {
      this.emitJson({ event: "error", message: "invalid json" });
      return;
    }

    void this.dispatchFrame(frame);
  }

  private async dispatchFrame(frame: Record<string, unknown>): Promise<void> {
    const sessionExists = await this.resolveAttachSessionExists(frame);
    const model = stringValue(frame.model);
    const run = optimisticRunForFrame(frame);
    this.maybeEmitApprovalResolvedFrame(frame);
    logDesktopNativeDebug("nativeWebSocket.dispatchFrame", {
      chatId: stringValue(frame.chat_id),
      hasRun: Boolean(run),
      model: model || "",
      type: stringValue(frame.type),
    });
    const request: NativeTransportWebSocketDispatchRequest = {
      clientId: this.clientId,
      frame,
      ...(this.attachedChatId ? { attachedChatId: this.attachedChatId } : {}),
      ...(sessionExists !== undefined ? { sessionExists } : {}),
      ...(this.editablePaths ? { editablePaths: this.editablePaths } : {}),
      ...(model ? { model } : {}),
      ...(run ? { runId: run.runId } : {}),
    };
    if (run) {
      this.lastUserMessageByChat.set(run.chatId, stringValue(frame.content));
      this.registerRun(run.runId, run);
      this.emitTurnStartedFrame(run, run.runId, frame);
    }
    try {
      this.applyDispatchResult(await this.nativeTransport.dispatchWebsocketMessage(request));
    } catch (error) {
      if (run) {
        this.activeRuns.delete(run.runId);
      }
      this.emitJson({ event: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async resolveAttachSessionExists(frame: Record<string, unknown>): Promise<boolean | undefined> {
    if (!this.resolveSessionExists || frame.type !== "attach") {
      return undefined;
    }
    const chatId = stringValue(frame.chat_id) || stringValue(frame.chatId);
    try {
      return chatId ? await this.resolveSessionExists(`websocket:${chatId}`) : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.readyState === DesktopNativeWebSocket.CLOSED) {
      return;
    }
    this.readyState = DesktopNativeWebSocket.CLOSED;
    this.unlistenAgentEvents();
    this.emit("close", new Event("close"));
  }

  private applyDispatchResult(result: unknown): void {
    const payload = isRecord(result) ? result : {};
    const transport = isRecord(payload.transport) ? payload.transport : payload;
    const attachedChatId = stringValue(transport.attachedChatId);
    if (attachedChatId) {
      this.attachedChatId = attachedChatId;
    }
    for (const frame of arrayValue(transport.frames)) {
      if (isRecord(frame)) {
        this.emitJson(frame);
      }
    }
    const chatId = stringValue(transport.chatId) || stringValue(transport.chat_id);
    const agent = isRecord(payload.agent) ? payload.agent : undefined;
    const runId = stringValue(agent?.runId) || stringValue(agent?.run_id) || this.activeRunIdForChat(chatId);
    if (runId && chatId) {
      this.registerRun(runId, {
        chatId,
        sessionId: stringValue(transport.sessionId) || stringValue(transport.session_id),
        messageId: stringValue(agent?.messageId) || stringValue(agent?.message_id) || runId,
        streamed: false,
      });
      const registeredRun = this.activeRuns.get(runId);
      if (registeredRun) {
        this.emitTurnStartedFrame(registeredRun, runId, {
          content: this.lastUserMessageByChat.get(chatId) ?? "",
        });
      }
    }
    const finalContent = stringValue(agent?.finalContent);
    const run = runId ? this.activeRuns.get(runId) : undefined;
    const alreadyProjectedStream = Boolean((runId && this.completedStreamedRunIds.has(runId)) || run?.streamed);
    if (finalContent && chatId && !alreadyProjectedStream) {
      this.emitJson({
        event: "message",
        chat_id: chatId,
        message_id: runId || `native:${chatId}`,
        text: finalContent,
      });
      this.emitJson({
        event: "stream_end",
        chat_id: chatId,
        message_id: runId || `native:${chatId}`,
        reason: stringValue(agent?.stopReason) || "stop",
      });
      if (run && runId) {
        this.emitAgentEventFrame(run, runId, "message.completed", {
          message_id: run.messageId,
          text: finalContent,
        }, `${runId}:final`);
        this.emitAgentEventFrame(run, runId, "agent.turn.completed", {
          message_id: run.messageId,
          reason: stringValue(agent?.stopReason) || "stop",
          usage: isRecord(agent?.usage) ? agent?.usage : undefined,
        });
      }
    }
  }

  private activeRunIdForChat(chatId: string): string {
    if (!chatId) {
      return "";
    }
    for (const [runId, run] of this.activeRuns) {
      if (run.chatId === chatId) {
        return runId;
      }
    }
    return this.completedStreamedRunIdsByChat.get(chatId) ?? "";
  }

  private async registerAgentEventListeners(): Promise<void> {
    if (!this.listenToAgentEvent) {
      return;
    }
    const registrations: Array<Promise<void>> = [];
    for (const eventName of AGENT_EVENT_NAMES) {
      const tauriEventName = toDesktopNativeTauriEventName(eventName);
      const unlisten = this.listenToAgentEvent(tauriEventName, (payload) => {
        this.handleAgentEvent(eventName, payload);
      });
      if (typeof unlisten === "function") {
        this.agentEventUnlisteners.push(unlisten);
        continue;
      }
      if (unlisten && typeof (unlisten as Promise<() => void>).then === "function") {
        registrations.push((unlisten as Promise<() => void>).then((resolvedUnlisten) => {
          if (this.readyState === DesktopNativeWebSocket.CLOSED) {
            resolvedUnlisten();
          } else {
            this.agentEventUnlisteners.push(resolvedUnlisten);
          }
        }).catch((error) => {
          logDesktopNativeDebug("nativeWebSocket.agentEvent.listener.failed", {
            error: error instanceof Error ? error.message : String(error),
            eventName,
          });
        }));
      }
    }
    await Promise.all(registrations);
  }

  private unlistenAgentEvents(): void {
    while (this.agentEventUnlisteners.length > 0) {
      const unlisten = this.agentEventUnlisteners.pop();
      unlisten?.();
    }
    this.pendingAgentEvents.clear();
    this.activeRuns.clear();
    this.activeToolCallDeltas.clear();
    this.completedStreamedRunIds.clear();
    this.completedStreamedRunIdsByChat.clear();
    this.startedAgentRunIds.clear();
    this.lastUserMessageByChat.clear();
  }

  private registerRun(runId: string, run: ActiveRun): void {
    const existing = this.activeRuns.get(runId);
    this.activeRuns.set(runId, existing ? { ...run, messageId: existing.messageId, streamed: existing.streamed } : run);
    const pending = this.pendingAgentEvents.get(runId) ?? [];
    this.pendingAgentEvents.delete(runId);
    for (const event of pending) {
      this.projectAgentEvent(event.eventName, event.payload, runId);
    }
  }

  private handleAgentEvent(eventName: DesktopNativeWebSocketAgentEventName, payload: unknown): void {
    if (this.readyState === DesktopNativeWebSocket.CLOSED) {
      return;
    }
    const record = isRecord(payload) ? payload : {};
    if (isCoworkEventName(eventName)) {
      this.emitJson({
        ...record,
        event: stringValue(record.event) || eventName,
      });
      return;
    }
    const runId = stringValue(record.runId) || stringValue(record.run_id);
    logDesktopNativeDebug("nativeWebSocket.agentEvent.received", {
      activeRunCount: this.activeRuns.size,
      eventName,
      hasRun: runId ? this.activeRuns.has(runId) : false,
      runId,
      text: summarizeDebugText(stringValue(record.delta) || stringValue(record.text) || stringValue(record.content)),
    });
    if (!runId) {
      return;
    }
    if (!this.activeRuns.has(runId)) {
      const events = this.pendingAgentEvents.get(runId) ?? [];
      events.push({ eventName, payload: record });
      this.pendingAgentEvents.set(runId, events);
      logDesktopNativeDebug("nativeWebSocket.agentEvent.queued", {
        eventName,
        pendingCount: events.length,
        runId,
      });
      return;
    }
    this.projectAgentEvent(eventName, record, runId);
  }

  private projectAgentEvent(eventName: DesktopNativeWebSocketAgentEventName, payload: Record<string, unknown>, runId: string): void {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return;
    }
    const messageId = stringValue(payload.messageId) || stringValue(payload.message_id) || run.messageId;
    if (messageId) {
      run.messageId = messageId;
    }
    if (eventName === "agent.delta" || eventName === "agent.reasoning_delta") {
      const text = stringValue(payload.delta) || stringValue(payload.text) || stringValue(payload.content);
      if (!text) {
        logDesktopNativeDebug("nativeWebSocket.agentEvent.dropped", {
          eventName,
          reason: "empty delta",
          runId,
        });
        return;
      }
      run.streamed = true;
      logDesktopNativeDebug("nativeWebSocket.agentEvent.projected", {
        chatId: run.chatId,
        eventName,
        messageId: run.messageId,
        runId,
        text: summarizeDebugText(text),
      });
      this.emitJson({
        event: "delta",
        chat_id: run.chatId,
        message_id: run.messageId,
        text,
        is_reasoning: eventName === "agent.reasoning_delta",
      });
      this.emitAgentEventFrame(run, runId, eventName === "agent.reasoning_delta" ? "reasoning.delta" : "message.delta", {
        message_id: run.messageId,
        text,
        visibility: eventName === "agent.reasoning_delta" ? "hidden" : "visible",
      });
      return;
    }
    if (eventName === "agent.tool_call.delta") {
      const index = numberValue(payload.index) ?? 0;
      const deltaKey = toolCallDeltaKey(runId, index);
      const current = this.activeToolCallDeltas.get(deltaKey);
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || current?.toolCallId || `${runId}:tool-${index}`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || current?.toolName || "tool";
      const argumentsText = `${current?.argumentsText ?? ""}${stringValue(payload.deltaText) || stringValue(payload.delta_text) || stringValue(payload.argumentsDelta) || stringValue(payload.arguments_delta)}`;
      this.activeToolCallDeltas.set(deltaKey, { argumentsText, toolCallId, toolName });
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:args`, toolName, toolCallId, formatToolCallText(toolName, argumentsText), {
        detail: true,
        hint: true,
      });
      return;
    }
    if (eventName === "agent.tool.start") {
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:tool`;
      const cachedToolCall = this.findToolCallDelta(runId, toolCallId);
      const toolName = cachedToolCall?.toolName || stringValue(payload.toolName) || stringValue(payload.tool_name) || "tool";
      const text = formatToolCallText(toolName, cachedToolCall?.argumentsText ?? "");
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:start`, toolName, toolCallId, text, {
        detail: true,
        hint: true,
      });
      this.emitAgentEventFrame(run, runId, "tool.call.started", {
        args_preview: cachedToolCall?.argumentsText ?? "",
        name: toolName,
        status: "running",
        tool_call_id: toolCallId,
      }, `${runId}:${toolCallId}`);
      return;
    }
    if (eventName === "agent.tool.result") {
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:tool`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || "tool";
      const text = stringValue(payload.content) || stringValue(payload.result) || stringValue(payload.output);
      const metadata = isRecord(payload.metadata) ? payload.metadata : {};
      if (metadata._delegate_event === true) {
        const delegatedPayload = delegatePayloadFromToolResult(metadata, runId, toolCallId, toolName, text);
        const delegateId = stringValue(delegatedPayload.delegate_id) || `${runId}:delegate`;
        this.emitAgentEventFrame(
          run,
          runId,
          delegatedEventTypeFromStatus(stringValue(delegatedPayload.status)),
          delegatedPayload,
          `${runId}:delegate:${delegateId}`,
        );
        return;
      }
      const approvalId = approvalIdFromPayload(payload, metadata);
      const awaitingApproval = isAwaitingApprovalToolResult(payload, metadata, text);
      const failed = ["failed", "error", "errored"].includes(stringValue(payload.status).toLowerCase());
      if (awaitingApproval) {
        this.emitApprovalRequiredToolResultFrame({
          approvalId,
          messageId: `${runId}:${toolCallId}:result`,
          run,
          runId,
          text: text || "Waiting for approval.",
          toolCallId,
          toolName,
        });
        if (approvalId) {
          this.emitJson({
            event: "approval_pending",
            chat_id: run.chatId,
            approval_id: approvalId,
          });
        }
        this.emitAgentEventFrame(run, runId, "approval.requested", {
          actions: arrayValue(payload.actions ?? metadata.actions),
          ...(approvalId ? { approval_id: approvalId } : {}),
          args_preview: approvalArgsPreview(payload, metadata),
          risk_level: stringValue(payload.riskLevel) || stringValue(payload.risk_level) || stringValue(metadata.riskLevel) || stringValue(metadata.risk_level),
          status: "approval_required",
          title: approvalTitle(payload, metadata, toolName),
          tool_call_id: toolCallId,
        }, approvalId ? `${runId}:approval:${approvalId}` : `${runId}:approval`);
        this.deleteToolCallDelta(runId, toolCallId);
        return;
      }
      this.emitToolProgressFrame(run.chatId, `${runId}:${toolCallId}:result`, toolName, toolCallId, text, {
        result: true,
      });
      this.emitAgentEventFrame(run, runId, failed ? "tool.call.failed" : "tool.call.completed", {
        error: failed ? { message: text || "tool failed" } : undefined,
        name: toolName,
        result_preview: text,
        status: failed ? "failed" : "completed",
        tool_call_id: toolCallId,
      }, `${runId}:${toolCallId}`);
      this.deleteToolCallDelta(runId, toolCallId);
      return;
    }
    if (eventName === "agent.usage") {
      this.emitJson({
        event: "usage",
        chat_id: run.chatId,
        usage: isRecord(payload.usage) ? payload.usage : payload,
      });
      return;
    }
    if (eventName === "agent.awaiting_form") {
      this.emitAwaitingFormFrame(run, payload, runId);
      return;
    }
    if (eventName === "agent.awaiting_approval") {
      const approvalId = stringValue(payload.approvalId) || stringValue(payload.approval_id);
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || approvalId;
      const operation = isRecord(payload.operation) ? payload.operation : {};
      const toolName = stringValue(payload.toolName)
        || stringValue(payload.tool_name)
        || stringValue(operation.toolName)
        || stringValue(operation.tool_name)
        || "tool";
      this.emitApprovalRequiredToolResultFrame({
        approvalId,
        messageId: approvalId ? `${runId}:approval:${approvalId}:result` : `${runId}:${toolCallId}:approval:result`,
        run,
        runId,
        text: stringValue(payload.content) || stringValue(payload.text) || "Waiting for approval.",
        toolCallId,
        toolName,
      });
      this.emitJson({
        event: "approval_pending",
        chat_id: run.chatId,
        ...(approvalId ? { approval_id: approvalId } : {}),
      });
      this.emitAgentEventFrame(run, runId, "approval.requested", {
        actions: arrayValue(payload.actions),
        approval_id: approvalId,
        args_preview: stringValue(payload.argsPreview) || stringValue(payload.args_preview),
        risk_level: stringValue(payload.riskLevel) || stringValue(payload.risk_level),
        title: stringValue(payload.title) || stringValue(payload.message) || `Approval required for ${toolName}`,
        tool_call_id: toolCallId,
      }, approvalId ? `${runId}:approval:${approvalId}` : `${runId}:approval`);
      return;
    }
    if (eventName === "agent.memory_reference") {
      const references = arrayValue(payload.references);
      if (references.length === 0) {
        return;
      }
      this.emitJson({
        event: "message",
        chat_id: run.chatId,
        message_id: run.messageId,
        text: "",
        _memory_references: references,
      });
      return;
    }
    if (eventName === "agent.task_progress") {
      const progress = payload.progress ?? payload.taskProgress ?? payload.task_progress;
      const toolCallId = stringValue(payload.toolCallId) || stringValue(payload.tool_call_id) || `${runId}:task-progress`;
      const toolName = stringValue(payload.toolName) || stringValue(payload.tool_name) || "task_progress";
      const planId = stringValue(payload.planId) || stringValue(payload.plan_id) || (isRecord(progress) ? stringValue(progress.plan_id) : "");
      this.emitTaskProgressFrame(run.chatId, `${runId}:${toolCallId}:task-progress`, toolName, toolCallId, progress, planId);
      return;
    }
    if (isDelegatedAgentEventName(eventName)) {
      const delegateId = stringValue(payload.delegateId) || stringValue(payload.delegate_id) || `${runId}:delegate`;
      this.emitAgentEventFrame(run, runId, eventName, payload, `${runId}:delegate:${delegateId}`);
      return;
    }
    if (eventName === "agent.browser_frame") {
      this.emitJson({
        event: "browser_frame",
        chat_id: run.chatId,
        image_url: stringValue(payload.imageUrl) || stringValue(payload.image_url),
        source_command: stringValue(payload.sourceCommand) || stringValue(payload.source_command),
        captured_at: payload.capturedAt ?? payload.captured_at ?? null,
      });
      this.emitAgentEventFrame(run, runId, "artifact.created", {
        artifact: {
          id: stringValue(payload.artifactId) || stringValue(payload.artifact_id) || `${runId}:browser-frame`,
          kind: "browser_snapshot",
          preview: stringValue(payload.imageUrl) || stringValue(payload.image_url),
          title: stringValue(payload.sourceCommand) || stringValue(payload.source_command) || "Browser snapshot",
        },
      }, `${runId}:browser-frame`);
      return;
    }
    if (eventName === "agent.cancelled") {
      run.streamed = true;
      this.emitJson({
        event: "interrupted",
        chat_id: run.chatId,
        cancelled: payload.cancelled !== false,
      });
      this.emitAgentEventFrame(run, runId, "agent.turn.interrupted", {
        cancelled: payload.cancelled !== false,
      });
      this.activeRuns.delete(runId);
      this.completedStreamedRunIds.add(runId);
      this.completedStreamedRunIdsByChat.set(run.chatId, runId);
      this.clearToolCallDeltas(runId);
      return;
    }
    if (eventName === "agent.error") {
      run.streamed = true;
      this.emitJson({
        event: "error",
        chat_id: run.chatId,
        message_id: run.messageId,
        message: stringValue(payload.message) || stringValue(payload.error) || "agent error",
      });
      this.emitAgentEventFrame(run, runId, "agent.turn.failed", {
        error: {
          message: stringValue(payload.message) || stringValue(payload.error) || "agent error",
        },
      });
      return;
    }
    if (eventName === "agent.done") {
      run.streamed = true;
      this.emitJson({
        event: "stream_end",
        chat_id: run.chatId,
        message_id: run.messageId,
        reason: stringValue(payload.stopReason) || stringValue(payload.stop_reason) || "stop",
        ...referenceMetadata(payload),
      });
      this.emitAgentEventFrame(run, runId, "agent.turn.completed", {
        message_id: run.messageId,
        reason: stringValue(payload.stopReason) || stringValue(payload.stop_reason) || "stop",
        usage: isRecord(payload.usage) ? payload.usage : undefined,
      });
      this.activeRuns.delete(runId);
      this.completedStreamedRunIds.add(runId);
      this.completedStreamedRunIdsByChat.set(run.chatId, runId);
      this.clearToolCallDeltas(runId);
    }
  }

  private emitAwaitingFormFrame(run: ActiveRun, payload: Record<string, unknown>, runId: string): void {
    const form = isRecord(payload.form) ? payload.form : {};
    const formId = stringValue(payload.formId) || stringValue(payload.form_id) || stringValue(form.form_id);
    if (!formId) {
      return;
    }
    const correlation = isRecord(form.correlation) ? form.correlation : {};
    const agentUiPayload = {
      ...form,
      form_id: formId,
      correlation: {
        ...correlation,
        chat_id: stringValue(correlation.chat_id) || run.chatId,
        form_id: stringValue(correlation.form_id) || formId,
        run_id: stringValue(correlation.run_id) || runId,
        ...(stringValue(correlation.session_id) || run.sessionId
          ? { session_id: stringValue(correlation.session_id) || run.sessionId }
          : {}),
      },
    };
    this.emitJson({
      event: "agent_ui_event",
      chat_id: run.chatId,
      agent_ui_event: {
        event_type: "ui.form.requested",
        chat_id: run.chatId,
        payload: agentUiPayload,
      },
    });
  }

  private emitTaskProgressFrame(
    chatId: string,
    messageId: string,
    toolName: string,
    toolCallId: string,
    progress: unknown,
    planId: string,
  ): void {
    this.emitJson({
      event: "message",
      chat_id: chatId,
      message_id: messageId,
      text: "Task progress updated.",
      _progress: true,
      _tool_call_id: toolCallId,
      _tool_name: toolName,
      _tool_result: true,
      _task_event: true,
      ...(planId ? { _task_plan_id: planId } : {}),
      _task_progress: progress,
    });
  }

  private emitToolProgressFrame(
    chatId: string,
    messageId: string,
    toolName: string,
    toolCallId: string,
    text: string,
    flags: { detail?: boolean; hint?: boolean; result?: boolean },
    extra: Record<string, unknown> = {},
  ): void {
    this.emitJson({
      event: "message",
      chat_id: chatId,
      message_id: messageId,
      text,
      _progress: true,
      _tool_call_id: toolCallId,
      ...(flags.detail ? { _tool_detail: true } : {}),
      ...(flags.hint ? { _tool_hint: true } : {}),
      ...(flags.result ? { _tool_result: true } : {}),
      _tool_name: toolName,
      ...extra,
    });
  }

  private emitApprovalRequiredToolResultFrame(options: {
    approvalId: string;
    messageId: string;
    run: ActiveRun;
    runId: string;
    text: string;
    toolCallId: string;
    toolName: string;
  }): void {
    this.emitToolProgressFrame(options.run.chatId, options.messageId, options.toolName, options.toolCallId, options.text, {
      result: true,
    }, {
      ...(options.approvalId ? { _approval_id: options.approvalId } : {}),
      _approval_status: "approval_required",
      status: "blocked",
    });
    logDesktopNativeDebug("nativeWebSocket.agentEvent.projected", {
      approvalId: options.approvalId,
      chatId: options.run.chatId,
      eventName: "agent.awaiting_approval",
      messageId: options.messageId,
      runId: options.runId,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
    });
  }

  private emitTurnStartedFrame(run: ActiveRun, runId: string, frame: Record<string, unknown>): void {
    if (this.startedAgentRunIds.has(runId)) {
      return;
    }
    this.startedAgentRunIds.add(runId);
    this.emitAgentEventFrame(run, runId, "agent.turn.started", {
      user_message: {
        id: `${runId}:user`,
        role: "user",
        text: stringValue(frame.content),
      },
      user_message_id: `${runId}:user`,
    });
  }

  private maybeEmitApprovalResolvedFrame(frame: Record<string, unknown>): void {
    const approvalId = stringValue(frame.approval_id) || stringValue(frame.approvalId);
    const decision = stringValue(frame.decision) || stringValue(frame.action) || stringValue(frame.approval_action);
    const normalizedDecision = decision.toLowerCase();
    if (!approvalId || !["approve", "approved", "approve_once", "approve_session", "deny", "denied", "reject", "rejected"].includes(normalizedDecision)) {
      return;
    }
    const chatId = stringValue(frame.chat_id) || stringValue(frame.chatId) || this.attachedChatId || "";
    const runId = stringValue(frame.run_id) || stringValue(frame.runId) || this.activeRunIdForChat(chatId);
    const run = runId ? this.activeRuns.get(runId) : undefined;
    if (!run) {
      return;
    }
    this.emitAgentEventFrame(run, runId, "approval.resolved", {
      approval_id: approvalId,
      decision: normalizedDecision.startsWith("deny") || normalizedDecision.startsWith("reject") ? "denied" : "approved",
      tool_call_id: stringValue(frame.tool_call_id) || stringValue(frame.toolCallId),
    }, `${runId}:approval:${approvalId}`);
  }

  private emitAgentEventFrame(
    run: ActiveRun,
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    stepId?: string,
  ): void {
    const sequence = ++this.agentEventSequence;
    this.emitJson({
      event: "agent_event",
      schema_version: "tinybot.agent_event.v1",
      event_id: `${runId}:${eventType}:${sequence}`,
      event_type: eventType,
      chat_id: run.chatId,
      session_key: run.sessionId || `websocket:${run.chatId}`,
      turn_id: runId,
      ...(stepId ? { step_id: stepId } : {}),
      sequence,
      created_at: new Date().toISOString(),
      payload,
    });
  }

  private findToolCallDelta(runId: string, toolCallId: string): ActiveToolCallDelta | null {
    for (const [key, value] of this.activeToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        return value;
      }
    }
    return null;
  }

  private deleteToolCallDelta(runId: string, toolCallId: string): void {
    for (const [key, value] of this.activeToolCallDeltas.entries()) {
      if (key.startsWith(`${runId}:`) && value.toolCallId === toolCallId) {
        this.activeToolCallDeltas.delete(key);
      }
    }
  }

  private clearToolCallDeltas(runId: string): void {
    for (const key of this.activeToolCallDeltas.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.activeToolCallDeltas.delete(key);
      }
    }
  }

  private emitJson(payload: Record<string, unknown>): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  private emit(type: "open" | "message" | "error" | "close", event: Event): void {
    this.dispatchEvent(event);
    const handler = this[`on${type}`];
    if (handler) {
      handler.call(this, event);
    }
  }
}

function isDelegatedAgentEventName(eventName: DesktopNativeWebSocketAgentEventName): boolean {
  return eventName.startsWith("agent.delegate.");
}

function delegatePayloadFromToolResult(
  metadata: Record<string, unknown>,
  runId: string,
  toolCallId: string,
  toolName: string,
  text: string,
): Record<string, unknown> {
  const result = isRecord(metadata._delegate_result) ? metadata._delegate_result : {};
  const status = normalizeDelegateStatus(stringValue(metadata._delegate_status) || stringValue(result.status));
  return {
    runId,
    run_id: runId,
    delegateId: stringValue(metadata._delegate_id) || stringValue(metadata._background_run_id) || toolCallId,
    delegate_id: stringValue(metadata._delegate_id) || stringValue(metadata._background_run_id) || toolCallId,
    delegate_type: "spawn",
    title: stringValue(metadata._delegate_label) || stringValue(metadata._background_label) || toolName,
    task: stringValue(metadata._delegate_task) || stringValue(metadata._background_task),
    status,
    toolCallId,
    tool_call_id: toolCallId,
    latest_activity: text,
    final_output: stringValue(result.summary) || text,
    traceRef: stringValue(metadata._delegate_trace_ref),
    trace_ref: stringValue(metadata._delegate_trace_ref),
    approval_id: stringValue(metadata.approvalId),
    approval_status: stringValue(metadata.approvalStatus),
    child_run_id: stringValue(metadata._delegate_child_run_id),
    child_tool_call_id: stringValue(metadata._delegate_child_tool_call_id),
    tool_name: stringValue(metadata._delegate_child_tool_name) || toolName,
    operation_preview: stringValue(metadata._delegate_operation_preview),
    workflow: "Spawned agent workflow",
  };
}

function delegatedEventTypeFromStatus(status: string): string {
  if (status === "completed") {
    return "agent.delegate.completed";
  }
  if (status === "failed") {
    return "agent.delegate.failed";
  }
  if (status === "cancelled") {
    return "agent.delegate.interrupted";
  }
  if (status === "closed") {
    return "agent.delegate.closed";
  }
  if (status === "awaiting_approval" || status === "blocked") {
    return "agent.delegate.awaiting_approval";
  }
  return "agent.delegate.running";
}

function normalizeDelegateStatus(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "approval_required" || normalized === "awaiting_approval") {
    return "blocked";
  }
  return normalized || "running";
}

function createClientId(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

function optimisticRunForFrame(frame: Record<string, unknown>): (ActiveRun & { runId: string }) | null {
  if (stringValue(frame.type) !== "message") {
    return null;
  }
  const chatId = stringValue(frame.chat_id) || stringValue(frame.chatId);
  if (!chatId) {
    return null;
  }
  const runId = `websocket-${sanitizeRunIdPart(chatId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    runId,
    chatId,
    sessionId: `websocket:${chatId}`,
    messageId: runId,
    streamed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function approvalIdFromPayload(payload: Record<string, unknown>, metadata: Record<string, unknown>): string {
  return stringValue(payload.approvalId)
    || stringValue(payload.approval_id)
    || stringValue(metadata.approvalId)
    || stringValue(metadata.approval_id)
    || stringValue(payload.id)
    || stringValue(metadata.id);
}

function isAwaitingApprovalToolResult(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  text: string,
): boolean {
  const status = normalizeStatusValue(
    stringValue(payload.status)
      || stringValue(payload.stopReason)
      || stringValue(payload.stop_reason)
      || stringValue(metadata.status)
      || stringValue(metadata.stopReason)
      || stringValue(metadata.stop_reason),
  );
  if (["awaiting_approval", "approval_required", "pending_approval", "waiting_approval"].includes(status)) {
    return true;
  }
  return (
    metadata.awaitingUserInput === true
    && normalizeStatusValue(stringValue(metadata.stopReason) || stringValue(metadata.stop_reason)) === "awaiting_approval"
  ) || text.trim().toLowerCase() === "waiting for approval.";
}

function approvalArgsPreview(payload: Record<string, unknown>, metadata: Record<string, unknown>): string {
  const explicit = stringValue(payload.argsPreview)
    || stringValue(payload.args_preview)
    || stringValue(metadata.argsPreview)
    || stringValue(metadata.args_preview);
  if (explicit) {
    return explicit;
  }
  const operation = isRecord(payload.operation) ? payload.operation : isRecord(metadata.operation) ? metadata.operation : {};
  const args = operation.arguments ?? operation.args;
  if (args === undefined) {
    return "";
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function approvalTitle(payload: Record<string, unknown>, metadata: Record<string, unknown>, fallbackToolName: string): string {
  const operation = isRecord(payload.operation) ? payload.operation : isRecord(metadata.operation) ? metadata.operation : {};
  const toolName = stringValue(operation.toolName) || stringValue(operation.tool_name) || fallbackToolName;
  return stringValue(payload.title)
    || stringValue(payload.message)
    || stringValue(metadata.title)
    || stringValue(metadata.message)
    || `Approval required for ${toolName}`;
}

function normalizeStatusValue(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isCoworkEventName(eventName: DesktopNativeWebSocketAgentEventName): boolean {
  return (
    eventName === "cowork_updated" ||
    eventName === "cowork_state" ||
    eventName === "cowork_stream" ||
    eventName === "cowork_mailbox_stream"
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-") || "chat";
}

function referenceMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const memoryReferences = arrayValue(payload._memory_references ?? payload.memoryReferences ?? payload.memory_references);
  const recentContextReferences = arrayValue(
    payload._recent_context_references ?? payload.recentContextReferences ?? payload.recent_context_references,
  );
  return {
    ...(memoryReferences.length ? { _memory_references: memoryReferences } : {}),
    ...(recentContextReferences.length ? { _recent_context_references: recentContextReferences } : {}),
  };
}

function toolCallDeltaKey(runId: string, index: number): string {
  return `${runId}:${index}`;
}

function formatToolCallText(toolName: string, argumentsText: string): string {
  return `${toolName}(${argumentsText})`;
}
