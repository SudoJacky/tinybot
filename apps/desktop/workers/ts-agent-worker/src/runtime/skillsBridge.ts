import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { JsonObject } from "../protocol/messages.ts";
import { SkillsRuntime, type SkillStoreEntry } from "../skills/skillsRuntime.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { SkillsBridge } from "./agentWorker.ts";

export class NativeSkillsBridge implements SkillsBridge {
  private readonly rpcClient: NativeRpcClient;
  private readonly env: Record<string, string | undefined>;

  constructor(rpcClient: NativeRpcClient, env: Record<string, string | undefined> = process.env) {
    this.rpcClient = rpcClient;
    this.env = env;
  }

  async listWebuiSkills(traceId: string): Promise<unknown> {
    const [enabledSkills, runtime] = await Promise.all([
      this.loadEnabledSkills(traceId),
      this.loadRuntime(traceId),
    ]);
    return runtime.buildWebuiList(enabledSkills);
  }

  async getWebuiSkillDetail(name: string, traceId: string): Promise<unknown> {
    return (await this.loadRuntime(traceId)).buildWebuiDetail(name);
  }

  async createWebuiSkill(body: Record<string, unknown>, traceId: string): Promise<unknown> {
    const name = normalizeSkillName(pythonTruthyString(body.name) ?? "");
    if (!name) {
      throw new NativeWebuiSkillError("name is required", 400);
    }
    if (name.length > 64) {
      throw new NativeWebuiSkillError("skill name too long (max 64 chars)", 400);
    }
    const existing = await this.loadSkillEntries(traceId);
    if (existing.some((skill) => skill.name === name && skill.source === "workspace")) {
      throw new NativeWebuiSkillError(`skill '${name}' already exists`, 409);
    }
    const description = body.description === undefined ? `Custom skill: ${name}` : String(body.description);
    const always = pythonTruthy(body.always);
    const path = skillFilePath(name);
    try {
      const content = createSkillBodyContent(body.content, always);
      const contents = createSkillContent(name, description, content, always);
      await this.rpcClient.request(traceId, "workspace.write_file", { path, contents });
      for (const resource of normalizeSkillResources(body.resources)) {
        await this.rpcClient.request(traceId, "workspace.create_dir", {
          path: `${skillDirPath(name)}/${resource}`,
        });
      }
    } catch (error) {
      await this.cleanupCreatedSkill(name, traceId);
      throw new NativeWebuiSkillError(`failed to create skill: ${errorMessage(error)}`, 500);
    }
    return {
      created: true,
      name,
      path,
      message: `Skill '${name}' created successfully`,
    };
  }

  async updateWebuiSkill(name: string, body: Record<string, unknown>, traceId: string): Promise<unknown> {
    const path = skillFilePath(name);
    const file = asObject(await this.rpcClient.request(traceId, "workspace.read_file", { path, format: "raw" }));
    const currentContent = asString(file?.content) ?? asString(file?.contents);
    if (currentContent === undefined) {
      throw new NativeWebuiSkillError("skill not found", 404);
    }
    const contents = updateSkillContent(currentContent, name, body);
    await this.rpcClient.request(traceId, "workspace.write_file", { path, contents });
    return { updated: true, name, path };
  }

  async deleteWebuiSkill(name: string, traceId: string): Promise<unknown> {
    const result = asObject(await this.rpcClient.request(traceId, "skills.list", {}));
    const entry = normalizeSkillEntries(result?.skills).find((skill) => skill.name === name);
    if (!entry) {
      throw new NativeWebuiSkillError("skill not found", 404);
    }
    if (entry?.source === "builtin") {
      throw new NativeWebuiSkillError("cannot delete builtin skills", 403);
    }
    await this.rpcClient.request(traceId, "workspace.delete_file", {
      path: skillDirPath(name),
      recursive: true,
    });
    return { deleted: true, name };
  }

