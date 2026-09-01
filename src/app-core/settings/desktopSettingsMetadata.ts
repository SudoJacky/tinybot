import type { DesktopSettingsValidationField } from "./desktopSettingsContracts";

export type DesktopSettingsPaneGroupId =
  | "general"
  | "provider-models"
  | "tools-mcp"
  | "files-workspace"
  | "skills"
  | "channels"
  | "automations"
  | "logs-diagnostics";

export type DesktopSettingsPaneApplyEffect = "immediate" | "workspace-reload";
export type DesktopSettingsPaneCommitMode = "manual" | "auto";
export type DesktopSettingsPaneConfirmationWhen = "enable" | "disable" | "change";

export interface DesktopSettingsPaneFieldConfirmation {
  when: DesktopSettingsPaneConfirmationWhen;
  message: string;
}

export interface DesktopSettingsPaneFieldMetadata {
  label: string;
  description: string;
  aliases: string[];
  i18nKey: string;
  validationField?: DesktopSettingsValidationField;
  sensitive?: boolean;
  applyEffect?: DesktopSettingsPaneApplyEffect;
  unit?: string;
  recommendation?: string;
  commitMode?: DesktopSettingsPaneCommitMode;
  confirmation?: DesktopSettingsPaneFieldConfirmation;
  notice?: string;
}

export interface DesktopSettingsPaneGroupMetadata {
  label: string;
  description: string;
  aliases: string[];
  i18nKey: string;
  navigationArea: "core" | "application" | "system";
  navigationMode: "section" | "preview" | "hidden";
}

export interface DesktopSettingsFieldBehaviorMetadata {
  commitMode: DesktopSettingsPaneCommitMode;
  confirmation?: DesktopSettingsPaneFieldConfirmation;
  notice?: string;
}

const GROUP_METADATA: Record<DesktopSettingsPaneGroupId, DesktopSettingsPaneGroupMetadata> = {
  general: {
    label: "General",
    description: "Default model, provider routing, and timezone behavior.",
    aliases: ["default model", "profile", "timezone", "workspace"],
    i18nKey: "settings.groups.general",
    navigationArea: "core",
    navigationMode: "section",
  },
  "provider-models": {
    label: "Provider & Models",
    description: "Provider profiles, endpoints, credentials, and model catalogs.",
    aliases: ["providers", "models", "api key", "credentials"],
    i18nKey: "settings.groups.provider-models",
    navigationArea: "core",
    navigationMode: "section",
  },
  "tools-mcp": {
    label: "Tools & MCP",
    description: "Tool toggles and MCP server access.",
    aliases: ["tools", "mcp", "security"],
    i18nKey: "settings.groups.tools-mcp",
    navigationArea: "core",
    navigationMode: "section",
  },
  "files-workspace": {
    label: "Files & Workspace",
    description: "Session attachments and editable workspace file boundaries.",
    aliases: ["files", "storage", "workspace"],
    i18nKey: "settings.groups.files-workspace",
    navigationArea: "application",
    navigationMode: "section",
  },
  skills: {
    label: "Skills",
    description: "Skill availability and loading policy.",
    aliases: ["skills", "capabilities"],
    i18nKey: "settings.groups.skills",
    navigationArea: "application",
    navigationMode: "preview",
  },
  channels: {
    label: "Channels",
    description: "Streaming and retry behavior for desktop channels.",
    aliases: ["streaming", "progress", "retries"],
    i18nKey: "settings.groups.channels",
    navigationArea: "application",
    navigationMode: "section",
  },
  automations: {
    label: "Automations",
    description: "Automation and scheduling capabilities planned after core stability.",
    aliases: ["automation", "scheduling"],
    i18nKey: "settings.groups.automations",
    navigationArea: "application",
    navigationMode: "preview",
  },
  "logs-diagnostics": {
    label: "Logs & Diagnostics",
    description: "Runtime logs, diagnostics export, and local state recovery.",
    aliases: ["logs", "diagnostics", "debug"],
    i18nKey: "settings.groups.logs-diagnostics",
    navigationArea: "system",
    navigationMode: "section",
  },
};

