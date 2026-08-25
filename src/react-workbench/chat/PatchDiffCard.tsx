import { useMemo } from "react";
import type { TFunction } from "i18next";
import { Copy, FileDiff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatStepStatus, ToolCallState } from "../../app-core/chat/chatTurnContracts";
import { ToolActivityFrame } from "./ToolActivityItem";

type PatchHunkSummary = {
  addedLines: number;
  removedLines: number;
};

type PatchHunkDelta = {
  newLines: string[];
  newStart: number;
  oldLines: string[];
  oldStart: number;
};

export type PatchFileChange = {
  delta: PatchHunkDelta[];
  deltaTruncated: boolean;
  hunks: PatchHunkSummary[];
  movePath?: string;
  operation: string;
  path: string;
};

export type PatchChangeSet = {
  files: PatchFileChange[];
};

type DiffRow = {
  content: string;
  kind: "context" | "add" | "remove";
  newLine?: number;
  oldLine?: number;
};

export function isApplyPatchToolCall(toolCall: ToolCallState): boolean {
  return toolCall.name === "apply_patch" || toolCall.name === "workspace.apply_patch";
}

export function patchChangeSetFromToolResult(value: unknown): PatchChangeSet | undefined {
  const result = findPatchResult(value);
  const rawFiles = result?.changed_files ?? result?.changedFiles;
  if (!Array.isArray(rawFiles)) {
    return undefined;
  }
  const files = rawFiles.map(normalizePatchFileChange);
  if (files.some((file) => !file)) {
    return undefined;
  }
  return { files: files as PatchFileChange[] };
}

