import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import {
  AGENT_UI_EVENT_TYPES,
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
} from "../../app-core/agent-ui/agentUiEvents";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { DesktopChatSessionController } from "../../app-core/chat/desktopChatSessionController";
import type { TinyOsDirectHostCommand } from "../../app-core/chat/tinyOsCommand";
import { normalizeNativeBrowserSnapshot } from "../../app-core/native/desktopNativeBrowser";
import { logDesktopNativeDebug } from "../../app-core/native/desktopNativeChatDebug";
import { toDesktopNativeTauriEventName } from "../../app-core/native/desktopNativeTauriEvents";
import { normalizeNativeBackendEventPayload } from "../../app-core/native/nativeBackendContract";
import type { ChatEvent } from "../services";

type NativeEvent = { payload: unknown };
type NativeEventHandler = (event: NativeEvent) => void | Promise<void>;
type NativeEventListen = (eventName: string, handler: NativeEventHandler) => Promise<() => void>;
type NativeEventController = Pick<
  DesktopChatSessionController,
  "applyTimelinePatch" | "loadSessions" | "state"
>;
type NotifyAll = (event: ChatEvent) => void;
type NotifySession = (sessionId: string, event: ChatEvent) => void;
type TerminalTimeline = Pick<ChatTimelineSnapshot, "turns"> | null;

const NATIVE_EVENT_NAMES = [
  toDesktopNativeTauriEventName("agent.timeline.patch"),
  toDesktopNativeTauriEventName("agent.awaiting_form"),
  "tinyos:browser-snapshot",
  "tinyos:host-operation",
] as const;
const MAX_LOGGED_ERROR_LENGTH = 500;

type TinyOsHostOperationUpdate = {
  commandId: string;
  error?: string;
  operationId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
};

