export type DesktopInspectorSection =
  | {
      type: "text";
      label: string;
      text: string;
      collapsed?: boolean;
    }
  | {
      type: "browserActivity";
      activity: DesktopBrowserActivity;
    };

export interface DesktopRunChainItem {
  key: string;
  kind: "planning" | "tool" | "browser";
  title: string;
  preview: string;
  status: "running" | "completed" | "failed";
  inspectable: boolean;
  detailTitle: string;
  detailSubtitle: string;
  detailSections: DesktopInspectorSection[];
}

export interface DesktopInspectorView {
  title: string;
  subtitle: string;
  sections: DesktopInspectorSection[];
  emptyText: string;
}

export interface DesktopBrowserActivity {
  action: string;
  actionLabel: string;
  command: string;
  url: string;
  title: string;
  viewport: string;
  pageScroll: string;
  responseText: string;
  metadataText: string;
  snapshotText: string;
  argsText: string;
}

export interface DesktopMemoryReferenceView {
  key: string;
  file: string;
  line: number | null;
  locationLabel: string;
  content: string;
  metadata: string[];
}

type MessageRecord = Record<string, unknown>;
type ToolCallRecord = Record<string, unknown>;

const DEFAULT_LABELS = {
  browserActivity: "Browser activity",
  browserActivitySubtitle: "Browser observation",
  browserCommand: "Command",
  browserPageSnapshot: "Page snapshot",
  browserRawOutput: "Raw output",
  browserUrlUnavailable: "URL unavailable",
  completed: "Completed",
  failed: "Needs attention",
  inspectorEmpty: "No saved detail.",
  lineLabel: "Line {line}",
  noArguments: "No arguments",
  planning: "Planning",
  planningLower: "planning",
  thinkingTrace: "Thinking trace",
  tool: "Tool",
  toolArgs: "Arguments",
  toolCall: "Tool call",
  toolCallAndResponse: "Tool call and response",
  toolDetail: "Tool detail",
  toolDetailAndResponse: "Tool detail and response",
  toolResponse: "Response",
  running: "Running",
} as const;

export function buildDesktopRunChainItems(messages: unknown[]): DesktopRunChainItem[] {
  const prepared = prepareMessageRelationships(messages);
  const items: DesktopRunChainItem[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const message = prepared[index];
    if (!message || booleanValue(message._pairedToolResponseConsumed)) {
      continue;
    }

    const reasoningText = stringValue(message.reasoning_content ?? message.reasoningContent).trim();
    if (reasoningText) {
      items.push({
        key: `${stringValue(message.message_id) || `reasoning-${index}`}:planning`,
        kind: "planning",
        title: DEFAULT_LABELS.planning,
        preview: compactText(reasoningText, 120),
        status: "completed",
        inspectable: true,
        detailTitle: DEFAULT_LABELS.planning,
        detailSubtitle: DEFAULT_LABELS.thinkingTrace,
        detailSections: [{ type: "text", label: "Thinking", text: reasoningText }],
      });
    }

    if (hasToolCalls(message)) {
      const toolCalls = getToolCalls(message);
      const relatedMessages = arrayValue(message._relatedToolMessages).filter(isRecord);
      const relatedGroups = relatedToolMessageGroups(toolCalls, relatedMessages);
      toolCalls.forEach((toolCall, toolIndex) => {
        const name = getToolCallName(toolCall) || "tool";
        const rawArgs = toolCallFunctionValue(toolCall, "arguments") ?? toolCall.arguments ?? "";
        const argsText = formatToolArguments(rawArgs);
        const responseText = relatedGroups[toolIndex].map((item) => stringValue(item.content)).filter(Boolean).join("\n\n");
        items.push(createToolRunChainItem({
          key: `${stringValue(message.message_id) || `tool-call-${index}`}:${getToolCallId(toolCall) || toolIndex}`,
          name,
          rawArgs,
          argsText,
          responseText,
          status: inferRunChainItemStatus(message, responseText),
          callStyle: "call",
        }));
      });
      index = relatedToolMessagesEndIndex(prepared, index);
      continue;
    }

    if (message.role === "tool" || message.role === "progress") {
      const name = getToolName(message) || "tool";
      const isResult = booleanValue(message._tool_result) || message.role === "tool";
      const argsText = isResult ? "" : stringValue(message.content);
      const responseText = isResult ? stringValue(message.content) : stringValue(asRecord(message._pairedToolResponse)?.content);
      items.push(createToolRunChainItem({
        key: `${stringValue(message.message_id) || `tool-message-${index}`}:${booleanValue(message._tool_result) ? "result" : "detail"}`,
        name,
        rawArgs: message.content ?? "",
        argsText,
        responseText,
        status: inferRunChainItemStatus(message, responseText),
        callStyle: "message",
      }));
    }
  }
  return items;
}

