export type DesktopToolConfigHint = "webDisabled" | "execDisabled" | "";
export type DesktopToolRiskHint = "modifyFiles" | "background" | "";
export type DesktopSkillStatus = "enabled" | "disabled" | "always" | "unavailable";

export interface DesktopToolSchemaField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue: string;
  enumValues: string[];
}

export interface DesktopToolRow {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  configHint: DesktopToolConfigHint;
  riskHint: DesktopToolRiskHint;
  schemaFields: DesktopToolSchemaField[];
  schemaText: string;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopToolDetailView extends DesktopToolRow {
  title: string;
  emptySchemaText: string;
}

export interface DesktopToolsConfigHintView {
  show: boolean;
  disabledToolGroups: string[];
}

export interface DesktopSkillRow {
  name: string;
  source: string;
  available: boolean;
  always: boolean;
  enabled: boolean;
  status: DesktopSkillStatus;
  deletable: boolean;
  meta: string;
  raw: UnknownRecord;
}

export interface DesktopSkillDetailView {
  name: string;
  description: string;
  always: boolean;
  content: string;
  source: string;
  deletable: boolean;
  nameEditable: boolean;
  validation: {
    state: "idle" | "valid" | "invalid";
    message: string;
  };
}

export interface DesktopSkillFormInput {
  name?: string;
  description?: string;
  content?: string;
  always?: boolean;
}

export interface DesktopSkillRequest {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: UnknownRecord;
}

type UnknownRecord = Record<string, unknown>;

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: "Read file",
  write_file: "Write file",
  exec: "Command",
  spawn: "Background command",
  cron: "Scheduled task",
};

export function buildDesktopToolRows(payload: unknown, config: unknown = {}): DesktopToolRow[] {
  return arrayFromPayload(payload, "tools").map((tool) => buildDesktopToolRow(tool, config));
}

export function buildDesktopToolDetailView(tool: unknown, config: unknown = {}): DesktopToolDetailView {
  const row = buildDesktopToolRow(asRecord(tool), config);
  return {
    ...row,
    title: row.displayName,
    emptySchemaText: "No parameters.",
  };
}

export function buildDesktopToolsConfigHint(config: unknown = {}): DesktopToolsConfigHintView {
  const tools = asRecord(asRecord(config).tools);
  const web = asRecord(tools.web);
  const exec = asRecord(tools.exec);
  const disabledToolGroups = [
    web.enable === true ? "" : "web",
    exec.enable === true ? "" : "exec",
  ].filter(Boolean);
  return {
    show: disabledToolGroups.length > 0,
    disabledToolGroups,
  };
}

export function buildDesktopToolSchemaFields(schema: unknown): DesktopToolSchemaField[] {
  const root = asRecord(schema);
  const required = new Set(arrayValue(root.required).map((item) => stringValue(item)).filter(Boolean));
  const properties = asRecord(root.properties);
  return Object.entries(properties).map(([name, value]) => {
    const property = asRecord(value);
    const enumValues = arrayValue(property.enum).map((item) => stringValue(item));
    return {
      name,
      type: enumValues.length ? "enum" : stringValue(property.type) || "unknown",
      required: required.has(name),
      description: stringValue(property.description),
      defaultValue: property.default === undefined ? "" : stringValue(property.default),
      enumValues,
    };
  });
}

export function buildDesktopSkillRows(payload: unknown, config: unknown = {}): DesktopSkillRow[] {
  const skills = arrayFromPayload(payload, "skills");
  const enabledSkills = arrayValue(asRecord(asRecord(config).skills).enabled).map((item) => stringValue(item));
  const allEnabled = !enabledSkills.length || enabledSkills.includes("*");
  return skills.map((skill) => buildDesktopSkillRow(skill, allEnabled, enabledSkills));
}

export function buildDesktopSkillDetailView(detail: unknown, listItem: unknown = {}): DesktopSkillDetailView {
  const payload = asRecord(detail);
  const metadata = asRecord(payload.metadata);
  const tinybotMeta = asRecord(pick(payload, "tinybot_meta", "tinybotMeta"));
  const list = asRecord(listItem);
  const source = stringValue(list.source) || stringValue(payload.source) || "unknown";
  return {
    name: stringValue(payload.name),
    description: stringValue(pick(tinybotMeta, "description")) || stringValue(pick(metadata, "description")),
    always: pick(tinybotMeta, "always") === true || pick(metadata, "always") === true,
    content: stringValue(payload.content),
    source,
    deletable: source === "workspace",
    nameEditable: false,
    validation: {
      state: "idle",
      message: "",
    },
  };
}

