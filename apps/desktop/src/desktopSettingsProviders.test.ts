import { describe, expect, test } from "vitest";
import {
  applyDesktopProviderModels,
  applyDesktopSettingsFieldEdit,
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsPaneModel,
  buildDesktopProviderModelRequest,
  buildDesktopSecretField,
  buildDesktopSettingsFormState,
  createDesktopSettingsPatch,
  findDesktopProfileIdForProvider,
  getDesktopProviderProfileConfig,
  parseDesktopProviderModelList,
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
      },
      [{ id: "openai", displayName: "OpenAI" }],
    );

    expect(state.agent.model).toBe("gpt-4.1");
    expect(state.agent.provider).toBe("openai");
    expect(state.agent.temperature).toBe(0);
    expect(state.embedding.modelName).toBe("text-embedding-v3");
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
      expect.objectContaining({ id: "model", label: "Model", value: "", state: "invalid", control: "text" }),
      expect.objectContaining({ id: "timezone", label: "Timezone", value: "Shanghai", state: "invalid", control: "text" }),
    ]));
    expect(pane.groups.find((group) => group.id === "provider-models")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "selectedProvider", label: "Selected provider", control: "select" }),
      expect.objectContaining({ id: "models", label: "Models", control: "textarea" }),
    ]));
    expect(pane.groups.find((group) => group.id === "files-workspace")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sessionFiles", label: "Session files", value: "Session file" }),
      expect.objectContaining({ id: "workspaceFiles", label: "Workspace files", value: "Workspace file" }),
    ]));
    expect(pane.groups.find((group) => group.id === "gateway-runtime")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "host", label: "Host" }),
      expect.objectContaining({ id: "port", label: "Port", state: "normal" }),
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

  test("applies desktop settings field edits to the saved config patch shape", () => {
    const state = buildDesktopSettingsFormState({
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai", active_profile: "work" } },
      providers: { profiles: { work: { provider: "openai", api_key: "sk-live", models: ["gpt-4.1-mini"] } } },
      knowledge: { enabled: true },
      gateway: { port: 18790 },
    }, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    const withModel = applyDesktopSettingsFieldEdit(state, "model", "gpt-4.1");
    const withoutKnowledge = applyDesktopSettingsFieldEdit(withModel, "enabled", false);
    const withPort = applyDesktopSettingsFieldEdit(withoutKnowledge, "port", "18888");
    const patch = createDesktopSettingsPatch(withPort, {}, [{ id: "openai", displayName: "OpenAI", status: "ready" }]);

    expect(patch.agents).toMatchObject({ defaults: { model: "gpt-4.1" } });
    expect(patch.knowledge).toMatchObject({ enabled: false });
    expect(patch.gateway).toMatchObject({ port: 18888 });
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
          api_base: "https://api.deepseek.com",
          api_key: "sk-deepseek",
        },
      },
    });
  });
});
