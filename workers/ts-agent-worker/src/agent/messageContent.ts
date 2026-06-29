import type { MessageContent } from "./contextTypes.ts";
import { toTextContentBlocks } from "../support/messageHelpers.ts";

export function mergeMessageContent(left: unknown, right: unknown): MessageContent {
  if (typeof left === "string" && typeof right === "string") {
    return left.length > 0 ? `${left}\n\n${right}` : right;
  }
  return [...toTextContentBlocks(left), ...toTextContentBlocks(right)];
}
export { toTextContentBlocks };
