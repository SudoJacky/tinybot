import type { ToolCallRequest } from "../model/provider.ts";

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type MessageContentBlock = Record<string, unknown> & {
  type: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCallRequest[];
  reasoningContent?: string;
  thinkingBlocks?: Array<Record<string, unknown>>;
};

export function currentTimeString(timezone?: string | null, now: Date = new Date()): string {
  const resolved = formatDateParts(timezone, now) ?? formatDateParts(undefined, now);
  const offset = resolved?.offset ?? offsetForDate(now);
  const timezoneName = timezone || resolved?.timeZoneName || "UTC";
  return `${resolved?.dateTime ?? fallbackDateTime(now)} (${timezoneName}, UTC${offset})`;
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

export function stringifyTextBlocks(content: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    parts.push(block.text);
  }
  return parts.join("\n");
}

export function splitMessage(content: string, maxLen = 2000): string[] {
  if (!content) {
    return [];
  }
  if (content.length <= maxLen) {
    return [content];
  }
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const cut = remaining.slice(0, maxLen);
    let position = cut.lastIndexOf("\n");
    if (position <= 0) {
      position = cut.lastIndexOf(" ");
    }
    if (position <= 0) {
      position = maxLen;
    }
    chunks.push(remaining.slice(0, position));
    remaining = remaining.slice(position).trimStart();
  }
  return chunks;
}

export function buildAssistantMessage(
  content: string | null,
  options: {
    toolCalls?: ToolCallRequest[];
    reasoningContent?: string | null;
    thinkingBlocks?: Array<Record<string, unknown>>;
  } = {},
): AssistantMessage {
  const message: AssistantMessage = { role: "assistant", content };
  if (options.toolCalls && options.toolCalls.length > 0) {
    message.toolCalls = options.toolCalls;
  }
  if (options.reasoningContent !== undefined || options.thinkingBlocks) {
    message.reasoningContent = options.reasoningContent ?? "";
  }
  if (options.thinkingBlocks && options.thinkingBlocks.length > 0) {
    message.thinkingBlocks = options.thinkingBlocks;
  }
  return message;
}

export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think[\s\S]*$/g, "")
    .trim();
}

export function toTextContentBlocks(value: unknown): MessageContentBlock[] {
  if (Array.isArray(value)) {
    return value.map((item) => (isContentBlock(item) ? item : textBlock(String(item))));
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [textBlock(String(value))];
}

function formatDateParts(
  timezone: string | undefined | null,
  now: Date,
): { dateTime: string; offset: string; timezoneAccepted: boolean; timeZoneName?: string } | undefined {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "long",
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(now);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    const year = byType.get("year") ?? "0000";
    const month = byType.get("month") ?? "01";
    const day = byType.get("day") ?? "01";
    const hour = normalizeHour(byType.get("hour") ?? "00");
    const minute = byType.get("minute") ?? "00";
    const weekday = byType.get("weekday") ?? "Monday";
    const rawOffset = byType.get("timeZoneName") ?? "GMT+0";
    return {
      dateTime: `${year}-${month}-${day} ${hour}:${minute} (${weekday})`,
      offset: normalizeOffset(rawOffset),
      timezoneAccepted: timezone !== undefined && timezone !== null,
      timeZoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  } catch {
    return undefined;
  }
}

function fallbackDateTime(now: Date): string {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = pad2(now.getHours());
  const minute = pad2(now.getMinutes());
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
  return `${year}-${month}-${day} ${hour}:${minute} (${weekday})`;
}

function offsetForDate(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

function normalizeOffset(value: string): string {
  const normalized = value.replace(/^GMT/i, "").replace(/^UTC/i, "");
  if (!normalized || normalized === "0") {
    return "+00:00";
  }
  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    return "+00:00";
  }
  return `${match[1]}${pad2(Number(match[2]))}:${match[3] ?? "00"}`;
}

function normalizeHour(hour: string): string {
  return hour === "24" ? "00" : hour;
}

function isContentBlock(value: unknown): value is MessageContentBlock {
  return isRecord(value) && typeof value.type === "string";
}

function textBlock(text: string): TextContentBlock {
  return { type: "text", text };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