export function createDesktopNativeEventBridge({
  controller,
  listen,
  notifyAll,
  notifySession,
}: {
  controller: NativeEventController;
  listen: NativeEventListen;
  notifyAll: NotifyAll;
  notifySession: NotifySession;
}) {
  const agentUiState = createAgentUiEventState();
  const notifiedTerminalTurns = new Set<string>();

  function notifyTerminalTimelineState(sessionId: string, timeline: TerminalTimeline): void {
    const turn = timeline?.turns[timeline.turns.length - 1];
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return;
    const key = `${sessionId}:${turn.id}:${turn.status}`;
    if (notifiedTerminalTurns.has(key)) return;
    notifiedTerminalTurns.add(key);
    const eventType = turn.status === "completed"
      ? "agent.turn.completed"
      : turn.status === "failed" ? "agent.turn.failed" : "agent.turn.interrupted";
    logDesktopNativeDebug("nativeEventBridge.timelinePatch.terminal", {
      eventType,
      sessionId,
      turnId: turn.id,
      turnStatus: turn.status,
    });
    notifySession(sessionId, { type: "agent.event", eventType });
  }

  function reduceNativeAgentFormEvent(payload: unknown): Record<string, unknown> {
    if (!isRecord(payload)) throw new Error("Native agent form event must be an object.");
    const form = isRecord(payload.form) ? payload.form : payload;
    const traceContext = isRecord(payload.traceContext) ? payload.traceContext : {};
    const formId = stringValue(payload.formId ?? payload.form_id ?? form.formId ?? form.form_id);
    const threadId = stringValue(traceContext.threadId ?? traceContext.thread_id);
    const turnId = stringValue(traceContext.turnId ?? traceContext.turn_id);
    if (!formId) throw new Error("Native agent form event is missing formId.");
    if (!threadId) throw new Error(`Native agent form ${formId} is missing threadId.`);
    const correlation = isRecord(form.correlation) ? form.correlation : {};
    const agentUiEvents = normalizeAgentUiEvents({
      event: "agent_ui_event",
      agent_ui_event: {
        event_type: "ui.form.requested",
        turn_id: turnId,
        payload: {
          ...form,
          form_id: formId,
          correlation: {
            ...correlation,
            form_id: formId,
            turn_id: turnId,
            session_key: threadId,
            thread_id: threadId,
          },
        },
      },
    });
    if (!agentUiEvents.length) {
      throw new Error(`Native agent form ${formId} could not be normalized.`);
    }
    const normalizationError = agentUiEvents.find((event) => (
      event.event_type === AGENT_UI_EVENT_TYPES["error.raised"]
    ));
    if (normalizationError) {
      throw new Error(stringValue(normalizationError.payload.message) || `Native agent form ${formId} is invalid.`);
    }
    for (const agentUiEvent of agentUiEvents) {
      reduceAgentUiEventState(agentUiState, agentUiEvent);
    }
    notifySession(threadId, { type: "agent-ui.form" });
    return {
      fieldCount: Array.isArray(form.fields) ? form.fields.length : 0,
      formId,
      sessionId: threadId,
      turnId,
    };
  }

  async function handleTimelinePatch(event: NativeEvent): Promise<void> {
    const startedAt = readMonotonicNow();
    const payload = normalizeNativeBackendEventPayload(event.payload);
    const debugDetails = summarizeTimelinePatch(payload);
    logDesktopNativeDebug("nativeEventBridge.timelinePatch.received", debugDetails);
    const sessionId = isRecord(payload) ? stringValue(payload.sessionId) : "";
    if (!sessionId) {
      const error = "Canonical timeline patch is missing sessionId";
      reportNativeEventBridgeError("timelinePatch", error, {
        ...debugDetails,
        durationMs: roundedDuration(readMonotonicNow() - startedAt),
      });
      notifyAll({ type: "timeline.error", error });
      return;
    }
    try {
      if (!controller.state.threads.some((thread) => thread.threadId === sessionId)) {
        logDesktopNativeDebug("nativeEventBridge.timelinePatch.sessionReload.start", {
          sessionId,
          threadCount: controller.state.threads.length,
        });
        await controller.loadSessions();
        const sessionFound = controller.state.threads.some((thread) => thread.threadId === sessionId);
        logDesktopNativeDebug("nativeEventBridge.timelinePatch.sessionReload.complete", {
          sessionFound,
          sessionId,
          threadCount: controller.state.threads.length,
        });
        if (sessionFound) {
          notifyAll({ type: "chat.created" });
        }
      }
      const timeline = await controller.applyTimelinePatch(sessionId, payload);
      logDesktopNativeDebug("nativeEventBridge.timelinePatch.applied", {
        ...debugDetails,
        durationMs: roundedDuration(readMonotonicNow() - startedAt),
        projected: Boolean(timeline),
        turnCount: timeline?.turns.length ?? 0,
      });
      if (timeline) {
        notifySession(sessionId, { type: "timeline.patch", timeline });
        notifyTerminalTimelineState(sessionId, timeline);
      }
    } catch (error) {
      const message = errorMessage(error);
      reportNativeEventBridgeError("timelinePatch", error, {
        ...debugDetails,
        durationMs: roundedDuration(readMonotonicNow() - startedAt),
      });
      notifySession(sessionId, { type: "timeline.error", error: message });
    }
  }

  function handleAgentForm(event: NativeEvent): void {
    try {
      const details = reduceNativeAgentFormEvent(normalizeNativeBackendEventPayload(event.payload));
      logDesktopNativeDebug("nativeEventBridge.agentForm.accepted", details);
    } catch (error) {
      const message = errorMessage(error);
      reportNativeEventBridgeError("agentForm", error);
      notifyAll({ type: "agent-ui.form.error", error: message });
    }
  }

  function handleBrowserSnapshot(event: NativeEvent): void {
    try {
      const browserSnapshot = normalizeNativeBrowserSnapshot(event.payload);
      logDesktopNativeDebug("nativeEventBridge.browserSnapshot.accepted", {
        browserSessionId: browserSnapshot.data.browserSessionId,
        revision: browserSnapshot.revision,
        sessionId: browserSnapshot.data.sessionId,
        tabCount: browserSnapshot.data.tabs.length,
      });
      notifySession(browserSnapshot.data.sessionId, { browserSnapshot, type: "browser.snapshot" });
    } catch (error) {
      const message = errorMessage(error);
      reportNativeEventBridgeError("browserSnapshot", error);
      notifyAll({ type: "browser.snapshot.error", error: message });
    }
  }

  function handleHostOperation(event: NativeEvent): void {
    const update = normalizeTinyOsHostOperationUpdate(event.payload);
    if (!update) {
      const error = "Native host operation event is missing commandId, operationId, sessionId, or status.";
      reportNativeEventBridgeError("hostOperation", error, summarizeHostOperation(event.payload));
      notifyAll({ type: "host.operation.error", error });
      return;
    }
    logDesktopNativeDebug("nativeEventBridge.hostOperation.accepted", {
      commandId: update.commandId,
      hasError: Boolean(update.error),
      operationId: update.operationId,
      sessionId: update.sessionId,
      status: update.status,
    });
    notifySession(update.sessionId, {
      commandId: update.commandId,
      error: update.error,
      operationId: update.operationId,
      operationStatus: update.status,
      type: "host.operation",
    });
  }

  return {
    async register() {
      const startedAt = readMonotonicNow();
      logDesktopNativeDebug("nativeEventBridge.register.start", {
        eventCount: NATIVE_EVENT_NAMES.length,
      });
      try {
        await Promise.all([
          listen(NATIVE_EVENT_NAMES[0], handleTimelinePatch),
          listen(NATIVE_EVENT_NAMES[1], handleAgentForm),
          listen(NATIVE_EVENT_NAMES[2], handleBrowserSnapshot),
          listen(NATIVE_EVENT_NAMES[3], handleHostOperation),
        ]);
        logDesktopNativeDebug("nativeEventBridge.register.complete", {
          durationMs: roundedDuration(readMonotonicNow() - startedAt),
          eventCount: NATIVE_EVENT_NAMES.length,
        });
      } catch (error) {
        reportNativeEventBridgeError("register", error, {
          durationMs: roundedDuration(readMonotonicNow() - startedAt),
          eventCount: NATIVE_EVENT_NAMES.length,
        });
        throw error;
      }
    },
    listAgentUiForms(sessionId: string): AgentUiForm[] {
      return Array.from(agentUiState.forms.values()).filter((form) => formMatchesSession(form, sessionId));
    },
    notifyTerminalTimelineState,
    hostOperationUpdateFromDispatch(
      command: TinyOsDirectHostCommand,
      value: unknown,
    ): Pick<TinyOsHostOperationUpdate, "error" | "status"> {
      const root = isRecord(value) ? value : {};
      const operation = isRecord(root.operation) ? root.operation : {};
      if (command.kind === "terminal.cancel") return { status: "cancelled" };
      const status = normalizeTinyOsHostOperationStatus(operation.status);
      if (status) {
        const error = stringValue(operation.error ?? operation.reason);
        return { status, ...(error ? { error } : {}) };
      }
      return { status: "completed" };
    },
  };
}

