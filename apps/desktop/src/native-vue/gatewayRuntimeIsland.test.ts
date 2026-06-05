// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountGatewayRuntimeIsland } from "./gatewayRuntimeIsland";
import type { GatewayRuntimeStatus } from "../desktopGatewayStartup";

describe("gateway runtime Vue island", () => {
  test("mounts Naive UI runtime rows and routes shell-owned actions", () => {
    const host = document.createElement("section");
    const actions: string[] = [];
    const status: GatewayRuntimeStatus = {
      state: "running",
      owner: "shell",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "uv run tinybot gateway",
      port: 18790,
      repo_root: "D:/Code/py/tinybot",
      logs: ["stdout: ready"],
      last_error: null,
      exit_policy: "stop_on_exit",
    };

    const mounted = mountGatewayRuntimeIsland(host, {
      gatewayHttp: "http://127.0.0.1:18790",
      status,
      onAction: ({ action }) => actions.push(action),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("gateway-runtime");
    expect(host.className).toBe("desktop-workbench-section desktop-gateway-runtime");
    expect(host.getAttribute("aria-label")).toBe("Gateway runtime controls");
    expect(Array.from(host.querySelectorAll("[data-desktop-gateway-runtime-row]")).map((row) => row.textContent)).toEqual([
      "StateRunning",
      "OwnerShell-owned",
      "Commanduv run tinybot gateway",
      "Port18790",
      "Repo rootD:/Code/py/tinybot",
      "Recent logsstdout: ready",
      "Last errorNo recent error",
      "Exit policyStop shell-owned gateway on exit",
    ]);

    host.querySelector<HTMLButtonElement>('[data-desktop-gateway-action="stop"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-gateway-action="restart"]')?.click();
    expect(actions).toEqual(["stop", "restart"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
