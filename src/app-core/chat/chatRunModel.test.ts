import { describe, expect, test } from "vitest";
import {
  createChatRunState,
  getArtifactRef,
  backendRuntimeStatesToTurns,
  legacyMessagesToTurns,
  normalizeAgentRunRuntimeStatePayload,
  reduceAgentEvent,
  redactedPreview,
  resolveChatInspectorPanel,
  safeArtifactPreview,
  selectChatInspector,
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

  test("projects backend turn items into restored chat turns before legacy adapters are removed", () => {
    const runtimeState = normalizeAgentRunRuntimeStatePayload({
      sessionId: "WebSocket:chat-1",
      runId: "run-1",
      runtimeEvents: [],
      turnItems: [
        {
          itemId: "reasoning-1",
          sessionId: "WebSocket:chat-1",
          turnId: "run-1",
          kind: "reasoning",
          status: "completed",
          createdAt: "2026-07-03T01:00:01Z",
          summary: "Need to inspect files.",
        },
        {
          itemId: "call-read",
          sessionId: "WebSocket:chat-1",
          turnId: "run-1",
          kind: "tool_call",
          status: "completed",
          createdAt: "2026-07-03T01:00:02Z",
          updatedAt: "2026-07-03T01:00:03Z",
          title: "read_file",
          summary: "README contents",
          payload: {
            toolCallId: "call-read",
            toolName: "read_file",
            argsPreview: "{\"path\":\"README.md\"}",
            resultPreview: "README contents",
          },
        },
        {
          itemId: "approval-1",
          sessionId: "WebSocket:chat-1",
          turnId: "run-1",
          kind: "approval_request",
          status: "waiting",
          createdAt: "2026-07-03T01:00:04Z",
          title: "Run command?",
          payload: {
            approvalId: "approval-1",
            toolCallId: "call-shell",
            reason: "Needs command approval",
          },
        },
      ],
    });

    expect(runtimeState).not.toBeNull();
    const turns = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState!], [{
      role: "user",
      content: "Check the README",
      reasoningContent: "",
      timestamp: "2026-07-03T01:00:00Z",
      messageId: "user-1",
    }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "run-1",
      status: "awaiting_approval",
      userMessage: { text: "Check the README" },
    });
    expect(turns[0].steps.map((step) => [step.kind, step.title, step.status])).toEqual([
      ["reasoning", "Thinking complete", "completed"],
      ["tool_call", "read_file", "completed"],
      ["approval", "Run command?", "blocked"],
    ]);
    expect(turns[0].steps[1].toolCall).toMatchObject({
      id: "call-read",
      name: "read_file",
      resultPreview: "README contents",
    });
    expect(turns[0].steps[2].approval).toMatchObject({
      approvalId: "approval-1",
      toolCallId: "call-shell",
    });
  });

  test("restores runtime-only blocked turns with their original user prompt", () => {
    const runtimeState = normalizeAgentRunRuntimeStatePayload({
      sessionId: "WebSocket:chat-1",
      runId: "run-approval",
      runtimeEvents: [],
      turnItems: [
        {
          itemId: "run-approval:user",
          sessionId: "WebSocket:chat-1",
          turnId: "run-approval",
          kind: "user_message",
          status: "completed",
          createdAt: "2026-07-03T01:00:00Z",
          payload: {
            messageId: "user-approval",
            content: "Write the config file",
          },
        },
        {
          itemId: "approval-1",
          sessionId: "WebSocket:chat-1",
          turnId: "run-approval",
          kind: "approval_request",
          status: "waiting",
          createdAt: "2026-07-03T01:00:04Z",
          title: "Allow file write?",
          payload: {
            approvalId: "approval-1",
            reason: "Needs file write approval",
          },
        },
      ],
    });

    expect(runtimeState).not.toBeNull();
    const turns = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState!], []);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "run-approval",
      status: "awaiting_approval",
      userMessageId: "user-approval",
      userMessage: { text: "Write the config file" },
    });
    expect(turns[0].finalMessage).toBeUndefined();
  });

  test("restores runtime-only completed assistant messages without legacy final messages", () => {
    const runtimeState = normalizeAgentRunRuntimeStatePayload({
      sessionId: "WebSocket:chat-1",
      runId: "run-completed",
      runtimeEvents: [],
      turnItems: [
        {
          itemId: "run-completed:user",
          sessionId: "WebSocket:chat-1",
          turnId: "run-completed",
          kind: "user_message",
          status: "completed",
          createdAt: "2026-07-03T01:00:00Z",
          payload: {
            messageId: "user-completed",
            content: "Say hello",
          },
        },
        {
          itemId: "run-completed:assistant",
          sessionId: "WebSocket:chat-1",
          turnId: "run-completed",
          kind: "assistant_message",
          status: "completed",
          createdAt: "2026-07-03T01:00:01Z",
          payload: {
            messageId: "assistant-completed",
            content: "Hello",
          },
        },
      ],
    });

    expect(runtimeState).not.toBeNull();
    const turns = backendRuntimeStatesToTurns("WebSocket:chat-1", [runtimeState!], []);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "run-completed",
      status: "completed",
      userMessage: { text: "Say hello" },
      finalMessage: {
        id: "assistant-completed",
        text: "Hello",
      },
    });
  });

  test("orders restored runtime states by numeric millisecond timestamps", () => {
    const early = normalizeAgentRunRuntimeStatePayload({
      sessionId: "WebSocket:chat-1",
      runId: "z-run-early",
      turnItems: [{
        itemId: "z-run-early:user",
        sessionId: "WebSocket:chat-1",
        turnId: "z-run-early",
        kind: "user_message",
        status: "completed",
        createdAt: "1782961828408",
        payload: { content: "first restored prompt" },
      }],
    });
    const late = normalizeAgentRunRuntimeStatePayload({
      sessionId: "WebSocket:chat-1",
      runId: "a-run-late",
      turnItems: [{
        itemId: "a-run-late:user",
        sessionId: "WebSocket:chat-1",
        turnId: "a-run-late",
        kind: "user_message",
        status: "completed",
        createdAt: "1782961829408",
        payload: { content: "second restored prompt" },
      }],
    });

    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    const turns = backendRuntimeStatesToTurns("WebSocket:chat-1", [late!, early!], []);

    expect(turns.map((turn) => turn.id)).toEqual(["z-run-early", "a-run-late"]);
    expect(turns.map((turn) => turn.userMessage.text)).toEqual(["first restored prompt", "second restored prompt"]);
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
      ["step:turn-1:message:assistant-final", "message", "Final answer"],
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

  test("coalesces streamed message chunks and hides them once the final answer is available", () => {
    const state = createChatRunState();
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-turn-start",
      event_type: "agent.turn.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      sequence: 1,
      created_at: "2026-06-27T04:00:00.000Z",
      payload: {
        user_message: { id: "user-1", role: "user", text: "Say hello" },
        user_message_id: "user-1",
      },
    });
    for (const [index, text] of ["你", "好", "!"].entries()) {
      reduceAgentEvent(state, {
        schema_version: "tinybot.agent_event.v1",
        event_id: `event-delta-${index + 1}`,
        event_type: "message.delta",
        chat_id: "chat-1",
        session_key: "WebSocket:chat-1",
        turn_id: "turn-1",
        sequence: index + 2,
        created_at: `2026-06-27T04:00:0${index + 1}.000Z`,
        payload: {
          message_id: "assistant-stream",
          text,
        },
      });
    }
    let turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns[0].steps.filter((step) => step.kind === "message")).toHaveLength(1);
    const streamMessages = turnsToConversationMessages(turns);
    expect(streamMessages[0]).toEqual(expect.objectContaining({ turnId: "turn-1", turnStatus: "running" }));
    expect(streamMessages[1]).toEqual(expect.objectContaining({ turnId: "turn-1", turnStatus: "running" }));
    expect(turns[0].steps.find((step) => step.kind === "message")?.summary).toBe("你好!");
    expect(turnsToConversationMessages(turns)).toEqual([
      expect.objectContaining({ body: ["Say hello"], tone: "user" }),
      expect.objectContaining({ body: ["你好!"], copyable: false, tone: "assistant" }),
    ]);

    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-final",
      event_type: "message.completed",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      sequence: 5,
      created_at: "2026-06-27T04:00:04.000Z",
      payload: {
        message_id: "assistant-stream",
        text: "你好!",
      },
    });

    turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns[0].steps.filter((step) => step.kind === "message")).toHaveLength(1);
    const finalMessageBeforeTurnComplete = turnsToConversationMessages(turns)[1];
    expect(finalMessageBeforeTurnComplete).toEqual(expect.objectContaining({ copyable: true, turnId: "turn-1", turnStatus: "running" }));
    expect(turnsToConversationMessages(turns)).toEqual([
      expect.objectContaining({ body: ["Say hello"], tone: "user" }),
      expect.objectContaining({ body: ["你好!"], copyable: true, tone: "assistant" }),
    ]);
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-turn-completed",
      event_type: "agent.turn.completed",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      sequence: 6,
      created_at: "2026-06-27T04:00:05.000Z",
      payload: {},
    });

    turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turnsToConversationMessages(turns)[1]).toEqual(expect.objectContaining({ copyable: true, turnId: "turn-1", turnStatus: "completed" }));
  });

  test("stores delegated trace updates on the child agent state", () => {
    const state = createChatRunState();
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-turn-start",
      event_type: "agent.turn.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      sequence: 1,
      created_at: "2026-06-27T04:00:00.000Z",
      payload: {
        user_message: { id: "user-1", role: "user", text: "Spawn a greeter" },
        user_message_id: "user-1",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-delegate-start",
      event_type: "agent.delegate.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-delegate",
      sequence: 2,
      created_at: "2026-06-27T04:00:01.000Z",
      payload: {
        delegate_id: "delegate-1",
        delegate_type: "spawn",
        task: "Say hello",
        title: "Greeter",
        status: "running",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-delegate-trace",
      event_type: "agent.delegate.trace.updated",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-delegate",
      sequence: 3,
      created_at: "2026-06-27T04:00:02.000Z",
      payload: {
        delegate_id: "delegate-1",
        delegate_type: "spawn",
        task: "Say hello",
        title: "Greeter",
        status: "running",
        trace: {
          delegateId: "delegate-1",
          childRunId: "delegate-1",
          parentRunId: "parent-run",
          parentSessionKey: "WebSocket:chat-1",
          status: "running",
          steps: [{
            id: "tool:call-1:completed",
            kind: "tool_call",
            status: "completed",
            title: "say",
            summary: "Child tool say completed.",
            toolName: "say",
            toolCallId: "call-1",
            resultPreview: "你好",
            createdAt: "2026-06-27T04:00:02.000Z",
            updatedAt: "2026-06-27T04:00:02.000Z",
          }],
          approvals: [],
          artifacts: [],
          updatedAt: "2026-06-27T04:00:02.000Z",
        },
      },
    });

    const delegate = state.delegatedRunsBySession.get("WebSocket:chat-1")?.get("delegate-1");
    expect(delegate?.trace?.steps).toEqual([expect.objectContaining({
      id: "tool:call-1:completed",
      kind: "tool_call",
      resultPreview: "你好",
      title: "say",
    })]);
    const turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns[0].steps.filter((step) => step.kind === "delegate")).toHaveLength(1);
    const panel = resolveChatInspectorPanel(state, {
      kind: "delegate",
      sessionKey: "WebSocket:chat-1",
      turnId: "turn-1",
      stepId: "step-delegate",
      delegateId: "delegate-1",
    });
    expect(panel?.body).toContain("say");
    expect(panel?.body).toContain("你好");
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

  test("stores artifact refs lazily and resolves inspector registry panels", () => {
    const state = createChatRunState();
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "event-tool",
      event_type: "tool.call.completed",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-1",
      step_id: "step-tool",
      sequence: 1,
      created_at: "2026-06-27T04:00:01.000Z",
      payload: {
        name: "shell",
        result_preview: "ok",
        status: "completed",
        tool_call_id: "call-shell",
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
      sequence: 2,
      created_at: "2026-06-27T04:00:02.000Z",
      payload: {
        artifact: {
          fetch_path: "/api/sessions/WebSocket:chat-1/artifacts/artifact-log",
          id: "artifact-log",
          kind: "terminal_output",
          mime_type: "text/plain",
          preview: "npm test summary",
          size_bytes: 4096,
          title: "npm test",
        },
      },
    });

    expect(getArtifactRef(state, "WebSocket:chat-1", "artifact-log")).toMatchObject({
      fetchPath: "/api/sessions/WebSocket:chat-1/artifacts/artifact-log",
      preview: "npm test summary",
      sizeBytes: 4096,
    });
    selectChatInspector(state, { kind: "artifact", sessionKey: "WebSocket:chat-1", artifactId: "artifact-log" });
    expect(resolveChatInspectorPanel(state)).toMatchObject({
      kind: "artifact",
      subtitle: "terminal_output / text/plain / 4096 bytes",
      title: "npm test",
    });
    expect(resolveChatInspectorPanel(state)?.body).toBe("npm test summary");

    selectChatInspector(state, { kind: "tool_call", sessionKey: "WebSocket:chat-1", turnId: "turn-1", stepId: "step-tool", toolCallId: "call-shell" });
    expect(resolveChatInspectorPanel(state)).toMatchObject({
      kind: "tool_call",
      status: "completed",
      title: "shell",
    });

    selectChatInspector(state, { kind: "delegate", sessionKey: "WebSocket:chat-1", turnId: "turn-1", stepId: "missing", delegateId: "missing" });
    expect(resolveChatInspectorPanel(state)).toMatchObject({
      kind: "delegate",
      status: "unavailable",
      title: "Unavailable",
    });
  });

  test("replaces parent spawn tool rows with authoritative delegated run state", () => {
    const state = createChatRunState();
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "turn-start",
      event_type: "agent.turn.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-spawn",
      sequence: 1,
      created_at: "2026-06-27T04:10:00.000Z",
      payload: {
        user_message: { id: "user-1", role: "user", text: "spawn a subagent" },
        user_message_id: "user-1",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "tool-start",
      event_type: "tool.call.started",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-spawn",
      step_id: "turn-spawn:call-spawn",
      sequence: 2,
      created_at: "2026-06-27T04:10:01.000Z",
      payload: {
        args_preview: "spawn({\"task\":\"say hello\"})",
        name: "spawn",
        status: "running",
        tool_call_id: "call-spawn",
      },
    });
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "delegate-completed",
      event_type: "agent.delegate.completed",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-spawn",
      step_id: "turn-spawn:delegate:delegate-1",
      sequence: 3,
      created_at: "2026-06-27T04:10:02.000Z",
      payload: {
        delegate_id: "delegate-1",
        delegate_type: "spawn",
        final_output: "你好",
        latest_activity: "child final result",
        status: "completed",
        task: "请用中文说一句\"你好\"",
        title: "打招呼",
        tool_call_id: "call-spawn",
        tool_name: "spawn",
        trace_ref: "trace-1",
      },
    });

    const turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns[0]?.steps).toHaveLength(1);
    expect(turns[0]?.steps[0]).toMatchObject({
      id: "turn-spawn:call-spawn",
      kind: "delegate",
      status: "completed",
      delegate: {
        finalOutput: "你好",
        parentToolCallId: "call-spawn",
        task: "请用中文说一句\"你好\"",
        toolName: "spawn",
      },
    });

    const messages = turnsToConversationMessages(turns);
    const activity = messages.flatMap((message) => message.toolActivities ?? [])[0];
    expect(activity).toMatchObject({
      id: "call-spawn",
      kind: "result",
      name: "spawn",
      responseText: "child final result",
      status: "completed",
    });
    expect(activity?.argsText).toContain("请用中文说一句");
    expect(activity?.argsText).not.toBe("No delegated task available");

    selectChatInspector(state, {
      kind: "delegate",
      delegateId: "delegate-1",
      sessionKey: "WebSocket:chat-1",
      stepId: "turn-spawn:call-spawn",
      turnId: "turn-spawn",
    });
    expect(resolveChatInspectorPanel(state)).toMatchObject({
      body: expect.stringContaining("Trace: trace-1"),
      kind: "delegate",
      status: "completed",
      title: "打招呼",
    });
  });

  test("replays interrupted delegated runs as cancelled steps", () => {
    const state = createChatRunState();
    reduceAgentEvent(state, {
      schema_version: "tinybot.agent_event.v1",
      event_id: "delegate-interrupted",
      event_type: "agent.delegate.interrupted",
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-spawn",
      step_id: "turn-spawn:delegate:delegate-1",
      sequence: 1,
      created_at: "2026-06-27T04:10:02.000Z",
      payload: {
        delegate_id: "delegate-1",
        delegate_type: "spawn",
        latest_activity: "Delegated run interrupted.",
        status: "cancelled",
        task: "long review",
        title: "Long review",
        trace_ref: "trace-1",
      },
    });

    const turns = state.turnsBySession.get("WebSocket:chat-1") ?? [];
    expect(turns[0]?.steps[0]).toMatchObject({
      kind: "delegate",
      status: "cancelled",
      delegate: {
        id: "delegate-1",
        status: "cancelled",
      },
    });
  });

  test("replays approval, failure, interruption, form, browser, file diff, and delegate variants", () => {
    const state = createChatRunState();
    const base = {
      schema_version: "tinybot.agent_event.v1" as const,
      chat_id: "chat-1",
      session_key: "WebSocket:chat-1",
      turn_id: "turn-rich",
      created_at: "2026-06-27T04:00:00.000Z",
    };
    reduceAgentEvent(state, {
      ...base,
      event_id: "turn-updated",
      event_type: "agent.turn.updated",
      sequence: 1,
      payload: { status: "awaiting_form" },
    });
    reduceAgentEvent(state, {
      ...base,
      event_id: "approval-requested",
      event_type: "approval.requested",
      step_id: "step-approval",
      sequence: 2,
      payload: {
        actions: ["approveOnce", "deny"],
        approval_id: "approval-1",
        risk_level: "medium",
        title: "Run shell",
        tool_call_id: "call-shell",
      },
    });
    reduceAgentEvent(state, {
      ...base,
      event_id: "form-requested",
      event_type: "ui.form.requested",
      step_id: "step-form",
      sequence: 3,
      payload: { form: { title: "Travel preferences" } },
    });
    for (const [index, delegateType] of ["spawn", "subagent", "cowork", "team"].entries()) {
      reduceAgentEvent(state, {
        ...base,
        event_id: `delegate-${delegateType}`,
        event_type: index === 3 ? "agent.delegate.completed" : "agent.delegate.started",
        step_id: `step-${delegateType}`,
        sequence: 4 + index,
        payload: {
          agent_count: index + 1,
          artifacts: [{ id: `artifact-${delegateType}`, kind: "markdown", preview: `${delegateType} notes`, title: `${delegateType} notes` }],
          delegate_id: delegateType,
          delegate_type: delegateType,
          final_output: index === 3 ? "Team finished" : "",
          latest_activity: `${delegateType} active`,
          status: index === 3 ? "completed" : "running",
          task: `${delegateType} task`,
          workflow: "review",
        },
      });
    }
    reduceAgentEvent(state, {
      ...base,
      event_id: "browser-artifact",
      event_type: "artifact.created",
      step_id: "step-browser",
      sequence: 9,
      payload: { artifact: { id: "browser-1", kind: "browser_snapshot", preview: "data:image/png;base64,x", title: "Browser snapshot" } },
    });
    reduceAgentEvent(state, {
      ...base,
      event_id: "diff-artifact",
      event_type: "artifact.created",
      step_id: "step-diff",
      sequence: 10,
      payload: { artifact: { id: "diff-1", kind: "file_diff", preview: "-old\n+new", title: "Patch" } },
    });
    reduceAgentEvent(state, {
      ...base,
      event_id: "turn-failed",
      event_type: "agent.turn.failed",
      step_id: "step-error",
      sequence: 11,
      payload: { error: { message: "boom" } },
    });
    reduceAgentEvent(state, {
      ...base,
      event_id: "turn-interrupted",
      event_type: "agent.turn.interrupted",
      sequence: 12,
      payload: {},
    });

    const turn = state.turnsBySession.get("WebSocket:chat-1")?.[0];
    expect(turn?.status).toBe("interrupted");
    expect(turn?.steps.map((step) => step.kind)).toEqual([
      "approval",
      "form",
      "delegate",
      "delegate",
      "delegate",
      "delegate",
      "artifact",
      "artifact",
      "error",
    ]);
    expect(turn?.steps.filter((step) => step.kind === "delegate").map((step) => step.delegate?.type)).toEqual(["spawn", "subagent", "cowork", "team"]);
    expect(getArtifactRef(state, "WebSocket:chat-1", "artifact-team")).toMatchObject({ kind: "markdown", preview: "team notes" });
    expect(getArtifactRef(state, "WebSocket:chat-1", "browser-1")).toMatchObject({ kind: "browser_snapshot" });
    expect(getArtifactRef(state, "WebSocket:chat-1", "diff-1")).toMatchObject({ kind: "file_diff" });
    selectChatInspector(state, { kind: "approval", sessionKey: "WebSocket:chat-1", turnId: "turn-rich", stepId: "step-approval", approvalId: "approval-1" });
    expect(resolveChatInspectorPanel(state)).toMatchObject({
      kind: "approval",
      subtitle: "approval-1",
      title: "Run shell",
    });
  });
});
