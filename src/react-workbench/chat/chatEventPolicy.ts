import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatEvent, SessionSummary } from "../services";

export type QueuedInputDisposition = "dispatch_next" | "pause" | "unchanged";

export type ChatEventEffects = {
  backgroundTabActivity: boolean;
  queuedInputDisposition: QueuedInputDisposition;
  reloadAgentUiForms: boolean;
  reloadMessages: boolean;
  reloadSessions: boolean;
  terminalAgentEvent: boolean;
};

const MESSAGE_RELOAD_EVENT_TYPES = new Set([
  "attached",
]);

const SESSION_RELOAD_EVENT_TYPES = new Set([
  "chat.created",
  "interrupted",
]);

const TERMINAL_AGENT_EVENT_TYPES = new Set([
  "agent.turn.completed",
  "agent.turn.failed",
  "agent.turn.interrupted",
]);

export function projectChatEventEffects(event: ChatEvent): ChatEventEffects {
  const terminalAgentEvent = event.type === "agent.event"
    && Boolean(event.eventType && TERMINAL_AGENT_EVENT_TYPES.has(event.eventType));
  return {
    backgroundTabActivity: Boolean(event.error || event.timeline || terminalAgentEvent),
    queuedInputDisposition: queuedInputDisposition(event),
    reloadAgentUiForms: event.type === "agent-ui.form" || event.type === "agent-ui.event",
    reloadMessages: MESSAGE_RELOAD_EVENT_TYPES.has(event.type),
    reloadSessions: SESSION_RELOAD_EVENT_TYPES.has(event.type) || terminalAgentEvent,
    terminalAgentEvent,
  };
}

export function projectTimelineSessionStatus(
  timeline: ChatTimelineSnapshot,
): SessionSummary["status"] | undefined {
  const status = timeline.turns[timeline.turns.length - 1]?.status;
  if (status === "pending" || status === "running" || status === "awaiting_user") {
    return "running";
  }
  if (status === "failed" || status === "interrupted") {
    return "failed";
  }
  if (status === "completed") {
    return "idle";
  }
  return undefined;
}

export function canDispatchQueuedInput(session: SessionSummary | undefined): boolean {
  return session?.status !== "running" && session?.status !== "failed";
}

function queuedInputDisposition(event: ChatEvent): QueuedInputDisposition {
  if (event.type === "interrupted"
    || (event.type === "agent.event" && (
      event.eventType === "agent.turn.failed" || event.eventType === "agent.turn.interrupted"
    ))) {
    return "pause";
  }
  if (event.type === "agent.event" && event.eventType === "agent.turn.completed") {
    return "dispatch_next";
  }
  return "unchanged";
}
