import { createAgentTimelineModel } from "../../../app-core/chat/agentTimelineModel";
import type { ChatTimelineSnapshot } from "../../../app-core/chat/agentTimelineModel";
import type { ChatStep, ChatTurn, TokenUsage } from "../../../app-core/chat/chatTurnContracts";
import type { ContextReferenceSummary } from "../chatMessages";

type ToolCallSummary = {
  argsText?: string;
  childTurnId?: string;
  delegateId?: string;
  delegateTask?: string;
  delegateTitle?: string;
  delegateType?: string;
  finalOutput?: string;
  id: string;
  name: string;
  parentTurnId?: string;
  responseText?: string;
  sessionKey?: string;
  status: "pending" | "running" | "complete" | "failed" | "blocked" | string;
  summary?: string;
  traceRef?: string;
};

export type TimelineMessageFixture = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  createdAtMs: number;
  text: string;
  status: "streaming" | "complete" | "failed";
  contextReferences?: ContextReferenceSummary[];
  selectedSkills?: string[];
  reasoningText?: string;
  toolCalls?: ToolCallSummary[];
  turnId?: string;
  turnStatus?: string;
  usage?: TokenUsage;
};

export function timelineFromReactMessages(
  sessionId: string,
  messages: TimelineMessageFixture[],
): ChatTimelineSnapshot {
  const turns: ChatTurn[] = [];
  let turn: ChatTurn | undefined;
  for (const message of messages) {
    const timestamp = new Date(message.createdAtMs).toISOString();
    if (message.role === "user") {
      turn = {
        id: message.turnId || `turn:${message.id}`,
        sessionKey: sessionId,
        userMessageId: message.id,
        userMessage: { id: message.id, role: "user", text: message.text, timestamp },
        status: "running",
        steps: [],
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      turns.push(turn);
      continue;
    }
    if (turn && message.turnId && turn.id !== message.turnId) {
      turn = undefined;
    }
    if (!turn) {
      turn = {
        id: message.turnId || `turn:${message.id}`,
        sessionKey: sessionId,
        userMessageId: `user:${message.id}`,
        userMessage: { id: `user:${message.id}`, role: "user", text: "", timestamp },
        status: "running",
        steps: [],
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      turns.push(turn);
    }
    if (message.reasoningText) {
      turn.steps.push(step(message, turn.steps.length + 1, "reasoning", "Thinking", message.reasoningText));
    }
    for (const toolCall of message.toolCalls ?? []) {
      turn.steps.push({
        ...step(message, turn.steps.length + 1, "tool_call", toolCall.name, toolCall.summary),
        status: toolCall.status === "complete" || toolCall.status === "completed"
          ? "completed"
          : toolCall.status === "failed"
            ? "failed"
            : toolCall.status === "blocked"
              ? "blocked"
              : toolCall.status === "queued"
                ? "pending"
              : "running",
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          argsPreview: toolCall.argsText,
          resultPreview: toolCall.responseText || toolCall.summary,
        },
      });
    }
    if (message.text) {
      if (turn.finalAnswer) {
        turn.steps.push(step(
          { ...message, id: turn.finalAnswer.id },
          turn.steps.length + 1,
          "message",
          "Assistant message",
          turn.finalAnswer.text,
        ));
      }
      turn.finalAnswer = {
        id: message.id,
        role: "assistant",
        text: message.text,
        timestamp,
        references: message.contextReferences?.map((reference) => ({
          detail: reference.detail ?? "",
          evidenceId: reference.id,
          kind: reference.kind as "browser" | "recent" | "reference",
          title: reference.title,
          sourcePath: reference.sourcePath,
          sourceLine: reference.sourceLine,
        })),
      };
    }
    turn.usage = message.usage ?? turn.usage;
    turn.updatedAt = timestamp;
    turn.status = message.turnStatus === "completed"
      ? "completed"
      : message.turnStatus === "failed"
        ? "failed"
        : message.turnStatus === "interrupted"
        ? "interrupted"
        : message.turnStatus
          ? "running"
        : message.status === "streaming"
            ? "running"
            : message.status === "failed"
              ? "failed"
              : "completed";
    if (turn.status === "completed" || turn.status === "failed") {
      turn.completedAt = timestamp;
    }
  }
  return {
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    turnRevisions: Object.fromEntries(turns.map((item, index) => [item.id, index + 1])),
    turns,
    diagnostics: [],
  };
}

function step(
  message: TimelineMessageFixture,
  sequence: number,
  kind: ChatStep["kind"],
  title: string,
  summary?: string,
): ChatStep {
  return {
    agentContext: { id: "main", title: "Tinybot", type: "main" },
    id: `${message.id}:${kind}:${sequence}`,
    kind,
    messageId: message.id,
    sequence,
    status: message.status === "streaming" ? "running" : message.status === "failed" ? "failed" : "completed",
    title,
    summary,
  };
}

export function subagentTimeline() {
  return createAgentTimelineModel().load("s1", [{
    timeline: {
      schemaVersion: "tinybot.timeline.v2", sessionId: "s1", turnId: "turn-subagent", snapshotRevision: 1,
      items: [{
        schemaVersion: "tinybot.turn_item.v2", sessionId: "s1", turnId: "turn-subagent",
        itemId: "delegate-1", sequence: 1, revision: 1, kind: "subagent_lifecycle",
        status: "running", createdAt: "2026-07-04T12:00:00Z", title: "Research agent",
        data: { type: "subagent_lifecycle", agentId: "delegate-1", action: "spawned",
          status: "running", name: "Research agent", task: "Read project files", message: "Inspecting source" },
      }],
    },
  }]);
}
