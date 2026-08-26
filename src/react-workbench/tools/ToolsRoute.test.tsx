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
        skills: [],
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

  it("exposes Skills and MCP as separate resource views", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({
      skills: [{
        id: "workspace:review-work",
        name: "review-work",
        description: "Review changes in this workspace.",
        source: "workspace",
        path: "D:\\project\\.agents\\skills\\review-work\\SKILL.md",
      }],
      mcpServers: [{
        id: "docs",
        enabled: true,
        transport: "stdio",
        state: "ready",
        toolCount: 2,
        source: ".mcp.json",
      }],
      tools: [],
    });
    const user = userEvent.setup();

    render(<ToolsRoute onOpenChat={vi.fn()} services={{ toolsStore } as unknown as AppServices} />);

    await user.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByText("review-work")).toBeTruthy();
    expect(screen.getByText("Review changes in this workspace.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "MCP" }));
    expect(await screen.findByText("docs")).toBeTruthy();
    expect(screen.getByText(".mcp.json")).toBeTruthy();
  });

  it("loads full Skill content only after the user opens its details", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({
      skills: [{
        id: "workspace:review-work",
        name: "review-work",
        description: "Review changes in this workspace.",
        source: "workspace",
        path: "D:\\project\\.agents\\skills\\review-work\\SKILL.md",
      }],
      mcpServers: [],
      tools: [],
    });
    toolsStore.loadSkillDetail.mockResolvedValue({
      id: "workspace:review-work",
      name: "review-work",
      description: "Review changes in this workspace.",
      source: "workspace",
      path: "D:\\project\\.agents\\skills\\review-work\\SKILL.md",
      content: "---\nname: review-work\n---\nReview the full diff.\n",
    });
    const user = userEvent.setup();

    render(<ToolsRoute onOpenChat={vi.fn()} services={{ toolsStore } as unknown as AppServices} />);
    await user.click(await screen.findByRole("button", { name: "Skills" }));

    expect(toolsStore.loadSkillDetail).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "View review-work details" }));

    expect(await screen.findByText(/Review the full diff\./)).toBeTruthy();
    expect(toolsStore.loadSkillDetail).toHaveBeenCalledWith("workspace:review-work");
  });
});

function createToolsStore() {
  return {
    installPlugin: vi.fn(),
    installPluginMigration: vi.fn(),
    listPlugins: vi.fn().mockResolvedValue([]),
    loadCatalog: vi.fn(),
    loadSkillDetail: vi.fn(),
    preparePluginMigration: vi.fn(),
    setPluginEnabled: vi.fn(),
    uninstallPlugin: vi.fn(),
  } satisfies Record<keyof ToolsStore, ReturnType<typeof vi.fn>>;
}
