import type { DesktopSecretField, DesktopSettingsValidationError, DesktopSettingsValidationField } from "./desktopSettingsContracts";
import type {
  DesktopSettingsPaneApplyEffect,
  DesktopSettingsPaneCommitMode,
  DesktopSettingsPaneFieldConfirmation,
  DesktopSettingsPaneGroupId,
  DesktopSettingsPaneGroupMetadata,
} from "./desktopSettingsMetadata";

export type DesktopSettingsSaveStatus = "idle" | "saving" | "saved" | "failed" | "restart-required" | "reload-required";
export type DesktopSettingsSaveTransport = "native";

export interface DesktopSettingsPaneSaveDetails {
  transport: DesktopSettingsSaveTransport;
  persistedRevision?: string;
  updatedFields: string[];
  applied: string[];
  restartRequired: string[];
  reloadRequired: string[];
  warnings: string[];
}

export type DesktopSettingsPaneFieldControl = "text" | "number" | "checkbox" | "textarea" | "select" | "password" | "readonly";
export type DesktopSettingsPaneFieldRequirement = "required" | "optional" | "readonly";
export type DesktopSettingsPaneSourceKind = "config" | "local-ui-preference" | "cache" | "runtime-status";
export type DesktopSettingsPaneValueOrigin = "explicit" | "default" | "environment" | "secret" | "cache" | "runtime" | "catalog";
export type DesktopSettingsPaneFieldConfigurationMode =
  | "fixed"
  | "freeform"
  | "json"
  | "list"
  | "numeric"
  | "readonly"
  | "secret"
  | "toggle"
  | "url";
export type DesktopSettingsEditableValue = string | boolean;

export interface DesktopSettingsPaneFieldOption {
  value: string;
  label: string;
}

export interface DesktopSettingsPaneField {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  i18nKey?: string;
  persistentPath?: string;
  sourceKind?: DesktopSettingsPaneSourceKind;
  valueOrigin?: DesktopSettingsPaneValueOrigin;
  validationField?: DesktopSettingsValidationField;
  sensitive?: boolean;
  applyEffect?: DesktopSettingsPaneApplyEffect;
  unit?: string;
  recommendation?: string;
  commitMode?: DesktopSettingsPaneCommitMode;
  confirmation?: DesktopSettingsPaneFieldConfirmation;
  notice?: string;
  value: string;
  state: "normal" | "invalid";
  control: DesktopSettingsPaneFieldControl;
  inputValue: string;
  checked?: boolean;
  options?: DesktopSettingsPaneFieldOption[];
  requirement: DesktopSettingsPaneFieldRequirement;
  configurationMode: DesktopSettingsPaneFieldConfigurationMode;
  disabled?: boolean;
  advanced?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface DesktopSettingsPaneGroup {
  id: DesktopSettingsPaneGroupId;
  label: string;
  description?: string;
  aliases?: string[];
  i18nKey?: string;
  navigationArea?: DesktopSettingsPaneGroupMetadata["navigationArea"];
  navigationMode?: DesktopSettingsPaneGroupMetadata["navigationMode"];
  fields: DesktopSettingsPaneField[];
}

export interface DesktopSettingsPaneModel {
  dirty: boolean;
  validationErrors: DesktopSettingsValidationError[];
  save: {
    status: DesktopSettingsSaveStatus;
    message: string;
    canSave: boolean;
    transport?: DesktopSettingsSaveTransport;
    persistedRevision?: string;
    updatedFields?: string[];
    applied?: string[];
    restartRequired?: string[];
    reloadRequired?: string[];
    warnings?: string[];
    diagnostics?: string;
  };
  diagnostics?: {
    runtimeSummary: string;
    runtimeOwnership: string;
    version: string;
    activeConfigPath: string;
    lastConfigError: string;
    logLevel: "error" | "info" | "debug";
  };
  groups: DesktopSettingsPaneGroup[];
  providerCatalog: Array<{
    id: string;
    label: string;
    profileId?: string;
    status: string;
    enabled?: boolean;
    enabledConfigured?: boolean;
    baseUrl?: string | null;
    apiKey?: DesktopSecretField;
    models?: string[];
    canDiscoverModels?: boolean;
  }>;
  defaultRouting?: {
    mode: "auto" | "provider";
    providerId: string;
    providerLabel: string;
    model: string | null;
    message: string;
  };
  providerEditor: {
    selectedProvider: string;
    profileId: string;
    apiKey: DesktopSecretField;
    apiBase: string | null;
    models: string[];
    canDiscoverModels: boolean;
  };
}
