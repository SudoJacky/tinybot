import type { MessageContent, MessageContentBlock, TextContentBlock } from "./contextTypes.ts";

export function mergeMessageContent(left: unknown, right: unknown): MessageContent {
  if (typeof left === "string" && typeof right === "string") {
    return left.length > 0 ? `${left}\n\n${right}` : right;
  }
  return [...toTextContentBlocks(left), ...toTextContentBlocks(right)];
}

export function toTextContentBlocks(value: unknown): MessageContentBlock[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isContentBlock(item)) {
        return item;
      }
      return textBlock(String(item));
    });
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [textBlock(String(value))];
}

function isContentBlock(value: unknown): value is MessageContentBlock {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string";
}

function textBlock(text: string): TextContentBlock {
  return { type: "text", text };
}
