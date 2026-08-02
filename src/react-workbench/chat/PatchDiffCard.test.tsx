// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "../../app-core/chat/chatTurnModel";
import { PatchDiffCard, patchChangeSetFromToolResult } from "./PatchDiffCard";

const applyPatchToolCall: ToolCallState = {
  id: "call-1",
  name: "apply_patch",
  resultJson: {
    content: "Applied patch",
    result: {
      changed_files: [{
        path: "src/lib.rs",
        operation: "update",
        hunks: [{ index: 1, removed_lines: 1, added_lines: 1 }],
        delta: [{
          old_start: 12,
          new_start: 12,
          old_lines: ["fn before() {}"],
          new_lines: ["fn after() {}"],
        }],
        delta_truncated: false,
      }],
      files_changed: 1,
      hunks_applied: 1,
    },
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PatchDiffCard", () => {
  it("unwraps the executor result and renders an expanded line diff", () => {
    expect(patchChangeSetFromToolResult(applyPatchToolCall.resultJson)?.files).toHaveLength(1);

    render(<PatchDiffCard status="completed" toolCall={applyPatchToolCall} />);

    expect(screen.getByRole("button", { name: "Toggle details for Edited lib.rs" })
      .getAttribute("aria-expanded"))
      .toBe("true");
    expect(screen.getByText("Completed")).toBeTruthy();
    const file = screen.getByRole("article", { name: "Diff for src/lib.rs" });
    expect(within(file).getByText("fn before() {}").closest("[data-diff-kind='remove']"))
      .not.toBeNull();
    expect(within(file).getByText("fn after() {}").closest("[data-diff-kind='add']"))
      .not.toBeNull();
    expect(within(file).getByText("12", { selector: "[data-line-side='old']" })).toBeTruthy();
    expect(within(file).getByText("12", { selector: "[data-line-side='new']" })).toBeTruthy();
  });

  it("collapses the preview and copies a unified diff", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<PatchDiffCard status="completed" toolCall={applyPatchToolCall} />);

    const toggle = screen.getByRole("button", { name: "Toggle details for Edited lib.rs" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("patch-diff-content").closest("[hidden]")).not.toBeNull();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Copy diff for src/lib.rs" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("--- a/src/lib.rs")));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("+fn after() {}"));
  });

  it("keeps the file summary visible when a large delta was truncated", () => {
    render(<PatchDiffCard status="completed" toolCall={{
      ...applyPatchToolCall,
      resultJson: {
        changed_files: [{
          path: "src/large.rs",
          operation: "update",
          hunks: [{ index: 1, removed_lines: 4_000, added_lines: 4_001 }],
          delta: [],
          delta_truncated: true,
        }],
      },
    }} />);

    expect(screen.getByText("Preview unavailable because this change is larger than 2 MiB."))
      .toBeTruthy();
    expect(screen.getAllByText("+4001")).toHaveLength(2);
    expect(screen.getAllByText("-4000")).toHaveLength(2);
  });
});
