import { describe, expect, test } from "vitest";

import {
  gatewayFrameFromTransportEvent,
  outboundMessageFrame,
  streamDeltaFrame,
  usageFrame,
} from "./streamFrames";

describe("streamFrames", () => {
  test("maps outbound messages to legacy WebSocket message frames", () => {
    expect(outboundMessageFrame({
      chatId: "chat-1",
      content: "reading file",
      metadata: {
        _stream_id: "msg-tool-1",
        _progress: true,
        _tool_hint: true,
        _tool_detail: true,
        _tool_result: true,
        _tool_name: "read_file",
        _approval_status: "approved",
        _approval_id: "approval-1",
        _task_event: true,
        _task_progress: { plan_id: "plan-1", progress: { completed: 1, total: 2 } },
        _task_plan_id: "plan-1",
        _memory_references: [{ note_id: "note-1" }],
        _recent_context_references: [{ evidence_id: "ev-1" }],
      },
    })).toEqual({
      event: "message",
      chat_id: "chat-1",
      message_id: "msg-tool-1",
      text: "reading file",
      _progress: true,
      _tool_hint: true,
      _tool_detail: true,
      _tool_result: true,
      _tool_name: "read_file",
      _approval_status: "approved",
      _approval_id: "approval-1",
      _task_event: true,
      _task_progress: { plan_id: "plan-1", progress: { completed: 1, total: 2 } },
      _task_plan_id: "plan-1",
      _memory_references: [{ note_id: "note-1" }],
      _recent_context_references: [{ evidence_id: "ev-1" }],
    });
  });

  test("maps special outbound message metadata to legacy operational frames", () => {
    expect(outboundMessageFrame({
      chatId: "chat-1",
      content: "",
      metadata: {
        _browser_snapshot: true,
        image_url: "data:image/png;base64,abc",
        source_command: "opencli browser state",
      },
    })).toEqual({
      event: "browser_frame",
      chat_id: "chat-1",
      image_url: "data:image/png;base64,abc",
      source_command: "opencli browser state",
      captured_at: undefined,
    });

    expect(outboundMessageFrame({
      chatId: "chat-1",
      content: "",
      metadata: { _approval_pending: true },
    })).toEqual({
      event: "approval_pending",
      chat_id: "chat-1",
    });

    expect(outboundMessageFrame({
      chatId: "chat-1",
      content: "",
      metadata: {
        _agent_ui_event: {
          event_type: "ui.form.requested",
          payload: { form_id: "form-1" },
        },
      },
    })).toEqual({
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: "ui.form.requested",
        chat_id: "chat-1",
        payload: { form_id: "form-1" },
      },
    });
  });

  test("maps stream delta, stream end, and usage events to legacy frames", () => {
    expect(streamDeltaFrame("chat-1", "po", { _stream_id: "stream-1" })).toEqual({
      event: "delta",
      chat_id: "chat-1",
      message_id: "stream-1",
      text: "po",
      is_reasoning: false,
    });
    expect(streamDeltaFrame("chat-1", "plan", { _stream_id: "stream-1", _reasoning_delta: true })).toEqual({
      event: "delta",
      chat_id: "chat-1",
      message_id: "stream-1",
      text: "plan",
      is_reasoning: true,
    });
    expect(streamDeltaFrame("chat-1", "", {
      _stream_id: "stream-1",
      _stream_end: true,
      _resuming: true,
      _recent_context_references: [{ evidence_id: "ev-1" }],
    })).toEqual({
      event: "stream_end",
      chat_id: "chat-1",
      message_id: "stream-1",
      reason: "stop",
      resuming: true,
      _recent_context_references: [{ evidence_id: "ev-1" }],
    });
    expect(usageFrame("chat-1", {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cached_tokens: 3,
    })).toEqual({
      event: "usage",
      chat_id: "chat-1",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        cached_tokens: 3,
      },
    });
  });

  test("maps generic transport event envelopes for Rust gateway callers", () => {
    expect(gatewayFrameFromTransportEvent({
      kind: "delta",
      chatId: "chat-1",
      delta: "hello",
      metadata: { _stream_id: "stream-1" },
    })).toEqual({
      event: "delta",
      chat_id: "chat-1",
      message_id: "stream-1",
      text: "hello",
      is_reasoning: false,
    });
  });
});
