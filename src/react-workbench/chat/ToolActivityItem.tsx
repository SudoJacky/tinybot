import { Children, useId, useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileText,
  Globe2,
  ListChecks,
  Loader2,
  PanelRightOpen,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ChatStepStatus, ToolCallState } from "../../app-core/chat/chatTurnModel";

type ToolActivityKind = "file" | "generic" | "plan" | "subagent" | "terminal" | "web";

type ToolActivityDescriptor = {
  category: string;
  input?: ToolActivityPreview;
  kind: ToolActivityKind;
  output?: ToolActivityPreview;
  title: string;
};

type ToolActivityPreview = {
  content: string;
  kind: "code" | "command" | "file" | "prose";
  lineStart?: number;
  meta?: string;
};

export function ToolActivityItem({
  fallbackSummary,
  onOpenDetails,
  status,
  toolCall,
}: {
  fallbackSummary?: string;
  onOpenDetails?: () => void;
  status: ChatStepStatus;
  toolCall: ToolCallState;
}) {
  const { t } = useTranslation("chat");
  const descriptor = useMemo(
    () => toolActivityDescriptor(toolCall, status, t, fallbackSummary),
    [fallbackSummary, status, t, toolCall],
  );
  const previews = [descriptor.input, descriptor.output].filter(Boolean) as ToolActivityPreview[];
  return (
    <ToolActivityFrame
      category={descriptor.category}
      defaultOpen={descriptor.kind !== "web" && previews.length > 0}
      durationMs={toolCall.durationMs}
      icon={<ToolActivityIcon kind={descriptor.kind} />}
      onOpenDetails={onOpenDetails}
      status={status}
      title={descriptor.title}
    >
      {previews.map((preview, index) => (
        <ToolActivityPreviewBlock key={`${preview.kind}:${index}`} preview={preview} />
      ))}
    </ToolActivityFrame>
  );
}

