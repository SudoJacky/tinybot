import { describe, expect, test } from "vitest";
import {
  isNativeBackendEventEnvelope,
  NATIVE_BACKEND_AGENT_EVENT_NAMES,
  NATIVE_BACKEND_COMMAND_NAMES,
  NATIVE_BACKEND_RUNTIME_EVENT_VISIBILITY,
  normalizeNativeBackendEventPayload,
  type NativeBackendRuntimeStatus,
} from "./nativeBackendContract";

describe("native backend contract", () => {
  test("keeps the existing Tauri command names as compatibility entry points", () => {
    expect(NATIVE_BACKEND_COMMAND_NAMES).toEqual(expect.arrayContaining([
      "worker_run_agent",
      "worker_cancel_agent",
      "worker_restore_agent_checkpoint",
      "worker_submit_agent_form",
      "worker_resume_agent_approval",
    ]));
  });

  test("covers Rust-owned agent events consumed by native surfaces", () => {
    expect(NATIVE_BACKEND_AGENT_EVENT_NAMES).toEqual(expect.arrayContaining([
      "agent.delta",
      "agent.awaiting_form",
      "agent.awaiting_approval",
      "agent.delegate.trace.updated",
      "agent.browser_frame",
      "heartbeat.delivery",
      "diagnostics.log",
      "worker.status",
    ]));
  });

  test("covers canonical runtime events and their visibility classes", () => {
    expect(NATIVE_BACKEND_AGENT_EVENT_NAMES).toEqual(expect.arrayContaining([
      "agent.turn.started",
      "agent.status",
      "agent.phase.changed",
      "agent.guidance",
      "agent.approval.decision",
      "agent.form.resolution",
      "agent.message.completed",
    ]));
    expect(NATIVE_BACKEND_RUNTIME_EVENT_VISIBILITY).toMatchObject({
      "agent.turn.started": "user-visible",
      "agent.status": "user-visible",
      "agent.phase.changed": "debug",
      "agent.guidance": "status",
      "agent.approval.decision": "websocket-visible",
      "agent.form.resolution": "websocket-visible",
      "agent.message.completed": "user-visible",
    });
  });

  test("normalizes Rust event envelopes while preserving payloads", () => {
    const payload = { runId: "run-1", delta: "hello" };
    const envelope = {
      sessionId: "WebSocket:chat-1",
      runId: "run-1",
      traceId: "trace-1",
      eventName: "agent.delta",
      timestamp: "2026-06-29T14:30:00.000Z",
      source: "rust_backend",
      payload,
    } as const;

    expect(isNativeBackendEventEnvelope(envelope)).toBe(true);
    expect(normalizeNativeBackendEventPayload(envelope)).toBe(payload);
    expect(normalizeNativeBackendEventPayload(payload)).toBe(payload);
  });

  test("models Rust backend ownership", () => {
    const status: NativeBackendRuntimeStatus = {
      backendKind: "rust",
      backendLabel: "rust",
    };

    expect(status.backendKind).toBe("rust");
    expect(status.backendLabel).toBe("rust");
  });
});
