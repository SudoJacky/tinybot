import type {
  DesktopSettingsFormState,
  DesktopSettingsProviderSummary,
  DesktopSettingsValidationError,
  DesktopSettingsValidationField,
} from "./desktopSettingsContracts";
import {
  getDesktopSettingsFieldBehaviorMetadata,
  getDesktopSettingsFieldMetadata,
  getDesktopSettingsGroupMetadata,
  type DesktopSettingsPaneApplyEffect,
  type DesktopSettingsPaneCommitMode,
  type DesktopSettingsPaneFieldConfirmation,
  type DesktopSettingsPaneGroupId,
} from "./desktopSettingsMetadata";
import type {
  DesktopSettingsPaneField,
  DesktopSettingsPaneFieldConfigurationMode,
  DesktopSettingsPaneFieldControl,
  DesktopSettingsPaneFieldOption,
  DesktopSettingsPaneFieldRequirement,
  DesktopSettingsPaneGroup,
  DesktopSettingsPaneSourceKind,
  DesktopSettingsPaneValueOrigin,
} from "./desktopSettingsPaneContracts";
import { buildDesktopSecretField, parseDesktopProviderModelList } from "./desktopSettingsValues";

type UnknownRecord = Record<string, unknown>;
type DesktopWorkbenchFileScopeId = "session" | "workspace";

const WORKBENCH_FILE_SCOPE_LABELS: Record<DesktopWorkbenchFileScopeId, string> = {
  session: "Session file",
  workspace: "Workspace file",
};

function workbenchFileScopeLabel(scope: DesktopWorkbenchFileScopeId): string {
  return WORKBENCH_FILE_SCOPE_LABELS[scope];
}

function isDesktopProviderDefaultSelectableStatus(status: string): boolean {
  return ["ready", "available", "no_models"].includes(status);
}

function buildDesktopDefaultModelOptions(
  state: DesktopSettingsFormState,
  providerSummaries: DesktopSettingsProviderSummary[],
): DesktopSettingsPaneFieldOption[] {
  const providerId = state.agent.provider && state.agent.provider !== "auto"
    ? state.agent.provider
    : state.providerEditor.selectedProvider;
  const provider = providerSummaries.find((summary) => summary.id === providerId);
  const models = parseDesktopProviderModelList(provider?.modelsText || state.providerEditor.modelsText);
  const selectedModel = stringOrNull(state.agent.model);
  if (selectedModel && !models.includes(selectedModel)) {
    models.unshift(selectedModel);
  }
  return models.map((model) => ({ value: model, label: model }));
}

