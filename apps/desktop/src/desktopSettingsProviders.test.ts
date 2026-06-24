import { describe, expect, test } from "vitest";
import {
  applyDesktopProviderModels,
  applyDesktopSettingsFieldEdit,
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsPaneModel,
  buildDesktopProviderModelRequest,
  buildDesktopSecretField,
  buildDesktopSettingsFormState,
  buildDesktopSettingsSavePatch,
  createDesktopSettingsPatch,
  findDesktopProfileIdForProvider,
  getDesktopProviderProfileConfig,
  parseDesktopProviderModelList,
  reconcileDesktopSettingsSavedState,
  resolveDesktopSecretValue,
  validateDesktopSettingsForm,
} from "./desktopSettingsProviders";

describe("desktop settings and provider helpers", () => {
  test("normalizes config and provider profiles for desktop panes", () => {
    const state = buildDesktopSettingsFormState(
      {
        agents: {
          defaults: {
            model: "gpt-4.1",
            active_profile: "work",
            provider: "openai",
            temperature: 0,
            embedding: {
              provider: "dashscope",
              model_name: "text-embedding-v3",
              api_key: "embed-key",
            },
          },
        },
        providers: {
          profiles: {
            work: {
              provider: "openai",
              api_key: "sk-live",
              api_base: "https://api.openai.com/v1",
              models: ["gpt-4.1", "gpt-4.1-mini"],
              supports_model_discovery: false,
            },
          },
        },
        tools: {
          mcp_servers: {
            docs: { command: "docs-mcp" },
          },
        },
        knowledge: {
          graph_extraction_enabled: false,
          graph_auto_extract: true,
          graph_extraction_model: "graph-model",
          graph_extraction_max_tokens: 640,
          graph_extraction_max_job_tokens: 1800,
          graph_extraction_concurrency: 2,
        },
      },
      [{ id: "openai", displayName: "OpenAI" }],
    );

    expect(state.agent.model).toBe("gpt-4.1");
    expect(state.agent.provider).toBe("openai");
    expect(state.agent.temperature).toBe(0);
    expect(state.embedding.modelName).toBe("text-embedding-v3");
    expect(state.knowledge.graphExtractionEnabled).toBe(false);
    expect(state.knowledge.graphAutoExtract).toBe(true);
    expect(state.knowledge.graphExtractionModel).toBe("graph-model");
    expect(state.knowledge.graphExtractionMaxTokens).toBe(640);
    expect(state.knowledge.graphExtractionMaxJobTokens).toBe(1800);
    expect(state.knowledge.graphExtractionConcurrency).toBe(2);
    expect(state.providerEditor).toMatchObject({
      selectedProvider: "openai",
      profileId: "work",
      apiKey: "sk-live",
      apiBase: "https://api.openai.com/v1",
      modelsText: "gpt-4.1\ngpt-4.1-mini",
      supportsModelDiscovery: false,
    });
    expect(state.tools.mcpServersText).toContain("docs-mcp");
  });

  test("builds the same config PATCH shape as the root WebUI settings form", () => {
    const state = buildDesktopSettingsFormState(
      {
        agents: {
          defaults: {
            model: "deepseek-chat",
            active_profile: "legacy",
            provider: "auto",
          },
        },
        providers: {
          profiles: {
            legacy: { provider: "deepseek", api_key: "old" },
          },
        },
      },
      [{ id: "deepseek" }],
    );
    state.providerEditor.profileId = "prod";
    state.providerEditor.selectedProvider = "deepseek";
    state.providerEditor.apiKey = "new-key";
    state.providerEditor.apiBase = "https://api.deepseek.com";
    state.providerEditor.modelsText = "deepseek-chat\ndeepseek-reasoner";
    state.tools.mcpServersText = "{\"search\":{\"command\":\"search-mcp\"}}";
    state.knowledge.graphExtractionEnabled = true;
    state.knowledge.graphAutoExtract = true;
    state.knowledge.graphExtractionModel = "graph-model";
    state.knowledge.graphExtractionMaxTokens = 640;
    state.knowledge.graphExtractionMaxJobTokens = 1800;
    state.knowledge.graphExtractionConcurrency = 3;

    const patch = createDesktopSettingsPatch(
      state,
      {
        providers: {
          profiles: {
            legacy: { provider: "deepseek", api_key: "old" },
          },
        },
      },
      [{ id: "deepseek" }],
    );

    expect(patch).toMatchObject({
      agents: {
        defaults: {
          model: "deepseek-chat",
          active_profile: "prod",
          provider: "auto",
          embedding: {
            api_key: "",
          },
        },
      },
      providers: {
        deepseek: {
          api_key: "new-key",
          api_base: "https://api.deepseek.com",
        },
      },
      tools: {
        mcp_servers: {
          search: { command: "search-mcp" },
        },
      },
      knowledge: {
        graph_extraction_enabled: true,
        graph_auto_extract: true,
        graph_extraction_model: "graph-model",
        graph_extraction_max_tokens: 640,
        graph_extraction_max_job_tokens: 1800,
        graph_extraction_concurrency: 3,
      },
    });
    expect((patch.providers as Record<string, unknown>).profiles).toMatchObject({
      legacy: { provider: "deepseek", api_key: "old" },
      prod: {
        provider: "deepseek",
        api_key: "new-key",
        api_base: "https://api.deepseek.com",
        models: ["deepseek-chat", "deepseek-reasoner"],
        supports_model_discovery: true,
      },
    });
  });

  test("validates desktop settings fields with root WebUI validation semantics", () => {
    const state = buildDesktopSettingsFormState({});
    state.agent.model = "";
    state.agent.timezone = "Shanghai";
    state.gateway.port = 70000;
    state.tools.mcpServersText = "[]";
    state.providerEditor.apiBase = "not a url";
    state.embedding.apiBase = "https://embedding.example/v1";
    state.knowledge.rerankApiBase = "bad-url";

    expect(validateDesktopSettingsForm(state)).toEqual([
      { field: "model", errorKey: "modelEmpty" },
      { field: "timezone", errorKey: "timezoneError" },
      { field: "gatewayPort", errorKey: "portRange" },
      { field: "mcpServers", errorKey: "jsonObjectError" },
      { field: "providerApiBase", errorKey: "urlError" },
      { field: "rerankApiBase", errorKey: "urlError" },
    ]);
  });

  test("accepts UTC, GMT, and IANA timezone defaults while rejecting invalid timezone values", () => {
    for (const timezone of ["UTC", "GMT", "Asia/Shanghai"]) {
      const state = buildDesktopSettingsFormState({
        agents: { defaults: { model: "gpt-4.1", timezone } },
      });

      expect(validateDesktopSettingsForm(state).filter((error) => error.field === "timezone")).toEqual([]);
    }

    for (const timezone of ["", "Shanghai", "Mars/Base"]) {
      const state = buildDesktopSettingsFormState({
        agents: { defaults: { model: "gpt-4.1", timezone } },
      });
      state.agent.timezone = timezone;

      expect(validateDesktopSettingsForm(state)).toEqual(expect.arrayContaining([
        { field: "timezone", errorKey: "timezoneError" },
      ]));
    }
  });

  test("builds provider model discovery requests and applies model results", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { provider: "openai", active_profile: "work" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
          },
        },
      },
    }, [{ id: "openai" }]);

    expect(buildDesktopProviderModelRequest(state)).toEqual({
      provider: "openai",
      profile: "work",
      api_key: "sk-live",
      api_base: "https://api.openai.com/v1",
      refresh: true,
    });

    const applied = applyDesktopProviderModels(state, {
      ok: true,
      models: ["gpt-4.1", "gpt-4.1", "gpt-4.1-mini"],
      warning: "cached",
    });

    expect(applied.status).toBe("loaded");
    expect(applied.models).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
    expect(applied.state.providerEditor.modelsText).toBe("gpt-4.1\ngpt-4.1-mini");
    expect(applied.state.agent.model).toBe("gpt-4.1");
    expect(applied.message).toBe("cached");
  });

  test("normalizes provider catalog payloads for workbench settings panes", () => {
    expect(buildDesktopProviderCatalogItems({
      providers: [
        { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", status: "ready", enabled: false },
        { id: "deepseek", display_name: "DeepSeek", base_url: "https://api.deepseek.com", status: "available" },
        null,
      ],
    })).toEqual([
      { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", status: "ready", enabled: false },
      { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", status: "available", enabled: null },
    ]);
    expect(buildDesktopProviderCatalogItems([
      { id: "local", display_name: "Local" },
    ])).toEqual([
      { id: "local", displayName: "Local", baseUrl: "", status: "", enabled: null },
    ]);
  });

  test("preserves masked secrets and parses provider profiles like the root helper", () => {
    expect(buildDesktopSecretField("sk-live")).toEqual({
      value: "sk-live",
      displayValue: "********",
      masked: true,
      empty: false,
    });
    expect(resolveDesktopSecretValue("********", "sk-live")).toBe("sk-live");
    expect(resolveDesktopSecretValue("replacement", "sk-live")).toBe("replacement");
    expect(parseDesktopProviderModelList("a,b\na\n c ")).toEqual(["a", "b", "c"]);
    expect(findDesktopProfileIdForProvider({ profiles: { work: { provider: "openai" } } }, "openai")).toBe("work");
    expect(
      getDesktopProviderProfileConfig(
        {
          openai: {
            api_key: "legacy-key",
            api_base: "https://legacy.example/v1",
            models: ["legacy-model"],
          },
        },
        "",
        "openai",
      ),
    ).toMatchObject({
      provider: "openai",
      apiKey: "legacy-key",
      apiBase: "https://legacy.example/v1",
      models: ["legacy-model"],
    });
  });

  test("builds grouped pane state with dirty, validation, and failed-save draft recovery", () => {
    const savedState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1"],
          },
        },
      },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);
    const draftState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "", provider: "openai", active_profile: "work", timezone: "Shanghai" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1", "gpt-4.1-mini"],
          },
        },
      },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const pane = buildDesktopSettingsPaneModel(draftState, {
      lastSavedState: savedState,
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      saveStatus: "failed",
      saveError: "HTTP 400",
    });

    expect(pane.dirty).toBe(true);
    expect(pane.save).toEqual({
      status: "failed",
      message: "HTTP 400",
      canSave: false,
    });
    expect(pane.validationErrors.map((error) => error.field)).toEqual(["model", "timezone"]);
    expect(pane.groups.map((group) => [group.id, group.label])).toEqual([
      ["general", "General"],
      ["provider-models", "Provider & Models"],
      ["knowledge", "Knowledge"],
      ["tools-approvals", "Tools & Approvals"],
      ["files-workspace", "Files & Workspace"],
      ["memory-experience", "Memory & Experience"],
      ["skills", "Skills"],
      ["channels", "Channels"],
      ["automations", "Automations"],
      ["gateway-runtime", "Gateway & Runtime"],
      ["logs-diagnostics", "Logs & Diagnostics"],
    ]);
    expect(pane.groups.find((group) => group.id === "general")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model", label: "Model", value: "", state: "invalid", control: "select", requirement: "required", configurationMode: "fixed" }),
      expect.objectContaining({ id: "timezone", label: "Timezone", value: "Shanghai", state: "invalid", control: "text", requirement: "required", configurationMode: "freeform" }),
    ]));
    expect(pane.groups.find((group) => group.id === "provider-models")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "selectedProvider", label: "Selected provider", control: "select", requirement: "required", configurationMode: "fixed" }),
      expect.objectContaining({ id: "apiKey", label: "API key", control: "password", requirement: "optional", configurationMode: "secret" }),
      expect.objectContaining({ id: "models", label: "Models", control: "textarea", requirement: "optional", configurationMode: "list" }),
    ]));
    expect(pane.groups.find((group) => group.id === "files-workspace")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sessionFiles", label: "Session files", value: "Session file", control: "readonly", requirement: "readonly", configurationMode: "readonly" }),
      expect.objectContaining({ id: "workspaceFiles", label: "Workspace files", value: "Workspace file", control: "readonly", requirement: "readonly", configurationMode: "readonly" }),
    ]));
    expect(pane.groups.find((group) => group.id === "gateway-runtime")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "host", label: "Host", requirement: "required", configurationMode: "freeform" }),
      expect.objectContaining({ id: "port", label: "Port", state: "normal", requirement: "required", configurationMode: "numeric" }),
    ]));
    expect(pane.providerCatalog).toEqual([
      expect.objectContaining({
        id: "openai",
        label: "OpenAI",
        profileId: "work",
        status: "ready",
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1", "gpt-4.1-mini"],
      }),
    ]);
    expect(pane.providerEditor).toMatchObject({
      profileId: "work",
      selectedProvider: "openai",
      apiKey: { displayValue: "********", masked: true },
      models: ["gpt-4.1", "gpt-4.1-mini"],
      canDiscoverModels: true,
    });
  });

  test("reports invalid dirty settings as needing attention beside save", () => {
    const savedState = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: ["gpt-4.1"] } } },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);
    const invalidState = applyDesktopSettingsFieldEdit(savedState, "timezone", "Shanghai");

    const pane = buildDesktopSettingsPaneModel(invalidState, {
      lastSavedState: savedState,
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
    });

    expect(pane.save.canSave).toBe(false);
    expect(pane.save.message).toBe("1 setting needs attention");
  });

  test("applies desktop settings field edits to the saved config patch shape", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work" } },
      providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: ["gpt-4.1-mini"] } } },
      knowledge: { enabled: true },
      gateway: { port: 18790 },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const withModel = applyDesktopSettingsFieldEdit(state, "model", "gpt-4.1");
    const withApiKey = applyDesktopSettingsFieldEdit(withModel, "apiKey", "********");
    const withReplacementKey = applyDesktopSettingsFieldEdit(withApiKey, "apiKey", "sk-replacement");
    const withoutKnowledge = applyDesktopSettingsFieldEdit(withReplacementKey, "enabled", false);
    const withPort = applyDesktopSettingsFieldEdit(withoutKnowledge, "port", "18888");
    const patch = createDesktopSettingsPatch(withPort, {}, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    expect(patch.agents).toMatchObject({ defaults: { model: "gpt-4.1" } });
    expect(patch.providers).toMatchObject({ openai: { api_key: "sk-replacement" } });
    expect(patch.knowledge).toMatchObject({ enabled: false });
    expect(patch.gateway).toMatchObject({ port: 18888 });
  });

  test("generates touched-path patches for individual field edits without hidden settings", () => {
    const existingConfig = {
      agents: {
        defaults: {
          model: "gpt-4.1-mini",
          provider: "openai",
          timezone: "UTC",
          hidden_backend_only: "preserve",
          embedding: {
            provider: "dashscope",
            model_name: "text-embedding-v3",
            hidden_embedding_only: true,
          },
        },
      },
      knowledge: {
        enabled: true,
        hidden_graph_backend_only: { preserve: true },
      },
      gateway: {
        host: "127.0.0.1",
        port: 18790,
        hidden_gateway_only: "preserve",
      },
    };
    const state = buildDesktopSettingsFormState(existingConfig, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const withTimezone = applyDesktopSettingsFieldEdit(state, "timezone", "Asia/Shanghai");
    const withKnowledgeDisabled = applyDesktopSettingsFieldEdit(state, "enabled", false);
    const withGatewayPort = applyDesktopSettingsFieldEdit(state, "port", "18888");

    expect(createDesktopSettingsPatch(withTimezone, existingConfig, [{ id: "openai", displayName: "OpenAI", status: "ready" }])).toEqual({
      agents: { defaults: { timezone: "Asia/Shanghai" } },
    });
    expect(createDesktopSettingsPatch(withKnowledgeDisabled, existingConfig, [{ id: "openai", displayName: "OpenAI", status: "ready" }])).toEqual({
      knowledge: { enabled: false },
    });
    expect(createDesktopSettingsPatch(withGatewayPort, existingConfig, [{ id: "openai", displayName: "OpenAI", status: "ready" }])).toEqual({
      gateway: { port: 18888 },
    });
  });

  test("generates touched-path patches for provider profile edits only", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1-mini"],
            hidden_profile_only: "preserve",
          },
        },
        openai: {
          api_key: "sk-live",
          api_base: "https://api.openai.com/v1",
          hidden_provider_only: "preserve",
        },
      },
    };
    const state = buildDesktopSettingsFormState(existingConfig, providerCatalog);
    const withProviderApiBase = applyDesktopSettingsFieldEdit(state, "apiBase", "https://proxy.example/v1");

    expect(createDesktopSettingsPatch(withProviderApiBase, existingConfig, providerCatalog)).toEqual({
      providers: {
        openai: { api_base: "https://proxy.example/v1" },
        profiles: {
          work: { api_base: "https://proxy.example/v1" },
        },
      },
    });
  });

  test("omits reverted touched fields from patches and dirty state", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
          },
        },
        openai: {
          api_key: "sk-live",
          api_base: "https://api.openai.com/v1",
        },
      },
    };
    const savedState = buildDesktopSettingsFormState(existingConfig, providerCatalog);
    const sameTimezone = applyDesktopSettingsFieldEdit(savedState, "timezone", "UTC");
    const sameProviderApiBase = applyDesktopSettingsFieldEdit(savedState, "apiBase", "https://api.openai.com/v1");

    expect(createDesktopSettingsPatch(sameTimezone, existingConfig, providerCatalog)).toEqual({});
    expect(createDesktopSettingsPatch(sameProviderApiBase, existingConfig, providerCatalog)).toEqual({});
    expect(buildDesktopSettingsPaneModel(sameTimezone, { lastSavedState: savedState, providerCatalog }).dirty).toBe(false);
    expect(buildDesktopSettingsPaneModel(sameProviderApiBase, { lastSavedState: savedState, providerCatalog }).dirty).toBe(false);
  });

  test("uses the loaded server snapshot when touched patches are generated without an explicit config", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
          },
        },
        openai: {
          api_key: "sk-live",
          api_base: "https://api.openai.com/v1",
        },
      },
    };
    const state = buildDesktopSettingsFormState(existingConfig, providerCatalog);

    expect(createDesktopSettingsPatch(applyDesktopSettingsFieldEdit(state, "timezone", "UTC"))).toEqual({});
    expect(createDesktopSettingsPatch(applyDesktopSettingsFieldEdit(state, "timezone", "Asia/Shanghai"))).toEqual({
      agents: { defaults: { timezone: "Asia/Shanghai" } },
    });
    expect(createDesktopSettingsPatch(applyDesktopSettingsFieldEdit(state, "apiBase", "https://api.openai.com/v1"))).toEqual({});
  });

  test("omits unrelated fields from patches for each settings group", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: {
        defaults: {
          model: "gpt-4.1-mini",
          provider: "openai",
          active_profile: "work",
          timezone: "UTC",
        },
      },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1-mini"],
          },
        },
        openai: {
          api_key: "sk-live",
          api_base: "https://api.openai.com/v1",
        },
      },
      knowledge: { enabled: true, auto_retrieve: false },
      tools: { exec: { enable: true, timeout: 120 }, web: { enable: true, search: { provider: "duckduckgo" } } },
      channels: { send_progress: true, send_tool_hints: false, send_max_retries: 3 },
      gateway: { host: "127.0.0.1", port: 18790, heartbeat: { enabled: true, interval_s: 1800 } },
    };

    const cases: Array<[string, string, string | boolean, unknown]> = [
      ["general", "model", "gpt-4.1", { agents: { defaults: { model: "gpt-4.1" } } }],
      ["provider-models", "apiKey", "sk-replacement", {
        providers: {
          openai: { api_key: "sk-replacement" },
          profiles: { work: { api_key: "sk-replacement" } },
        },
      }],
      ["knowledge", "autoRetrieve", true, { knowledge: { auto_retrieve: true } }],
      ["tools-approvals", "execTimeout", "90", { tools: { exec: { timeout: 90 } } }],
      ["channels", "sendMaxRetries", "5", { channels: { send_max_retries: 5 } }],
      ["gateway-runtime", "heartbeatIntervalS", "900", { gateway: { heartbeat: { interval_s: 900 } } }],
      ["files-workspace", "sessionFiles", "ignored", {}],
      ["memory-experience", "memory", "ignored", {}],
      ["skills", "skills", "ignored", {}],
      ["automations", "automations", "ignored", {}],
      ["logs-diagnostics", "diagnostics", "ignored", {}],
    ];

    for (const [groupName, fieldId, value, expectedPatch] of cases) {
      const state = buildDesktopSettingsFormState(existingConfig, providerCatalog);
      expect(createDesktopSettingsPatch(applyDesktopSettingsFieldEdit(state, fieldId, value), existingConfig, providerCatalog), groupName).toEqual(expectedPatch);
    }
  });

  test("validates the full draft before producing a touched-path save patch", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
          },
        },
      },
      knowledge: { enabled: true },
    };
    const state = buildDesktopSettingsFormState(existingConfig, providerCatalog);
    const invalidDraft = applyDesktopSettingsFieldEdit(state, "model", "");
    const invalidWithKnowledgeEdit = applyDesktopSettingsFieldEdit(invalidDraft, "enabled", false);

    expect(buildDesktopSettingsSavePatch(invalidWithKnowledgeEdit, existingConfig, providerCatalog)).toEqual({
      ok: false,
      validationErrors: [{ field: "model", errorKey: "modelEmpty" }],
    });

    const validWithKnowledgeEdit = applyDesktopSettingsFieldEdit(state, "enabled", false);
    expect(buildDesktopSettingsSavePatch(validWithKnowledgeEdit, existingConfig, providerCatalog)).toEqual({
      ok: true,
      patch: { knowledge: { enabled: false } },
    });
  });

  test("reconciles saved config only when it reflects touched draft values", () => {
    const providerCatalog = [{ id: "openai", displayName: "OpenAI", status: "ready" }];
    const existingConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            api_base: "https://api.openai.com/v1",
          },
        },
      },
    };
    const draft = applyDesktopSettingsFieldEdit(
      buildDesktopSettingsFormState(existingConfig, providerCatalog),
      "timezone",
      "Asia/Shanghai",
    );

    const staleResult = reconcileDesktopSettingsSavedState(draft, existingConfig, providerCatalog);
    expect(staleResult).toEqual({
      ok: false,
      mismatchedPaths: ["agents.defaults.timezone"],
      state: draft,
    });
    expect(createDesktopSettingsPatch(staleResult.state, existingConfig, providerCatalog)).toEqual({
      agents: { defaults: { timezone: "Asia/Shanghai" } },
    });

    const savedResult = reconcileDesktopSettingsSavedState(draft, {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "Asia/Shanghai" } },
      providers: existingConfig.providers,
    }, providerCatalog);
    expect(savedResult.ok).toBe(true);
    if (savedResult.ok) {
      expect(savedResult.state.touchedPaths).toBeUndefined();
      expect(createDesktopSettingsPatch(savedResult.state, savedResult.state.serverSnapshot, providerCatalog)).toMatchObject({
        agents: { defaults: { timezone: "Asia/Shanghai" } },
      });
    }
  });

  test("classifies settings fields by requirement, input mode, and advanced visibility", () => {
    const state = buildDesktopSettingsFormState({
      agents: {
        defaults: {
          model: "deepseek-chat",
          provider: "deepseek",
          active_profile: "deepseek",
          temperature: 0.2,
          max_tokens: 4096,
          reasoning_effort: "medium",
        },
      },
      providers: {
        profiles: {
          deepseek: {
            provider: "deepseek",
            api_key: "sk-live",
            api_base: "https://api.deepseek.com",
            models: ["deepseek-chat", "deepseek-reasoner"],
          },
        },
      },
      tools: {
        web: { enable: true, proxy: "http://127.0.0.1:7890", search: { provider: "duckduckgo" } },
        exec: { enable: true, timeout: 120 },
      },
    }, [{ id: "deepseek", displayName: "DeepSeek", status: "ready" }]);

    const pane = buildDesktopSettingsPaneModel(state, {
      providerCatalog: [{ id: "deepseek", displayName: "DeepSeek", status: "ready" }],
    });
    const fields = Object.fromEntries(pane.groups.flatMap((group) => group.fields.map((field) => [`${group.id}.${field.id}`, field])));

    expect(fields["general.model"]).toMatchObject({
      control: "select",
      requirement: "required",
      configurationMode: "fixed",
      options: [
        { value: "deepseek-chat", label: "deepseek-chat" },
        { value: "deepseek-reasoner", label: "deepseek-reasoner" },
      ],
    });
    expect(fields["general.temperature"]).toMatchObject({ control: "number", requirement: "optional", configurationMode: "numeric", advanced: true });
    expect(fields["general.reasoningEffort"]).toMatchObject({ control: "select", requirement: "optional", configurationMode: "fixed", advanced: true });
    expect(fields["tools-approvals.mcpServers"]).toMatchObject({ control: "textarea", requirement: "optional", configurationMode: "json", advanced: true });
    expect(fields["tools-approvals.searchProvider"]).toMatchObject({ control: "select", requirement: "optional", configurationMode: "fixed", advanced: true });
    expect(fields["knowledge.retrievalMode"]).toMatchObject({ control: "select", requirement: "optional", configurationMode: "fixed" });
    expect(fields["knowledge.graphExtractionEnabled"]).toMatchObject({ control: "checkbox", requirement: "optional", configurationMode: "toggle" });
    expect(fields["knowledge.graphAutoExtract"]).toMatchObject({ control: "checkbox", requirement: "optional", configurationMode: "toggle", advanced: true });
    expect(fields["knowledge.graphExtractionModel"]).toMatchObject({ control: "text", requirement: "optional", configurationMode: "freeform", advanced: true });
    expect(fields["knowledge.graphExtractionMaxTokens"]).toMatchObject({ control: "number", requirement: "optional", configurationMode: "numeric", advanced: true });
    expect(fields["knowledge.graphExtractionMaxJobTokens"]).toMatchObject({ control: "number", requirement: "optional", configurationMode: "numeric", advanced: true });
    expect(fields["knowledge.graphExtractionConcurrency"]).toMatchObject({ control: "number", requirement: "optional", configurationMode: "numeric", advanced: true });
    expect(fields["memory-experience.memory"]).toMatchObject({ control: "readonly", requirement: "readonly", configurationMode: "readonly" });
  });

  test("keeps provider editing separate from the default LLM provider", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-openai",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1"],
          },
          deepseek: {
            provider: "deepseek",
            api_key: "sk-deepseek",
            api_base: "https://api.deepseek.com",
            models: ["deepseek-chat"],
          },
        },
      },
    }, [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
      { id: "ollama", displayName: "Ollama", status: "not_configured" },
    ]);

    const pane = buildDesktopSettingsPaneModel(state, {
      providerCatalog: [
        { id: "openai", displayName: "OpenAI", status: "ready" },
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
        { id: "ollama", displayName: "Ollama", status: "not_configured" },
      ],
    });
    expect(pane.providerCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "deepseek",
        enabled: true,
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-chat"],
      }),
      expect.objectContaining({
        id: "ollama",
        enabled: false,
      }),
    ]));
    expect(pane.groups.find((group) => group.id === "general")?.fields.find((field) => field.id === "provider")?.options).toEqual([
      { value: "auto", label: "Auto" },
      { value: "openai", label: "OpenAI" },
      { value: "deepseek", label: "DeepSeek" },
    ]);

    const editingDeepSeek = applyDesktopSettingsFieldEdit(state, "selectedProvider", "deepseek");
    expect(editingDeepSeek.agent.provider).toBe("openai");
    expect(editingDeepSeek.providerEditor).toMatchObject({
      selectedProvider: "deepseek",
      profileId: "deepseek",
      apiKey: "sk-deepseek",
      apiBase: "https://api.deepseek.com",
      modelsText: "deepseek-chat",
    });

    const disabledDeepSeek = applyDesktopSettingsFieldEdit(state, "providerEnabled:deepseek", false);
    const disabledPane = buildDesktopSettingsPaneModel(disabledDeepSeek, {
      providerCatalog: [
        { id: "openai", displayName: "OpenAI", status: "ready" },
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
        { id: "ollama", displayName: "Ollama", status: "not_configured" },
      ],
    });
    expect(disabledPane.providerCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", enabled: false, enabledConfigured: true }),
    ]));
    expect(disabledPane.groups.find((group) => group.id === "general")?.fields.find((field) => field.id === "provider")?.options).toEqual([
      { value: "auto", label: "Auto" },
      { value: "openai", label: "OpenAI" },
    ]);
    expect(createDesktopSettingsPatch(disabledDeepSeek, {}, [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ])).toMatchObject({
      providers: {
        deepseek: {
          enabled: false,
        },
      },
    });
  });

  test("does not dirty settings or change the patch when only browsing provider cards", () => {
    const providerCatalog = [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ];
    const config = {
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-openai",
            api_base: "https://api.openai.com/v1",
            models: ["gpt-4.1"],
          },
          deepseek: {
            provider: "deepseek",
            api_key: "sk-deepseek",
            api_base: "https://api.deepseek.com",
            models: ["deepseek-chat"],
          },
        },
      },
    };
    const savedState = buildDesktopSettingsFormState(config, providerCatalog);
    const browsingState = applyDesktopSettingsFieldEdit(savedState, "selectedProvider", "deepseek");

    expect(buildDesktopSettingsPaneModel(browsingState, {
      lastSavedState: savedState,
      providerCatalog,
    }).dirty).toBe(false);
    expect(createDesktopSettingsPatch(browsingState, config, providerCatalog)).toEqual({});
  });

  test("prevents disabling the current default provider until another route is selected", () => {
    const providerCatalog = [
      { id: "openai", displayName: "OpenAI", status: "ready" },
      { id: "deepseek", displayName: "DeepSeek", status: "ready" },
    ];
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1", provider: "openai", active_profile: "work" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            enabled: true,
            api_key: "sk-openai",
            models: ["gpt-4.1"],
          },
          deepseek: {
            provider: "deepseek",
            enabled: true,
            api_key: "sk-deepseek",
            models: ["deepseek-chat"],
          },
        },
      },
    }, providerCatalog);

    const attemptedDisable = applyDesktopSettingsFieldEdit(state, "providerEnabled:openai", false);

    expect(buildDesktopSettingsPaneModel(attemptedDisable, { providerCatalog }).providerCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai", enabled: true }),
    ]));
    expect(createDesktopSettingsPatch(attemptedDisable, {}, providerCatalog).providers).not.toMatchObject({
      openai: { enabled: false },
    });
  });

  test("preserves save warnings and gateway fallback details in the pane model", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            models: ["gpt-4.1-mini"],
          },
        },
      },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const pane = buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      saveStatus: "saved",
      saveDetails: {
        transport: "gateway-fallback",
        updatedFields: ["agents.defaults.model"],
        applied: ["agents.defaults.model"],
        restartRequired: [],
        reloadRequired: [],
        warnings: ["Native patch failed; gateway fallback applied."],
      },
    });

    expect(pane.save.message).toBe("Settings saved through gateway fallback");
    expect(pane.save.transport).toBe("gateway-fallback");
    expect(pane.save.updatedFields).toEqual(["agents.defaults.model"]);
    expect(pane.save.applied).toEqual(["agents.defaults.model"]);
    expect(pane.save.warnings).toEqual(["Native patch failed; gateway fallback applied."]);
  });

  test("promotes saved restart and reload side effects to distinct save states", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work", timezone: "UTC" } },
      providers: {
        profiles: {
          work: {
            provider: "openai",
            api_key: "sk-live",
            models: ["gpt-4.1-mini"],
          },
        },
      },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const restartPane = buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      saveStatus: "saved",
      saveDetails: {
        transport: "native",
        updatedFields: ["gateway.port"],
        applied: ["gatewayRuntimeChanged"],
        restartRequired: ["gatewayRestartRequired"],
        reloadRequired: [],
        warnings: [],
      },
    });
    const reloadPane = buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      providerCatalog: [{ id: "openai", displayName: "OpenAI", status: "ready" }],
      saveStatus: "saved",
      saveDetails: {
        transport: "native",
        updatedFields: ["agents.defaults.workspace"],
        applied: ["workspaceChanged"],
        restartRequired: [],
        reloadRequired: ["workspaceReloadRequired"],
        warnings: [],
      },
    });

    expect(restartPane.save.status).toBe("restart-required");
    expect(restartPane.save.message).toBe("Settings saved. Gateway restart required");
    expect(reloadPane.save.status).toBe("reload-required");
    expect(reloadPane.save.message).toBe("Settings saved. Workspace reload required");
  });
});
