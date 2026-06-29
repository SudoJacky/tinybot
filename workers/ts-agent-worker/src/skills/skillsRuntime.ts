import type { SkillsContext } from "../agent/contextTypes.ts";

export type SkillSource = "workspace" | "builtin";

export type SkillInfo = {
  name: string;
  path: string;
  source: SkillSource;
};

export type SkillStoreEntry = SkillInfo & {
  content: string;
};

export type SkillsRuntimeOptions = {
  skills: SkillStoreEntry[];
  hasBin?: (name: string) => boolean;
  hasEnv?: (name: string) => boolean;
};

export type ListSkillsOptions = {
  filterUnavailable?: boolean;
};

export type SkillListItem = SkillInfo & {
  description: string;
  available: boolean;
  enabled: boolean;
  always: boolean;
  missing_requirements?: string;
};

export type SkillDetail = {
  name: string;
  content: string;
  raw_content: string;
  metadata: SkillMetadata;
  tinybot_meta: TinybotSkillMetadata;
  available: boolean;
};

type SkillMetadata = Record<string, string>;
type TinybotSkillMetadata = Record<string, unknown>;

export class SkillsRuntime {
  private readonly skills: SkillStoreEntry[];
  private readonly hasBin: (name: string) => boolean;
  private readonly hasEnv: (name: string) => boolean;

  constructor(options: SkillsRuntimeOptions) {
    this.skills = discoverSkills(options.skills);
    this.hasBin = options.hasBin ?? (() => false);
    this.hasEnv = options.hasEnv ?? (() => false);
  }

  static isSkillEnabled(name: string, enabledList: string[] | undefined | null): boolean {
    return !enabledList?.length || enabledList.includes("*") || enabledList.includes(name);
  }

  listSkills(options: ListSkillsOptions = {}): SkillInfo[] {
    const filterUnavailable = options.filterUnavailable ?? true;
    return this.skills
      .filter((skill) => !filterUnavailable || this.isAvailable(this.getSkillMeta(skill.name)))
      .map(({ name, path, source }) => ({ name, path, source }));
  }

  loadSkill(name: string): string | null {
    return this.skills.find((skill) => skill.name === name)?.content ?? null;
  }

  loadSkillsForContext(skillNames: string[]): string {
    const parts = skillNames.flatMap((name) => {
      const content = this.loadSkill(name);
      return content ? [`### Skill: ${name}\n\n${stripFrontmatter(content)}`] : [];
    });
    return parts.join("\n\n---\n\n");
  }

  buildContext(enabledSkills?: string[] | null): SkillsContext {
    const alwaysSkillNames = this.getAlwaysSkills(enabledSkills);
    const allSkills = this.listSkills({ filterUnavailable: false });
    const sourceCounts = {
      workspace: allSkills.filter((skill) => skill.source === "workspace").length,
      builtin: allSkills.filter((skill) => skill.source === "builtin").length,
    };
    return {
      activeSkillsContent: this.loadSkillsForContext(alwaysSkillNames),
      skillsSummary: this.buildSkillsSummary(enabledSkills),
      alwaysSkillNames,
      unavailableCount: allSkills.filter((skill) => !this.isAvailable(this.getSkillMeta(skill.name))).length,
      sourceCounts,
    };
  }

  buildSkillsSummary(enabledSkills?: string[] | null): string {
    const skills = this.listSkills({ filterUnavailable: false })
      .filter((skill) => SkillsRuntime.isSkillEnabled(skill.name, enabledSkills));
    if (!skills.length) {
      return "";
    }

    const lines = ["<skills>"];
    for (const skill of skills) {
      const skillMeta = this.getSkillMeta(skill.name);
      const available = this.isAvailable(skillMeta);
      lines.push(`  <skill available="${String(available)}">`);
      lines.push(`    <name>${escapeXml(skill.name)}</name>`);
      lines.push(`    <description>${escapeXml(this.getSkillDescription(skill.name))}</description>`);
      lines.push(`    <location>${skill.path}</location>`);
      if (!available) {
        const missing = this.missingRequirements(skillMeta);
        if (missing) {
          lines.push(`    <requires>${escapeXml(missing)}</requires>`);
        }
      }
      lines.push("  </skill>");
    }
    lines.push("</skills>");
    return lines.join("\n");
  }

