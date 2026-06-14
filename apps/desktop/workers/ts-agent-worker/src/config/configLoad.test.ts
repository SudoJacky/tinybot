import { describe, expect, test } from "vitest";

import {
  loadTinybotConfigFromJsonText,
  serializeTinybotConfig,
} from "./configLoad.ts";

describe("configLoad", () => {
  test("returns defaults with an info diagnostic when config text is missing", () => {
    const result = loadTinybotConfigFromJsonText(null, { path: "C:/Users/test/.tinybot/config.json" });

    expect(result.source).toBe("default");
    expect(result.config.agents.defaults.model).toBe("deepseek-reasoner");
    expect(result.diagnostics).toEqual([
      {
        level: "info",
        code: "missing_config",
        message: "config file is missing; using defaults",
        path: "C:/Users/test/.tinybot/config.json",
      },
    ]);
  });

  test("returns defaults with a warning diagnostic when JSON is invalid", () => {
    const result = loadTinybotConfigFromJsonText("{ invalid json", { path: "bad-config.json" });

    expect(result.source).toBe("default");
    expect(result.config.tools.restrictToWorkspace).toBe(true);
    expect(result.diagnostics).toMatchObject([
      {
        level: "warning",
        code: "invalid_json",
        path: "bad-config.json",
      },
    ]);
    expect(result.diagnostics[0]?.message).toContain("failed to parse config JSON");
  });

  test("returns defaults with a warning diagnostic when validation fails", () => {
    const result = loadTinybotConfigFromJsonText(
      JSON.stringify({ agents: { defaults: { model: " " } } }),
      { path: "invalid-config.json" },
    );

    expect(result.source).toBe("default");
    expect(result.config.agents.defaults.model).toBe("deepseek-reasoner");
    expect(result.diagnostics).toEqual([
      {
        level: "warning",
        code: "invalid_config",
        message: "agents.defaults.model cannot be empty",
        path: "invalid-config.json",
      },
    ]);
  });

  test("loads valid config text through migrations", () => {
    const result = loadTinybotConfigFromJsonText(JSON.stringify({
      agents: { defaults: { model: "gpt-5" } },
      tools: { exec: { restrictToWorkspace: false } },
    }));

    expect(result.source).toBe("file");
    expect(result.diagnostics).toEqual([]);
    expect(result.config.agents.defaults.model).toBe("gpt-5");
    expect(result.config.tools.restrictToWorkspace).toBe(false);
  });

  test("serializes canonical camelCase JSON for saving", () => {
    const { config } = loadTinybotConfigFromJsonText(JSON.stringify({
      agents: { defaults: { max_tokens: 4096 } },
      tools: { restrict_to_workspace: false },
    }));

    const serialized = serializeTinybotConfig(config);

    expect(serialized).toContain('\n  "agents": {');
    expect(serialized).toContain('"maxTokens": 4096');
    expect(serialized).toContain('"restrictToWorkspace": false');
    expect(serialized).not.toContain("max_tokens");
    expect(serialized).not.toContain("restrict_to_workspace");
    expect(JSON.parse(serialized)).toMatchObject({
      agents: { defaults: { maxTokens: 4096 } },
      tools: { restrictToWorkspace: false },
    });
  });
});
