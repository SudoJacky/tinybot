import type {
  DesktopProviderCatalogItem,
  DesktopSettingsFormState,
  DesktopSettingsProviderSummary,
} from "./desktopSettingsContracts";
import type {
  DesktopSettingsPaneModel,
  DesktopSettingsPaneSaveDetails,
  DesktopSettingsSaveStatus,
} from "./desktopSettingsPaneContracts";
import { buildDesktopSettingsPaneGroups } from "./desktopSettingsPaneGroups";
import { isDesktopSettingsDraftDirty } from "./desktopSettingsPersistence";
import { validateDesktopSettingsForm } from "./desktopSettingsProviders";
import { buildDesktopSecretField, parseDesktopProviderModelList } from "./desktopSettingsValues";

export function buildDesktopSettingsPaneModel(
  state: DesktopSettingsFormState,
  options: {
    lastSavedState?: DesktopSettingsFormState | null;
    providerCatalog?: DesktopProviderCatalogItem[];
    saveStatus?: DesktopSettingsSaveStatus;
    saveError?: string | null;
    saveDetails?: DesktopSettingsPaneSaveDetails | null;
  } = {},
): DesktopSettingsPaneModel {
  const validationErrors = validateDesktopSettingsForm(state);
  const providerSummaries = getDesktopStateProviderSummaries(state, options.providerCatalog ?? []);
  const dirty = options.lastSavedState
    ? isDesktopSettingsDraftDirty(state, options.lastSavedState)
    : false;
  const saveDetails = normalizeDesktopSettingsSaveDetails(options.saveDetails);
  const saveStatus = resolveDesktopSettingsSaveStatus(options.saveStatus ?? "idle", saveDetails);
  const save: DesktopSettingsPaneModel["save"] = {
    status: saveStatus,
    message: saveStatus === "failed" ? options.saveError || "Save failed" : formatDesktopSettingsSaveMessage(saveStatus, dirty, validationErrors.length, saveDetails),
    canSave: dirty && validationErrors.length === 0 && saveStatus !== "saving",
  };
  if (saveDetails) {
    save.transport = saveDetails.transport;
    save.persistedRevision = saveDetails.persistedRevision;
    save.updatedFields = saveDetails.updatedFields;
    save.applied = saveDetails.applied;
    save.restartRequired = saveDetails.restartRequired;
    save.reloadRequired = saveDetails.reloadRequired;
    save.warnings = saveDetails.warnings;
    save.diagnostics = formatDesktopSettingsSaveDiagnostics(saveStatus, saveDetails);
  }
  const diagnostics = buildDesktopSettingsDiagnosticsSummary(save);
  const providerCatalog = providerSummaries.map((provider) => ({
    id: provider.id,
    label: provider.label,
    profileId: provider.profileId,
    status: provider.status || "unknown",
    enabled: provider.enabled,
    enabledConfigured: provider.enabledConfigured,
    baseUrl: provider.apiBase,
    apiKey: buildDesktopSecretField(provider.apiKey),
    models: parseDesktopProviderModelList(provider.modelsText),
    canDiscoverModels: provider.supportsModelDiscovery,
  })).filter((provider) => provider.id);
  return {
    dirty,
    validationErrors,
    save,
    diagnostics,
    groups: buildDesktopSettingsPaneGroups(state, validationErrors, providerSummaries),
    providerCatalog,
    defaultRouting: buildDesktopDefaultRouting(state, providerCatalog),
    providerEditor: {
      selectedProvider: state.providerEditor.selectedProvider,
      profileId: state.providerEditor.profileId,
      apiKey: buildDesktopSecretField(state.providerEditor.apiKey),
      apiBase: state.providerEditor.apiBase,
      models: parseDesktopProviderModelList(state.providerEditor.modelsText),
      canDiscoverModels: state.providerEditor.supportsModelDiscovery,
    },
  };
}

function buildDesktopSettingsDiagnosticsSummary(
  save: DesktopSettingsPaneModel["save"],
): NonNullable<DesktopSettingsPaneModel["diagnostics"]> {
  const saveStatus = `Settings save status: ${save.status}`;
  return {
    runtimeSummary: `Runtime summary: in-process Rust backend; ${saveStatus}.`,
    runtimeOwnership: "Runtime ownership: Tauri-managed native backend.",
    version: "Version: Current desktop build.",
    activeConfigPath: "Active config path: Managed by native runtime.",
    lastConfigError: save.status === "failed"
      ? `Last config error: ${save.message}`
      : "Last config error: None.",
    logLevel: "info",
  };
}

