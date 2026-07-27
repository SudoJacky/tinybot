import { describe, expect, test } from "vitest";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeRows,
  runDesktopGatewayRuntimeCommand,
} from "./desktopGatewayRuntimeControls";
import { DEFAULT_NATIVE_BACKEND_COMMAND, type GatewayRuntimeStatus } from "./desktopGatewayRuntime";

function runtimeStatus(overrides: Partial<GatewayRuntimeStatus> = {}): GatewayRuntimeStatus {
  return {
    state: "running",
    owner: "shell",
    command: DEFAULT_NATIVE_BACKEND_COMMAND,
    repo_root: "D:/Code/tinybot/tinybot",
    logs: [],
    last_error: null,
    exit_policy: "stop_on_exit",
    ...overrides,
  };
}

describe("desktop gateway runtime controls", () => {
  test("projects native runtime state without nonexistent network endpoint fields", () => {
    const status = runtimeStatus({
      state: "starting",
      logs: ["stdout: booting", "stderr: warning", "stdout: ready"],
      last_error: "Runtime unavailable",
    });

    expect(buildDesktopGatewayRuntimeRows(status)).toEqual([
      { label: "State", value: "Starting" },
      { label: "Owner", value: "Shell-owned" },
      { label: "Command", value: DEFAULT_NATIVE_BACKEND_COMMAND },
      { label: "Repo root", value: "D:/Code/tinybot/tinybot" },
      { label: "Recent logs", value: "stdout: booting\nstderr: warning\nstdout: ready" },
      { label: "Last error", value: "Runtime unavailable" },
      { label: "Exit policy", value: "Stop native backend on exit" },
    ]);
  });

  test("exposes only ownership-safe runtime actions", () => {
    const external = runtimeStatus({ owner: "external" });

    expect(buildDesktopGatewayRuntimeActions(external).map((action) => action.id)).toEqual([
      "copyDiagnostics",
      "openLogs",
    ]);
    expect(buildDesktopGatewayRuntimeActions({ ...external, owner: "shell" }).map((action) => action.id)).toEqual([
      "stop",
      "restart",
      "keepRunningOnExit",
      "copyDiagnostics",
      "openLogs",
    ]);
    expect(buildDesktopGatewayRuntimeActions({
      ...external,
      state: "offline",
      owner: "none",
      last_error: "runtime stopped",
    }).map((action) => action.id)).toEqual([
      "start",
      "retry",
      "copyDiagnostics",
      "openLogs",
    ]);
  });

  test("runs lifecycle commands with ownership guards", async () => {
    const status = runtimeStatus();
    const commands: string[] = [];
    const nextStatus = runtimeStatus({ state: "starting" });

    await runDesktopGatewayRuntimeCommand("restart", status, {
      runCommand: async (command) => {
        commands.push(command);
        return nextStatus;
      },
    });
    await runDesktopGatewayRuntimeCommand("restart", { ...status, owner: "external" }, {
      runCommand: async (command) => {
        commands.push(command);
        return nextStatus;
      },
    });

    expect(commands).toEqual(["stop_gateway", "start_gateway"]);
  });

  test("toggles native backend exit policy through a persisted runtime command", async () => {
    const status = runtimeStatus();
    const calls: Array<{ command: string; payload?: unknown }> = [];

    await runDesktopGatewayRuntimeCommand("keepRunningOnExit", status, {
      runCommand: async (command, payload) => {
        calls.push({ command, payload });
        return { ...status, exit_policy: "keep_running" };
      },
    });
    await runDesktopGatewayRuntimeCommand("stopOnExit", { ...status, exit_policy: "keep_running" }, {
      runCommand: async (command, payload) => {
        calls.push({ command, payload });
        return status;
      },
    });

    expect(calls).toEqual([
      { command: "set_gateway_keep_running", payload: { keep_running: true } },
      { command: "set_gateway_keep_running", payload: { keep_running: false } },
    ]);
  });

  test("projects bootstrap diagnostics without reconstructing an HTTP endpoint", () => {
    const status = runtimeStatus({
      state: "failed",
      owner: "none",
      last_error: "Native runtime startup failed",
      bootstrap_status: "incompatible",
      response_class: "incompatible-runtime",
      recovery_hint: "Restart the desktop runtime and try again.",
    });

    expect(buildDesktopGatewayRuntimeRows(status)).toEqual(expect.arrayContaining([
      { label: "Bootstrap", value: "Incompatible" },
      { label: "Response class", value: "incompatible-runtime" },
      { label: "Recovery", value: "Restart the desktop runtime and try again." },
    ]));
    expect(buildDesktopGatewayRuntimeActions(status).map((action) => action.id)).toContain("retry");
  });

  test("projects worker runtime state and diagnostics without changing runtime actions", () => {
    const status = runtimeStatus({
      owner: "external",
      worker_runtime: {
        state: "running",
        transport_mode: "stdio",
        diagnostics: [
          { stream: "stdout", line: "worker ready" },
          { stream: "stderr", line: "worker warning" },
        ],
        last_error: null,
        recovery_hint: null,
      },
    });

    expect(buildDesktopGatewayRuntimeRows(status)).toEqual(expect.arrayContaining([
      { label: "Rust backend", value: "Running via stdio" },
      { label: "Rust diagnostics", value: "stdout: worker ready\nstderr: worker warning" },
    ]));
    expect(buildDesktopGatewayRuntimeActions(status).map((action) => action.id)).toEqual([
      "copyDiagnostics",
      "openLogs",
    ]);
  });
});
