// @vitest-environment happy-dom

import { createRef } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatStep } from "../../app-core/chat/chatRunModel";
import { LiveCanvas, type LiveCanvasEntry } from "./LiveCanvas";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function step(overrides: Partial<ChatStep>): ChatStep {
  return {
    agentContext: { id: "main", title: "Tinybot", type: "main" },
    id: "step-1",
    kind: "tool_call",
    sequence: 0,
    status: "completed",
    title: "Tool",
    ...overrides,
  };
}

function entry(canvasStep: ChatStep, turnId = "turn-1"): LiveCanvasEntry {
  return { step: canvasStep, turnId };
}

function canvasProps(entries: LiveCanvasEntry[], overrides: Record<string, unknown> = {}) {
  return {
    agentUiForms: [] as AgentUiForm[],
    entries,
    headingRef: createRef<HTMLHeadingElement>(),
    mode: "live_follow" as const,
    onCancelForm: vi.fn(),
    onAttachContext: vi.fn(),
    onClose: vi.fn(),
    onOpenArtifact: vi.fn(),
    onResolveApproval: vi.fn(),
    onReturnToLive: vi.fn(),
    onSelectEntry: vi.fn(),
    onSubmitForm: vi.fn(),
    onWidthChange: vi.fn(),
    resolvingApprovalId: "",
    widthPx: 480,
    ...overrides,
  };
}