export function createDesktopRunChainInspectorView(item: DesktopRunChainItem | null | undefined): DesktopInspectorView {
  return {
    title: item?.detailTitle || item?.title || "Run-chain item",
    subtitle: item?.detailSubtitle || item?.preview || "",
    sections: item?.detailSections || [],
    emptyText: DEFAULT_LABELS.inspectorEmpty,
  };
}

export function buildDesktopRunChainSummary(items: DesktopRunChainItem[]): string {
  const toolCount = items.filter((item) => item.kind === "tool" || item.kind === "browser").length;
  const planningCount = items.filter((item) => item.kind === "planning").length;
  const status = runChainStatusClass(items);
  const parts = [runChainStatusLabel(status), `${items.length} item${items.length === 1 ? "" : "s"}`];
  if (toolCount) {
    parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  }
  if (planningCount) {
    parts.push(DEFAULT_LABELS.planningLower);
  }
  return parts.join(" | ");
}

export function buildDesktopMemoryReferenceView(reference: unknown): DesktopMemoryReferenceView {
  const source = asRecord(reference) ?? {};
  const file = stringValue(source.view_file) || stringValue(source.file) || "memory/MEMORY.md";
  const line = numberOrNull(source.view_line ?? source.line ?? source.cursor);
  const content = stringValue(source.content);
  const metadata = [
    stringValue(source.scope),
    stringValue(source.type),
    stringValue(source.note_id),
    stringValue(source.evidence_id),
  ].filter(Boolean);
  return {
    key: `${file}:${line ?? ""}:${stringValue(source.note_id) || stringValue(source.evidence_id) || content}`,
    file,
    line,
    locationLabel: line ? DEFAULT_LABELS.lineLabel.replace("{line}", String(line)) : "Position unknown",
    content,
    metadata,
  };
}

export function resolveDesktopMemoryHighlightLine(content: string, targetLine: number | null, reference: unknown): number {
  const source = asRecord(reference) ?? {};
  const lines = String(content || "").split(/\r?\n/);
  const needles = [source.note_id, source.content].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const needle of needles) {
    const index = lines.findIndex((line) => line.includes(needle));
    if (index >= 0) {
      return index + 1;
    }
  }
  return targetLine || 0;
}

function createToolRunChainItem({
  key,
  name,
  rawArgs,
  argsText,
  responseText,
  status,
  callStyle,
}: {
  key: string;
  name: string;
  rawArgs: unknown;
  argsText: string;
  responseText: string;
  status: DesktopRunChainItem["status"];
  callStyle: "call" | "message";
}): DesktopRunChainItem {
  const browserActivity = buildBrowserActivity(name, rawArgs, argsText, responseText);
  if (browserActivity) {
    return {
      key,
      kind: "browser",
      title: `${toolKindLabel(name)} | ${browserActivity.actionLabel}`,
      preview: browserActivityPreview(browserActivity),
      status,
      inspectable: true,
      detailTitle: browserActivity.title || DEFAULT_LABELS.browserActivity,
      detailSubtitle: DEFAULT_LABELS.browserActivitySubtitle,
      detailSections: browserActivitySections(browserActivity),
    };
  }

  return {
    key,
    kind: "tool",
    title: `${toolKindLabel(name)} | ${name}`,
    preview: callStyle === "call"
      ? responseText
        ? compactText(responseText, 120)
        : summarizeToolArguments(argsText)
      : compactText(responseText || argsText || "Tool activity", 120),
    status,
    inspectable: true,
    detailTitle: name,
    detailSubtitle: callStyle === "call"
      ? responseText
        ? DEFAULT_LABELS.toolCallAndResponse
        : DEFAULT_LABELS.toolCall
      : responseText
        ? DEFAULT_LABELS.toolDetailAndResponse
        : DEFAULT_LABELS.toolDetail,
    detailSections: [
      ...(argsText ? [{ type: "text" as const, label: callStyle === "call" ? DEFAULT_LABELS.toolArgs : "Detail", text: argsText || DEFAULT_LABELS.noArguments }] : []),
      ...(responseText ? [{ type: "text" as const, label: DEFAULT_LABELS.toolResponse, text: responseText }] : []),
    ],
  };
}

