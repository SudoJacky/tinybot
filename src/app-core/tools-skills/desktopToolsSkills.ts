export type DesktopToolConfigHint = "webDisabled" | "execDisabled" | "";
export type DesktopToolRiskHint = "modifyFiles" | "background" | "";
export type DesktopSkillStatus = "enabled" | "disabled" | "always" | "unavailable";
export type DesktopSkillEditorMode = "create" | "edit";
export type DesktopSkillEditorField = "name" | "description" | "content" | "always";
export type DesktopSkillSaveStatus = "idle" | "saving" | "saved" | "failed";

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

export interface DesktopSkillValidationState {
  state: "idle" | "valid" | "invalid";
  message: string;
}

export interface DesktopSkillDraft {
  name: string;
  description: string;
  content: string;
  always: boolean;
}

export interface DesktopSkillEditorState {
  mode: DesktopSkillEditorMode;
  draft: DesktopSkillDraft;
  lastSaved: DesktopSkillDraft;
  dirty: boolean;
  canSave: boolean;
  saveStatus: DesktopSkillSaveStatus;
  saveMessage: string;
  validation: DesktopSkillValidationState;
}

export interface DesktopSkillEditorInput {
  mode?: DesktopSkillEditorMode;
  draft?: Partial<DesktopSkillFormInput>;
  lastSaved?: Partial<DesktopSkillFormInput>;
  saveStatus?: DesktopSkillSaveStatus;
  saveError?: string;
  validation?: DesktopSkillValidationState;
}

export interface DesktopSkillPaneDetailView extends DesktopSkillDetailView {
  available: boolean;
  editor: DesktopSkillEditorState;
  actions: {
    create: boolean;
    save: boolean;
    delete: boolean;
    validate: boolean;
    toggleAlways: boolean;
  };
}

export interface DesktopToolsSkillsPaneModel {
  status: string;
  toolRows: DesktopToolRow[];
  skillRows: DesktopSkillRow[];
  selectedTool: DesktopToolDetailView | null;
  selectedSkill: DesktopSkillPaneDetailView | null;
}

