import { BOOTSTRAP_FILE_ORDER, type BootstrapFile } from "./contextTypes.ts";

export type SystemPromptInput = {
  identity: string;
  bootstrapFiles?: BootstrapFile[];
  activeSkillsContent?: string;
  skillsSummary?: string;
  includeDeferredSkillsPlaceholder?: boolean;
};

export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts = [input.identity];
  const bootstrap = formatBootstrapFiles(input.bootstrapFiles ?? []);
  if (bootstrap.length > 0) {
    parts.push(bootstrap);
  }
  const activeSkillsContent = input.activeSkillsContent?.trim();
  const skillsSummary = input.skillsSummary?.trim();
  if (activeSkillsContent) {
    parts.push(`# Active Skills\n\n${activeSkillsContent}`);
  }
  if (skillsSummary) {
    parts.push(
      [
        "# Skills",
        "",
        "The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.",
        'Skills with available="false" need dependencies installed first - you can try installing them with apt/brew.',
        "",
        skillsSummary,
      ].join("\n"),
    );
  }
  if (!activeSkillsContent && !skillsSummary && (input.includeDeferredSkillsPlaceholder ?? true)) {
    parts.push("# Active Skills\n\n(deferred in TS context phase 1)");
  }
  return parts.join("\n\n---\n\n");
}

export function includedBootstrapPaths(files: BootstrapFile[] = []): string[] {
  return sortedBootstrapFiles(files)
    .filter((file) => nonempty(file.contents))
    .map((file) => file.path);
}

function formatBootstrapFiles(files: BootstrapFile[]): string {
  return sortedBootstrapFiles(files)
    .filter((file) => nonempty(file.contents))
    .map((file) => `## ${file.path}\n\n${file.contents}`)
    .join("\n\n");
}

function sortedBootstrapFiles(files: BootstrapFile[]): BootstrapFile[] {
  return [...files].sort((left, right) => {
    const leftIndex = bootstrapIndex(left.path);
    const rightIndex = bootstrapIndex(right.path);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.path.localeCompare(right.path);
  });
}

function bootstrapIndex(path: string): number {
  const index = BOOTSTRAP_FILE_ORDER.indexOf(path as (typeof BOOTSTRAP_FILE_ORDER)[number]);
  return index === -1 ? BOOTSTRAP_FILE_ORDER.length : index;
}

function nonempty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