function buildBrowserActivity(name: string, args: unknown, argsText: string, responseText = ""): DesktopBrowserActivity | null {
  const command = extractCommandFromToolArgs(args, argsText);
  const commandInfo = parseOpenCliBrowserCommand(command);
  const responseInfo = parseBrowserResponseMeta(responseText);
  const output = splitBrowserSnapshotOutput(responseText);
  const hasBrowserResponse = Boolean(responseInfo.navigatedTo || responseInfo.url || responseInfo.title);
  if (!commandInfo && !(name.toLowerCase() === "exec" && hasBrowserResponse)) {
    return null;
  }

  const action = commandInfo?.action || (responseInfo.navigatedTo ? "open" : "activity");
  const url = responseInfo.url || responseInfo.navigatedTo || commandInfo?.url || "";
  return {
    action,
    actionLabel: browserActionLabel(action),
    command,
    url,
    title: responseInfo.title,
    viewport: responseInfo.viewport,
    pageScroll: responseInfo.pageScroll,
    responseText,
    metadataText: output.metadata,
    snapshotText: output.snapshot,
    argsText,
  };
}

function browserActivityPreview(activity: DesktopBrowserActivity): string {
  const parts = [activity.title, activity.url, activity.viewport].filter(Boolean);
  return compactText(parts.join(" | ") || activity.command || DEFAULT_LABELS.browserActivity, 120);
}

function browserActivitySections(activity: DesktopBrowserActivity): DesktopInspectorSection[] {
  const sections: DesktopInspectorSection[] = [{ type: "browserActivity", activity }];
  if (activity.command) {
    sections.push({ type: "text", label: DEFAULT_LABELS.browserCommand, text: activity.command });
  }
  if (activity.snapshotText) {
    sections.push({ type: "text", label: DEFAULT_LABELS.browserPageSnapshot, text: activity.snapshotText, collapsed: true });
  } else if (activity.responseText) {
    sections.push({ type: "text", label: DEFAULT_LABELS.browserRawOutput, text: activity.responseText, collapsed: true });
  }
  return sections;
}

function prepareMessageRelationships(messages: unknown[]): MessageRecord[] {
  const prepared = messages.filter(isRecord).map((message) => ({ ...message }));
  for (let index = 0; index < prepared.length; index += 1) {
    const message = prepared[index];
    if (!hasToolCalls(message)) {
      continue;
    }
    const toolNames = new Set(getToolCalls(message).map(getToolCallName).filter(Boolean));
    const related: MessageRecord[] = [];
    let nextIndex = index + 1;
    while (nextIndex < prepared.length) {
      const nextMessage = prepared[nextIndex];
      if (nextMessage.role !== "tool" && nextMessage.role !== "progress") {
        break;
      }
      const nextToolName = getToolName(nextMessage);
      if (toolNames.size > 0 && nextToolName && !toolNames.has(nextToolName)) {
        break;
      }
      related.push(nextMessage);
      nextIndex += 1;
    }
    message._relatedToolMessages = related;
  }

  const pendingDetailsByName = new Map<string, MessageRecord[]>();
  for (const message of prepared) {
    if (message.role !== "progress") {
      pendingDetailsByName.clear();
      continue;
    }
    if (booleanValue(message._tool_detail)) {
      const name = getToolName(message);
      const queue = pendingDetailsByName.get(name) || [];
      queue.push(message);
      pendingDetailsByName.set(name, queue);
      continue;
    }
    if (!booleanValue(message._tool_result)) {
      continue;
    }
    const name = getToolName(message);
    const queue = pendingDetailsByName.get(name) || [];
    const detailMessage = queue.shift();
    if (!detailMessage) {
      continue;
    }
    detailMessage._pairedToolResponse = message;
    message._pairedToolResponseConsumed = true;
    if (!queue.length) {
      pendingDetailsByName.delete(name);
    }
  }
  return prepared;
}

