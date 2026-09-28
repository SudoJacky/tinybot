export type ConfigSettingsGroupId = "tools-mcp" | "channels";

export type DesktopConfigSettingsValues = {
  webEnable: boolean;
  execEnable: boolean;
  webProxy: string;
  searchProvider: string;
  execTimeout: string;
  restrictToWorkspace: boolean;
  mcpServers: string;
  sendProgress: boolean;
  sendToolHints: boolean;
  sendMaxRetries: string;
};

export type ConfigSettingsFieldId = keyof DesktopConfigSettingsValues;
export type ConfigSettingsField = {
  id: ConfigSettingsFieldId;
  path: readonly string[];
  control: "text" | "number" | "checkbox" | "textarea" | "select";
  advanced?: boolean;
  placeholder?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  confirmWhen?: "enable" | "disable";
};

const FIELDS: Record<ConfigSettingsGroupId, readonly ConfigSettingsField[]> = {
  "tools-mcp": [
    { id: "webEnable", path: ["tools", "web", "enable"], control: "checkbox" },
    { id: "execEnable", path: ["tools", "exec", "enable"], control: "checkbox", confirmWhen: "enable" },
    { id: "webProxy", path: ["tools", "web", "proxy"], control: "text", advanced: true, placeholder: "http://127.0.0.1:7890" },
    { id: "searchProvider", path: ["tools", "web", "search", "provider"], control: "select", advanced: true,
      options: ["duckduckgo", "brave", "tavily", "searxng", "jina"] },
    { id: "execTimeout", path: ["tools", "exec", "timeout"], control: "number", advanced: true, min: 1, step: 1 },
    { id: "restrictToWorkspace", path: ["tools", "restrict_to_workspace"], control: "checkbox", advanced: true, confirmWhen: "disable" },
    { id: "mcpServers", path: ["tools", "mcp_servers"], control: "textarea", advanced: true,
      placeholder: '{"server":{"command":"npx","args":[]}}' },
  ],
  channels: [
    { id: "sendProgress", path: ["channels", "send_progress"], control: "checkbox" },
    { id: "sendToolHints", path: ["channels", "send_tool_hints"], control: "checkbox" },
    { id: "sendMaxRetries", path: ["channels", "send_max_retries"], control: "number", min: 0, max: 10, step: 1 },
  ],
};

export function configSettingsFields(groupId: ConfigSettingsGroupId): readonly ConfigSettingsField[] {
  return FIELDS[groupId];
}

export function buildDesktopConfigSettingsValues(config: unknown): DesktopConfigSettingsValues {
  const root = asRecord(config);
  const tools = asRecord(root.tools);
  const web = asRecord(tools.web);
  const exec = asRecord(tools.exec);
  const channels = asRecord(root.channels);
  const mcpServers = tools.mcpServers ?? tools.mcp_servers;
  return {
    webEnable: web.enable !== false,
    execEnable: exec.enable !== false,
    webProxy: String(web.proxy ?? "").trim(),
    searchProvider: String(asRecord(web.search).provider ?? "duckduckgo"),
    execTimeout: String(exec.timeout ?? 60),
    restrictToWorkspace: (tools.restrictToWorkspace ?? tools.restrict_to_workspace) === true,
    mcpServers: mcpServers == null ? "" : JSON.stringify(mcpServers, null, 2),
    sendProgress: (channels.sendProgress ?? channels.send_progress) === true,
    sendToolHints: (channels.sendToolHints ?? channels.send_tool_hints) === true,
    sendMaxRetries: String(channels.sendMaxRetries ?? channels.send_max_retries ?? 3),
  };
}

export function isDesktopConfigSettingsDirty(
  draft: DesktopConfigSettingsValues,
  saved: DesktopConfigSettingsValues,
  groupId: ConfigSettingsGroupId,
): boolean {
  return FIELDS[groupId].some(({ id }) => draft[id] !== saved[id]);
}

export type ConfigSettingsValidationError = "number" | "minimum" | "maximum" | "invalidJson";

export function validateDesktopConfigSettings(
  values: DesktopConfigSettingsValues,
  groupId: ConfigSettingsGroupId,
): Partial<Record<ConfigSettingsFieldId, ConfigSettingsValidationError>> {
  const errors: Partial<Record<ConfigSettingsFieldId, ConfigSettingsValidationError>> = {};
  for (const field of FIELDS[groupId]) {
    const value = values[field.id];
    if (field.control === "number" && typeof value === "string" && value.trim()) {
      const number = Number(value);
      if (!Number.isFinite(number)) errors[field.id] = "number";
      else if (field.min !== undefined && number < field.min) errors[field.id] = "minimum";
      else if (field.max !== undefined && number > field.max) errors[field.id] = "maximum";
    }
    if (field.id === "mcpServers") {
      try { parseMcpServers(values.mcpServers); }
      catch { errors.mcpServers = "invalidJson"; }
    }
  }
  return errors;
}

/** Persist only edited fields in the displayed group; defaults and unrelated settings stay untouched. */
export function createDesktopConfigSettingsPatch(
  draft: DesktopConfigSettingsValues,
  saved: DesktopConfigSettingsValues,
  groupId: ConfigSettingsGroupId,
): Record<string, unknown> {
  const errors = validateDesktopConfigSettings(draft, groupId);
  if (Object.keys(errors).length) throw new Error(`Invalid configuration fields: ${Object.keys(errors).join(", ")}`);
  const patch: Record<string, unknown> = {};
  for (const field of FIELDS[groupId]) {
    if (draft[field.id] === saved[field.id]) continue;
    const input = draft[field.id];
    const value = field.id === "mcpServers" ? parseMcpServers(draft.mcpServers)
      : field.control === "number" ? (String(input).trim() ? Number(input) : null)
      : typeof input === "string" ? input.trim() || null : input;
    let target = patch;
    for (const segment of field.path.slice(0, -1)) {
      target[segment] ??= {};
      target = target[segment] as Record<string, unknown>;
    }
    target[field.path[field.path.length - 1]] = value;
  }
  return patch;
}

function parseMcpServers(value: string): Record<string, unknown> {
  const parsed: unknown = value.trim() ? JSON.parse(value) : {};
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP servers must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
