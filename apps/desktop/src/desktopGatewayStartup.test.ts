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
    command: "uv run tinybot gateway",
    repo_root: "D:/Code/py/tinybot",
    logs: [],
    last_error: null,
  };
}

describe("desktop gateway startup", () => {
  test("attaches to an already reachable external gateway without invoking Tauri commands", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const invoke = vi.fn();

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn,
      invoke,
      hasTauriRuntime: () => true,
    });

    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/webui/bootstrap",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(invoke).not.toHaveBeenCalled();
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

  test("uses gateway_status when Tauri reports an externally reachable gateway", async () => {
    const external = status("external", "running", true);
    const invoke = vi.fn(async (command: string) => {
      expect(command).toBe("gateway_status");
      return external;
    });

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn: vi.fn(async () => new Response("{}", { status: 503 })),
      invoke,
      hasTauriRuntime: () => true,
    });

    expect(result).toBe(external);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("starts a shell-owned gateway and waits for bootstrap readiness", async () => {
    const offline = status("none", "offline", false);
    const starting = status("shell", "starting", false);
    const running = status("shell", "running", true);
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status" && invoke.mock.calls.length === 1) {
        return offline;
      }
      if (command === "start_gateway") {
        return starting;
      }
      return running;
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
      fetchFn,
      invoke,
      hasTauriRuntime: () => true,
      delay: async () => undefined,
    });

    expect(result).toBe(running);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["gateway_status", "start_gateway", "gateway_status"]);
  });

  test("reports shell startup timeout with the last readiness error", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(status("none", "offline", false))
      .mockResolvedValueOnce(status("shell", "starting", false));
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(31_000);

    await expect(
      ensureGatewayReady(DEFAULT_GATEWAY_CONFIG, {
        fetchFn: vi.fn(async () => new Response("{}", { status: 503 })),
        invoke,
        hasTauriRuntime: () => true,
        delay: async () => undefined,
        now,
      }),
    ).rejects.toThrow("Gateway did not become ready after start_gateway. Last status: starting/shell. HTTP 503");
  });
});
