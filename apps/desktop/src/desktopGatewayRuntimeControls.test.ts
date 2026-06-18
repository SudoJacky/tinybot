import { describe, expect, test } from "vitest";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeRows,
  runDesktopGatewayRuntimeCommand,
} from "./desktopGatewayRuntimeControls";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";

describe("desktop gateway runtime controls", () => {
  test("projects ownership, command, port, repo root, logs, errors, and exit policy", () => {
    const status: GatewayRuntimeStatus = {
      state: "starting",
      owner: "shell",
      http_ok: false,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: ["stdout: booting", "stderr: warning", "stdout: listening"],
      last_error: "HTTP 503",
      exit_policy: "stop_on_exit",
    };

    expect(buildDesktopGatewayRuntimeRows(status, "http://127.0.0.1:18790")).toEqual([
      { label: "State", value: "Starting" },
      { label: "Owner", value: "Shell-owned" },
      { label: "Command", value: "node workers/ts-agent-worker/src/index.ts" },
      { label: "Port", value: "18790" },
      { label: "Repo root", value: "D:/Code/py/tinybot" },
      { label: "Recent logs", value: "stdout: booting\nstderr: warning\nstdout: listening" },
      { label: "Last error", value: "HTTP 503" },
      { label: "Exit policy", value: "Stop native TS backend on exit" },
    ]);
  });

  test("exposes only ownership-safe runtime actions", () => {
    const baseStatus: GatewayRuntimeStatus = {
      state: "running",
      owner: "external",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: ["external gateway reachable"],
      last_error: null,
      exit_policy: "stop_on_exit",
    };

    expect(buildDesktopGatewayRuntimeActions(baseStatus).map((action) => action.id)).toEqual([
      "copyDiagnostics",
      "openLogs",
    ]);
    expect(buildDesktopGatewayRuntimeActions({ ...baseStatus, owner: "shell" }).map((action) => action.id)).toEqual([
      "stop",
      "restart",
      "keepRunningOnExit",
      "copyDiagnostics",
      "openLogs",
    ]);
    expect(buildDesktopGatewayRuntimeActions({
      ...baseStatus,
      state: "offline",
      owner: "none",
      http_ok: false,
      last_error: "connection refused",
    }).map((action) => action.id)).toEqual([
      "start",
      "retry",
      "copyDiagnostics",
      "openLogs",
    ]);
  });

  test("runs lifecycle commands with ownership guards", async () => {
    const status: GatewayRuntimeStatus = {
      state: "running",
      owner: "shell",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: [],
      last_error: null,
      exit_policy: "stop_on_exit",
    };
    const commands: string[] = [];
    const nextStatus = { ...status, state: "starting" as const };

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

  test("toggles native TS backend exit policy through a persisted runtime command", async () => {
    const status: GatewayRuntimeStatus = {
      state: "running",
      owner: "shell",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: [],
      last_error: null,
      exit_policy: "stop_on_exit",
    };
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
        return { ...status, exit_policy: "stop_on_exit" };
      },
    });

    expect(calls).toEqual([
      { command: "set_gateway_keep_running", payload: { keep_running: true } },
      { command: "set_gateway_keep_running", payload: { keep_running: false } },
    ]);
  });

  test("explains incompatible bootstrap responses with recovery guidance", () => {
    const status: GatewayRuntimeStatus = {
      state: "failed",
      owner: "none",
      http_ok: false,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: [],
      last_error: "Port 18790 is occupied by an incompatible service",
      exit_policy: "stop_on_exit",
      bootstrap_status: "incompatible",
      response_class: "incompatible-bootstrap",
      recovery_hint: "Stop the conflicting process on port 18790, then retry Tinybot gateway startup.",
    };

    expect(buildDesktopGatewayRuntimeRows(status, "http://127.0.0.1:18790")).toEqual(expect.arrayContaining([
      { label: "Bootstrap", value: "Incompatible" },
      { label: "Response class", value: "incompatible-bootstrap" },
      { label: "Recovery", value: "Stop the conflicting process on port 18790, then retry Tinybot gateway startup." },
    ]));
    expect(buildDesktopGatewayRuntimeActions(status).map((action) => action.id)).toContain("retry");
  });

  test("projects worker runtime state and diagnostics without changing gateway actions", () => {
    const status: GatewayRuntimeStatus = {
      state: "running",
      owner: "external",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: [],
      last_error: null,
      exit_policy: "stop_on_exit",
      worker_runtime: {
        state: "running",
        transport_mode: "stdio",
        diagnostics: [
          { stream: "stdout", line: "worker ready" },
          { stream: "stderr", line: "worker warning" },
        ],
        last_error: null,
        recovery_hint: null,
        gateway_compatibility_available: true,
      },
    };

    expect(buildDesktopGatewayRuntimeRows(status, "http://127.0.0.1:18790")).toEqual(expect.arrayContaining([
      { label: "Worker", value: "Running via stdio" },
      { label: "Worker diagnostics", value: "stdout: worker ready\nstderr: worker warning" },
      { label: "Gateway compatibility", value: "Available" },
    ]));
    expect(buildDesktopGatewayRuntimeActions(status).map((action) => action.id)).toEqual([
      "copyDiagnostics",
      "openLogs",
    ]);
  });
});