  async validateWebuiSkill(name: string, traceId: string): Promise<unknown> {
    const path = skillFilePath(name);
    const listing = await this.loadSkillDirectory(name, traceId);
    const file = asObject(await this.rpcClient.request(traceId, "workspace.read_file", { path, format: "raw" }));
    const content = asString(file?.content) ?? asString(file?.contents);
    if (content === undefined) {
      return { name, valid: false, message: "SKILL.md not found" };
    }
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      return { name, valid: false, message: "Invalid frontmatter format" };
    }
    const result = validateSkillFrontmatter(name, frontmatter);
    if (!result.valid) {
      return result;
    }
    return validateSkillChildren(name, listing?.entries);
  }

  private async loadRuntime(traceId: string): Promise<SkillsRuntime> {
    return new SkillsRuntime({
      skills: await this.loadSkillEntries(traceId),
      hasBin: (name) => hasExecutableOnPath(name, this.env),
      hasEnv: (name) => this.env[name] !== undefined,
    });
  }

  private async loadSkillEntries(traceId: string): Promise<SkillStoreEntry[]> {
    const result = asObject(await this.rpcClient.request(traceId, "skills.list", {}));
    return normalizeSkillEntries(result?.skills);
  }

  private async loadEnabledSkills(traceId: string): Promise<string[] | undefined> {
    try {
      const result = asObject(await this.rpcClient.request(traceId, "config.snapshot_public", {}));
      const snapshot = asObject(result?.value);
      const skills = asObject(snapshot?.skills);
      return Array.isArray(skills?.enabled) ? normalizeStringArray(skills.enabled) : undefined;
    } catch {
      return undefined;
    }
  }

  private async loadSkillDirectory(name: string, traceId: string): Promise<JsonObject | undefined> {
    try {
      return asObject(await this.rpcClient.request(traceId, "workspace.list_dir", {
        path: skillDirPath(name),
        recursive: false,
      }));
    } catch {
      throw new NativeWebuiSkillError("skill not found", 404);
    }
  }

  private async cleanupCreatedSkill(name: string, traceId: string): Promise<void> {
    try {
      await this.rpcClient.request(traceId, "workspace.delete_file", {
        path: skillDirPath(name),
        recursive: true,
      });
    } catch {
      // Match Python's best-effort cleanup: creation still reports the original error.
    }
  }
}

export class NativeWebuiSkillError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NativeWebuiSkillError";
    this.status = status;
  }
}

function createSkillContent(name: string, description: string, content: string, always: boolean): string {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
  ];
  if (always) {
    lines.push("always: true");
  }
  lines.push(
    "---",
    "",
    `# ${titleCaseSkillName(name)}`,
    "",
    content || "[TODO: Add skill instructions here]",
  );
  return lines.join("\n");
}

function updateSkillContent(currentContent: string, name: string, body: Record<string, unknown>): string {
  const match = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatterLines = ["---"];
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator === -1) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === "description" && body.description !== undefined) {
        frontmatterLines.push(`description: ${String(body.description)}`);
      } else if (key === "always" && body.always !== undefined) {
        frontmatterLines.push(`always: ${String(body.always).toLowerCase()}`);
      } else {
        frontmatterLines.push(`${key}: ${value}`);
      }
    }
    if (body.description !== undefined && !frontmatterLines.some((line) => line.startsWith("description:"))) {
      frontmatterLines.push(`description: ${String(body.description)}`);
    }
    if (body.always !== undefined && !frontmatterLines.some((line) => line.startsWith("always:"))) {
      frontmatterLines.push(`always: ${String(body.always).toLowerCase()}`);
    }
  } else {
    frontmatterLines.push(`name: ${name}`);
    frontmatterLines.push(`description: ${asString(body.description) ?? name}`);
    if (body.always === true) {
      frontmatterLines.push("always: true");
    }
  }
  frontmatterLines.push("---");
  const bodyStart = match ? match[0].length : 0;
  const bodyContent = Object.prototype.hasOwnProperty.call(body, "content")
    ? updateSkillBodyContent(body.content)
    : currentContent.slice(bodyStart).trim();
  return `${frontmatterLines.join("\n")}\n${bodyContent}`;
}

