// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    const workingDirectory = "D:\\project";

    render(
      <ToolsRoute
        onOpenChat={vi.fn()}
        services={{ toolsStore } as unknown as AppServices}
        workingDirectory={workingDirectory}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByText("review-work")).toBeTruthy();
    expect(screen.getByText("Review changes in this workspace.")).toBeTruthy();
    expect(toolsStore.loadCatalog).toHaveBeenCalledWith({
      skillScope: "allWorkspaces",
      workingDirectory,
    });

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
    const workingDirectory = "D:\\project";

    render(
      <ToolsRoute
        onOpenChat={vi.fn()}
        services={{ toolsStore } as unknown as AppServices}
        workingDirectory={workingDirectory}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Skills" }));

    expect(toolsStore.loadSkillDetail).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "View review-work details" }));

    expect(await screen.findByText(/Review the full diff\./)).toBeTruthy();
    expect(toolsStore.loadSkillDetail).toHaveBeenCalledWith("workspace:review-work", {
      skillScope: "allWorkspaces",
      workingDirectory,
    });
  });

  it("creates a Streamable HTTP MCP server from the MCP form", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({ skills: [], mcpServers: [], tools: [] });
    const createStreamableHttpMcpServer = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), createStreamableHttpMcpServer },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    expect(screen.getByRole("heading", { name: "Connect a custom MCP" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Streamable HTTP" }));
    expect(screen.getByRole("button", { name: "Streamable HTTP" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Bearer token") as HTMLInputElement).type).toBe("password");

    await user.type(screen.getByLabelText("Name"), "docs.search");
    await user.type(screen.getByLabelText("URL"), "https://example.com/mcp");
    await user.type(screen.getByLabelText("Bearer token"), "private-token");
    await user.type(screen.getByLabelText("Headers: Header name 1"), "X-Tenant");
    await user.type(screen.getByLabelText("Headers: Value 1"), "tinybot");
    await user.type(screen.getByLabelText("Headers from environment variables: Header name 1"), "X-Trace-Token");
    await user.type(screen.getByLabelText("Headers from environment variables: Environment variable 1"), "DOCS_TRACE_TOKEN");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createStreamableHttpMcpServer).toHaveBeenCalledWith({
      name: "docs.search",
      url: "https://example.com/mcp",
      bearerToken: "private-token",
      httpHeaders: { "X-Tenant": "tinybot" },
      envHttpHeaders: { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
    }));
    expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Restart MCP servers" })).toBeTruthy();
  });

  it("creates an STDIO MCP server from structured process fields", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({ skills: [], mcpServers: [], tools: [] });
    const createStdioMcpServer = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), createStdioMcpServer },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    expect(screen.getByRole("button", { name: "STDIO" }).getAttribute("aria-pressed")).toBe("true");

    await user.type(screen.getByLabelText("Name"), "local.sqlite");
    await user.type(screen.getByLabelText("Command to launch"), "openai-dev-mcp");
    await user.type(screen.getByLabelText("Arguments: Argument 1"), "serve-sqlite");
    await user.click(screen.getByRole("button", { name: "Add argument" }));
    await user.type(screen.getByLabelText("Arguments: Argument 2"), "./data/app.db");
    await user.type(screen.getByLabelText("Environment variables: Variable name 1"), "LOG_LEVEL");
    await user.type(screen.getByLabelText("Environment variables: Value 1"), "debug");
    await user.type(screen.getByLabelText("Environment variable passthrough: Environment variable 1"), "DATABASE_TOKEN");
    await user.type(screen.getByLabelText("Working directory"), "./tools");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createStdioMcpServer).toHaveBeenCalledWith({
      name: "local.sqlite",
      command: "openai-dev-mcp",
      args: ["serve-sqlite", "./data/app.db"],
      env: { LOG_LEVEL: "debug" },
      envVarRefs: { DATABASE_TOKEN: "DATABASE_TOKEN" },
      cwd: "./tools",
    }));
    expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Restart MCP servers" })).toBeTruthy();
  });

  it("requires sensitive STDIO environment values to use passthrough", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({ skills: [], mcpServers: [], tools: [] });
    const createStdioMcpServer = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), createStdioMcpServer },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    await user.type(screen.getByLabelText("Name"), "local-secure");
    await user.type(screen.getByLabelText("Command to launch"), "node");
    await user.type(screen.getByLabelText("Environment variables: Variable name 1"), "API_TOKEN");
    await user.type(screen.getByLabelText("Environment variables: Value 1"), "private-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Sensitive environment values must use environment variable passthrough.")).toBeTruthy();
    expect(createStdioMcpServer).not.toHaveBeenCalled();
  });

  it("does not create an MCP server with a conflicting name", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({
      skills: [],
      mcpServers: [{ id: "docs", enabled: true, transport: "stdio", state: "ready", toolCount: 1 }],
      tools: [],
    });
    const createStreamableHttpMcpServer = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), createStreamableHttpMcpServer },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Add MCP server" }));
    await user.type(screen.getByLabelText("Name"), "docs");
    await user.type(screen.getByLabelText("Command to launch"), "node");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("A server with this name already exists in the current workspace.")).toBeTruthy();
    expect(createStreamableHttpMcpServer).not.toHaveBeenCalled();
  });

  it("toggles a globally configured MCP server from its catalog row", async () => {
    const toolsStore = createToolsStore();
    toolsStore.loadCatalog.mockResolvedValue({
      skills: [],
      mcpServers: [{
        id: "docs",
        enabled: true,
        source: "configuration",
        transport: "stdio",
        state: "ready",
        toolCount: 1,
      }],
      tools: [],
    });
    const setMcpServerEnabled = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), setMcpServerEnabled },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    const toggle = screen.getByRole("switch", { name: "Disable docs" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);

    await waitFor(() => expect(setMcpServerEnabled).toHaveBeenCalledWith("docs", false));
    await waitFor(() => expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(2));
  });

  it("opens a configured MCP server in the existing structured form and saves edits", async () => {
    const toolsStore = createToolsStore();
    const catalog = {
      skills: [],
      mcpServers: [{
        id: "local.sqlite",
        enabled: true,
        source: "configuration",
        transport: "stdio",
        state: "ready",
        toolCount: 2,
      }],
      tools: [],
    };
    let finishRestart: ((catalogSnapshot: typeof catalog) => void) | undefined;
    toolsStore.loadCatalog
      .mockResolvedValueOnce(catalog)
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishRestart = resolve;
      }));
    const loadMcpServerConfiguration = vi.fn(async () => ({
      name: "local.sqlite",
      enabled: true,
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
      env: { LOG_LEVEL: "info" },
      envVarRefs: { API_TOKEN: "API_TOKEN" },
      cwd: "./tools",
    }));
    const updateStdioMcpServer = vi.fn(async () => undefined);
    const user = userEvent.setup();

    render(<ToolsRoute
      onOpenChat={vi.fn()}
      services={{
        toolsStore,
        settingsStore: { load: vi.fn(), loadMcpServerConfiguration, updateStdioMcpServer },
      } as unknown as AppServices}
    />);

    await user.click(await screen.findByRole("button", { name: "MCP" }));
    await user.click(screen.getByRole("button", { name: "Configure local.sqlite" }));

    expect(await screen.findByRole("heading", { name: "Configure local.sqlite" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Arguments: Argument 1") as HTMLInputElement).value).toBe("server.js");
    await user.clear(screen.getByLabelText("Command to launch"));
    await user.type(screen.getByLabelText("Command to launch"), "uvx");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateStdioMcpServer).toHaveBeenCalledWith({
      name: "local.sqlite",
      command: "uvx",
      args: ["server.js"],
      env: { LOG_LEVEL: "info" },
      envVarRefs: { API_TOKEN: "API_TOKEN" },
      cwd: "./tools",
    }));
    expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(1);

    const restart = await screen.findByRole("button", { name: "Restart MCP servers" });
    await user.click(restart);

    await waitFor(() => expect(toolsStore.loadCatalog).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("button", { name: "Restart MCP servers" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("local.sqlite")).toBeTruthy();

    finishRestart?.(catalog);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restart MCP servers" })).toBeNull());
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
