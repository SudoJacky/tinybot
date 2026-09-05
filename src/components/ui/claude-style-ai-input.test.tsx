// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeStyleAiInput,
  type ComposerSkillOption,
  type ComposerSlashCommand,
} from "./claude-style-ai-input";

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

const skillOptions = [
  {
    description: "Apple-style interface design and fluid physical motion.",
    id: "apple-design",
    label: "Apple Design",
    sourceLabel: "Workspace",
  },
  {
    description: "Name unfamiliar animation and motion effects.",
    id: "animation-vocabulary",
    label: "Animation Vocabulary",
    sourceLabel: "Personal",
  },
] as const satisfies readonly ComposerSkillOption[];

afterEach(cleanup);

it("moves the panel glow with the pointer and clears it on leave", () => {
  render(<ClaudeStyleAiInput onSendMessage={vi.fn()} />);
  const panel = screen.getByRole("textbox", { name: "Message" })
    .closest<HTMLElement>(".claude-ai-input__panel")!;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 400, 200));

  fireEvent.pointerMove(panel, { clientX: 100, clientY: 70 });
  expect(panel.style.getPropertyValue("--claude-ai-panel-glow-x")).toBe("0px");
  expect(panel.style.getPropertyValue("--claude-ai-panel-glow-y")).toBe("20px");
  expect(Number(panel.style.getPropertyValue("--claude-ai-panel-glow-opacity"))).toBeGreaterThan(0);

  fireEvent.pointerLeave(panel);
  expect(panel.style.getPropertyValue("--claude-ai-panel-glow-opacity")).toBe("0");
});