function validateSkillFrontmatter(name: string, frontmatter: Record<string, string>): { name: string; valid: boolean; message: string } {
  if (!("name" in frontmatter)) {
    return { name, valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!("description" in frontmatter)) {
    return { name, valid: false, message: "Missing 'description' in frontmatter" };
  }
  const skillName = frontmatter.name;
  if (skillName !== name) {
    return { name, valid: false, message: `Skill name '${skillName}' must match directory name '${name}'` };
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    return { name, valid: false, message: "Name should be hyphen-case (lowercase letters, digits, hyphens)" };
  }
  if (!frontmatter.description.trim()) {
    return { name, valid: false, message: "Description cannot be empty" };
  }
  return { name, valid: true, message: "Skill is valid" };
}

function validateSkillChildren(name: string, entries: unknown): { name: string; valid: boolean; message: string } {
  if (!Array.isArray(entries)) {
    return { name, valid: true, message: "Skill is valid" };
  }
  const allowedDirs = new Set(["scripts", "references", "assets"]);
  for (const entry of entries) {
    const object = asObject(entry);
    const entryPath = asString(object?.path);
    if (!entryPath) {
      continue;
    }
    const childName = entryPath.split(/[\\/]/).at(-1) ?? entryPath;
    if (childName === "SKILL.md") {
      continue;
    }
    if (object?.kind === "symlink") {
      continue;
    }
    if (object?.kind === "dir" && allowedDirs.has(childName)) {
      continue;
    }
    return {
      name,
      valid: false,
      message: `Unexpected file/directory: ${childName}. Only scripts/, references/, assets/ allowed`,
    };
  }
  return { name, valid: true, message: "Skill is valid" };
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return frontmatter;
}

function normalizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function titleCaseSkillName(name: string): string {
  return name.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function skillDirPath(name: string): string {
  return `skills/${name}`;
}

function skillFilePath(name: string): string {
  return `${skillDirPath(name)}/SKILL.md`;
}

const ALLOWED_SKILL_RESOURCE_DIRS = new Set<string>(["scripts", "references", "assets"]);

function normalizeSkillResources(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const resources: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !ALLOWED_SKILL_RESOURCE_DIRS.has(item) || seen.has(item)) {
      continue;
    }
    seen.add(item);
    resources.push(item);
  }
  return resources;
}

function normalizeSkillEntries(value: unknown): SkillStoreEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const object = asObject(entry);
    const name = asString(object?.name);
    const path = asString(object?.path);
    const source = asString(object?.source);
    const content = asString(object?.content);
    if (!name || !path || (source !== "workspace" && source !== "builtin") || content === undefined) {
      return null;
    }
    return { name, path, source, content };
  }).filter((skill): skill is SkillStoreEntry => skill !== null);
}

function hasExecutableOnPath(name: string, env: Record<string, string | undefined>): boolean {
  const paths = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return paths.some((path) => extensions.some((extension) => existsSync(join(path, `${name}${extension}`))));
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function createSkillBodyContent(value: unknown, always: boolean): string {
  if (value === undefined || typeof value === "string") {
    return value ?? "";
  }
  if (!pythonTruthy(value)) {
    return "";
  }
  const itemIndex = always ? 8 : 7;
  throw new TypeError(`sequence item ${itemIndex}: expected str instance, ${pythonTypeName(value)} found`);
}

function updateSkillBodyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError(`can only concatenate str (not "${pythonTypeName(value)}") to str`);
}

function pythonTypeName(value: unknown): string {
  if (value === null) {
    return "NoneType";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "bigint") {
    return "int";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  if (typeof value === "object" && value !== null) {
    return "dict";
  }
  return typeof value;
}

function pythonTruthyString(value: unknown): string | undefined {
  return pythonTruthy(value) ? String(value) : undefined;
}

function pythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