export function PatchDiffCard({
  status,
  toolCall,
}: {
  status: ChatStepStatus;
  toolCall: ToolCallState;
}) {
  const { t } = useTranslation("chat");
  const changes = useMemo(() => patchChangeSetFromToolResult(toolCall.resultJson), [toolCall.resultJson]);
  if (!changes?.files.length) {
    return null;
  }
  const totals = changes.files.reduce(
    (current, file) => {
      const stats = patchFileStats(file);
      return { additions: current.additions + stats.additions, removals: current.removals + stats.removals };
    },
    { additions: 0, removals: 0 },
  );
  const title = patchChangeTitle(changes.files, t);

  return (
    <section aria-label={t("patch.label")} className="react-patch-change">
      <ToolActivityFrame
        category={t("patch.category")}
        durationMs={toolCall.durationMs}
        icon={<FileDiff size={17} />}
        status={status}
        title={title}
      >
        <div aria-label={t("patch.changedFiles")} className="react-patch-change__file-summary">
          <header>
            <span>{t("patch.filesChanged", { count: changes.files.length })}</span>
            <PatchStats additions={totals.additions} removals={totals.removals} />
          </header>
          {changes.files.map((file, index) => {
            const path = displayPath(file);
            const stats = patchFileStats(file);
            return (
              <div className="react-patch-change__file-row" key={`${file.path}:${file.movePath ?? ""}:${index}`}>
                <span className="react-patch-change__file-path" title={path}>{path}</span>
                <PatchStats additions={stats.additions} removals={stats.removals} />
                <button
                  aria-label={t("patch.copyFor", { path })}
                  className="react-patch-file__copy"
                  title={t("patch.copy")}
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(unifiedPatchText(file))}
                >
                  <Copy aria-hidden="true" size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="react-patch-change__diff-block" data-testid="patch-diff-content">
          {changes.files.map((file, index) => (
            <PatchFileDiff file={file} key={`${file.path}:${file.movePath ?? ""}:${index}`} />
          ))}
        </div>
      </ToolActivityFrame>
    </section>
  );
}

function PatchFileDiff({ file }: { file: PatchFileChange }) {
  const { t } = useTranslation("chat");
  const path = displayPath(file);
  return (
    <article aria-label={t("patch.diffFor", { path })} className="react-patch-file">
      <header className="react-patch-file__header">
        <div className="react-patch-file__path" title={path}>
          <strong>{fileName(path)}</strong>
          {parentPath(path) ? <small>{parentPath(path)}</small> : null}
        </div>
      </header>
      {file.deltaTruncated ? (
        <p className="react-patch-file__notice">{t("patch.previewUnavailable")}</p>
      ) : (
        <div className="react-patch-file__diff" role="table">
          {file.delta.map((hunk, hunkIndex) => (
            <PatchHunk hunk={hunk} key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`} />
          ))}
        </div>
      )}
    </article>
  );
}

function PatchHunk({ hunk }: { hunk: PatchHunkDelta }) {
  const rows = diffRows(hunk);
  return (
    <div className="react-patch-hunk" role="rowgroup">
      <div className="react-patch-hunk__header" role="row">
        <span role="cell">{hunkHeader(hunk)}</span>
      </div>
      {rows.map((row, index) => (
        <div className="react-patch-diff-row" data-diff-kind={row.kind} key={`${row.kind}:${row.oldLine ?? ""}:${row.newLine ?? ""}:${index}`} role="row">
          <span data-line-side="old" role="cell">{row.oldLine ?? ""}</span>
          <span data-line-side="new" role="cell">{row.newLine ?? ""}</span>
          <span aria-hidden="true" className="react-patch-diff-row__marker" role="cell">
            {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
          </span>
          <code role="cell">{row.content || " "}</code>
        </div>
      ))}
    </div>
  );
}

function PatchStats({ additions, removals }: { additions: number; removals: number }) {
  const { t } = useTranslation("chat");
  return (
    <span aria-label={t("patch.stats", { additions, removals })} className="react-patch-stats">
      <span>+{additions}</span>
      <span>-{removals}</span>
    </span>
  );
}

function findPatchResult(value: unknown): Record<string, unknown> | undefined {
  const queue: unknown[] = [value];
  const visited = new Set<unknown>();
  while (queue.length && visited.size < 12) {
    const candidate = queue.shift();
    if (!isRecord(candidate) || visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);
    if (Array.isArray(candidate.changed_files) || Array.isArray(candidate.changedFiles)) {
      return candidate;
    }
    queue.push(candidate.result, candidate.executor, candidate.raw);
  }
  return undefined;
}

function normalizePatchFileChange(value: unknown): PatchFileChange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = stringValue(value.path);
  const operation = stringValue(value.operation);
  const rawHunks = value.hunks;
  const rawDelta = value.delta;
  if (!path || !operation || !Array.isArray(rawHunks) || !Array.isArray(rawDelta)) {
    return undefined;
  }
  const hunks = rawHunks.map((hunk) => {
    if (!isRecord(hunk)) {
      return undefined;
    }
    const addedLines = nonNegativeInteger(hunk.added_lines ?? hunk.addedLines);
    const removedLines = nonNegativeInteger(hunk.removed_lines ?? hunk.removedLines);
    return addedLines === undefined || removedLines === undefined ? undefined : { addedLines, removedLines };
  });
  const delta = rawDelta.map((hunk) => {
    if (!isRecord(hunk)) {
      return undefined;
    }
    const oldStart = positiveInteger(hunk.old_start ?? hunk.oldStart);
    const newStart = positiveInteger(hunk.new_start ?? hunk.newStart);
    const oldLines = stringArray(hunk.old_lines ?? hunk.oldLines);
    const newLines = stringArray(hunk.new_lines ?? hunk.newLines);
    return oldStart === undefined || newStart === undefined || !oldLines || !newLines
      ? undefined
      : { oldStart, newStart, oldLines, newLines };
  });
  if (hunks.some((hunk) => !hunk) || delta.some((hunk) => !hunk)) {
    return undefined;
  }
  return {
    delta: delta as PatchHunkDelta[],
    deltaTruncated: value.delta_truncated === true || value.deltaTruncated === true,
    hunks: hunks as PatchHunkSummary[],
    ...(stringValue(value.move_path ?? value.movePath) ? { movePath: stringValue(value.move_path ?? value.movePath) } : {}),
    operation,
    path,
  };
}

function diffRows(hunk: PatchHunkDelta): DiffRow[] {
  const { oldLines, newLines } = hunk;
  if (oldLines.length * newLines.length > 100_000) {
    return coarseDiffRows(hunk);
  }
  const lengths = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ content: oldLines[oldIndex], kind: "context", oldLine, newLine });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
    } else if (oldIndex < oldLines.length && (newIndex >= newLines.length || lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1])) {
      rows.push({ content: oldLines[oldIndex], kind: "remove", oldLine });
      oldIndex += 1;
      oldLine += 1;
    } else {
      rows.push({ content: newLines[newIndex], kind: "add", newLine });
      newIndex += 1;
      newLine += 1;
    }
  }
  return rows;
}

function coarseDiffRows(hunk: PatchHunkDelta): DiffRow[] {
  return [
    ...hunk.oldLines.map((content, index): DiffRow => ({ content, kind: "remove", oldLine: hunk.oldStart + index })),
    ...hunk.newLines.map((content, index): DiffRow => ({ content, kind: "add", newLine: hunk.newStart + index })),
  ];
}

function patchFileStats(file: PatchFileChange): { additions: number; removals: number } {
  if (file.hunks.length) {
    return file.hunks.reduce(
      (current, hunk) => ({
        additions: current.additions + hunk.addedLines,
        removals: current.removals + hunk.removedLines,
      }),
      { additions: 0, removals: 0 },
    );
  }
  return file.delta.reduce(
    (current, hunk) => ({
      additions: current.additions + hunk.newLines.length,
      removals: current.removals + hunk.oldLines.length,
    }),
    { additions: 0, removals: 0 },
  );
}

function patchChangeTitle(files: PatchFileChange[], t: TFunction<"chat">): string {
  if (files.length !== 1) {
    return t("patch.editedFiles", { count: files.length });
  }
  const target = fileName(files[0].movePath ?? files[0].path);
  if (files[0].movePath) {
    return t("patch.moved", { name: target });
  }
  if (files[0].operation === "add") {
    return t("patch.created", { name: target });
  }
  if (files[0].operation === "delete") {
    return t("patch.deleted", { name: target });
  }
  return t("patch.edited", { name: target });
}

function displayPath(file: PatchFileChange): string {
  return file.movePath ? `${file.path} → ${file.movePath}` : file.path;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function hunkHeader(hunk: PatchHunkDelta): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines.length} +${hunk.newStart},${hunk.newLines.length} @@`;
}

function unifiedPatchText(file: PatchFileChange): string {
  const oldPath = file.operation === "add" ? "/dev/null" : `a/${file.path}`;
  const newPath = file.operation === "delete" ? "/dev/null" : `b/${file.movePath ?? file.path}`;
  const body = file.delta.flatMap((hunk) => [
    hunkHeader(hunk),
    ...diffRows(hunk).map((row) => `${row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}${row.content}`),
  ]);
  return [`--- ${oldPath}`, `+++ ${newPath}`, ...body].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}
