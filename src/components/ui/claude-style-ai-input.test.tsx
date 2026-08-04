// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeStyleAiInput, type ComposerSlashCommand } from "./claude-style-ai-input";

const slashCommands = [
  {
    command: "/plan",
    description: "Plan the work",
    label: "Plan",
    prompt: "Plan this task before editing.",
  },
  {
    command: "/review",
    description: "Review current changes",
    label: "Review",
    prompt: "Review the current changes.",
  },
] as const satisfies readonly ComposerSlashCommand[];

afterEach(cleanup);

describe("ClaudeStyleAiInput slash commands", () => {
  it("navigates commands with arrow keys and expands the selected prompt", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput onSendMessage={onSendMessage} slashCommands={slashCommands} />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(input, "/");

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByRole("option", { name: /\/plan Plan/ }).getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(within(listbox).getByRole("option", { name: /\/review Review/ }).getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Enter}");
    expect(input.value).toBe("Review the current changes.");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("dismisses the menu with Escape without changing the draft", async () => {
    const user = userEvent.setup();
    render(<ClaudeStyleAiInput slashCommands={slashCommands} />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(input, "/");
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
    expect(input.value).toBe("/");
  });

  it("submits control commands immediately when selected", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      slashCommands={[{
        command: "/compact",
        description: "Compact context",
        label: "Compact",
        prompt: "/compact",
        submitOnSelect: true,
      }]}
    />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "/comp");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalledWith(
      "/compact",
      [],
      [],
      {},
    ));
  });
});