function buildDesktopDefaultRouting(
  state: DesktopSettingsFormState,
  providerCatalog: DesktopSettingsPaneModel["providerCatalog"],
): DesktopSettingsPaneModel["defaultRouting"] {
  const model = state.agent.model;
  const configuredProvider = providerCatalog.find((provider) => provider.id === state.agent.provider);
  const resolvedProvider = configuredProvider ?? providerCatalog[0];
  const providerLabel = resolvedProvider?.label || resolvedProvider?.id || "Unavailable";
  const providerId = resolvedProvider?.id || "";
  return {
    mode: "provider",
    providerId,
    providerLabel,
    model,
    message: `${providerLabel}${model ? ` / ${model}` : ""}`,
  };
}

function getDesktopStateProviderSummaries(
  state: DesktopSettingsFormState,
  providerCatalog: DesktopProviderCatalogItem[],
): DesktopSettingsProviderSummary[] {
  if (state.providerSummaries?.length) {
    return state.providerSummaries;
  }
  const selectedProvider = state.providerEditor.selectedProvider || "deepseek";
  const catalog = providerCatalog.length
    ? providerCatalog
    : [{ id: selectedProvider, displayName: selectedProvider, status: "not_configured" }];
  return catalog.map((provider) => {
    const id = stringValue(provider.id);
    const status = stringValue(provider.status) || "not_configured";
    const isSelected = id === selectedProvider;
    return {
      id,
      label: stringValue(provider.displayName) || id,
      profileId: isSelected ? state.providerEditor.profileId : id,
      apiKey: isSelected ? state.providerEditor.apiKey : "",
      apiKeyConfigured: isSelected ? state.providerEditor.apiKeyConfigured : false,
      apiBase: isSelected ? state.providerEditor.apiBase : stringOrNull(provider.baseUrl),
      modelsText: isSelected ? state.providerEditor.modelsText : "",
      supportsModelDiscovery: isSelected ? state.providerEditor.supportsModelDiscovery : true,
      status,
      enabled: isDesktopProviderEnabledStatus(status),
      enabledConfigured: false,
    };
  }).filter((provider) => provider.id);
}

function normalizeDesktopSettingsSaveDetails(
  details: DesktopSettingsPaneSaveDetails | null | undefined,
): DesktopSettingsPaneSaveDetails | null {
  if (!details) {
    return null;
  }
  return {
    transport: details.transport,
    persistedRevision: details.persistedRevision,
    updatedFields: [...details.updatedFields],
    applied: [...details.applied],
    restartRequired: [...details.restartRequired],
    reloadRequired: [...details.reloadRequired],
    warnings: [...details.warnings],
  };
}

function resolveDesktopSettingsSaveStatus(
  status: DesktopSettingsSaveStatus,
  saveDetails: DesktopSettingsPaneSaveDetails | null,
): DesktopSettingsSaveStatus {
  if (status !== "saved") {
    return status;
  }
  if (saveDetails?.restartRequired.length) {
    return "restart-required";
  }
  if (saveDetails?.reloadRequired.length) {
    return "reload-required";
  }
  return status;
}

function formatDesktopSettingsSaveMessage(
  status: DesktopSettingsSaveStatus,
  dirty: boolean,
  validationErrorCount = 0,
  saveDetails: DesktopSettingsPaneSaveDetails | null = null,
): string {
  if (status === "saving") {
    return "Saving settings";
  }
  if (status === "saved") {
    if (saveDetails?.warnings.length) {
      return "Settings persisted with warnings";
    }
    if (saveDetails && !saveDetails.applied.length && saveDetails.updatedFields.length) {
      return "Settings persisted. Runtime not applied yet";
    }
    return "Settings persisted";
  }
  if (status === "restart-required") {
    return "Settings persisted. Application restart required";
  }
  if (status === "reload-required") {
    return "Settings persisted. Workspace reload required";
  }
  if (validationErrorCount > 0) {
    return `${validationErrorCount} ${validationErrorCount === 1 ? "setting needs" : "settings need"} attention`;
  }
  return dirty ? "Unsaved changes" : "No changes";
}

function formatDesktopSettingsSaveDiagnostics(
  status: DesktopSettingsSaveStatus,
  saveDetails: DesktopSettingsPaneSaveDetails | null,
): string {
  const rows = [`Status: ${status}`];
  if (!saveDetails) {
    return rows.join("\n");
  }
  rows.push(`Transport: ${saveDetails.transport}`);
  if (saveDetails.persistedRevision) {
    rows.push(`Persisted revision: ${saveDetails.persistedRevision}`);
  }
  rows.push(`Updated fields: ${formatDiagnosticList(saveDetails.updatedFields)}`);
  rows.push(`Applied: ${formatDiagnosticList(saveDetails.applied)}`);
  rows.push(`Restart required: ${formatDiagnosticList(saveDetails.restartRequired)}`);
  rows.push(`Reload required: ${formatDiagnosticList(saveDetails.reloadRequired)}`);
  rows.push(`Warnings: ${formatDiagnosticList(saveDetails.warnings)}`);
  return rows.join("\n");
}

function formatDiagnosticList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function isDesktopProviderEnabledStatus(status: string): boolean {
  return ["ready", "available", "no_models"].includes(status);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
