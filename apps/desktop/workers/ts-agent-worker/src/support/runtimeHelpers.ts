export const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.";

export const FINALIZATION_RETRY_PROMPT =
  "You have already finished the tool work. Do not call any more tools. Using only the conversation and tool results above, provide the final answer for the user now.";

const MAX_REPEAT_EXTERNAL_LOOKUPS = 2;

export function emptyToolResultMessage(toolName: string): string {
  return `(${toolName} completed with no output)`;
}

export function ensureNonemptyToolResult(toolName: string, content: unknown): unknown {
  if (content === null || content === undefined) {
    return emptyToolResultMessage(toolName);
  }
  if (typeof content === "string" && content.trim().length === 0) {
    return emptyToolResultMessage(toolName);
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return emptyToolResultMessage(toolName);
    }
    const textPayload = stringifyTextBlocks(content);
    if (textPayload !== undefined && textPayload.trim().length === 0) {
      return emptyToolResultMessage(toolName);
    }
  }
  return content;
}

export function isBlankText(content: string | undefined | null): boolean {
  return content === undefined || content === null || content.trim().length === 0;
}

export function buildFinalizationRetryMessage(): { role: "user"; content: string } {
  return { role: "user", content: FINALIZATION_RETRY_PROMPT };
}

export function normalizeToolResultContent(toolName: string, content: string, budget?: number): string {
  const nonemptyContent = content.trim().length === 0 ? emptyToolResultMessage(toolName) : content;
  return applyTextBudget(nonemptyContent, budget);
}

export function applyTextBudget(content: string, budget: number | undefined): string {
  if (budget === undefined || budget <= 0 || content.length <= budget) {
    return content;
  }
  return `${content.slice(0, budget)}\n... (truncated)`;
}

export function externalLookupSignature(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "web_fetch") {
    const url = String(args.url ?? "").trim();
    if (url.length > 0) {
      return `web_fetch:${url.toLowerCase()}`;
    }
  }
  if (toolName === "web_search") {
    const query = String(args.query ?? args.search_term ?? "").trim();
    if (query.length > 0) {
      return `web_search:${query.toLowerCase()}`;
    }
  }
  return undefined;
}

export function repeatedExternalLookupError(
  toolName: string,
  args: Record<string, unknown>,
  seenCounts: Record<string, number>,
): string | undefined {
  const signature = externalLookupSignature(toolName, args);
  if (!signature) {
    return undefined;
  }
  const count = (seenCounts[signature] ?? 0) + 1;
  seenCounts[signature] = count;
  if (count <= MAX_REPEAT_EXTERNAL_LOOKUPS) {
    return undefined;
  }
  return "Error: repeated external lookup blocked. Use the results you already have to answer, or try a meaningfully different source.";
}

function stringifyTextBlocks(content: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      return undefined;
    }
    if (part.type !== "text") {
      return undefined;
    }
    parts.push(typeof part.text === "string" ? part.text : "");
  }
  return parts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
