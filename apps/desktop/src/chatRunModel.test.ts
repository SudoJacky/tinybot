import { describe, expect, test } from "vitest";
import {
  createChatRunState,
  legacyMessagesToTurns,
  reduceAgentEvent,
  redactedPreview,
  safeArtifactPreview,
  turnsToConversationMessages,
} from "./chatRunModel";
import type { NativeChatMessage } from "./nativeChat";

describe("chat run model", () => {
  test("converts legacy messages into turns with separate process steps and final answer", () => {
    const messages: NativeChatMessage[] = [
      {
        role: "user",
        content: "List the workspace",
        reasoningContent: "",
        timestamp: "2026-06-27T04:00:00.000Z",
        messageId: "user-1",
      },
      {
        role: "assistant",
        content: "",
        reasoningContent: "I should inspect the workspace.",
        toolActivities: [{
          argsText: "{\"path\":\".\"}",
          id: "call-list",
          kind: "call",
          name: "list_dir",
          responseText: "",
          status: "running",
        }],
        timestamp: "2026-06-27T04:00:01.000Z",
        messageId: "assistant-tools",
      },
      {
        role: "assistant",
        content: "The workspace contains apps and tests.",
        reasoningContent: "I have enough context.",
        references: [{ detail: "workspace", kind: "reference", title: "." }],
        timestamp: "2026-06-27T04:00:02.000Z",
        messageId: "assistant-final",
      },
    ];

    const turns = legacyMessagesToTurns("WebSocket:chat-1", messages);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "turn:WebSocket:chat-1:user-1",
      sessionKey: "WebSocket:chat-1",
      userMessageId: "user-1",
      status: "completed",
      finalMessage: {
        id: "assistant-final",
        text: "The workspace contains apps and tests.",
      },
    });
    expect(turns[0].steps.map((step) => [step.kind, step.title, step.status])).toEqual([
      ["reasoning", "Thinking", "completed"],
      ["tool_call", "list_dir", "running"],
      ["reasoning", "Thinking complete", "completed"],
    ]);
    expect(turns[0].steps[1].toolCall).toMatchObject({
      id: "call-list",
      argsPreview: "{\"path\":\".\"}",
      name: "list_dir",
    });
  });

  test("replays structured events with deduplication, delegated workflows, and artifacts", () => {
    const state = createChatRunState();
    const started = {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-turn-start",
      event_type: "agent.turn.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      sequence: 1,
      created_at: "2026-06-27T04:00:00.000Z",
      payload: {
        user_message: { id: "user-1", role: "user", text: "Run tests" },
        user_message_id: "user-1",
        title: "Run tests",
      },
    } as const;

    reduceAgentEvent(state, started);
    reduceAgentEvent(state, started);
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-tool-start",
      event_type: "tool.call.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-tool",
      sequence: 2,
      created_at: "2026-06-27T04:00:01.000Z",
      payload: {
        args_json: { command: "npm test", token: "secret-token" },
        name: "shell",
        status: "running",
        tool_call_id: "call-shell",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-delegate",
      event_type: "agent.delegate.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-delegate",
      sequence: 3,
      created_at: "2026-06-27T04:00:02.000Z",
      payload: {
        agent_context: { id: "cowork-1", title: "Cowork", type: "cowork" },
        delegate_id: "cowork-1",
        delegate_type: "cowork",
        task: "Review implementation",
        title: "Review implementation",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-artifact",
      event_type: "artifact.created",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-tool",
      sequence: 4,
      created_at: "2026-06-27T04:00:03.000Z",
      payload: {
        artifact: {
          id: "artifact-output",
          kind: "terminal_output",
          mimeType: "text/plain",
          preview: "npm test output",
          sizeBytes: 1200,
          title: "npm test",
        },
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-final",
      event_type: "message.completed",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-final",
      sequence: 5,
      created_at: "2026-06-27T04:00:04.000Z",
      payload: {
        message_id: "assistant-final",
        role: "assistant",
        text: "Tests passed.",
      },
    });

    const turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns).toHaveLength(1);
    expect(state.appliedEventIds.size).toBe(5);
    expect(turns[0].steps.map((step) => [step.id, step.kind, step.title])).toEqual([
      ["step-tool", "tool_call", "shell"],
      ["step-delegate", "delegate", "Review implementation"],
      ["step-final", "message", "Final answer"],
    ]);
    expect(turns[0].steps[0].toolCall?.argsJson).toEqual({ command: "npm test", token: "[redacted]" });
    expect(turns[0].steps[0].artifacts).toEqual([{
      id: "artifact-output",
      kind: "terminal_output",
      mimeType: "text/plain",
      preview: "npm test output",
      sizeBytes: 1200,
      status: "available",
      title: "npm test",
    }]);
    expect(turns[0].steps[1].delegate).toMatchObject({
      id: "cowork-1",
      type: "cowork",
      task: "Review implementation",
    });
    expect(turns[0].finalMessage?.text).toBe("Tests passed.");
  });

  test("builds legacy conversation messages and keeps final answer copy separate", () => {
    const turns = legacyMessagesToTurns("WebSocket:chat-1", [
      {
        role: "user",
        content: "Summarize",
        reasoningContent: "",
        timestamp: "2026-06-27T04:00:00.000Z",
        messageId: "user-1",
      },
      {
        role: "assistant",
        content: "",
        reasoningContent: "hidden raw chain",
        timestamp: "2026-06-27T04:00:01.000Z",
        messageId: "reasoning-1",
      },
      {
        role: "assistant",
        content: "Final only",
        reasoningContent: "do not copy",
        timestamp: "2026-06-27T04:00:02.000Z",
        messageId: "final-1",
      },
    ]);

    const view = turnsToConversationMessages(turns);

    expect(view).toEqual([
      expect.objectContaining({ body: ["Summarize"], tone: "user" }),
      expect.objectContaining({ body: [], reasoningContent: "hidden raw chain", tone: "assistant" }),
      expect.objectContaining({ body: [], reasoningContent: "do not copy", tone: "assistant" }),
      expect.objectContaining({ body: ["Final only"], copyable: true, reasoningContent: "", tone: "assistant" }),
    ]);
  });

  test("redacts sensitive fields and renders unsafe artifact payloads inertly", () => {
    expect(redactedPreview({
      authorization: "Bearer abc",
      nested: { private_key: "key", safe: "value" },
      token: "secret",
    })).toBe("{\"authorization\":\"[redacted]\",\"nested\":{\"private_key\":\"[redacted]\",\"safe\":\"value\"},\"token\":\"[redacted]\"}");

    expect(safeArtifactPreview({
      html: "<button onclick=\"steal()\">Run</button>",
      onClick: "steal()",
      script: "alert(1)",
      text: "Visible",
    })).toBe("{\"html\":\"[unsafe omitted]\",\"onClick\":\"[unsafe omitted]\",\"script\":\"[unsafe omitted]\",\"text\":\"Visible\"}");
  });
});