function relatedToolMessagesEndIndex(messages: MessageRecord[], startIndex: number): number {
  const message = messages[startIndex];
  if (!hasToolCalls(message)) {
    return startIndex;
  }

  const toolNames = new Set(getToolCalls(message).map(getToolCallName).filter(Boolean));
  let nextIndex = startIndex + 1;
  while (nextIndex < messages.length) {
    const nextMessage = messages[nextIndex];
    if (nextMessage.role !== "tool" && nextMessage.role !== "progress") {
      break;
    }
    const nextToolName = getToolName(nextMessage);
    if (toolNames.size > 0 && nextToolName && !toolNames.has(nextToolName)) {
      break;
    }
    nextIndex += 1;
  }
  return nextIndex - 1;
}

function relatedToolMessageGroups(toolCalls: ToolCallRecord[], relatedMessages: MessageRecord[]): MessageRecord[][] {
  const groups = toolCalls.map((): MessageRecord[] => []);
  const usedMessageIndexes = new Set<number>();
  const callIdToIndex = new Map<string, number>();

  toolCalls.forEach((toolCall, index) => {
    const id = getToolCallId(toolCall);
    if (id) {
      callIdToIndex.set(id, index);
    }
  });

  relatedMessages.forEach((message, index) => {
    const messageCallId = stringValue(message.tool_call_id) || stringValue(message._tool_call_id);
    const callIndex = messageCallId ? callIdToIndex.get(messageCallId) : undefined;
    if (callIndex !== undefined) {
      groups[callIndex].push(message);
      usedMessageIndexes.add(index);
    }
  });

  let fallbackCursor = 0;
  relatedMessages.forEach((message, messageIndex) => {
    if (usedMessageIndexes.has(messageIndex)) {
      return;
    }

    const messageName = getToolName(message);
    for (let offset = 0; offset < toolCalls.length; offset += 1) {
      const callIndex = (fallbackCursor + offset) % toolCalls.length;
      const callName = getToolCallName(toolCalls[callIndex]);
      if (!messageName || !callName || messageName === callName) {
        groups[callIndex].push(message);
        usedMessageIndexes.add(messageIndex);
        fallbackCursor = (callIndex + 1) % toolCalls.length;
        return;
      }
    }
  });

  return groups;
}

function inferRunChainItemStatus(message: MessageRecord, responseText = ""): DesktopRunChainItem["status"] {
  const raw = stringValue(message._approval_status) || stringValue(message.status);
  const normalized = raw.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("denied")) {
    return "failed";
  }
  if (message.role === "tool" || booleanValue(message._tool_result) || isRecord(message._pairedToolResponse) || responseText) {
    return "completed";
  }
  if (message.role === "progress" || hasToolCalls(message)) {
    return "running";
  }
  return "completed";
}

function runChainStatusClass(items: DesktopRunChainItem[]): DesktopRunChainItem["status"] {
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "running")) return "running";
  return "completed";
}

function runChainStatusLabel(status: DesktopRunChainItem["status"]): string {
  return {
    running: DEFAULT_LABELS.running,
    completed: DEFAULT_LABELS.completed,
    failed: DEFAULT_LABELS.failed,
  }[status];
}

function toolKindLabel(name = ""): string {
  const value = name.toLowerCase();
  if (value.includes("read")) return "Read";
  if (value.includes("write") || value.includes("create")) return "File";
  if (value.includes("exec") || value.includes("shell") || value.includes("terminal")) return "Command";
  if (value.includes("browser") || value.includes("web")) return "Browser";
  if (value.includes("task") || value.includes("agent") || value.includes("spawn")) return "Agent";
  return DEFAULT_LABELS.tool;
}

