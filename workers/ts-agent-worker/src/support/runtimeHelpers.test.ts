import { describe, expect, test } from "vitest";

import {
  buildFinalizationRetryMessage,
  EMPTY_FINAL_RESPONSE_MESSAGE,
  emptyToolResultMessage,
  ensureNonemptyToolResult,
  externalLookupSignature,
  FINALIZATION_RETRY_PROMPT,
  isBlankText,
  repeatedExternalLookupError,
} from "./runtimeHelpers";

describe("runtimeHelpers", () => {
  test("keeps legacy finalization constants stable", () => {
    expect(EMPTY_FINAL_RESPONSE_MESSAGE).toBe(
      "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.",
    );
    expect(FINALIZATION_RETRY_PROMPT).toBe(
      "You have already finished the tool work. Do not call any more tools. Using only the conversation and tool results above, provide the final answer for the user now.",
    );
    expect(buildFinalizationRetryMessage()).toEqual({ role: "user", content: FINALIZATION_RETRY_PROMPT });
  });

  test("normalizes semantically empty tool results", () => {
    expect(emptyToolResultMessage("search")).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", undefined)).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", null)).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", "   ")).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", [])).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", [{ type: "text", text: "   " }])).toBe("(search completed with no output)");
    expect(ensureNonemptyToolResult("search", [{ type: "text", text: "result" }])).toEqual([
      { type: "text", text: "result" },
    ]);
  });

  test("detects blank text without treating visible content as blank", () => {
    expect(isBlankText(undefined)).toBe(true);
    expect(isBlankText(" \n\t")).toBe(true);
    expect(isBlankText("done")).toBe(false);
  });

  test("builds stable signatures for external lookup throttling", () => {
    expect(externalLookupSignature("web_fetch", { url: " HTTPS://Example.COM/Docs " })).toBe(
      "web_fetch:https://example.com/docs",
    );
    expect(externalLookupSignature("web_search", { search_term: " TinyBot TS " })).toBe("web_search:tinybot ts");
    expect(externalLookupSignature("shell", { command: "date" })).toBeUndefined();
  });

  test("blocks repeated external lookups after the legacy retry budget", () => {
    const seenCounts: Record<string, number> = {};
    const args = { query: "same source" };

    expect(repeatedExternalLookupError("web_search", args, seenCounts)).toBeUndefined();
    expect(repeatedExternalLookupError("web_search", args, seenCounts)).toBeUndefined();
    expect(repeatedExternalLookupError("web_search", args, seenCounts)).toBe(
      "Error: repeated external lookup blocked. Use the results you already have to answer, or try a meaningfully different source.",
    );
  });
});
