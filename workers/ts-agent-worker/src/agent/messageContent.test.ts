import { describe, expect, test } from "vitest";

import { mergeMessageContent, toTextContentBlocks } from "./messageContent";

describe("messageContent", () => {
  test("merges two strings with a blank line", () => {
    expect(mergeMessageContent("first", "second")).toBe("first\n\nsecond");
  });

  test("uses the right string when the left string is empty", () => {
    expect(mergeMessageContent("", "second")).toBe("second");
  });

  test("converts mixed content to text blocks", () => {
    expect(mergeMessageContent("first", [{ type: "text", text: "second" }])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  test("preserves existing blocks and stringifies non-block values", () => {
    expect(toTextContentBlocks([{ type: "image_url", image_url: { url: "file://image.png" } }, 42])).toEqual([
      { type: "image_url", image_url: { url: "file://image.png" } },
      { type: "text", text: "42" },
    ]);
  });

  test("handles nullish content as no blocks", () => {
    expect(toTextContentBlocks(null)).toEqual([]);
    expect(toTextContentBlocks(undefined)).toEqual([]);
  });
});