export function buildDesktopSkillCreateRequest(form: DesktopSkillFormInput): DesktopSkillRequest {
  return {
    method: "POST",
    path: "/api/skills",
    body: {
      name: stringValue(form.name).trim(),
      description: stringValue(form.description).trim(),
      content: stringValue(form.content),
      always: form.always === true,
    },
  };
}

export function buildDesktopSkillUpdateRequest(name: string, form: DesktopSkillFormInput): DesktopSkillRequest {
  return {
    method: "PATCH",
    path: `/api/skills/${encodePathSegment(name)}`,
    body: {
      description: stringValue(form.description).trim(),
      content: stringValue(form.content),
      always: form.always === true,
    },
  };
}

export function buildDesktopSkillDeleteRequest(name: string): DesktopSkillRequest {
  return {
    method: "DELETE",
    path: `/api/skills/${encodePathSegment(name)}`,
  };
}

export function buildDesktopSkillValidateRequest(name: string): DesktopSkillRequest {
  return {
    method: "POST",
    path: `/api/skills/${encodePathSegment(name)}/validate`,
  };
}

export function buildDesktopSkillTogglePatch(
  skillName: string,
  enable: boolean,
  skills: unknown,
  config: unknown = {},
): UnknownRecord {
  const currentEnabled = arrayValue(asRecord(asRecord(config).skills).enabled).map((item) => stringValue(item));
  const isAllEnabled = !currentEnabled.length || currentEnabled.includes("*");
  let nextEnabled: string[];

  if (enable) {
    nextEnabled = isAllEnabled ? ["*"] : Array.from(new Set([...currentEnabled, skillName]));
  } else if (isAllEnabled) {
    nextEnabled = arrayFromPayload(skills, "skills")
      .filter((skill) => skill.available !== false && skill.name !== skillName && skill.always !== true)
      .map((skill) => stringValue(skill.name))
      .filter(Boolean);
  } else {
    nextEnabled = currentEnabled.filter((name) => name !== skillName);
  }

  return {
    skills: {
      enabled: nextEnabled,
    },
  };
}

function buildDesktopToolRow(tool: UnknownRecord, config: unknown): DesktopToolRow {
  const name = stringValue(tool.name);
  const schemaFields = buildDesktopToolSchemaFields(tool.parameters);
  const enabled = resolveDesktopToolEnabled(name, config);
  return {
    name,
    displayName: TOOL_DISPLAY_NAMES[name] || name,
    description: stringValue(tool.description),
    enabled,
    configHint: resolveDesktopToolConfigHint(name, config),
    riskHint: resolveDesktopToolRiskHint(name),
    schemaFields,
    schemaText: stringifySchema(tool.parameters),
    meta: [enabled ? "" : "disabled", schemaFields.length ? `${schemaFields.length} parameters` : "no parameters"]
      .filter(Boolean)
      .join(" / "),
    raw: tool,
  };
}

function buildDesktopSkillRow(skill: UnknownRecord, allEnabled: boolean, enabledSkills: string[]): DesktopSkillRow {
  const name = stringValue(skill.name);
  const source = stringValue(skill.source) || "unknown";
  const available = skill.available !== false;
  const always = skill.always === true;
  const enabled = available && (always || allEnabled || enabledSkills.includes(name));
  const status: DesktopSkillStatus = !available ? "unavailable" : always ? "always" : enabled ? "enabled" : "disabled";
  return {
    name,
    source,
    available,
    always,
    enabled,
    status,
    deletable: source === "workspace",
    meta: [source, status].filter(Boolean).join(" / "),
    raw: skill,
  };
}

function resolveDesktopToolEnabled(name: string, config: unknown): boolean {
  return resolveDesktopToolConfigHint(name, config) === "";
}

function resolveDesktopToolConfigHint(name: string, config: unknown): DesktopToolConfigHint {
  const tools = asRecord(asRecord(config).tools);
  if (name === "exec" && asRecord(tools.exec).enable !== true) {
    return "execDisabled";
  }
  if ((name === "web" || name === "web_search" || name === "search") && asRecord(tools.web).enable !== true) {
    return "webDisabled";
  }
  return "";
}

function resolveDesktopToolRiskHint(name: string): DesktopToolRiskHint {
  if (name === "write_file" || name === "exec") {
    return "modifyFiles";
  }
  if (name === "spawn" || name === "cron") {
    return "background";
  }
  return "";
}

function stringifySchema(schema: unknown): string {
  if (schema === undefined || schema === null || schema === "") {
    return "";
  }
  try {
    return typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}

function arrayFromPayload(payload: unknown, ...keys: string[]): UnknownRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const record = asRecord(payload);
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
