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
    notifySession(sessionId, { type: "agent.event", eventType });
  }

  function reduceNativeAgentFormEvent(payload: unknown): void {
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
  }

  async function handleTimelinePatch(event: NativeEvent): Promise<void> {
    const payload = normalizeNativeBackendEventPayload(event.payload);
    const sessionId = isRecord(payload) ? stringValue(payload.sessionId) : "";
    if (!sessionId) {
      notifyAll({ type: "timeline.error", error: "Canonical timeline patch is missing sessionId" });
      return;
    }
    try {
      if (!controller.state.threads.some((thread) => thread.threadId === sessionId)) {
        await controller.loadSessions();
        if (controller.state.threads.some((thread) => thread.threadId === sessionId)) {
          notifyAll({ type: "chat.created" });
        }
      }
      const timeline = await controller.applyTimelinePatch(sessionId, payload);
      if (timeline) {
        notifySession(sessionId, { type: "timeline.patch", timeline });
        notifyTerminalTimelineState(sessionId, timeline);
      }
    } catch (error) {
      notifySession(sessionId, { type: "timeline.error", error: errorMessage(error) });
    }
  }

  function handleAgentForm(event: NativeEvent): void {
    try {
      reduceNativeAgentFormEvent(normalizeNativeBackendEventPayload(event.payload));
    } catch (error) {
      notifyAll({ type: "agent-ui.form.error", error: errorMessage(error) });
    }
  }

  function handleBrowserSnapshot(event: NativeEvent): void {
    try {
      const browserSnapshot = normalizeNativeBrowserSnapshot(event.payload);
      notifySession(browserSnapshot.data.sessionId, { browserSnapshot, type: "browser.snapshot" });
    } catch (error) {
      notifyAll({ type: "browser.snapshot.error", error: errorMessage(error) });
    }
  }

  function handleHostOperation(event: NativeEvent): void {
    const update = normalizeTinyOsHostOperationUpdate(event.payload);
    if (!update) {
      notifyAll({
        type: "host.operation.error",
        error: "Native host operation event is missing commandId, operationId, sessionId, or status.",
      });
      return;
    }
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
      await Promise.all([
        listen(toDesktopNativeTauriEventName("agent.timeline.patch"), handleTimelinePatch),
        listen(toDesktopNativeTauriEventName("agent.awaiting_form"), handleAgentForm),
        listen("tinyos:browser-snapshot", handleBrowserSnapshot),
        listen("tinyos:host-operation", handleHostOperation),
      ]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
