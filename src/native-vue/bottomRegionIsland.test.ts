// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { GatewayRuntimeStatus } from "../desktopGatewayStartup";
import { buildDesktopTaskCenterItems } from "../desktopTaskCenter";
import { mountBottomRegionIsland } from "./bottomRegionIsland";

describe("bottom region Vue island", () => {
  test("renders task center and gateway runtime surfaces with routed actions", () => {
    const host = document.createElement("section");
    const taskEvents: string[] = [];
    const gatewayEvents: string[] = [];
    const taskItems = buildDesktopTaskCenterItems({
      fileOperations: [{
        id: "file:workspace:AGENTS.md:save",
        title: "Save AGENTS.md",
        status: "failed",
        detail: "Save conflict",
        canonical: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
        retryable: true,
        diagnostics: "HTTP 409",
      }],
    });
    const status: GatewayRuntimeStatus = {
      state: "running",
      owner: "shell",
      http_ok: true,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: "node workers/ts-agent-worker/src/index.ts",
      port: 18790,
      repo_root: "D:/Code/tinybot/tinybot",
      logs: ["stdout: ready"],
      last_error: null,
      exit_policy: "stop_on_exit",
    };

    const mounted = mountBottomRegionIsland(host, {
      gatewayHttp: "http://127.0.0.1:18790",
      gatewayStatus: status,
      taskItems,
      onGatewayAction: ({ action }) => gatewayEvents.push(action),
      onTaskAction: ({ action, item }) => taskEvents.push(`${action}:${item.id}`),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("bottom-region");
    expect(host.className).toBe("desktop-bottom-content");
    expect(host.querySelector(".n-card.desktop-bottom-content-card")).not.toBeNull();
    expect(host.querySelector("#desktop-task-center")?.getAttribute("data-desktop-vue-island")).toBe("task-center");
    expect(host.querySelector("#desktop-task-center")?.getAttribute("aria-label")).toBe("Background task center");
    expect(host.querySelector("#desktop-task-center")?.textContent).toContain("Save AGENTS.md");
    expect(host.querySelector(".desktop-gateway-runtime")?.getAttribute("data-desktop-vue-island")).toBe("gateway-runtime");
    expect(host.querySelector(".desktop-gateway-runtime")?.getAttribute("aria-label")).toBe("Gateway runtime controls");
    expect(host.querySelector(".desktop-gateway-runtime")?.textContent).toContain("Running");

    host.querySelector<HTMLButtonElement>('[data-desktop-task-action="retry"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-gateway-action="stop"]')?.click();

    expect(taskEvents).toEqual(["retry:file:workspace:AGENTS.md:save"]);
    expect(gatewayEvents).toEqual(["stop"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