function formMatchesSession(form: AgentUiForm, sessionId: string): boolean {
  const chatId = stringValue(form.chat_id || form.correlation.chat_id);
  const sessionKey = stringValue(form.correlation.session_key ?? form.correlation.sessionKey);
  return sessionKey === sessionId
    || chatId === sessionId
    || (Boolean(chatId) && sessionId.endsWith(`:${chatId}`));
}

function normalizeTinyOsHostOperationUpdate(value: unknown): TinyOsHostOperationUpdate | undefined {
  if (!isRecord(value)) return undefined;
  const commandId = stringValue(value.commandId);
  const operationId = stringValue(value.operationId);
  const sessionId = stringValue(value.sessionId);
  const status = normalizeTinyOsHostOperationStatus(value.status);
  if (!commandId || !operationId || !sessionId || !status) return undefined;
  const error = stringValue(value.error);
  return {
    commandId,
    operationId,
    sessionId,
    status,
    ...(error ? { error } : {}),
  };
}

function normalizeTinyOsHostOperationStatus(
  value: unknown,
): TinyOsHostOperationUpdate["status"] | undefined {
  const status = stringValue(value);
  if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "user_required") return "completed";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportNativeEventBridgeError(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  const message = errorMessage(error);
  const loggedError = message.length > MAX_LOGGED_ERROR_LENGTH
    ? `${message.slice(0, MAX_LOGGED_ERROR_LENGTH)}...`
    : message;
  logDesktopNativeDebug(`nativeEventBridge.${stage}.failed`, {
    ...details,
    error: loggedError,
  });
  console.error("[tinybot-native-event-bridge]", {
    ...details,
    error: loggedError,
    stage,
  });
}

function summarizeTimelinePatch(payload: unknown): Record<string, unknown> {
  const root = isRecord(payload) ? payload : {};
  const item = isRecord(root.item) ? root.item : {};
  return compactDebugDetails({
    itemId: stringValue(item.itemId),
    itemKind: stringValue(item.kind),
    itemStatus: stringValue(item.status),
    sessionId: stringValue(root.sessionId),
    snapshotRevision: numberValue(root.snapshotRevision),
    turnId: stringValue(root.turnId),
  });
}

function summarizeHostOperation(payload: unknown): Record<string, unknown> {
  const root = isRecord(payload) ? payload : {};
  return compactDebugDetails({
    commandId: stringValue(root.commandId),
    operationId: stringValue(root.operationId),
    sessionId: stringValue(root.sessionId),
    status: stringValue(root.status),
  });
}

function compactDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => (
    value !== "" && value !== undefined
  )));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundedDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
