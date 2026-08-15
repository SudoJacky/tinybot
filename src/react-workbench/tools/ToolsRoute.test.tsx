// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices, ToolsStore } from "../services";
import ToolsRoute from "./ToolsRoute";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolsRoute", () => {
  it("exposes catalog load failures and retries through the route interface", async () => {
    const error = new Error("catalog offline");
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        mcpServers: [],
        tools: [{
          available: true,
          displayName: "Read file",
          enabled: true,
          id: "read-file",
          name: "read_file",
          source: "builtin",
        }],
      });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute onOpenChat={vi.fn()} services={{ toolsStore } as unknown as AppServices} />);
    await user.click(screen.getByRole("button", { name: "Tools" }));

    expect((await screen.findByRole("alert")).textContent).toContain("catalog offline");
    expect(log).toHaveBeenCalledWith("[tinybot-tools-route] catalog load failed", { error });

    await user.click(screen.getByRole("button", { name: "Retry loading Tools" }));
    expect(await screen.findByText("Read file")).toBeTruthy();
    expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(2);
  });
});

function createToolsStore() {
  return {
    installPlugin: vi.fn(),
    installPluginMigration: vi.fn(),
    listPlugins: vi.fn().mockResolvedValue([]),
    loadCatalog: vi.fn(),
    preparePluginMigration: vi.fn(),
    setPluginEnabled: vi.fn(),
    uninstallPlugin: vi.fn(),
  } satisfies Record<keyof ToolsStore, ReturnType<typeof vi.fn>>;
}
