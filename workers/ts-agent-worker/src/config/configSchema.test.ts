import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { defaultTinybotConfig, parseTinybotConfig, TinybotConfigValidationError } from "./configSchema";

describe("configSchema", () => {
  test("parses legacy default config fixture for canonical core fields", () => {
    const raw = JSON.parse(
      readFileSync(new URL("./fixtures/default_config.json", import.meta.url), "utf-8"),
    );

    const config = parseTinybotConfig(raw);
    const defaults = defaultTinybotConfig();

    expect(config).toEqual(defaults);
  });

  test("matches legacy default config for worker-relevant core fields", () => {
    const config = defaultTinybotConfig();

    expect(config.agents.defaults).toMatchObject({
      workspace: "~/.tinybot/workspace",
      model: "deepseek-reasoner",
      activeProfile: null,
      provider: "auto",
      maxTokens: 8192,
      contextWindowTokens: 65536,
      contextBlockLimit: null,
      temperature: 0.1,
      maxToolIterations: 200,
      maxToolResultChars: 16000,
      providerRetryMode: "standard",
      reasoningEffort: null,
      timezone: "UTC",
      enableVectorStore: false,
    });
    expect(config.channels).toMatchObject({
      sendProgress: true,
      sendToolHints: true,
      sendMaxRetries: 3,
    });
    expect(config.gateway).toMatchObject({
      host: "0.0.0.0",
      port: 18790,
      heartbeat: { enabled: true, intervalS: 1800, keepRecentMessages: 8 },
    });
    expect(config.desktop.tsCoworkRuntime).toEqual({
      enabled: true,
      readOnlySnapshot: true,
      mutations: true,
      scheduler: true,
      swarm: true,
    });
    expect(config.tools).toMatchObject({
      restrictToWorkspace: true,
      mcpServers: {},
      ssrfWhitelist: [],
    });
    expect(config.knowledge).toMatchObject({
      enabled: false,
      autoRetrieve: true,
      maxChunks: 5,
      retrievalMode: "hybrid",
      graphragEnabled: true,
    });
  });

  test("accepts snake_case and camelCase aliases and emits canonical camelCase keys", () => {
    const config = parseTinybotConfig({
      agents: {
        defaults: {
          active_profile: "coding",
          max_tokens: 4096,
          context_window_tokens: 32768,
          context_block_limit: 8192,
          max_tool_iterations: 12,
          max_tool_result_chars: 2048,
          provider_retry_mode: "persistent",
          reasoning_effort: "HIGH",
          enable_vector_store: false,
          recent_context: { recency_days: 3, max_records: 2, scan_limit: 20 },
        },
      },
      tools: {
        restrict_to_workspace: false,
        mcp_servers: {
          local: { type: "stdio", command: "node", args: ["server.mjs"], tool_timeout: 5 },
        },
        ssrf_whitelist: ["100.64.0.0/10"],
      },
      desktop: {
        ts_cowork_runtime: {
          enabled: true,
          read_only_snapshot: true,
          mutations: true,
          scheduler: false,
          swarm: false,
        },
      },
    });

    expect(config.agents.defaults.activeProfile).toBe("coding");
    expect(config.agents.defaults.maxTokens).toBe(4096);
    expect(config.agents.defaults.contextWindowTokens).toBe(32768);
    expect(config.agents.defaults.contextBlockLimit).toBe(8192);
    expect(config.agents.defaults.maxToolIterations).toBe(12);
    expect(config.agents.defaults.maxToolResultChars).toBe(2048);
    expect(config.agents.defaults.providerRetryMode).toBe("persistent");
    expect(config.agents.defaults.reasoningEffort).toBe("high");
    expect(config.agents.defaults.recentContext).toMatchObject({ recencyDays: 3, maxRecords: 2, scanLimit: 20 });
    expect(config.tools.restrictToWorkspace).toBe(false);
    expect(config.tools.mcpServers.local).toMatchObject({ type: "stdio", command: "node", toolTimeout: 5 });
    expect(config.tools.ssrfWhitelist).toEqual(["100.64.0.0/10"]);
    expect(config.desktop.tsCoworkRuntime).toMatchObject({
      enabled: true,
      readOnlySnapshot: true,
      mutations: true,
      scheduler: false,
      swarm: false,
    });
    expect(Object.keys(config.agents.defaults)).toContain("activeProfile");
    expect(Object.keys(config.agents.defaults)).not.toContain("active_profile");
  });

  test("normalizes MCP server transport detection and allowlist aliases", () => {
    const config = parseTinybotConfig({
      tools: {
        mcp_servers: {
          filesystem: {
            command: "npx",
            enabled_tools: [],
          },
          docs: {
            url: "https://example.test/sse",
            tool_timeout: 45,
          },
          remote: {
            url: "https://example.test/mcp",
            enabledTools: ["search"],
          },
        },
      },
    });

    expect(config.tools.mcpServers.filesystem).toMatchObject({
      type: "stdio",
      command: "npx",
      enabledTools: [],
    });
    expect(config.tools.mcpServers.docs).toMatchObject({
      type: "sse",
      url: "https://example.test/sse",
      toolTimeout: 45,
      enabledTools: ["*"],
    });
    expect(config.tools.mcpServers.remote).toMatchObject({
      type: "streamableHttp",
      url: "https://example.test/mcp",
      enabledTools: ["search"],
    });
  });

  test("preserves extra provider and channel sections", () => {
    const config = parseTinybotConfig({
      providers: {
        openrouter: {
          apiKey: "secret",
          apiBase: "https://openrouter.test/api/v1",
          models: ["openai/gpt-4o-mini"],
          manualModelIds: "model-a\nmodel-b",
          supportsModelDiscovery: false,
          extraBody: { route: "low-cost" },
        },
      },
      channels: {
        slack: { enabled: true, streaming: true },
      },
    });

    expect(config.providers.openrouter).toMatchObject({
      apiKey: "secret",
      apiBase: "https://openrouter.test/api/v1",
      models: ["openai/gpt-4o-mini"],
      manualModels: ["model-a", "model-b"],
      supportsModelDiscovery: false,
      extraBody: { route: "low-cost" },
    });
    expect(config.channels.slack).toEqual({ enabled: true, streaming: true });
  });

  test("rejects invalid values that legacy validators reject", () => {
    expect(() => parseTinybotConfig({ agents: { defaults: { model: " " } } })).toThrow(TinybotConfigValidationError);
    expect(() => parseTinybotConfig({ agents: { defaults: { temperature: 3 } } })).toThrow(TinybotConfigValidationError);
    expect(() => parseTinybotConfig({ agents: { defaults: { maxToolIterations: 0 } } })).toThrow(TinybotConfigValidationError);
    expect(() =>
      parseTinybotConfig({ agents: { defaults: { contextWindowTokens: 100, contextBlockLimit: 200 } } })
    ).toThrow(TinybotConfigValidationError);
    expect(() =>
      parseTinybotConfig({ tools: { mcpServers: { bad: { type: "stdio", command: "", toolTimeout: 0 } } } })
    ).toThrow(TinybotConfigValidationError);
  });
});
