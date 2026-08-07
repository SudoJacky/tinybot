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
  test("exposes the current typed Tauri command surface", () => {
    expect(NATIVE_BACKEND_COMMAND_NAMES).toEqual(expect.arrayContaining([
      "worker_submit_thread_turn",
      "worker_submit_thread_form",
      "worker_thread_read",
      "worker_thread_resume",
      "worker_threads_list",
      "worker_thread_activity",
      "worker_thread_status",
      "worker_thread_update_metadata",
      "worker_thread_agent_registry",
      "worker_thread_start_turn",
      "worker_thread_continue_turn",
      "worker_thread_interrupt",
      "worker_thread_apply_op",
      "thread_list_turns",
      "thread_get_turn_runtime_state",
      "thread_get_effective_capabilities",
      "worker_subagent_resume",
      "worker_plugins_list",
      "worker_plugin_install",
      "worker_plugin_prepare_migration",
      "worker_plugin_install_migration",
      "worker_plugin_set_enabled",
      "worker_plugin_uninstall",
    ]));
    for (const removedCommand of [
      "worker_run_agent",
      "worker_run_agent_input",
      "worker_cancel_agent",
      "worker_restore_agent_checkpoint",
      "worker_submit_agent_form",
    ]) {
      expect(NATIVE_BACKEND_COMMAND_NAMES).not.toContain(removedCommand);
    }
  });

  test("covers Rust-owned agent events consumed by native surfaces", () => {
    expect(NATIVE_BACKEND_AGENT_EVENT_NAMES).toEqual(expect.arrayContaining([
      "agent.delta",
      "agent.awaiting_form",
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
      "agent.form.resolution",
      "agent.message.completed",
    ]));
    expect(NATIVE_BACKEND_RUNTIME_EVENT_VISIBILITY).toMatchObject({
      "agent.turn.started": "user-visible",
      "agent.status": "user-visible",
      "agent.phase.changed": "debug",
      "agent.guidance": "status",
      "agent.form.resolution": "websocket-visible",
      "agent.message.completed": "user-visible",
    });
  });

  test("normalizes Rust event envelopes while preserving payloads", () => {
    const payload = { turnId: "turn-1", delta: "hello" };
    const envelope = {
      sessionId: "WebSocket:chat-1",
      turnId: "turn-1",
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
