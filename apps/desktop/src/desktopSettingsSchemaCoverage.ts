import type { DesktopSettingsPaneModel } from "./desktopSettingsProviders";

export type DesktopSettingsDisposition =
  | "essential"
  | "advanced"
  | "expert-editor"
  | "managed-elsewhere"
  | "runtime-only"
  | "unsupported";

export type DesktopSettingsSchemaCoverageIssue = {
  field: string;
  persistentPath: string;
  code: "missing_disposition" | "non_canonical_alias" | "duplicate_editable_owner";
  owner?: string;
};

type DispositionRule = {
  pattern: RegExp;
  disposition: DesktopSettingsDisposition;
};

const DISPOSITION_RULES: DispositionRule[] = [
  { pattern: /^agents\.defaults\.(model|provider|activeProfile|temperature|timezone|workspace|maxTokens|contextWindowTokens|maxToolIterations|reasoningEffort)$/, disposition: "essential" },
  { pattern: /^agents\.defaults\.(contextBlockLimit|maxToolResultChars|embedding\..+)$/, disposition: "advanced" },
  { pattern: /^providers\.[^.]+\.(api_key|api_base|enabled|models)$/, disposition: "essential" },
  { pattern: /^providers\.profiles\.[^.]+\.(provider|api_key|api_base|enabled|models)$/, disposition: "essential" },
  { pattern: /^knowledge\..+$/, disposition: "advanced" },
  { pattern: /^tools\.(mcpServers|restrictToWorkspace|ssrfWhitelist)(\.|$)/, disposition: "advanced" },
  { pattern: /^tools\.(web|exec)(\.|$)/, disposition: "advanced" },
  { pattern: /^channels\..+$/, disposition: "advanced" },
  { pattern: /^gateway\.(host|port|heartbeat\.(enabled|intervalS))$/, disposition: "essential" },
  { pattern: /^desktop\.ui\..+$/, disposition: "managed-elsewhere" },
];

export function getDesktopSettingsPathDisposition(path: string): DesktopSettingsDisposition | undefined {
  return DISPOSITION_RULES.find((rule) => rule.pattern.test(path))?.disposition;
}

export function canonicalizeDesktopSettingsPersistentPath(path: string): string {
  return path
    .replace(/^agents\.defaults\.active_profile$/, "agents.defaults.activeProfile")
    .replace(/^agents\.defaults\.max_tokens$/, "agents.defaults.maxTokens")
    .replace(/^agents\.defaults\.reasoning_effort$/, "agents.defaults.reasoningEffort")
    .replace(/^agents\.defaults\.context_block_limit$/, "agents.defaults.contextBlockLimit")
    .replace(/^agents\.defaults\.context_window_tokens$/, "agents.defaults.contextWindowTokens")
    .replace(/^agents\.defaults\.max_tool_result_chars$/, "agents.defaults.maxToolResultChars")
    .replace(/^agents\.defaults\.max_tool_iterations$/, "agents.defaults.maxToolIterations")
    .replace(/^tools\.mcp_servers(?=\.|$)/, "tools.mcpServers")
    .replace(/^tools\.ssrf_whitelist(?=\.|$)/, "tools.ssrfWhitelist")
    .replace(/^channels\.send_progress(?=\.|$)/, "channels.sendProgress")
    .replace(/^gateway\.heartbeat\.interval_s$/, "gateway.heartbeat.intervalS")
    .replace(/^knowledge\.chunk_size$/, "knowledge.chunkSize")
    .replace(/^knowledge\.chunk_overlap$/, "knowledge.chunkOverlap")
    .replace(/^knowledge\.retrieval_mode$/, "knowledge.retrievalMode")
    .replace(/^knowledge\.graph_extraction_enabled$/, "knowledge.semanticExtractionEnabled")
    .replace(/^knowledge\.graph_extraction_model$/, "knowledge.semanticExtractionModel")
    .replace(/^knowledge\.graph_extraction_max_tokens$/, "knowledge.semanticExtractionMaxTokens")
    .replace(/^knowledge\.graph_extraction_max_job_tokens$/, "knowledge.semanticExtractionMaxJobTokens")
    .replace(/^knowledge\.graph_extraction_concurrency$/, "knowledge.semanticExtractionConcurrency")
    .replace(/^tools\.restrict_to_workspace$/, "tools.restrictToWorkspace")
    .replace(/^channels\.send_tool_hints$/, "channels.sendToolHints")
    .replace(/^channels\.send_max_retries$/, "channels.sendMaxRetries");
}

export function validateDesktopSettingsPaneSchemaCoverage(
  pane: DesktopSettingsPaneModel,
): DesktopSettingsSchemaCoverageIssue[] {
  const issues: DesktopSettingsSchemaCoverageIssue[] = [];
  const editableOwners = new Map<string, string>();
  for (const group of pane.groups) {
    for (const field of group.fields) {
      if (!field.persistentPath) {
        continue;
      }
      const canonicalPath = canonicalizeDesktopSettingsPersistentPath(field.persistentPath);
      const fieldId = `${group.id}.${field.id}`;
      const isEditableOwner = field.sourceKind === "config" && field.control !== "readonly" && field.disabled !== true;
      if (canonicalPath !== field.persistentPath && !isAllowedLegacySecretPath(field.persistentPath)) {
        issues.push({
          field: fieldId,
          persistentPath: field.persistentPath,
          code: "non_canonical_alias",
        });
        continue;
      }
      if (!getDesktopSettingsPathDisposition(canonicalPath)) {
        issues.push({
          field: fieldId,
          persistentPath: field.persistentPath,
          code: "missing_disposition",
        });
      }
      if (isEditableOwner) {
        const existingOwner = editableOwners.get(canonicalPath);
        if (existingOwner && existingOwner !== fieldId) {
          issues.push({
            field: fieldId,
            owner: existingOwner,
            persistentPath: field.persistentPath,
            code: "duplicate_editable_owner",
          });
        } else {
          editableOwners.set(canonicalPath, fieldId);
        }
      }
    }
  }
  return issues;
}

export function buildDesktopSettingsSearchableIndex(pane: DesktopSettingsPaneModel): Array<{
  field: string;
  persistentPath?: string;
  text: string;
  editable: boolean;
}> {
  const rows: Array<{
    field: string;
    persistentPath?: string;
    text: string;
    editable: boolean;
  }> = [];
  for (const group of pane.groups) {
    if ((group.navigationMode ?? "section") !== "section") {
      continue;
    }
    for (const field of group.fields) {
      if (field.sensitive || field.configurationMode === "secret") {
        continue;
      }
      rows.push({
        field: `${group.id}.${field.id}`,
        persistentPath: field.persistentPath,
        text: [
          group.label,
          group.description ?? "",
          ...(group.aliases ?? []),
          field.label,
          field.description ?? "",
          ...(field.aliases ?? []),
          field.value,
          field.inputValue,
        ].join(" "),
        editable: field.control !== "readonly" && field.disabled !== true,
      });
    }
  }
  return rows;
}

function isAllowedLegacySecretPath(path: string): boolean {
  return /^providers(\.profiles)?\.[^.]+\.api_(key|base)$/.test(path);
}
