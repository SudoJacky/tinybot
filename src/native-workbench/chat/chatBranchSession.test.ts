import { describe, expect, test } from "vitest";
import { createBranchSessionDraft } from "./chatBranchSession";

describe("chat branch session continuation", () => {
  test("copies visible history and portable context while excluding runtime state", () => {
    const source = {
      sessionId: "websocket:chat-1",
      chatId: "chat-1",
      title: "查看 CloudFront 证书详情",
      messages: [
        { messageId: "m1", role: "user", content: "A" },
        { messageId: "m2", role: "assistant", content: "B" },
        { messageId: "m3", role: "assistant", content: "C" },
      ],
      portableContext: {
        workspaceRoot: "D:/Code/py/tinybot",
        provider: "openai-compatible",
        model: "deepseek-reasoner",
      },
      runtimeState: {
        queuedInputs: [{ id: "queued-1" }],
        pendingApprovals: [{ id: "approval-1" }],
        liveSubagents: [{ id: "delegate-1" }],
      },
    };

    const branch = createBranchSessionDraft(source, "m2");

    expect(branch).toEqual({
      title: "查看 CloudFront 证书详情 · 分叉",
      branchedFromSessionId: "websocket:chat-1",
      branchedFromMessageId: "m2",
      messages: [
        { messageId: "m1", role: "user", content: "A" },
        { messageId: "m2", role: "assistant", content: "B" },
      ],
      portableContext: {
        workspaceRoot: "D:/Code/py/tinybot",
        provider: "openai-compatible",
        model: "deepseek-reasoner",
      },
      runtimeState: {},
    });
    expect(source.messages).toHaveLength(3);
    expect(source.runtimeState.queuedInputs).toEqual([{ id: "queued-1" }]);
  });

  test("reports branch action unavailable when selected message is missing", () => {
    expect(() =>
      createBranchSessionDraft({
        sessionId: "websocket:chat-1",
        chatId: "chat-1",
        title: "Session",
        messages: [{ messageId: "m1", role: "user", content: "A" }],
        portableContext: {},
        runtimeState: {},
      }, "missing"),
    ).toThrow("Cannot branch from unknown message missing");
  });
});