  buildWebuiList(enabledSkills?: string[] | null): { skills: SkillListItem[] } {
    const skills = this.listSkills({ filterUnavailable: false }).map((skill) => {
      const skillMeta = this.getSkillMeta(skill.name);
      const available = this.isAvailable(skillMeta);
      const item: SkillListItem = {
        ...skill,
        description: this.getSkillDescription(skill.name),
        available,
        enabled: SkillsRuntime.isSkillEnabled(skill.name, enabledSkills),
        always: booleanValue(skillMeta.always),
      };
      if (!available) {
        const missingRequirements = this.missingRequirements(skillMeta);
        if (missingRequirements) {
          item.missing_requirements = missingRequirements;
        }
      }
      return item;
    });
    return { skills };
  }

  buildWebuiDetail(name: string): SkillDetail | null {
    const content = this.loadSkill(name);
    if (!content) {
      return null;
    }

    const metadata = this.getSkillMetadata(name) ?? {};
    const skillMeta = this.frontmatterTinybotMeta(metadata);
    return {
      name,
      content: stripFrontmatter(content),
      raw_content: content,
      metadata,
      tinybot_meta: skillMeta,
      available: this.isAvailable(skillMeta),
    };
  }

  getAlwaysSkills(enabledSkills?: string[] | null): string[] {
    return this.listSkills({ filterUnavailable: true })
      .filter((skill) => SkillsRuntime.isSkillEnabled(skill.name, enabledSkills))
      .filter((skill) => {
        const metadata = this.getSkillMetadata(skill.name) ?? {};
        return booleanValue(this.frontmatterTinybotMeta(metadata).always);
      })
      .map((skill) => skill.name);
  }

  getSkillMetadata(name: string): SkillMetadata | null {
    const content = this.loadSkill(name);
    return content ? parseFrontmatter(content) : null;
  }

  private getSkillDescription(name: string): string {
    return this.getSkillMetadata(name)?.description || name;
  }

  private getSkillMeta(name: string): TinybotSkillMetadata {
    return this.frontmatterTinybotMeta(this.getSkillMetadata(name) ?? {});
  }

  private frontmatterTinybotMeta(metadata: SkillMetadata): TinybotSkillMetadata {
    const skillMeta = { ...parseTinybotMetadata(metadata.metadata) };
    if (metadata.always !== undefined && skillMeta.always === undefined) {
      skillMeta.always = booleanValue(metadata.always);
    }
    return skillMeta;
  }

  private isAvailable(skillMeta: TinybotSkillMetadata): boolean {
    return !this.missingRequirements(skillMeta);
  }

  private missingRequirements(skillMeta: TinybotSkillMetadata): string {
    const missing: string[] = [];
    const requires = asRecord(skillMeta.requires);
    for (const bin of stringList(requires?.bins)) {
      if (!this.hasBin(bin)) {
        missing.push(`CLI: ${bin}`);
      }
    }
    for (const env of stringList(requires?.env)) {
      if (!this.hasEnv(env)) {
        missing.push(`ENV: ${env}`);
      }
    }
    return missing.join(", ");
  }
}

function discoverSkills(skills: SkillStoreEntry[]): SkillStoreEntry[] {
  const discovered: SkillStoreEntry[] = [];
  const seen = new Set<string>();
  for (const source of ["workspace", "builtin"] as const) {
    for (const skill of skills) {
      if (skill.source !== source || seen.has(skill.name)) {
        continue;
      }
      seen.add(skill.name);
      discovered.push(skill);
    }
  }
  return discovered;
}

function parseFrontmatter(content: string): SkillMetadata | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const metadata: SkillMetadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content;
}

function parseTinybotMetadata(raw: unknown): TinybotSkillMetadata {
  if (typeof raw !== "string" || raw.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    const object = asRecord(parsed);
    return asRecord(object?.tinybot) ?? asRecord(object?.openclaw) ?? {};
  } catch {
    return {};
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanValue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