export function ToolActivityFrame({
  category,
  children,
  defaultOpen = true,
  durationMs,
  icon,
  onOpenDetails,
  status,
  title,
}: {
  category: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  durationMs?: number;
  icon: ReactNode;
  onOpenDetails?: () => void;
  status: ChatStepStatus;
  title: string;
}) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const hasContent = Children.count(children) > 0;
  const [open, setOpen] = useState(defaultOpen && hasContent);
  const meta = [category, durationMs === undefined ? "" : formatToolDuration(durationMs)].filter(Boolean).join(" · ");

  return (
    <section className="react-tool-activity" data-open={open ? "true" : undefined} data-status={status}>
      <header className="react-tool-activity__header">
        <span aria-hidden="true" className="react-tool-activity__icon">{icon}</span>
        <span className="react-tool-activity__copy">
          <strong>{title}</strong>
          {meta ? <small>{meta}</small> : null}
        </span>
        <ToolActivityStatus status={status} />
        {onOpenDetails ? (
          <button
            aria-label={t("toolActivity.openDetails", { title })}
            className="react-tool-activity__open-details"
            title={t("toolActivity.viewDetails")}
            type="button"
            onClick={onOpenDetails}
          >
            <PanelRightOpen aria-hidden="true" size={15} />
          </button>
        ) : <span aria-hidden="true" className="react-tool-activity__action-spacer" />}
        {hasContent ? (
          <button
            aria-controls={contentId}
            aria-expanded={open}
            aria-label={t("toolActivity.toggleDetails", { title })}
            className="react-tool-activity__toggle"
            type="button"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown aria-hidden="true" size={17} />
          </button>
        ) : <span aria-hidden="true" className="react-tool-activity__action-spacer" />}
      </header>
      {hasContent ? (
        <div className="react-tool-activity__details" data-testid="tool-activity-details" hidden={!open} id={contentId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ToolActivityPreviewBlock({ preview }: { preview: ToolActivityPreview }) {
  const clipped = clippedPreview(preview.content);
  if (preview.kind === "file") {
    return (
      <div className="react-tool-activity__preview react-tool-activity__preview--code" data-preview-kind={preview.kind}>
        <div className="react-tool-activity__code-lines">
          {clipped.lines.map((line, index) => (
            <div key={`${preview.lineStart ?? 1}:${index}`}>
              <span aria-hidden="true">{(preview.lineStart ?? 1) + index}</span>
              <code>{line || " "}</code>
            </div>
          ))}
        </div>
        <PreviewMeta meta={preview.meta} truncated={clipped.truncated} />
      </div>
    );
  }
  return (
    <div className="react-tool-activity__preview" data-preview-kind={preview.kind}>
      {preview.kind === "command" ? <span aria-hidden="true" className="react-tool-activity__prompt">$</span> : null}
      {preview.kind === "prose" ? <p>{clipped.text}</p> : <pre>{clipped.text}</pre>}
      <PreviewMeta meta={preview.meta} truncated={clipped.truncated} />
    </div>
  );
}

function PreviewMeta({ meta, truncated }: { meta?: string; truncated: boolean }) {
  const { t } = useTranslation("chat");
  const label = [meta, truncated ? t("toolActivity.truncated") : ""].filter(Boolean).join(" · ");
  return label ? <small className="react-tool-activity__preview-meta">{label}</small> : null;
}

function ToolActivityStatus({ status }: { status: ChatStepStatus }) {
  const { t } = useTranslation("chat");
  const normalized = toolActivityStatus(status, t);
  return (
    <span className="react-tool-activity__status" data-status={normalized.kind}>
      {normalized.icon}
      <span>{normalized.label}</span>
    </span>
  );
}

function ToolActivityIcon({ kind }: { kind: ToolActivityKind }) {
  switch (kind) {
    case "terminal": return <SquareTerminal size={17} />;
    case "file": return <FileText size={17} />;
    case "web": return <Globe2 size={17} />;
    case "plan": return <ListChecks size={17} />;
    case "subagent": return <Bot size={17} />;
    default: return <Wrench size={17} />;
  }
}

function toolActivityDescriptor(toolCall: ToolCallState, status: ChatStepStatus, t: TFunction<"chat">, fallbackSummary?: string): ToolActivityDescriptor {
  const args = normalizedRecord(toolCall.argsJson) ?? normalizedRecord(toolCall.argsPreview) ?? {};
  const name = toolCall.name.toLowerCase();
  if (isTerminalTool(name)) {
    const command = firstString(args.command, args.cmd, args.script, toolCall.argsPreview) || t("toolActivity.command");
    const output = terminalOutput(toolCall, status) || fallbackSummary;
    return {
      category: t("toolActivity.category.terminal"),
      input: command === t("toolActivity.command") ? undefined : { content: command, kind: "command" },
      kind: "terminal",
      output: output ? { content: output, kind: "code" } : undefined,
      title: terminalTitle(command, status, t),
    };
  }
  if (isFileTool(name)) {
    const path = firstString(args.path, args.file, args.filePath, args.file_path) || t("toolActivity.workspaceFile");
    const range = fileRange(args, t);
    const result = fileOutput(toolCall) || fallbackSummary;
    return {
      category: t("toolActivity.category.fileRead"),
      input: path === t("toolActivity.workspaceFile") ? undefined : { content: path, kind: "code", meta: range },
      kind: "file",
      output: result ? { content: result, kind: "file", lineStart: fileLineStart(args) } : undefined,
      title: fileTitle(path, status, t),
    };
  }
  if (name.startsWith("web.")) {
    const page = webPageInfo(toolCall, args, t);
    const result = webOutput(toolCall) || fallbackSummary;
    return {
      category: t("toolActivity.category.web"),
      input: page.url ? { content: page.url, kind: "code" } : undefined,
      kind: "web",
      output: result ? { content: result, kind: "prose" } : undefined,
      title: webTitle(name, args, page.label, status, t),
    };
  }
  if (name === "update_plan") {
    return genericDescriptor(t("toolActivity.updatedPlan"), t("toolActivity.category.planning"), "plan", toolCall, fallbackSummary);
  }
  if (name === "publish_data_view") {
    const output = structuredResultPreview(toolCall) || fallbackSummary;
    const title = status === "failed"
      ? t("toolActivity.dataViewFailed")
      : status === "cancelled"
        ? t("toolActivity.dataViewCancelled")
        : status === "running" || status === "pending" || status === "blocked"
          ? t("toolActivity.preparingDataView")
          : t("toolActivity.publishedDataView");
    return {
      category: t("toolActivity.category.presentation"),
      kind: "generic",
      ...(output ? { output: { content: output, kind: "prose" } } : {}),
      title,
    };
  }
  if (name.startsWith("subagent.")) {
    const task = firstString(args.task, args.content);
    const title = name.endsWith("spawn") ? t("toolActivity.delegated") : name.endsWith("wait") ? t("toolActivity.waitedSubagents") : t("toolActivity.updatedSubagent");
    return genericDescriptor(title, t("toolActivity.category.subagent"), "subagent", toolCall, fallbackSummary, task);
  }
  if (name === "request_user_input") {
    return genericDescriptor(t("toolActivity.requestedInput"), t("toolActivity.category.interaction"), "generic", toolCall, fallbackSummary);
  }
  return genericDescriptor(humanizeToolName(toolCall.name, t), t("toolActivity.category.tool"), "generic", toolCall, fallbackSummary);
}

function genericDescriptor(
  title: string,
  category: string,
  kind: ToolActivityKind,
  toolCall: ToolCallState,
  fallbackSummary?: string,
  inputOverride?: string,
): ToolActivityDescriptor {
  const input = inputOverride || structuredPreview(toolCall.argsJson ?? toolCall.argsPreview);
  const output = structuredResultPreview(toolCall) || fallbackSummary;
  return {
    category,
    input: input ? { content: input, kind: "code" } : undefined,
    kind,
    output: output ? { content: output, kind: "code" } : undefined,
    title,
  };
}

function terminalTitle(command: string, status: ChatStepStatus, t: TFunction<"chat">): string {
  if (status === "failed") return t("toolActivity.commandFailed");
  if (status === "cancelled") return t("toolActivity.commandCancelled");
  const key = status === "running" ? "toolActivity.runningCommand" : status === "blocked" || status === "pending" ? "toolActivity.waitingCommand" : "toolActivity.ranCommand";
  return t(key, { command: singleLine(command, 56) });
}

function fileTitle(path: string, status: ChatStepStatus, t: TFunction<"chat">): string {
  const target = fileName(path);
  if (status === "failed") return t("toolActivity.inspectFailed", { target });
  if (status === "running") return t("toolActivity.inspecting", { target });
  return t("toolActivity.inspected", { target });
}

function webTitle(name: string, args: Record<string, unknown>, page: string, status: ChatStepStatus, t: TFunction<"chat">): string {
  if (status === "failed") return t("toolActivity.webFailed");
  if (name === "web.open") return t(status === "running" ? "toolActivity.opening" : "toolActivity.opened", { page });
  if (name === "web.read") return t(status === "running" ? "toolActivity.reviewing" : "toolActivity.reviewed", { page });
  const action = normalizedRecord(args.action);
  const actionType = firstString(action?.type);
  const key = actionType === "scroll" ? "toolActivity.scrolled" : actionType === "click" || actionType === "clickTarget" ? "toolActivity.clicked" : actionType === "fill" || actionType === "type" ? "toolActivity.enteredText" : "toolActivity.used";
  return t(key, { page });
}

function webPageInfo(toolCall: ToolCallState, args: Record<string, unknown>, t: TFunction<"chat">): { label: string; url: string } {
  const result = findNestedRecord(toolCall.resultJson, (candidate) => Boolean(firstString(candidate.url, candidate.title)));
  const url = firstString(args.url, result?.url);
  const title = firstString(result?.title);
  if (title) return { label: singleLine(title, 52), url };
  if (url) {
    try {
      return { label: new URL(url).hostname.replace(/^www\./, ""), url };
    } catch {
      return { label: singleLine(url, 52), url };
    }
  }
  return { label: t("toolActivity.currentPage"), url: "" };
}

function terminalOutput(toolCall: ToolCallState, status: ChatStepStatus): string {
  const result = findNestedRecord(toolCall.resultJson, (candidate) => (
    typeof candidate.stdout === "string" || typeof candidate.stderr === "string" || typeof candidate.output === "string"
  ));
  const chunks = terminalChunkOutput(toolCall.resultJson);
  const stdout = firstString(result?.stdout, result?.output, chunks.stdout);
  const stderr = firstString(result?.stderr, chunks.stderr, toolCall.stderrPreview);
  return status === "failed" ? stderr || stdout || nonJsonPreview(toolCall.resultPreview) : stdout || stderr || nonJsonPreview(toolCall.resultPreview);
}

function terminalChunkOutput(value: unknown): { stderr: string; stdout: string } {
  const result = findNestedRecord(value, (candidate) => Array.isArray(candidate.chunks));
  if (!Array.isArray(result?.chunks)) return { stderr: "", stdout: "" };
  const streams = { stderr: [] as string[], stdout: [] as string[] };
  for (const chunk of result.chunks) {
    if (!isRecord(chunk) || typeof chunk.content !== "string") continue;
    const stream = chunk.stream === "stderr" ? "stderr" : "stdout";
    streams[stream].push(chunk.content);
  }
  return {
    stderr: streams.stderr.join("").trim(),
    stdout: streams.stdout.join("").trim(),
  };
}

function fileOutput(toolCall: ToolCallState): string {
  const result = findNestedRecord(toolCall.resultJson, (candidate) => (
    typeof candidate.content === "string" || typeof candidate.text === "string"
  ));
  return firstString(result?.content, result?.text, nonJsonPreview(toolCall.resultPreview));
}

function webOutput(toolCall: ToolCallState): string {
  const result = findNestedRecord(toolCall.resultJson, (candidate) => (
    typeof candidate.summary === "string" || typeof candidate.text === "string" || typeof candidate.content === "string"
  ));
  return firstString(result?.summary, result?.text, result?.content, nonJsonPreview(toolCall.resultPreview));
}

function structuredResultPreview(toolCall: ToolCallState): string {
  return nonJsonPreview(toolCall.resultPreview);
}

function structuredPreview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") {
    const parsed = normalizedRecord(value);
    return parsed ? JSON.stringify(parsed, null, 2) : value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nonJsonPreview(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return normalizedRecord(trimmed) ? "" : trimmed;
}

function normalizedRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findNestedRecord(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const queue: unknown[] = [value];
  const visited = new Set<unknown>();
  while (queue.length && visited.size < 20) {
    const current = queue.shift();
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);
    if (predicate(current)) return current;
    queue.push(current.result, current.executor, current.raw, current.tinybot_result, current.tinybotResult, current.snapshot);
  }
  return undefined;
}

function clippedPreview(value: string): { lines: string[]; text: string; truncated: boolean } {
  const normalized = value.replace(/\r\n?/g, "\n").trimEnd();
  const sourceLines = normalized.split("\n");
  const lines = sourceLines.slice(0, 8);
  let text = lines.join("\n");
  let truncated = sourceLines.length > lines.length;
  if (text.length > 4_000) {
    text = text.slice(0, 4_000).trimEnd();
    truncated = true;
  }
  return { lines: text.split("\n"), text, truncated };
}

function toolActivityStatus(status: ChatStepStatus, t: TFunction<"chat">): { icon: ReactNode; kind: string; label: string } {
  switch (status) {
    case "completed": return { icon: <CheckCircle2 aria-hidden="true" size={16} />, kind: "success", label: t("toolActivity.status.completed") };
    case "running": return { icon: <Loader2 aria-hidden="true" size={16} />, kind: "active", label: t("toolActivity.status.running") };
    case "blocked": return { icon: <AlertTriangle aria-hidden="true" size={16} />, kind: "waiting", label: t("toolActivity.status.waiting") };
    case "failed": return { icon: <XCircle aria-hidden="true" size={16} />, kind: "error", label: t("toolActivity.status.failed") };
    case "cancelled": return { icon: <XCircle aria-hidden="true" size={16} />, kind: "error", label: t("toolActivity.status.cancelled") };
    default: return { icon: <Circle aria-hidden="true" size={14} />, kind: "pending", label: t("toolActivity.status.pending") };
  }
}

function isTerminalTool(name: string): boolean {
  return name === "exec_command" || name === "write_stdin" || name.startsWith("shell.");
}

function isFileTool(name: string): boolean {
  return name === "workspace.read_file" || name === "read_file" || name.endsWith(".read_file");
}

function fileRange(args: Record<string, unknown>, t: TFunction<"chat">): string | undefined {
  const start = integerValue(args.startLine ?? args.start_line ?? args.line ?? args.offset);
  const end = integerValue(args.endLine ?? args.end_line);
  if (start === undefined && end === undefined) return undefined;
  const normalizedStart = start === undefined ? 1 : Math.max(1, start);
  return end === undefined ? t("toolActivity.line", { start: normalizedStart }) : t("toolActivity.lines", { start: normalizedStart, end: Math.max(normalizedStart, end) });
}

function fileLineStart(args: Record<string, unknown>): number {
  return Math.max(1, integerValue(args.startLine ?? args.start_line ?? args.line ?? args.offset) ?? 1);
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? "";
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function singleLine(value: string, maxLength: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

function humanizeToolName(name: string, t: TFunction<"chat">): string {
  const parts = name.split(/[.:]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? name;
  const words = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!words) return t("toolActivity.usedTool");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatToolDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
