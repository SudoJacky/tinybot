import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import {
  deriveSessionTitle,
  displaySessionTitle,
  isDefaultSessionTitle,
} from "./sessionTitle";

const t = ((key: string) => key === "shell.newChat" ? "New chat" : key) as TFunction<"chat">;

describe("sessionTitle", () => {
  test("localizes known default titles without changing user titles", () => {
    expect(isDefaultSessionTitle("New session")).toBe(true);
    expect(isDefaultSessionTitle("新建会话")).toBe(true);
    expect(displaySessionTitle("New chat", t)).toBe("New chat");
    expect(displaySessionTitle("Architecture review", t)).toBe("Architecture review");
  });

  test("normalizes and bounds optimistic titles", () => {
    expect(deriveSessionTitle("  inspect   the timeline  ", t)).toBe("inspect the timeline");
    expect(deriveSessionTitle("x".repeat(40), t)).toBe(`${"x".repeat(28)}…`);
    expect(deriveSessionTitle("", t)).toBe("New chat");
  });
});