export function buildDesktopSettingsPaneGroups(
  state: DesktopSettingsFormState,
  validationErrors: DesktopSettingsValidationError[],
  providerSummaries: DesktopSettingsProviderSummary[] = state.providerSummaries ?? [],
): DesktopSettingsPaneGroup[] {
  const invalidFields = new Set(validationErrors.map((error) => error.field));
  const modelOptions = buildDesktopDefaultModelOptions(state, providerSummaries);
  const editorProviderOptions = providerSummaries.map((provider) => ({
      value: provider.id,
      label: provider.label || provider.id,
    })).filter((provider) => provider.value);
  for (const value of [state.providerEditor.selectedProvider, "deepseek"].filter(Boolean)) {
    if (!editorProviderOptions.some((option) => option.value === value)) {
      editorProviderOptions.push({ value, label: value });
    }
  }
  const currentDefaultProvider = state.agent.provider && state.agent.provider !== "auto" ? state.agent.provider : "";
  const selectableProviderOptions = providerSummaries.filter((provider) => provider.enabled && isDesktopProviderDefaultSelectableStatus(provider.status)).map((provider) => ({
    value: provider.id,
    label: provider.label || provider.id,
  }));
  const agentProviderOptions = [
    { value: "auto", label: "Auto" },
    ...selectableProviderOptions,
  ];
  if (currentDefaultProvider && !agentProviderOptions.some((option) => option.value === currentDefaultProvider)) {
    const currentDefaultSummary = providerSummaries.find((provider) => provider.id === currentDefaultProvider);
    agentProviderOptions.push({
      value: currentDefaultProvider,
      label: currentDefaultSummary?.label || currentDefaultProvider,
    });
  }
  const fixedOptions = (values: string[]): DesktopSettingsPaneFieldOption[] => values.map((value) => ({
    value,
    label: value || "None",
  }));
  const fieldModeForControl = (control: DesktopSettingsPaneFieldControl): DesktopSettingsPaneFieldConfigurationMode => {
    switch (control) {
      case "checkbox":
        return "toggle";
      case "number":
        return "numeric";
      case "password":
        return "secret";
      case "readonly":
        return "readonly";
      case "select":
        return "fixed";
      case "textarea":
        return "freeform";
      default:
        return "freeform";
    }
  };
  const fieldRequirementForControl = (control: DesktopSettingsPaneFieldControl): DesktopSettingsPaneFieldRequirement => (
    control === "readonly" ? "readonly" : "optional"
  );
  const field = (
    id: string,
    label: string,
    value: unknown,
    config: {
      persistentPath?: string;
      sourceKind?: DesktopSettingsPaneSourceKind;
      valueOrigin?: DesktopSettingsPaneValueOrigin;
      validationField?: DesktopSettingsValidationField;
      control?: DesktopSettingsPaneFieldControl;
      options?: DesktopSettingsPaneFieldOption[];
      inputValue?: string;
      requirement?: DesktopSettingsPaneFieldRequirement;
      configurationMode?: DesktopSettingsPaneFieldConfigurationMode;
      applyEffect?: DesktopSettingsPaneApplyEffect;
      disabled?: boolean;
      advanced?: boolean;
      placeholder?: string;
      min?: number;
      max?: number;
      step?: number;
      commitMode?: DesktopSettingsPaneCommitMode;
      confirmation?: DesktopSettingsPaneFieldConfirmation;
      notice?: string;
    } = {},
  ): DesktopSettingsPaneField => ({
    id,
    label,
    persistentPath: config.persistentPath,
    sourceKind: config.sourceKind,
    valueOrigin: config.valueOrigin,
    validationField: config.validationField,
    value: formatDesktopSettingsFieldValue(value),
    state: config.validationField && invalidFields.has(config.validationField) ? "invalid" : "normal",
    control: config.control ?? "text",
    inputValue: config.inputValue ?? stringValue(value),
    checked: config.control === "checkbox" ? value === true : undefined,
    options: config.options,
    requirement: config.requirement ?? fieldRequirementForControl(config.control ?? "text"),
    configurationMode: config.configurationMode ?? fieldModeForControl(config.control ?? "text"),
    applyEffect: config.applyEffect,
    disabled: config.disabled ?? false,
    advanced: config.advanced,
    placeholder: config.placeholder,
    min: config.min,
    max: config.max,
    step: config.step,
    commitMode: config.commitMode,
    confirmation: config.confirmation,
    notice: config.notice,
  });
  const secretField = buildDesktopSecretField(state.providerEditor.apiKey);
  const providerEditorProviderId = state.providerEditor.selectedProvider || "deepseek";
  const providerEditorProfileId = state.providerEditor.profileId || providerEditorProviderId;
  return enrichDesktopSettingsPaneGroups([
    {
      id: "general",
      label: "General",
      fields: [
        field("model", "Model", state.agent.model, {
          validationField: "model",
          control: modelOptions.length ? "select" : "text",
          options: modelOptions.length ? modelOptions : undefined,
          requirement: "required",
          configurationMode: modelOptions.length ? "fixed" : "freeform",
        }),
        field("provider", "Provider", state.agent.provider, {
          control: "select",
          options: agentProviderOptions,
          requirement: "optional",
          configurationMode: "fixed",
        }),
        field("activeProfile", "Profile", state.agent.activeProfile, {
          requirement: "optional",
          configurationMode: "freeform",
        }),
        field("timezone", "Timezone", state.agent.timezone, {
          validationField: "timezone",
          requirement: "required",
          configurationMode: "freeform",
          placeholder: "Asia/Shanghai",
        }),
        field("temperature", "Temperature", state.agent.temperature, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 0,
          max: 2,
          step: 0.1,
        }),
        field("maxTokens", "Max tokens", state.agent.maxTokens, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("contextWindowTokens", "Context window tokens", state.agent.contextWindowTokens, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("contextWindowStrategy", "Context window strategy", state.agent.contextWindowStrategy, {
          control: "select",
          options: fixedOptions(["discard", "compact"]),
          requirement: "optional",
          configurationMode: "fixed",
          advanced: true,
        }),
        field("maxToolIterations", "Max tool iterations", state.agent.maxToolIterations, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
      ],
    },
    {
      id: "provider-models",
      label: "Provider & Models",
      fields: [
        field("selectedProvider", "Selected provider", state.providerEditor.selectedProvider, {
          persistentPath: "desktop.ui.settings.providerEditor.selectedProvider",
          sourceKind: "local-ui-preference",
          control: "select",
          options: editorProviderOptions,
          requirement: "required",
          configurationMode: "fixed",
        }),
        field("profileId", "Profile ID", state.providerEditor.profileId, {
          control: "readonly",
          requirement: "readonly",
          configurationMode: "readonly",
        }),
        field("apiKey", "API key", secretField.empty ? "" : "Configured", {
          persistentPath: `providers.${providerEditorProviderId}.api_key`,
          control: "password",
          inputValue: secretField.displayValue,
          requirement: "optional",
          configurationMode: "secret",
        }),
        field("apiBase", "API base", state.providerEditor.apiBase, {
          persistentPath: `providers.${providerEditorProviderId}.api_base`,
          validationField: "providerApiBase",
          requirement: "optional",
          configurationMode: "url",
          placeholder: "https://api.example.com/v1",
        }),
        field("models", "Models", parseDesktopProviderModelList(state.providerEditor.modelsText).join(", "), {
          persistentPath: `providers.profiles.${providerEditorProfileId}.models`,
          control: "textarea",
          inputValue: state.providerEditor.modelsText,
          requirement: "optional",
          configurationMode: "list",
          placeholder: "one-model-id-per-line",
        }),
      ],
    },
    {
      id: "tools-mcp",
      label: "Tools & MCP",
      fields: [
        field("webEnable", "Web tools", state.tools.webEnable, { control: "checkbox" }),
        field("execEnable", "Exec tools", state.tools.execEnable, { control: "checkbox" }),
        field("webProxy", "Web proxy", state.tools.webProxy, {
          advanced: true,
          placeholder: "http://127.0.0.1:7890",
        }),
        field("searchProvider", "Search provider", state.tools.searchProvider, {
          control: "select",
          options: fixedOptions(["duckduckgo", "brave", "tavily", "searxng", "jina"]),
          advanced: true,
        }),
        field("execTimeout", "Exec timeout", state.tools.execTimeout, {
          control: "number",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("restrictToWorkspace", "Restrict to workspace", state.tools.restrictToWorkspace, {
          control: "checkbox",
          advanced: true,
        }),
        field("mcpServers", "MCP servers", state.tools.mcpServersText ? "Configured" : "None", {
          validationField: "mcpServers",
          control: "textarea",
          inputValue: state.tools.mcpServersText,
          requirement: "optional",
          configurationMode: "json",
          advanced: true,
          placeholder: "{\"server\":{\"command\":\"npx\",\"args\":[]}}",
        }),
      ],
    },
    {
      id: "files-workspace",
      label: "Files & Workspace",
      fields: [
        field("workspace", "Workspace", state.agent.workspace, {
          requirement: "required",
          configurationMode: "freeform",
          placeholder: "~/.tinybot/workspace",
        }),
        field("sessionFiles", "Session files", workbenchFileScopeLabel("session"), { control: "readonly" }),
        field("workspaceFiles", "Workspace files", workbenchFileScopeLabel("workspace"), { control: "readonly" }),
      ],
    },
    {
      id: "skills",
      label: "Skills",
      fields: [
        field("skills", "Skills", "Managed by Tools and Skills workbench", { control: "readonly" }),
      ],
    },
    {
      id: "channels",
      label: "Channels",
      fields: [
        field("sendProgress", "Progress events", state.channels.sendProgress, { control: "checkbox" }),
        field("sendToolHints", "Tool hints", state.channels.sendToolHints, { control: "checkbox" }),
        field("sendMaxRetries", "Max retries", state.channels.sendMaxRetries, {
          control: "number",
          configurationMode: "numeric",
          min: 0,
          max: 10,
          step: 1,
        }),
      ],
    },
    {
      id: "automations",
      label: "Automations",
      fields: [
        field("automations", "Automations", "Planned after core workbench stability", { control: "readonly" }),
      ],
    },
    {
      id: "logs-diagnostics",
      label: "Logs & Diagnostics",
      fields: [
        field("diagnostics", "Diagnostics", "Export diagnostics and inspect runtime logs", { control: "readonly" }),
      ],
    },
  ], state);
}

function enrichDesktopSettingsPaneGroups(
  groups: DesktopSettingsPaneGroup[],
  state: DesktopSettingsFormState,
): DesktopSettingsPaneGroup[] {
  return groups.map((group) => {
    const groupMetadata = getDesktopSettingsGroupMetadata(group.id);
    return {
      ...group,
      label: groupMetadata.label,
      description: groupMetadata.description,
      aliases: [...groupMetadata.aliases],
      i18nKey: groupMetadata.i18nKey,
      navigationArea: groupMetadata.navigationArea,
      navigationMode: groupMetadata.navigationMode,
      fields: group.fields.map((field) => enrichDesktopSettingsPaneField(state, group.id, field)),
    };
  });
}

function enrichDesktopSettingsPaneField(
  state: DesktopSettingsFormState,
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): DesktopSettingsPaneField {
  const metadata = getDesktopSettingsFieldMetadata(groupId, field.id);
  const behavior = resolveDesktopSettingsFieldBehavior(groupId, field);
  const persistence = resolveDesktopSettingsPaneFieldPersistence(state, groupId, field);
  if (!metadata) {
    return {
      ...field,
      aliases: field.aliases ?? [],
      i18nKey: field.i18nKey ?? `settings.fields.${groupId}.${field.id}`,
      ...persistence,
      ...behavior,
    };
  }
  return {
    ...field,
    ...persistence,
    label: metadata.label,
    description: metadata.description,
    aliases: [...metadata.aliases],
    i18nKey: metadata.i18nKey,
    validationField: metadata.validationField ?? field.validationField,
    sensitive: metadata.sensitive,
    applyEffect: metadata.applyEffect ?? persistence.applyEffect,
    unit: metadata.unit,
    recommendation: metadata.recommendation,
    commitMode: metadata.commitMode ?? behavior.commitMode,
    confirmation: metadata.confirmation ?? behavior.confirmation,
    notice: metadata.notice ?? behavior.notice,
  };
}

function resolveDesktopSettingsFieldBehavior(
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): Pick<DesktopSettingsPaneField, "commitMode" | "confirmation" | "notice"> {
  const metadata = getDesktopSettingsFieldBehaviorMetadata(groupId, field.id);
  return {
    commitMode: field.commitMode ?? metadata.commitMode,
    confirmation: field.confirmation ?? metadata.confirmation,
    notice: field.notice ?? metadata.notice,
  };
}

function resolveDesktopSettingsPaneFieldPersistence(
  state: DesktopSettingsFormState,
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): Pick<DesktopSettingsPaneField, "persistentPath" | "sourceKind" | "valueOrigin" | "applyEffect"> {
  if (field.control === "readonly") {
    return {
      sourceKind: groupId === "logs-diagnostics" ? "runtime-status" : "config",
      valueOrigin: "runtime",
    };
  }
  const persistentPath = getDesktopSettingsPaneFieldPersistentPath(groupId, field);
  const sourceKind = field.sourceKind ?? (field.id === "selectedProvider" ? "local-ui-preference" : "config");
  return {
    ...(persistentPath ? { persistentPath } : {}),
    sourceKind,
    valueOrigin: field.valueOrigin ?? resolveDesktopSettingsValueOrigin(state, sourceKind, persistentPath, field),
    applyEffect: field.applyEffect ?? (sourceKind === "config" ? "immediate" : undefined),
  };
}

function resolveDesktopSettingsValueOrigin(
  state: DesktopSettingsFormState,
  sourceKind: DesktopSettingsPaneSourceKind,
  persistentPath: string | undefined,
  field: DesktopSettingsPaneField,
): DesktopSettingsPaneValueOrigin {
  if (field.sensitive || field.configurationMode === "secret") {
    return "secret";
  }
  if (sourceKind !== "config" || !persistentPath) {
    return "default";
  }
  const metadataOrigin = getDesktopSettingsMetadataValueOrigin(state.serverSnapshot, persistentPath);
  if (metadataOrigin) {
    return metadataOrigin;
  }
  return getDesktopSettingsExistingConfigPathValue(state.serverSnapshot, persistentPath) === undefined
    ? "default"
    : "explicit";
}

function getDesktopSettingsMetadataValueOrigin(
  existingConfig: unknown,
  persistentPath: string,
): DesktopSettingsPaneValueOrigin | null {
  const metadata = asRecord(asRecord(existingConfig).configMetadata);
  const origins = asRecord(metadata.origins);
  const origin = stringValue(origins[persistentPath]);
  switch (origin) {
    case "file":
      return "explicit";
    case "default":
      return "default";
    case "environment":
    case "env":
      return "environment";
    case "secret-store":
      return "secret";
    case "runtime":
      return "runtime";
    case "catalog":
      return "catalog";
    default:
      return null;
  }
}

function getDesktopSettingsPaneFieldPersistentPath(
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): string | undefined {
  const key = `${groupId}.${field.id}`;
  const staticPaths: Record<string, string> = {
    "general.model": "agents.defaults.model",
    "general.provider": "agents.defaults.provider",
    "general.activeProfile": "agents.defaults.activeProfile",
    "general.timezone": "agents.defaults.timezone",
    "general.temperature": "agents.defaults.temperature",
    "general.maxTokens": "agents.defaults.maxTokens",
    "general.contextWindowTokens": "agents.defaults.contextWindowTokens",
    "general.contextWindowStrategy": "agents.defaults.contextWindowStrategy",
    "general.maxToolIterations": "agents.defaults.maxIterations",
    "provider-models.selectedProvider": "desktop.ui.settings.providerEditor.selectedProvider",
    "provider-models.profileId": "agents.defaults.activeProfile",
    "tools-mcp.webEnable": "tools.web.enable",
    "tools-mcp.execEnable": "tools.exec.enable",
    "tools-mcp.webProxy": "tools.web.proxy",
    "tools-mcp.searchProvider": "tools.web.search.provider",
    "tools-mcp.execTimeout": "tools.exec.timeout",
    "tools-mcp.restrictToWorkspace": "tools.restrictToWorkspace",
    "tools-mcp.mcpServers": "tools.mcpServers",
    "files-workspace.workspace": "agents.defaults.workspace",
    "channels.sendProgress": "channels.sendProgress",
    "channels.sendToolHints": "channels.sendToolHints",
    "channels.sendMaxRetries": "channels.sendMaxRetries",
  };
  if (field.persistentPath) {
    return field.persistentPath;
  }
  return staticPaths[key];
}

function getDesktopSettingsExistingConfigPathValue(existingConfig: unknown, path: string): unknown {
  let cursor: unknown = existingConfig;
  for (const part of path.split(".")) {
    cursor = asRecord(cursor)[part];
  }
  return cursor;
}

function formatDesktopSettingsFieldValue(value: unknown): string {
  if (value === true) return "Enabled";
  if (value === false) return "Disabled";
  return stringValue(value);
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
