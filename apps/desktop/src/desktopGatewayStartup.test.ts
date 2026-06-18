import { describe, expect, test, vi } from "vitest";
import { ensureGatewayReady, type GatewayRuntimeStatus } from "./desktopGatewayStartup";
import { DEFAULT_GATEWAY_CONFIG } from "./gatewayConfig";

function status(owner: GatewayRuntimeStatus["owner"], state: GatewayRuntimeStatus["state"], httpOk: boolean): GatewayRuntimeStatus {
  return {
    state,
    owner,
    http_ok: httpOk,
    gateway_http: DEFAULT_GATEWAY_CONFIG.httpBaseUrl,
    gateway_ws: DEFAULT_GATEWAY_CONFIG.wsUrl,
    command: "node workers/ts-agent-worker/src/index.ts",
    repo_root: "D:/Code/py/tinybot",
    logs: [],
    last_error: null,
  };
}

describe("desktop gateway startup", () => {
  test("uses gateway_status for native Tauri startup without probing the Python gateway", async () => {
    const reachable = status("shell", "running", true);
    const fetchFn = vi.fn();
    const invoke = vi.fn(async () => reachable);

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn,
      invoke,
      hasTauriRuntime: () => true,
    });

    expect(result).toBe(reachable);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("gateway_status");
  });

  test("attaches to an already reachable external gateway outside Tauri without runtime logs", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ token: "token-1" }), { status: 200 }));
    const invoke = vi.fn();

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn,
      invoke,
      hasTauriRuntime: () => false,
    });

    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("does not treat an incompatible 2xx bootstrap response as a Tinybot gateway", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>not tinybot</html>", { status: 200 }));

    await expect(
      ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
        fetchFn,
        invoke: vi.fn(),
        hasTauriRuntime: () => false,
      }),
    ).rejects.toThrow("bootstrap response is not valid JSON");
  });

  test("keeps startup diagnostics recoverable when gateway is offline outside Tauri", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(
      ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
        fetchFn,
        invoke: vi.fn(),
        hasTauriRuntime: () => false,
      }),
    ).rejects.toThrow("Tauri runtime commands are unavailable: connect ECONNREFUSED");
  });

  test("starts the native TS worker when Tauri reports no running backend", async () => {
    const offline = status("none", "offline", false);
    const running = status("shell", "running", false);
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status") {
        return offline;
      }
      expect(command).toBe("start_gateway");
      return running;
    });

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn: vi.fn(),
      invoke,
      hasTauriRuntime: () => true,
    });

    expect(result).toBe(running);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["gateway_status", "start_gateway"]);
  });

  test("rejects native startup when start_gateway returns a non-running status", async () => {
    const offline = status("none", "offline", false);
    const failed = status("shell", "failed", false);
    failed.last_error = "worker exited immediately";
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status") {
        return offline;
      }
      expect(command).toBe("start_gateway");
      return failed;
    });

    await expect(
      ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
        fetchFn: vi.fn(),
        invoke,
        hasTauriRuntime: () => true,
      }),
    ).rejects.toThrow("Gateway failed to start");
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["gateway_status", "start_gateway"]);
  });

  test("does not wait for Python bootstrap readiness after starting the native TS worker", async () => {
    const offline = status("none", "offline", false);
    const running = status("shell", "running", true);
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status") {
        return offline;
      }
      if (command === "start_gateway") {
        return running;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const fetchFn = vi.fn(async () => new Response("{}", { status: 503 }));

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn,
      invoke,
      hasTauriRuntime: () => true,
      delay: async () => undefined,
    });

    expect(result).toBe(running);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["gateway_status", "start_gateway"]);
  });

  test("reports native TS worker startup errors", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(status("none", "offline", false))
      .mockRejectedValueOnce(new Error("TS worker failed"));

    await expect(
      ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
        fetchFn: vi.fn(),
        invoke,
        hasTauriRuntime: () => true,
      }),
    ).rejects.toThrow("TS worker failed");
  });
});
