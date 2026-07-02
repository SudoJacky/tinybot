import { describe, expect, test } from "vitest";

import {
  closeChatDetailPanel,
  openChatDetailPanel,
  resolveChatDetailPresentation,
} from "./chatDetailPanelState";

describe("chat detail panel state", () => {
  test("opens a drawer detail panel for a selected target on desktop widths", () => {
    expect(openChatDetailPanel("tool", "tool-1", 1280)).toEqual({
      kind: "tool",
      open: true,
      presentation: "drawer",
      targetId: "tool-1",
    });
  });

  test("opens fullscreen detail on narrow widths", () => {
    expect(openChatDetailPanel("subagent", "delegate-1", 719)).toEqual({
      kind: "subagent",
      open: true,
      presentation: "fullscreen",
      targetId: "delegate-1",
    });
  });

  test("closes the current detail panel without keeping the target", () => {
    expect(closeChatDetailPanel()).toEqual({
      kind: "none",
      open: false,
      presentation: "drawer",
    });
  });

  test("uses drawer at and above the 720px breakpoint", () => {
    expect(resolveChatDetailPresentation(719)).toBe("fullscreen");
    expect(resolveChatDetailPresentation(720)).toBe("drawer");
  });
});
