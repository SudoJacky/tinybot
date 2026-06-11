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

  private async loadRuntime(traceId: string): Promise<SkillsRuntime> {
    const result = asObject(await this.rpcClient.request(traceId, "skills.list", {}));
    return new SkillsRuntime({
      skills: normalizeSkillEntries(result?.skills),
      hasBin: (name) => hasExecutableOnPath(name, this.env),
      hasEnv: (name) => this.env[name] !== undefined,
    });
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
