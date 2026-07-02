import { describe, expect, test } from "vitest";
import {
  CHAT_RUNTIME_CAPABILITY_AUDIT,
  CHAT_SURFACE_OWNERSHIP,
  createEmptyChatDetailPanelState,
  projectNativeChatState,
  type QueuedInput,
} from "./chatUiProjection";
import {
  createNativeChatState,
  setMessages,
  setSessions,
  type NativeChatMessage,
} from "./nativeChat";

describe("chat UI projection", () => {
  test("records current Rust desktop runtime capabilities for the rebuild adapter", () => {
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.sessions.status).toBe("available");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.messages.status).toBe("available");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.runInput.status).toBe("available");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.approvalResume.status).toBe("route");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.subagentTranscript.status).toBe("partial");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.branchSession.status).toBe("missing");
    expect(CHAT_RUNTIME_CAPABILITY_AUDIT.legacyConversationThread.status).toBe("frozen");
    expect(CHAT_SURFACE_OWNERSHIP.legacyConversationThread.allowedChanges).toEqual([
      "compatibility",
      "fallback",
      "adapter",
      "entry-switch",
    ]);
    expect(CHAT_SURFACE_OWNERSHIP.newProductBehaviorTarget).toBe("new-chat-surface");
  });

  test("projects sessions, turns, tool summaries, approvals, subagents, queue, and branch metadata", () => {
    const state = createNativeChatState();
    setSessions(state, [
      {
        key: "websocket:chat-1",
        chatId: "chat-1",
        title: "Investigate IAM certificate",
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: "2026-07-01T10:05:00Z",
      },
    ]);
    state.activeSessionKey = "websocket:chat-1";
    state.activeChatId = "chat-1";
    state.respondingSessionKeys.add("websocket:chat-1");
    setMessages(state, "websocket:chat-1", fixtureMessages());

    const queuedInputs: QueuedInput[] = [{
      id: "queued-1",
      mode: "queued",
      content: "After this, summarize the decision.",
      createdAt: "2026-07-01T10:06:00Z",
      status: "queued",
    }];

    const projection = projectNativeChatState(state, {
      queuedInputsBySession: new Map([["websocket:chat-1", queuedInputs]]),
      detailPanel: createEmptyChatDetailPanelState(),
    });

    expect(projection.sessions).toEqual([{
      key: "websocket:chat-1",
      chatId: "chat-1",
      title: "Investigate IAM certificate",
      createdAt: "2026-07-01T10:00:00Z",
      updatedAt: "2026-07-01T10:05:00Z",
      primaryBadge: "waiting_approval",
      isActive: true,
    }]);
    expect(projection.activeSessionKey).toBe("websocket:chat-1");
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[1]).toMatchObject({
      id: "m-assistant",
      role: "assistant",
      content: "I need approval before writing.",
      process: {
        state: "waiting_approval",
        summary: "Execution process · 3 tools",
        toolCount: 3,
      },
    });
    expect(projection.turns[1].tools).toEqual([
      {
        id: "call-read",
        name: "workspace.read_file",
        status: "completed",
        preview: "README contents",
        argsPreview: "{\"path\":\"README.md\"}",
        resultPreview: "README contents",
        detail: {
          argsText: "{\"path\":\"README.md\"}",
          responseText: "README contents",
          rawEvent: undefined,
          stdout: "",
          stderr: "",
        },
        kind: "result",
      },
      {
        id: "approval-1",
        name: "workspace.write_file",
        status: "waiting_approval",
        preview: "Needs approval",
        argsPreview: "{\"path\":\"notes.md\"}",
        resultPreview: "Needs approval",
        detail: {
          argsText: "{\"path\":\"notes.md\"}",
          responseText: "Needs approval",
          rawEvent: undefined,
          stdout: "",
          stderr: "",
        },
        kind: "result",
        approvalId: "approval-1",
      },
      {
        id: "delegate-1",
        name: "subagent.wait",
        status: "running",
        preview: "checking docs",
        argsPreview: "",
        resultPreview: "checking docs",
        detail: {
          argsText: "",
          responseText: "checking docs",
          rawEvent: undefined,
          stdout: "",
          stderr: "",
        },
        kind: "result",
        delegateId: "delegate-1",
      },
    ]);
    expect(projection.approvals).toEqual([{
      id: "approval-1",
      sessionKey: "websocket:chat-1",
      toolName: "workspace.write_file",
      status: "pending",
      scopeKey: "filesystem.write:workspace",
      scopeLabel: "Allow workspace writes for this session",
      prompt: "Needs approval",
      choices: ["allow_once", "allow_session", "deny"],
    }]);
    expect(projection.liveSubagents).toEqual([{
      id: "delegate-1",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Check docs",
      status: "running",
      latestActivity: "checking docs",
      capabilities: ["partial_transcript", "can_forward"],
      transcript: {
        id: "delegate-1",
        sessionKey: "websocket:chat-1",
        capability: "partial_transcript",
        messages: [],
        toolSummaries: [{
          id: "delegate-1",
          name: "subagent.wait",
          status: "running",
          preview: "checking docs",
        }],
      },
    }]);
    expect(projection.queuedInputs).toEqual(queuedInputs);
    expect(projection.branchSource).toEqual({
      canBranchSession: true,
      portableContextKeys: ["chatId", "sessionKey"],
      runtimeStateExcluded: true,
    });
    expect(projection.detailPanel).toEqual({
      kind: "none",
      open: false,
      presentation: "drawer",
    });
  });

  test("treats blocked tool activities with approval IDs as waiting approval", () => {
    const state = createNativeChatState();
    setSessions(state, [{
      key: "websocket:chat-approval",
      chatId: "chat-approval",
      title: "Approval required",
      createdAt: "2026-07-01T11:00:00Z",
      updatedAt: "2026-07-01T11:01:00Z",
    }]);
    state.activeSessionKey = "websocket:chat-approval";
    state.activeChatId = "chat-approval";
    setMessages(state, "websocket:chat-approval", [{
      role: "assistant",
      content: "I need approval.",
      reasoningContent: "",
      timestamp: "2026-07-01T11:01:00Z",
      messageId: "m-approval",
      toolActivities: [{
        id: "tool-blocked",
        approvalId: "approval-blocked",
        name: "workspace.write_file",
        argsText: "{\"path\":\"notes.md\"}",
        responseText: "Needs approval",
        kind: "result",
        status: "blocked",
      }],
    }]);

    const projection = projectNativeChatState(state);

    expect(projection.sessions[0].primaryBadge).toBe("waiting_approval");
    expect(projection.turns[0].tools[0].status).toBe("waiting_approval");
    expect(projection.approvals).toEqual([{
      id: "approval-blocked",
      sessionKey: "websocket:chat-approval",
      toolName: "workspace.write_file",
      status: "pending",
      scopeKey: "filesystem.write:workspace",
      scopeLabel: "Allow workspace writes for this session",
      prompt: "Needs approval",
      choices: ["allow_once", "allow_session", "deny"],
    }]);
  });
});

function fixtureMessages(): NativeChatMessage[] {
  return [
    {
      role: "user",
      content: "Please inspect the certificate setup.",
      reasoningContent: "",
      timestamp: "2026-07-01T10:01:00Z",
      messageId: "m-user",
    },
    {
      role: "assistant",
      content: "I need approval before writing.",
      reasoningContent: "Checking workspace policy.",
      timestamp: "2026-07-01T10:02:00Z",
      messageId: "m-assistant",
      toolActivities: [
        {
          id: "call-read",
          name: "workspace.read_file",
          argsText: "{\"path\":\"README.md\"}",
          responseText: "README contents",
          kind: "result",
          status: "completed",
        },
        {
          id: "approval-1",
          approvalId: "approval-1",
          name: "workspace.write_file",
          argsText: "{\"path\":\"notes.md\"}",
          responseText: "Needs approval",
          kind: "result",
          approvalStatus: "pending",
          status: "waiting_approval",
        },
        {
          id: "delegate-1",
          name: "subagent.wait",
          argsText: "",
          responseText: "checking docs",
          kind: "result",
          status: "running",
          delegateId: "delegate-1",
          delegateTitle: "Researcher",
          delegateTask: "Check docs",
        },
      ],
    },
  ];
}