function getToolCalls(message: MessageRecord): ToolCallRecord[] {
  if (Array.isArray(message.tool_calls)) {
    return message.tool_calls.filter(isRecord);
  }
  if (isRecord(message.tool_calls)) {
    return [message.tool_calls];
  }
  return [];
}

function hasToolCalls(message: MessageRecord): boolean {
  return getToolCalls(message).length > 0;
}

function getToolName(message: MessageRecord): string {
  return stringValue(message._tool_name) || stringValue(message.name);
}

function getToolCallName(toolCall: ToolCallRecord): string {
  return stringValue(toolCallFunctionValue(toolCall, "name")) || stringValue(toolCall.name);
}

function getToolCallId(toolCall: ToolCallRecord): string {
  return stringValue(toolCall.id) || stringValue(toolCall.tool_call_id);
}

function toolCallFunctionValue(toolCall: ToolCallRecord, name: string): unknown {
  const fn = asRecord(toolCall.function);
  return fn?.[name];
}

function formatToolArguments(args: unknown): string {
  if (args == null || args === "") {
    return "";
  }
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function summarizeToolArguments(argsText: string): string {
  if (!argsText) {
    return DEFAULT_LABELS.noArguments;
  }
  const compact = argsText.replace(/\s+/g, " ").trim();
  return compactText(compact, 120);
}

function extractCommandFromToolArgs(args: unknown, argsText = ""): string {
  const parsed = parseToolArguments(args);
  if (typeof parsed.command === "string" && parsed.command.trim()) {
    return parsed.command.trim();
  }
  return firstRegexMatch(argsText, [
    /"command"\s*:\s*"([^"]+)"/i,
    /command\s*=\s*"([^"]+)"/i,
    /command\s*=\s*'([^']+)'/i,
  ]);
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (!args) {
    return {};
  }
  if (isRecord(args)) {
    return args;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseOpenCliBrowserCommand(command = ""): { action: string; url: string } | null {
  const text = String(command || "");
  const commandMatch = text.match(/opencli(?:\.(?:cmd|ps1|bat|exe))?\s+browser\s+([^\s&|;]+)?/i);
  if (!commandMatch) {
    return null;
  }
  const action = (commandMatch[1] || "open").toLowerCase();
  const url = firstRegexMatch(text, [
    /opencli(?:\.(?:cmd|ps1|bat|exe))?\s+browser\s+open\s+["']?([^"'\s&|;]+)/i,
    /(https?:\/\/[^\s"']+)/i,
  ]);
  return { action, url };
}

function parseBrowserResponseMeta(responseText = "") {
  const text = String(responseText || "");
  return {
    navigatedTo: firstRegexMatch(text, [/^Navigated to:\s*(.+)$/im]),
    url: firstRegexMatch(text, [/^URL:\s*(.+)$/im, /^url:\s*(.+)$/im]),
    title: firstRegexMatch(text, [/^title:\s*(.+)$/im]),
    viewport: firstRegexMatch(text, [/^viewport:\s*(.+)$/im]),
    pageScroll: firstRegexMatch(text, [/^page_scroll:\s*(.+)$/im]),
  };
}

function splitBrowserSnapshotOutput(responseText = "") {
  const text = String(responseText || "").trim();
  if (!text) {
    return { metadata: "", snapshot: "" };
  }
  const parts = text.split(/\r?\n---\r?\n/);
  if (parts.length < 2) {
    return { metadata: "", snapshot: "" };
  }
  return {
    metadata: parts.shift()?.trim() || "",
    snapshot: parts.join("\n---\n").trim(),
  };
}

function browserActionLabel(action = ""): string {
  return {
    open: "Open",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    click: "Click",
    type: "Type",
    select: "Select",
    keys: "Keys",
    wait: "Wait",
    state: "State",
    screenshot: "Screenshot",
    network: "Network",
  }[action] || action || DEFAULT_LABELS.browserActivity;
}

function firstRegexMatch(text = "", patterns: RegExp[] = []): string {
  const value = String(text || "");
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function compactText(text: string, length: number): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length).trim()}...` : compact;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): MessageRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
