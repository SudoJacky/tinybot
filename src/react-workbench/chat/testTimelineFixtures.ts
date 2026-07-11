import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStep, ChatTurn } from "../../app-core/chat/chatRunModel";
import type { ReactChatMessage } from "./messageActions";

export function timelineFromReactMessages(
  sessionId: string,
  messages: ReactChatMessage[],
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
            : toolCall.status === "blocked" || toolCall.status.includes("approval")
              ? "blocked"
              : "running",
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          approvalId: toolCall.approvalId,
          approvalStatus: toolCall.approvalStatus,
          argsPreview: toolCall.argsText,
          resultPreview: toolCall.responseText || toolCall.summary,
        },
      });
    }
    if (message.text) {
      if (turn.finalMessage) {
        turn.steps.push(step(
          { ...message, id: turn.finalMessage.id },
          turn.steps.length + 1,
          "message",
          "Assistant message",
          turn.finalMessage.text,
        ));
      }
      turn.finalMessage = {
        id: message.id,
        role: "assistant",
        text: message.text,
        timestamp,
        references: message.contextReferences?.map((reference) => ({
          detail: reference.detail ?? "",
          evidenceId: reference.id,
          kind: reference.kind as "browser" | "memory" | "recent" | "reference",
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
    runRevisions: Object.fromEntries(turns.map((item, index) => [item.id, index + 1])),
    turns,
    diagnostics: [],
  };
}

function step(
  message: ReactChatMessage,
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
