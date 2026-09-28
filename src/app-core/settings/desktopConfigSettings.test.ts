import { describe, expect, test } from "vitest";
import { buildDesktopConfigSettingsValues, createDesktopConfigSettingsPatch, isDesktopConfigSettingsDirty, validateDesktopConfigSettings } from "./desktopConfigSettings";

describe("desktop tools and channels settings", () => {
  test("reads both config spellings without including provider state", () => {
    const tools = { restrictToWorkspace: true, mcpServers: { docs: { command: "docs-server" } } };
    const values = buildDesktopConfigSettingsValues({ tools, channels: { sendProgress: true, sendToolHints: true, sendMaxRetries: 5 } });
    expect(values).toEqual(buildDesktopConfigSettingsValues({
      tools: { restrict_to_workspace: true, mcp_servers: tools.mcpServers },
      channels: { send_progress: true, send_tool_hints: true, send_max_retries: 5 },
      providers: { profiles: { active: { apiKey: "stored-secret" } } },
    }));
    expect(values.execTimeout).toBe("60");
    expect(JSON.parse(values.mcpServers)).toEqual(tools.mcpServers);
    expect(JSON.stringify(values)).not.toContain("stored-secret");
  });

  test("does not materialize defaults and omits reverted edits", () => {
    const saved = buildDesktopConfigSettingsValues({});
    expect(createDesktopConfigSettingsPatch({ ...saved }, saved, "tools-mcp")).toEqual({});
    const draft = { ...saved, webEnable: false };
    expect(isDesktopConfigSettingsDirty(draft, saved, "tools-mcp")).toBe(true);
    expect(createDesktopConfigSettingsPatch(draft, saved, "tools-mcp")).toEqual({ tools: { web: { enable: false } } });
    draft.webEnable = saved.webEnable;
    expect(isDesktopConfigSettingsDirty(draft, saved, "tools-mcp")).toBe(false);
    expect(createDesktopConfigSettingsPatch(draft, saved, "tools-mcp")).toEqual({});
  });

  test("limits partial saves to the displayed group and leaves loaded secrets untouched", () => {
    const config = { agents: { defaults: { model: "custom" } }, providers: { profiles: { work: { apiKey: "secret" } } } };
    const saved = buildDesktopConfigSettingsValues(config);
    const draft = { ...saved, execTimeout: "90", sendMaxRetries: "4", sendToolHints: true };
    expect(createDesktopConfigSettingsPatch(draft, saved, "tools-mcp")).toEqual({ tools: { exec: { timeout: 90 } } });
    expect(createDesktopConfigSettingsPatch(draft, saved, "channels")).toEqual({ channels: { send_tool_hints: true, send_max_retries: 4 } });
    expect(config.providers.profiles.work.apiKey).toBe("secret");
    expect(isDesktopConfigSettingsDirty({ ...saved, webEnable: false }, saved, "channels")).toBe(false);
  });

  test("rejects invalid MCP definitions and numeric limits before creating a patch", () => {
    const saved = buildDesktopConfigSettingsValues({});
    for (const mcpServers of ["{broken", "[]", "null", '"server"']) {
      const draft = { ...saved, mcpServers };
      expect(validateDesktopConfigSettings(draft, "tools-mcp")).toEqual({ mcpServers: "invalidJson" });
      expect(() => createDesktopConfigSettingsPatch(draft, saved, "tools-mcp")).toThrow("mcpServers");
    }
    expect(validateDesktopConfigSettings({ ...saved, execTimeout: "bad" }, "tools-mcp")).toEqual({ execTimeout: "number" });
    expect(validateDesktopConfigSettings({ ...saved, execTimeout: "0" }, "tools-mcp")).toEqual({ execTimeout: "minimum" });
    expect(validateDesktopConfigSettings({ ...saved, sendMaxRetries: "11" }, "channels")).toEqual({ sendMaxRetries: "maximum" });
  });

  test("keeps optional clearing and structured MCP saves", () => {
    const saved = buildDesktopConfigSettingsValues({ tools: { web: { proxy: "http://proxy" } } });
    const draft = { ...saved, webProxy: "", execTimeout: "", mcpServers: '{"docs":{"command":"docs-server"}}' };
    expect(createDesktopConfigSettingsPatch(draft, saved, "tools-mcp")).toEqual({ tools: {
      web: { proxy: null }, exec: { timeout: null }, mcp_servers: { docs: { command: "docs-server" } },
    } });
  });
});