export interface DesktopToolsSkillsPaneInput {
  toolsPayload?: unknown;
  skillsPayload?: unknown;
  config?: unknown;
  selectedToolName?: string | null;
  selectedSkillName?: string | null;
  selectedSkillDetail?: unknown;
  skillEditor?: DesktopSkillEditorInput;
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

export function buildDesktopToolsSkillsPaneModel(input: DesktopToolsSkillsPaneInput = {}): DesktopToolsSkillsPaneModel {
  const config = input.config ?? {};
  const toolRows = buildDesktopToolRows(input.toolsPayload ?? {}, config);
  const skillRows = buildDesktopSkillRows(input.skillsPayload ?? {}, config);
  const selectedToolRow = toolRows.find((tool) => tool.name === input.selectedToolName) ?? toolRows[0] ?? null;
  const selectedSkillRow = skillRows.find((skill) => skill.name === input.selectedSkillName) ?? skillRows[0] ?? null;
  const selectedTool = selectedToolRow ? buildDesktopToolDetailView(selectedToolRow.raw, config) : null;
  const selectedSkill = input.skillEditor?.mode === "create"
    ? buildDesktopSkillPaneDetailView(null, { name: "", source: "workspace", available: true }, input.skillEditor)
    : selectedSkillRow
      ? buildDesktopSkillPaneDetailView(input.selectedSkillDetail ?? selectedSkillRow.raw, selectedSkillRow.raw, input.skillEditor)
      : null;
  return {
    status: `${toolRows.length} ${toolRows.length === 1 ? "tool" : "tools"} / ${skillRows.length} ${skillRows.length === 1 ? "skill" : "skills"}`,
    toolRows,
    skillRows,
    selectedTool,
    selectedSkill,
  };
}

export function updateDesktopSkillEditorDraft(
  pane: DesktopToolsSkillsPaneModel,
  field: DesktopSkillEditorField,
  value: string | boolean,
): DesktopToolsSkillsPaneModel {
  if (!pane.selectedSkill) {
    return pane;
  }
  const previous = pane.selectedSkill.editor;
  const draft = normalizeDesktopSkillDraft({
    ...previous.draft,
    [field]: field === "always" ? value === true : stringValue(value),
  });
  const editor = buildDesktopSkillEditorStateFromDraft(previous.mode, draft, previous.lastSaved, {
    saveStatus: "idle",
    validation: { state: "idle", message: "" },
  });
  return {
    ...pane,
    selectedSkill: {
      ...pane.selectedSkill,
      name: previous.mode === "create" ? "" : draft.name,
      description: draft.description,
      content: draft.content,
      always: draft.always,
      editor,
      actions: desktopSkillPaneActions(pane.selectedSkill.available, pane.selectedSkill.deletable, editor),
    },
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

function buildDesktopSkillPaneDetailView(
  detail: unknown,
  listItem: unknown,
  editorInput: DesktopSkillEditorInput = {},
): DesktopSkillPaneDetailView {
  const row = asRecord(listItem);
  const mode = editorInput.mode ?? "edit";
  const view = mode === "create"
    ? createDesktopSkillDraftDetailView(editorInput)
    : buildDesktopSkillDetailView(detail, row);
  const editor = buildDesktopSkillEditorState(view, editorInput);
  return {
    ...view,
    available: row.available !== false,
    description: editor.draft.description,
    content: editor.draft.content,
    always: editor.draft.always,
    source: mode === "create" ? "workspace" : view.source,
    deletable: mode === "create" ? false : view.deletable,
    nameEditable: mode === "create",
    validation: editor.validation,
    editor,
    actions: desktopSkillPaneActions(row.available !== false, mode === "create" ? false : view.deletable, editor),
  };
}

function createDesktopSkillDraftDetailView(editorInput: DesktopSkillEditorInput): DesktopSkillDetailView {
  const draft = normalizeDesktopSkillDraft(editorInput.draft ?? {});
  return {
    name: "",
    description: draft.description,
    always: draft.always,
    content: draft.content,
    source: "workspace",
    deletable: false,
    nameEditable: true,
    validation: editorInput.validation ?? { state: "idle", message: "" },
  };
}

function buildDesktopSkillEditorState(
  detail: DesktopSkillDetailView,
  input: DesktopSkillEditorInput = {},
): DesktopSkillEditorState {
  const mode = input.mode ?? "edit";
  const detailDraft = normalizeDesktopSkillDraft({
    name: detail.name,
    description: detail.description,
    content: detail.content,
    always: detail.always,
  });
  const lastSaved = normalizeDesktopSkillDraft({ ...detailDraft, ...(input.lastSaved ?? {}) });
  const draft = normalizeDesktopSkillDraft({ ...detailDraft, ...(input.draft ?? {}) });
  return buildDesktopSkillEditorStateFromDraft(mode, draft, lastSaved, input);
}

function buildDesktopSkillEditorStateFromDraft(
  mode: DesktopSkillEditorMode,
  draft: DesktopSkillDraft,
  lastSaved: DesktopSkillDraft,
  input: Pick<DesktopSkillEditorInput, "saveStatus" | "saveError" | "validation"> = {},
): DesktopSkillEditorState {
  const dirty = !desktopSkillDraftsEqual(draft, lastSaved);
  const saveStatus = input.saveStatus ?? "idle";
  return {
    mode,
    draft,
    lastSaved,
    dirty,
    canSave: dirty && draft.name.trim().length > 0,
    saveStatus,
    saveMessage: desktopSkillSaveMessage(saveStatus, dirty, input.saveError),
    validation: input.validation ?? { state: "idle", message: "" },
  };
}

function desktopSkillPaneActions(
  available: boolean,
  deletable: boolean,
  editor: DesktopSkillEditorState,
): DesktopSkillPaneDetailView["actions"] {
  const existing = editor.mode === "edit";
  return {
    create: true,
    save: available && editor.draft.name.trim().length > 0,
    delete: existing && deletable,
    validate: existing && available,
    toggleAlways: existing && available,
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

function normalizeDesktopSkillDraft(value: Partial<DesktopSkillFormInput>): DesktopSkillDraft {
  return {
    name: stringValue(value.name).trim(),
    description: stringValue(value.description),
    content: stringValue(value.content),
    always: value.always === true,
  };
}

function desktopSkillDraftsEqual(left: DesktopSkillDraft, right: DesktopSkillDraft): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.content === right.content
    && left.always === right.always;
}

function desktopSkillSaveMessage(status: DesktopSkillSaveStatus, dirty: boolean, error?: string): string {
  if (status === "saving") {
    return "Saving skill";
  }
  if (status === "saved") {
    return "Skill saved";
  }
  if (status === "failed") {
    return error || "Skill save failed";
  }
  return dirty ? "Unsaved changes" : "No changes";
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
