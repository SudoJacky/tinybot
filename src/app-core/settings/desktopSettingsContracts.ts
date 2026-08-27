export interface DesktopProviderCatalogItem {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  supportsModelDiscovery?: boolean;
  status?: string;
  enabled?: boolean | null;
}

export interface DesktopSettingsProviderEditorState {
  selectedProvider: string;
  profileId: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiBase: string | null;
  modelsText: string;
  supportsModelDiscovery: boolean;
}

export interface DesktopSettingsProviderSummary {
  id: string;
  label: string;
  profileId: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiBase: string | null;
  modelsText: string;
  supportsModelDiscovery: boolean;
  status: string;
  enabled: boolean;
  enabledConfigured: boolean;
}

export interface DesktopSettingsFormState {
  agent: {
    workspace: string | null;
    model: string | null;
    activeProfile: string | null;
    provider: string | null;
    temperature: number | null;
    maxTokens: number | null;
    contextWindowTokens: number | null;
    contextWindowStrategy: string | null;
    maxToolIterations: number | null;
    timezone: string | null;
  };
  embedding: {
    provider: string | null;
    modelName: string | null;
    apiKey: string;
    apiBase: string | null;
  };
  tools: {
    webEnable: boolean;
    webProxy: string | null;
    searchProvider: string | null;
    execEnable: boolean;
    execTimeout: number | null;
    mcpServersText: string;
    restrictToWorkspace: boolean;
  };
  channels: {
    sendProgress: boolean;
    sendToolHints: boolean;
    sendMaxRetries: number | null;
  };
  providerEditor: DesktopSettingsProviderEditorState;
  providerSummaries: DesktopSettingsProviderSummary[];
  providerEditorDirty?: boolean;
  touchedPaths?: string[];
  serverSnapshot?: unknown;
}

export type DesktopSettingsValidationField =
  | "model"
  | "timezone"
  | "mcpServers"
  | "providerApiBase"
  | "embeddingApiBase";

export interface DesktopSettingsValidationError {
  field: DesktopSettingsValidationField;
  errorKey: "modelEmpty" | "timezoneError" | "jsonObjectError" | "urlError";
}

export type DesktopSettingsSavePatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; validationErrors: DesktopSettingsValidationError[] };

export type DesktopSettingsSaveReconcileResult =
  | { ok: true; state: DesktopSettingsFormState }
  | { ok: false; state: DesktopSettingsFormState; mismatchedPaths: string[] };

export interface DesktopProviderModelRequest {
  provider: string;
  profile: string;
  api_key: string;
  api_base: string;
  refresh: boolean;
}

export interface DesktopProviderModelApplyResult {
  state: DesktopSettingsFormState;
  models: string[];
  selectedModel: string | null;
  status: "loaded" | "empty" | "failed";
  message: string;
}

export interface DesktopSecretField {
  value: string;
  displayValue: string;
  masked: boolean;
  empty: boolean;
}