describe("ClaudeStyleAiInput slash commands", () => {
  it("keeps the draft editable while sending is temporarily unavailable", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      sendDisabled
      sendDisabledReason="Loading sessions…"
    />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(input.disabled).toBe(false);

    await user.type(input, "Draft while loading");

    expect(input.value).toBe("Draft while loading");
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Loading sessions…");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

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

  it("starts a new query from any slash immediately behind the caret", async () => {
    const user = userEvent.setup();
    render(<ClaudeStyleAiInput slashCommands={slashCommands} />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(input, "//////");
    input.setSelectionRange(3, 3);
    fireEvent.select(input);

    let listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByRole("option", { name: /\/plan Plan/ })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: /\/review Review/ })).toBeTruthy();

    await user.keyboard("rev");

    listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(input.value).toBe("///rev///");
    expect(within(listbox).queryByRole("option", { name: /\/plan Plan/ })).toBeNull();
    expect(within(listbox).getByRole("option", { name: /\/review Review/ })).toBeTruthy();
  });

  it("does not invoke a slash query when the caret first enters text after a slash", () => {
    render(<ClaudeStyleAiInput slashCommands={slashCommands} value="foo/rev" />);

    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.select(input);
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();

    input.setSelectionRange(4, 4);
    fireEvent.select(input);
    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByRole("option", { name: /\/plan Plan/ })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: /\/review Review/ })).toBeTruthy();
  });

  it("renders selected Skills inline with user text while submitting only the plain message", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();

    function Harness() {
      const [message, setMessage] = useState("");
      const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
      return <ClaudeStyleAiInput
        onAddSkill={(id) => setSelectedSkills((current) => [...current, id])}
        onClearSkills={() => setSelectedSkills([])}
        onRemoveSkill={(id) => setSelectedSkills((current) => current.filter((skillId) => skillId !== id))}
        onSendMessage={onSendMessage}
        onValueChange={setMessage}
        selectedSkillIds={selectedSkills}
        skillOptions={skillOptions}
        slashCommands={slashCommands}
        value={message}
      />;
    }

    render(<Harness />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "/apple");

    const listbox = screen.getByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByText("Skills")).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: /Apple Design.*Workspace/ })).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(within(input).getByText("Apple Design")).toBeTruthy();
    expect(screen.queryByLabelText("Composer attachments")).toBeNull();

    await user.keyboard("{Backspace}");
    expect(within(input).queryByText("Apple Design")).toBeNull();
    await user.keyboard("/apple{Enter}");
    expect(within(input).getByText("Apple Design")).toBeTruthy();
    expect(within(input).getByRole("button", { name: "Remove Apple Design" })).toBeTruthy();

    await user.keyboard("我希望这样显示 /animation");
    await user.keyboard("{Enter}");
    await user.keyboard("在用户的输入内容中显示");

    expect(within(input).getByText("Animation Vocabulary")).toBeTruthy();
    expect(input.textContent).toBe("Apple Design我希望这样显示 Animation Vocabulary在用户的输入内容中显示");

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).toHaveBeenCalledWith(
      "我希望这样显示 在用户的输入内容中显示",
      [],
      [],
      expect.any(Object),
    );
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

  it("applies asynchronous default selection and submits current tool selection", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    const view = render(<ClaudeStyleAiInput onSendMessage={onSendMessage} tools={[]} />);

    view.rerender(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      tools={[{
        allowed: true,
        available: true,
        defaultSelected: true,
        description: "Run a saved workflow.",
        id: "agent_graph.run.review",
        name: "Review workflow",
        selected: true,
      }]}
    />);

    await user.click(screen.getByRole("button", { name: "Tools" }));
    const graphTool = screen.getByRole("menuitemcheckbox", { name: /Review workflow/ });
    await vi.waitFor(() => expect(graphTool.getAttribute("aria-checked")).toBe("true"));
    await user.click(graphTool);
    expect(graphTool.getAttribute("aria-checked")).toBe("false");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Review this incident");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("Review this incident", [], [], {
      reasoningEffort: "high",
      selectedTools: [],
    });
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

    await user.click(within(menu).getByRole("button", { name: /Effort High/ }));
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

  it("uses one primary action that switches between stop and send", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    const onStopResponding = vi.fn();
    const view = render(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      onStopResponding={onStopResponding}
      responding
    />);

    expect(document.querySelectorAll(".claude-ai-input__send")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Queue as next turn" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onStopResponding).toHaveBeenCalledTimes(1);

    view.rerender(<ClaudeStyleAiInput
      onSendMessage={onSendMessage}
      onStopResponding={onStopResponding}
    />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "Start the next turn");
    expect(document.querySelectorAll(".claude-ai-input__send")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Stop generation" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).toHaveBeenCalledWith("Start the next turn", [], [], { reasoningEffort: "high" });
  });

  it("submits and clears externally controlled file attachments", async () => {
    const user = userEvent.setup();
    const files = [{
      contentHash: "abc123",
      id: "file-1",
      mimeType: "image/png",
      name: "diagram.png",
      path: "C:\\Tinybot\\diagram.png",
      sizeBytes: 2048,
    }];
    const onFilesChange = vi.fn();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      files={files}
      onFilesChange={onFilesChange}
      onSendMessage={onSendMessage}
    />);

    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("", files, [], { reasoningEffort: "high" });
    expect(onFilesChange).toHaveBeenCalledWith([]);
  });

  it("renders, removes, and clears expanded spreadsheet annotation context", async () => {
    const user = userEvent.setup();
    const onClearContextReferences = vi.fn();
    const onRemoveContextReference = vi.fn();
    const onSendMessage = vi.fn();
    render(<ClaudeStyleAiInput
      contextReferences={[{
        annotation: { label: "1 annotation", text: "Increase the total to 24" },
        body: "18",
        detail: "Range: Revenue!C5",
        id: "spreadsheet-1",
        kind: "file",
        label: "q4.xlsx",
      }]}
      onClearContextReferences={onClearContextReferences}
      onRemoveContextReference={onRemoveContextReference}
      onSendMessage={onSendMessage}
    />);

    const attachments = screen.getByLabelText("Composer attachments");
    expect(within(attachments).getByText("q4.xlsx")).toBeTruthy();
    expect(within(attachments).getByText("Range: Revenue!C5")).toBeTruthy();
    expect(within(attachments).getByText("18")).toBeTruthy();
    expect(within(attachments).getByText("1 annotation")).toBeTruthy();
    expect(within(attachments).getByText("Increase the total to 24")).toBeTruthy();

    await user.click(within(attachments).getByRole("button", { name: "Remove q4.xlsx" }));
    expect(onRemoveContextReference).toHaveBeenCalledWith("spreadsheet-1");

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).toHaveBeenCalledWith("", [], [], { reasoningEffort: "high" });
    expect(onClearContextReferences).toHaveBeenCalledOnce();
  });

  it("rejects image selections for a model without image input while keeping ordinary files", async () => {
    const user = userEvent.setup();
    const onSelectFiles = vi.fn(async () => ([
      {
        contentHash: "image-hash",
        mimeType: "image/png",
        name: "diagram.png",
        path: "C:\\Tinybot\\diagram.png",
        sizeBytes: 2048,
      },
      {
        mimeType: "text/plain",
        name: "notes.txt",
        path: "C:\\Tinybot\\notes.txt",
        sizeBytes: 64,
      },
    ]));
    render(<ClaudeStyleAiInput
      defaultModel="text-model"
      models={[{
        id: "text-model",
        name: "Text model",
        description: "Provider",
        supportsImageInput: false,
      }]}
      onSelectFiles={onSelectFiles}
    />);

    await user.click(screen.getByRole("button", { name: "Attach files" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Text model does not support image input");
    expect(screen.queryByText("diagram.png")).toBeNull();
    expect(screen.getByText("notes.txt")).toBeTruthy();
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
      { reasoningEffort: "high" },
    ));
  });
});
