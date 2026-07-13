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
    canCancelRun: false,
    canPauseRun: false,
    canRequestChange: false,
    canResumeRun: false,
    canRetryRun: false,
    commandLifecycle: { stage: "idle" } as const,
    entries,
    headingRef: createRef<HTMLHeadingElement>(),
    mode: "live_follow" as const,
    onCancelForm: vi.fn(),
    onCancelRun: vi.fn(),
    onPauseRun: vi.fn(),
    onAgentRequest: vi.fn(),
    onAttachContext: vi.fn(),
    onClose: vi.fn(),
    onOpenArtifact: vi.fn(),
    onResolveApproval: vi.fn(),
    onRetryOperation: vi.fn(),
    onReturnToLive: vi.fn(),
    onResumeRun: vi.fn(),
    onSelectEntry: vi.fn(),
    onSubmitForm: vi.fn(),
    onWidthChange: vi.fn(),
    resolvingApprovalId: "",
    widthPx: 480,
    ...overrides,
  };
}

describe("LiveCanvas TinyOS", () => {
  it("exposes the shared cancel control and its pending state", async () => {
    const onCancelRun = vi.fn();
    const { rerender } = render(<LiveCanvas {...canvasProps([], { canCancelRun: true, onCancelRun })} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel active Agent run" }));
    expect(onCancelRun).toHaveBeenCalledTimes(1);

    rerender(<LiveCanvas {...canvasProps([], {
      canCancelRun: true,
      commandLifecycle: {
        command: {
          schemaVersion: "tinybot.command.v1",
          commandId: "command-1",
          issuedAt: "2026-07-13T00:00:00Z",
          kind: "agent.cancel",
          source: { control: "system-bar-cancel", surface: "tinyos" },
          target: { runId: "run-1", sessionId: "session-1" },
        },
        dispatchedAtMs: 1,
        transportAcceptedAtMs: 2,
        stage: "waiting_for_canonical",
      },
      onCancelRun,
    })} />);
    expect((screen.getByRole("button", { name: "Cancel command pending" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Awaiting runtime")).toBeTruthy();
  });

  it("routes pause and resume through the shared run controller", async () => {
    const onPauseRun = vi.fn();
    const onResumeRun = vi.fn();
    const { rerender } = render(<LiveCanvas {...canvasProps([], { canPauseRun: true, onPauseRun, onResumeRun })} />);

    await userEvent.click(screen.getByRole("button", { name: "Pause active Agent run" }));
    expect(onPauseRun).toHaveBeenCalledTimes(1);

    rerender(<LiveCanvas {...canvasProps([], { canResumeRun: true, onPauseRun, onResumeRun })} />);
    await userEvent.click(screen.getByRole("button", { name: "Resume paused Agent run" }));
    expect(onResumeRun).toHaveBeenCalledTimes(1);
  });

  it("marks Agent requests from History as new live operations", async () => {
    const onAgentRequest = vi.fn();
    const fileEntry = entry(step({
      id: "file-history-1",
      title: "workspace.read_file",
      toolCall: {
        argsJson: { path: "src/main.ts" },
        id: "file-history-call-1",
        name: "workspace.read_file",
        resultPreview: "export const ready = true;",
      },
    }));
    render(<LiveCanvas {...canvasProps([fileEntry], {
      canRequestChange: true,
      mode: "history",
      onAgentRequest,
      selection: fileEntry,
    })} />);

    const files = screen.getByLabelText("Files window");
    await userEvent.click(within(files).getByRole("button", { name: "export const ready = true;" }));
    await userEvent.click(within(files).getByRole("button", { name: "Explain" }));

    expect(onAgentRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: "file" }), "explain", true);
  });

  it("routes retry for the failed canonical operation through the shared callback", async () => {
    const onRetryOperation = vi.fn();
    const failed = entry(step({ id: "error-failed", kind: "error", status: "failed", title: "Operation failed" }), "run-failed");
    render(<LiveCanvas {...canvasProps([failed], { canRetryRun: true, onRetryOperation })} />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetryOperation).toHaveBeenCalledWith(failed);
  });

  it("explains backend-authored cancellation denial", () => {
    render(<LiveCanvas {...canvasProps([], {
      cancelUnavailableReason: "The run is waiting for user input.",
    })} />);

    const cancel = screen.getByRole("button", { name: "Cancel active Agent run" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(cancel.getAttribute("title")).toBe("The run is waiting for user input.");
    expect(screen.getByText("The run is waiting for user input.")).toBeTruthy();
  });

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

  it("renders historical requests as read-only evidence", () => {
    const onResolveApproval = vi.fn();
    const approval = entry(step({
      approval: { approvalId: "approval-history", riskLevel: "high" },
      id: "approval-history",
      kind: "approval",
      status: "blocked",
      title: "Historical approval",
    }));

    render(<LiveCanvas {...canvasProps([approval], { mode: "history", onResolveApproval, selection: approval })} />);

    expect(screen.getByLabelText("Historical TinyOS request")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it("exposes the expanded route-surface mode", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    const fileEntry = entry(step({
      id: "file-expanded",
      toolCall: { argsJson: { path: "README.md" }, id: "file-expanded", name: "workspace.read_file" },
    }));
    const { rerender } = render(<LiveCanvas {...canvasProps([fileEntry], { onExpandedChange })} />);

    await user.click(screen.getByRole("button", { name: "Expand TinyOS to Chat surface" }));
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
    rerender(<LiveCanvas {...canvasProps([fileEntry], { expanded: true, onExpandedChange })} />);
    expect(screen.getByLabelText("Live Canvas").getAttribute("data-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Exit expanded TinyOS" })).toBeTruthy();
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
      provenance: { kind: "canonical", sourceItemId: "file-a", turnId: "turn-1" },
      selectedText: "const a = 1;\nexport { a };",
      startLine: 1,
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
    expect(within(terminal).getByText("1/1")).toBeTruthy();
    await user.selectOptions(within(terminal).getByLabelText("Terminal stream filter"), "stderr");
    await user.click(within(terminal).getByRole("button", { name: "Pause" }));
    expect(within(terminal).getByText("Follow paused")).toBeTruthy();
    await user.selectOptions(within(terminal).getByLabelText("Terminal stream filter"), "stdout");
    fireEvent.click(within(terminal).getByRole("button", { name: "$ npm test" }));
    fireEvent.click(within(terminal).getByRole("button", { name: "PASS tinyos" }), { shiftKey: true });
    await user.click(within(terminal).getByRole("button", { name: "Attach L1–2" }));
    expect(onAttachContext).toHaveBeenCalledWith({
      command: "npm test",
      endLine: 2,
      kind: "terminal",
      selectedText: "$ npm test\nPASS tinyos",
      sourceItemId: "shell-a",
      startLine: 1,
      turnId: "turn-1",
    });
  });

  it("switches applications with keyboard shortcuts and restores session UI state", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "shortcut-file", toolCall: { argsJson: { path: "README.md" }, id: "shortcut-file", name: "workspace.read_file" } })),
      entry(step({ id: "shortcut-shell", toolCall: { argsJson: { cmd: "npm test" }, id: "shortcut-shell", name: "shell.exec" } })),
    ];
    const props = canvasProps(entries, { sessionKey: "session-shortcuts", widthPx: 480 });
    const { unmount } = render(<LiveCanvas {...props} />);
    const canvas = screen.getByLabelText("Live Canvas");

    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Move Terminal window"), { altKey: true, key: "1" });
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    await user.click(within(canvas).getByRole("button", { name: "Minimize Files" }));
    unmount();

    render(<LiveCanvas {...props} />);
    const restored = screen.getByLabelText("Live Canvas");
    expect(restored.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(within(restored).getByRole("button", { name: "Open Files" }).getAttribute("data-minimized")).toBe("true");
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
