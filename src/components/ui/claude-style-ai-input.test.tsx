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

  it("selects workspace conversations with @ and exposes a removable reference chip", async () => {
    const user = userEvent.setup();
    const onAddSessionMention = vi.fn();
    const onRemoveSessionMention = vi.fn();
    const options = [
      { id: "thread-1", label: "Planning notes", detail: "Workspace conversation · 5 minutes ago" },
      { id: "thread-2", label: "Architecture review", detail: "Workspace conversation · 1 minute ago" },
    ];
    const view = render(<ClaudeStyleAiInput
      onAddSessionMention={onAddSessionMention}
      onRemoveSessionMention={onRemoveSessionMention}
      sessionMentionOptions={options}
    />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(input, "Compare with @arch");

    const listbox = screen.getByRole("listbox", { name: "Workspace conversations" });
    expect(within(listbox).getByRole("option", { name: /Architecture review/ }).getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Enter}");
    expect(onAddSessionMention).toHaveBeenCalledWith("thread-2");
    expect(input.value).toBe("Compare with ");

    view.rerender(<ClaudeStyleAiInput
      onAddSessionMention={onAddSessionMention}
      onRemoveSessionMention={onRemoveSessionMention}
      selectedSessionMentionIds={["thread-2"]}
      sessionMentionOptions={options}
    />);
    const attachments = screen.getByLabelText("Composer attachments");
    expect(within(attachments).getByText("Architecture review")).toBeTruthy();

    await user.click(within(attachments).getByRole("button", { name: "Remove Architecture review" }));
    expect(onRemoveSessionMention).toHaveBeenCalledWith("thread-2");
  });

  it("selects reasoning effort from the model menu and sends the API value", async () => {
    const user = userEvent.setup();
    const onReasoningEffortChange = vi.fn();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      models={[{ id: "gpt-5.6", name: "GPT-5.6", description: "OpenAI" }]}
      onReasoningEffortChange={onReasoningEffortChange}
      onSendMessage={onSendMessage}
    />);

    await user.click(screen.getByRole("button", { name: "Select model" }));
    const menu = screen.getByRole("dialog", { name: "Model and reasoning effort" });
    expect(within(menu).getByRole("button", { name: /Model GPT-5\.6/ })).toBeTruthy();
    expect(within(menu).queryByText("Speed")).toBeNull();

    await user.click(within(menu).getByRole("button", { name: /Effort Medium/ }));
    const effortList = screen.getByRole("listbox", { name: "Reasoning effort" });
    expect(within(effortList).queryByRole("option", { name: /Default/ })).toBeNull();
    expect(within(effortList).queryByRole("option", { name: /^None/ })).toBeNull();
    expect(within(effortList).queryByRole("option", { name: /Ultra/ })).toBeNull();
    await user.click(within(effortList).getByRole("option", { name: /Extra High/ }));

    expect(onReasoningEffortChange).toHaveBeenCalledWith("xhigh");
    expect(screen.getByRole("button", { name: "Select model" }).textContent).toContain("Extra High");

    await user.type(screen.getByRole("textbox", { name: "Message" }), "Think carefully");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).toHaveBeenCalledWith("Think carefully", [], [], {
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
    });
  });

  it("queues the next turn without showing text actions while responding", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      responding
    />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "Do this afterward");
    await user.click(screen.getByRole("button", { name: "Queue as next turn" }));
    expect(onSendMessage).toHaveBeenCalledWith("Do this afterward", [], [], { reasoningEffort: "medium" });
    expect(screen.queryByText("Interrupt current task")).toBeNull();
    expect(screen.queryByText("Queue as next turn")).toBeNull();
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
      { reasoningEffort: "medium" },
    ));
  });
});