describe("LiveCanvas TinyOS", () => {
  it("renders stable Files and Terminal applications from canonical entries", () => {
    const entries = [
      entry(step({
        id: "file",
        title: "workspace.read_file",
        toolCall: { argsJson: { path: "src/app.ts" }, id: "file", name: "workspace.read_file", resultPreview: "export default app;" },
      })),
      entry(step({
        id: "shell",
        status: "running",
        title: "Run checks",
        toolCall: { argsJson: { cmd: "npm test" }, id: "shell", name: "shell.exec", resultPreview: "Tests passed" },
      })),
    ];

    render(<LiveCanvas {...canvasProps(entries, { widthPx: 680 })} />);

    const canvas = screen.getByLabelText("Live Canvas");
    expect(within(canvas).getByRole("heading", { name: "TinyOS" })).toBeTruthy();
    expect(within(canvas).getAllByText("Structured simulation").length).toBeGreaterThan(0);
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(within(canvas).getAllByText("src/app.ts").length).toBeGreaterThan(0);
    expect(within(canvas).getAllByText(/npm test/).length).toBeGreaterThan(0);
    expect(within(canvas).getByText(/Tests passed/)).toBeTruthy();
    const shelf = within(canvas).getByRole("navigation", { name: "TinyOS recent operations" });
    expect(within(shelf).getAllByRole("button")).toHaveLength(1);
    expect(within(shelf).getByText("shell.exec")).toBeTruthy();
  });

  it("reconstructs a historical desktop and returns to live", async () => {
    const user = userEvent.setup();
    const onReturnToLive = vi.fn();
    const onSelectEntry = vi.fn();
    const entries = [
      entry(step({ id: "file", toolCall: { argsJson: { path: "src/main.ts" }, id: "file", name: "workspace.read_file" } })),
      entry(step({ id: "memory", title: "memory.search", toolCall: { argsJson: { query: "TinyOS" }, id: "memory", name: "memory.search" } })),
    ];

    render(<LiveCanvas {...canvasProps(entries, { mode: "history", onReturnToLive, onSelectEntry, selection: entries[0] })} />);

    const canvas = screen.getByLabelText("Live Canvas");
    expect(within(canvas).getByText("History")).toBeTruthy();
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='memory']")).toBeNull();
    await user.click(within(canvas).getByRole("button", { name: "Next canonical operation" }));
    expect(onSelectEntry).toHaveBeenCalledWith(entries[1]);
    await user.click(within(canvas).getByRole("button", { name: "Return to live" }));
    expect(onReturnToLive).toHaveBeenCalledTimes(1);
  });

  it("resolves approvals directly from a TinyOS system dialog", async () => {
    const user = userEvent.setup();
    const onResolveApproval = vi.fn();
    const approval = entry(step({
      approval: { approvalId: "approval-1", riskLevel: "high" },
      id: "approval",
      kind: "approval",
      summary: "npm test -- --runInBand",
      status: "blocked",
      title: "Run shell command",
    }));

    render(<LiveCanvas {...canvasProps([approval], { onResolveApproval })} />);

    const dialog = screen.getByRole("dialog", { name: "TinyOS approval request" });
    expect(within(dialog).getByText("high")).toBeTruthy();
    expect(within(dialog).getByText("npm test -- --runInBand")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Approve for session" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Approve once" }));
    expect(onResolveApproval).toHaveBeenCalledWith("approval-1", "approveOnce");
  });

  it("submits a matching Agent UI form from TinyOS", async () => {
    const user = userEvent.setup();
    const onSubmitForm = vi.fn();
    const form: AgentUiForm = {
      correlation: {},
      fields: [{ label: "Repository", name: "repository", required: true, type: "text" }],
      form_id: "form-1",
      title: "Choose repository",
    };
    const formEntry = entry(step({
      form: { fieldIds: ["repository"], formId: "form-1" },
      id: "form",
      kind: "form",
      status: "blocked",
      title: "Repository input",
    }));

    render(<LiveCanvas {...canvasProps([formEntry], { agentUiForms: [form], onSubmitForm })} />);

    const dialog = screen.getByRole("dialog", { name: "TinyOS input request" });
    await user.type(within(dialog).getByLabelText("Repository"), "tinybot");
    await user.click(within(dialog).getByRole("button", { name: "Submit" }));
    expect(onSubmitForm).toHaveBeenCalledWith(form, { repository: "tinybot" });
  });

  it("supports keyboard resizing and operation history selection", async () => {
    const user = userEvent.setup();
    const onSelectEntry = vi.fn();
    const onWidthChange = vi.fn();
    const fileEntry = entry(step({ id: "file", toolCall: { id: "file", name: "workspace.read_file" } }));

    render(<LiveCanvas {...canvasProps([fileEntry], { onSelectEntry, onWidthChange })} />);

    const separator = screen.getByRole("separator", { name: "Resize TinyOS" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(504);
    const shelf = screen.getByRole("navigation", { name: "TinyOS recent operations" });
    await user.click(within(shelf).getByRole("button", { name: /workspace\.read_file/i }));
    expect(onSelectEntry).toHaveBeenCalledWith(fileEntry);
  });

  it("switches between compact and workspace widths from the system bar", async () => {
    const user = userEvent.setup();
    const onWidthChange = vi.fn();
    const fileEntry = entry(step({ id: "file", toolCall: { id: "file", name: "workspace.read_file" } }));
    const { rerender } = render(<LiveCanvas {...canvasProps([fileEntry], { onWidthChange, widthPx: 480 })} />);

    await user.click(screen.getByRole("button", { name: "Expand TinyOS workspace" }));
    expect(onWidthChange).toHaveBeenCalledWith(680);

    rerender(<LiveCanvas {...canvasProps([fileEntry], { onWidthChange, widthPx: 680 })} />);
    await user.click(screen.getByRole("button", { name: "Use compact TinyOS workspace" }));
    expect(onWidthChange).toHaveBeenLastCalledWith(480);
  });

  it("shows one focused application in compact mode and restores another from the launcher", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "file", toolCall: { argsJson: { path: "src/main.ts" }, id: "file", name: "workspace.read_file" } })),
      entry(step({ id: "shell", toolCall: { argsJson: { cmd: "npm test" }, id: "shell", name: "shell.exec" } })),
    ];

    render(<LiveCanvas {...canvasProps(entries, { widthPx: 480 })} />);

    const canvas = screen.getByLabelText("Live Canvas");
    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='files']")).toBeNull();
    await user.click(within(canvas).getByRole("button", { name: "Open Files" }));
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='terminal']")).toBeNull();
  });

  it("supports keyboard window movement, snapping, maximize, and minimize", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({ id: "file", toolCall: { id: "file", name: "workspace.read_file" } }));
    render(<LiveCanvas {...canvasProps([fileEntry], { widthPx: 680 })} />);

    const canvas = screen.getByLabelText("Live Canvas");
    const titlebar = within(canvas).getByLabelText("Move Files window");
    const appWindow = canvas.querySelector<HTMLElement>("[data-app='files']")!;
    const initialLeft = appWindow.style.left;
    fireEvent.keyDown(titlebar, { key: "ArrowRight" });
    expect(appWindow.style.left).not.toBe(initialLeft);
    fireEvent.keyDown(titlebar, { altKey: true, key: "ArrowLeft" });
    expect(appWindow.style.left).toBe("10px");
    fireEvent.keyDown(titlebar, { altKey: true, key: "ArrowUp" });
    expect(appWindow.dataset.maximized).toBe("true");
    fireEvent.keyDown(titlebar, { altKey: true, key: "ArrowDown" });
    expect(canvas.querySelector("[data-app='files']")).toBeNull();
    await user.click(within(canvas).getByRole("button", { name: "Open Files" }));
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
  });

  it("navigates canonical file tabs and creates a visible line-range selection", async () => {
    const user = userEvent.setup();
    const onAttachContext = vi.fn();
    const entries = [
      entry(step({ id: "file-a", toolCall: { argsJson: { path: "src/a.ts" }, id: "file-a", name: "workspace.read_file", resultPreview: "const a = 1;\nexport { a };" } })),
      entry(step({ id: "file-b", toolCall: { argsJson: { path: "src/b.ts" }, id: "file-b", name: "workspace.read_file", resultPreview: "const b = 2;" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { onAttachContext, widthPx: 680 })} />);

    const filesWindow = screen.getByLabelText("Files window");
    await user.click(within(filesWindow).getByRole("tab", { name: "a.ts" }));
    expect(within(filesWindow).getByText("const a = 1;")).toBeTruthy();
    await user.click(within(filesWindow).getByRole("button", { name: "const a = 1;" }));
    fireEvent.click(within(filesWindow).getByRole("button", { name: "export { a };" }), { shiftKey: true });
    await user.click(within(filesWindow).getByRole("button", { name: "Attach src/a.ts · L1–2" }));
    expect(onAttachContext).toHaveBeenCalledWith({
      endLine: 2,
      kind: "file",
      path: "src/a.ts",
      selectedText: "const a = 1;\nexport { a };",
      sourceItemId: "file-a",
      startLine: 1,
      turnId: "turn-1",
    });
  });

  it("switches terminal command tabs and controls search, stream, and follow", async () => {
    const user = userEvent.setup();
    const onAttachContext = vi.fn();
    const entries = [
      entry(step({ id: "shell-a", toolCall: { argsJson: { cmd: "npm test" }, id: "shell-a", name: "shell.exec", resultPreview: "PASS tinyos" } })),
      entry(step({ id: "shell-b", toolCall: { argsJson: { cmd: "npm run build" }, id: "shell-b", name: "shell.exec", resultPreview: "built" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { onAttachContext, widthPx: 680 })} />);

    const terminal = screen.getByLabelText("Terminal window");
    await user.click(within(terminal).getByRole("tab", { name: "npm test" }));
    expect(within(terminal).getByText("PASS tinyos")).toBeTruthy();
    await user.type(within(terminal).getByLabelText("Search terminal output"), "pass");
    expect(within(terminal).getByText("1 matches")).toBeTruthy();
    await user.selectOptions(within(terminal).getByLabelText("Terminal stream filter"), "stderr");
    await user.click(within(terminal).getByRole("button", { name: "Pause" }));
    expect(within(terminal).getByText("Follow paused")).toBeTruthy();
    await user.selectOptions(within(terminal).getByLabelText("Terminal stream filter"), "stdout");
    await user.click(within(terminal).getByRole("button", { name: "PASS tinyos" }));
    await user.click(within(terminal).getByRole("button", { name: "Attach output L2" }));
    expect(onAttachContext).toHaveBeenCalledWith({
      command: "npm test",
      endLine: 2,
      kind: "terminal",
      selectedText: "PASS tinyos",
      sourceItemId: "shell-a",
      startLine: 2,
      turnId: "turn-1",
    });
  });

  it("pins two canonical evidence items into a split Inspector", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "file", title: "Read config", toolCall: { id: "file", name: "workspace.read_file" } })),
      entry(step({ id: "shell", title: "Run tests", toolCall: { id: "shell", name: "shell.exec" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { widthPx: 680 })} />);

    await user.click(screen.getByRole("button", { name: "Inspect Files" }));
    await user.click(screen.getByRole("button", { name: "Inspect Terminal" }));
    const inspector = screen.getByLabelText("TinyOS Inspector");
    expect(inspector.dataset.split).toBe("true");
    expect(within(inspector).getByText("Read config")).toBeTruthy();
    expect(within(inspector).getByText("Run tests")).toBeTruthy();
  });

  it("closes from the responsive backdrop unless a system dialog needs attention", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fileEntry = entry(step({ id: "file", toolCall: { id: "file", name: "workspace.read_file" } }));
    const { rerender } = render(<LiveCanvas {...canvasProps([fileEntry], { onClose })} />);

    await user.click(screen.getByRole("button", { name: "Close TinyOS overlay" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const approval = entry(step({
      approval: { approvalId: "approval-1", riskLevel: "high" },
      id: "approval",
      kind: "approval",
      status: "blocked",
      title: "Run shell command",
    }));
    rerender(<LiveCanvas {...canvasProps([approval], { onClose })} />);
    expect(screen.queryByRole("button", { name: "Close TinyOS overlay" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "TinyOS approval request" })).toBeTruthy();
  });
});