const FIELD_METADATA: Record<string, DesktopSettingsPaneFieldMetadata> = {
  "general.model": {
    label: "Model",
    description: "Model used for default chat and agent responses.",
    aliases: ["default model", "chat model", "agent model"],
    validationField: "model",
    i18nKey: "settings.fields.general.model",
  },
  "general.activeProfile": {
    label: "Profile",
    description: "Named provider profile with credentials and endpoint settings.",
    aliases: ["active profile", "provider profile"],
    i18nKey: "settings.fields.general.activeProfile",
  },
  "general.timezone": {
    label: "Timezone",
    description: "Timezone used for timestamps, reminders, and scheduled work.",
    aliases: ["time zone", "locale", "schedule timezone"],
    validationField: "timezone",
    i18nKey: "settings.fields.general.timezone",
  },
  "files-workspace.workspace": {
    label: "Workspace",
    description: "Default desktop workspace path for local files and agent work.",
    aliases: ["workspace folder", "working directory", "files"],
    applyEffect: "workspace-reload",
    i18nKey: "settings.fields.files-workspace.workspace",
  },
  "general.temperature": {
    label: "Temperature",
    description: "Sampling temperature for default chat and agent responses.",
    aliases: ["creativity", "sampling"],
    recommendation: "Recommended 0.1",
    i18nKey: "settings.fields.general.temperature",
  },
  "general.maxTokens": {
    label: "Max tokens",
    description: "Maximum generated tokens for a default response.",
    aliases: ["output tokens", "completion tokens"],
    unit: "tokens",
    i18nKey: "settings.fields.general.maxTokens",
  },
  "provider-models.apiKey": {
    label: "API key",
    description: "Secret credential used by the selected provider profile.",
    aliases: ["secret", "credential", "token"],
    sensitive: true,
    i18nKey: "settings.fields.provider-models.apiKey",
  },
  "provider-models.apiBase": {
    label: "API base",
    description: "OpenAI-compatible endpoint for this provider.",
    aliases: ["base url", "endpoint", "provider url"],
    validationField: "providerApiBase",
    i18nKey: "settings.fields.provider-models.apiBase",
  },
  "tools-mcp.mcpServers": {
    label: "MCP servers",
    description: "JSON object of MCP server definitions.",
    aliases: ["mcp", "servers", "tools json"],
    validationField: "mcpServers",
    sensitive: true,
    i18nKey: "settings.fields.tools-mcp.mcpServers",
  },
};

const AUTO_COMMIT_FIELDS = new Set([
  "tools-mcp.webEnable",
  "tools-mcp.execEnable",
  "tools-mcp.restrictToWorkspace",
  "channels.sendProgress",
  "channels.sendToolHints",
]);

const FIELD_CONFIRMATIONS: Record<string, DesktopSettingsPaneFieldConfirmation> = {
  "tools-mcp.execEnable": {
    when: "enable",
    message: "Enable local command execution for agent workflows? Only enable this when you trust the active workspace.",
  },
  "tools-mcp.restrictToWorkspace": {
    when: "disable",
    message: "Allow execution outside the workspace boundary? This broadens local file access for command workflows.",
  },
};

const FIELD_NOTICES: Record<string, string> = {};

export function getDesktopSettingsGroupMetadata(
  groupId: DesktopSettingsPaneGroupId,
): DesktopSettingsPaneGroupMetadata {
  return GROUP_METADATA[groupId];
}

export function getDesktopSettingsFieldMetadata(
  groupId: DesktopSettingsPaneGroupId,
  fieldId: string,
): DesktopSettingsPaneFieldMetadata | null {
  return FIELD_METADATA[`${groupId}.${fieldId}`] ?? null;
}

export function getDesktopSettingsFieldBehaviorMetadata(
  groupId: DesktopSettingsPaneGroupId,
  fieldId: string,
): DesktopSettingsFieldBehaviorMetadata {
  const key = `${groupId}.${fieldId}`;
  return {
    commitMode: AUTO_COMMIT_FIELDS.has(key) ? "auto" : "manual",
    confirmation: FIELD_CONFIRMATIONS[key],
    notice: FIELD_NOTICES[key],
  };
}
