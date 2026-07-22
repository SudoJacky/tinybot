// @vitest-environment happy-dom

import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { BackendAgentTurnItem, ChatStep } from "../../app-core/chat/chatRunModel";
import { createTinyOsBrowserSessionSnapshot } from "../../app-core/chat/tinyOsNativeSnapshot";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import { clampTinyOsWidth, LiveCanvas, type LiveCanvasEntry } from "./LiveCanvas";

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

function canonicalItemForEntry(
  canvasEntry: LiveCanvasEntry,
  eventIndex: number,
  overrides: Partial<BackendAgentTurnItem> = {},
): BackendAgentTurnItem {
  const { step: canvasStep, turnId } = canvasEntry;
  return {
    schemaVersion: "tinybot.turn_item.v2",
    createdAt: `2026-07-14T00:00:${String(eventIndex).padStart(2, "0")}Z`,
    data: {
      args: canvasStep.toolCall?.argsJson ?? {},
      name: canvasStep.toolCall?.name ?? canvasStep.title,
      result: canvasStep.toolCall?.resultJson ?? {},
      status: canvasStep.status,
      timing: {},
      toolCallId: canvasStep.toolCall?.id ?? `call-${eventIndex}`,
      type: "tool_call",
    },
    itemId: canvasStep.id,
    kind: "tool_call",
    revision: 1,
    runId: "run-1",
    sequence: eventIndex,
    sessionId: "session-1",
    status: canvasStep.status,
    title: canvasStep.title,
    turnId,
    ...overrides,
  } as BackendAgentTurnItem;
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

function dragTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
    get types() { return [...values.keys()]; },
  } as unknown as DataTransfer;
}

function browserSessionSnapshot() {
  return createTinyOsBrowserSessionSnapshot({
    activeTabId: "tab-1",
    browserSessionId: "browser-session-1",
    contract: "browser_session_v1",
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    profileId: "profile-session-1",
    profilePersistence: "persistent",
    runId: "run-browser-1",
    runtimeKind: "windows_webview2",
    runtimeVersion: "test-webview2",
    sessionId: "session-1",
    state: "running",
    control: { controlEpoch: 0, state: "agent_active" },
    tabs: [{
      activeHistoryIndex: 1,
      captures: [
        { captureId: "capture-old", observedAt: "2026-07-14T01:00:00Z", stale: true },
        { captureId: "capture-current", observedAt: "2026-07-14T01:01:00Z", stale: false },
      ],
      currentCaptureId: "capture-current",
      history: [
        { captureId: "capture-old", title: "Old", url: "https://example.com/old" },
        { captureId: "capture-current", title: "Current", url: "https://example.com/current" },
      ],
      loading: false,
      rendererLifecycle: "running",
      tabId: "tab-1",
      title: "Current",
      url: "https://example.com/current",
    }, {
      activeHistoryIndex: 0,
      captures: [{ captureId: "capture-second", observedAt: "2026-07-14T01:02:00Z", stale: false }],
      currentCaptureId: "capture-second",
      history: [{ captureId: "capture-second", title: "Second", url: "https://example.org" }],
      loading: true,
      rendererLifecycle: "running",
      tabId: "tab-2",
      title: "Second",
      url: "https://example.org",
    }],
  }, {
    observedAt: "2026-07-14T01:02:00Z",
    revision: "browser-revision-1",
    sourceId: "browser.session",
  });
}

function browserRuntimeMock() {
  const snapshot = browserSessionSnapshot();
  const activateTab = vi.fn(async () => snapshot);
  const back = vi.fn(async () => undefined);
  const closeSession = vi.fn(async () => undefined);
  const closeTab = vi.fn(async () => snapshot);
  const createSession = vi.fn(async () => snapshot);
  const createTab = vi.fn(async () => snapshot);
  const forward = vi.fn(async () => undefined);
  const navigate = vi.fn(async () => snapshot);
  const reload = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const updateSurface = vi.fn(async (_input: Parameters<NativeBrowserRuntimeApi["updateSurface"]>[0]) => snapshot);
  const api = {
    activateTab,
    back,
    capabilities: vi.fn(),
    closeSession,
    closeTab,
    createSession,
    createTab,
    deleteProfile: vi.fn(),
    forward,
    interact: vi.fn(),
    navigate,
    observe: vi.fn(),
    reload,
    resolvePolicyRequest: vi.fn(async () => snapshot),
    restartTab: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    stop,
    updateSurface,
  } as unknown as NativeBrowserRuntimeApi;
  return { activateTab, api, back, closeSession, closeTab, createSession, createTab, forward, navigate, reload, stop, updateSurface };
}

describe("LiveCanvas TinyOS", () => {
  it("keeps run state out of the system bar while retaining commands in the palette", async () => {
    const user = userEvent.setup();
    const onCancelRun = vi.fn();
    const onPauseRun = vi.fn();
    const onResumeRun = vi.fn();
    const planEntry = entry(step({
      id: "system-bar-plan",
      kind: "plan",
      plan: { completed: 1, steps: [{ status: "completed", step: "Plan work" }], total: 1 },
      title: "Execution plan",
    }));
    render(<LiveCanvas {...canvasProps([planEntry], {
      canCancelRun: true,
      canPauseRun: true,
      canResumeRun: true,
      onCancelRun,
      onPauseRun,
      onResumeRun,
    })} />);

    const systemBar = document.querySelector<HTMLElement>(".tinyos-system-bar")!;
    expect(within(systemBar).queryByText("Live workspace")).toBeNull();
    expect(within(systemBar).queryByText("Plan updated")).toBeNull();
    expect(within(systemBar).queryByRole("button", { name: "Pause active Agent run" })).toBeNull();
    expect(within(systemBar).queryByRole("button", { name: "Resume paused Agent run" })).toBeNull();
    expect(within(systemBar).queryByRole("button", { name: "Cancel active Agent run" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    let palette = screen.getByRole("dialog", { name: "command palette" });
    await user.type(within(palette).getByRole("searchbox", { name: "Search TinyOS commands" }), "pause active");
    await user.click(within(palette).getByRole("option", { name: /Pause active Agent run/ }));
    expect(onPauseRun).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    palette = screen.getByRole("dialog", { name: "command palette" });
    await user.type(within(palette).getByRole("searchbox", { name: "Search TinyOS commands" }), "resume paused");
    await user.click(within(palette).getByRole("option", { name: /Resume paused Agent run/ }));
    expect(onResumeRun).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Open command palette" }));
    palette = screen.getByRole("dialog", { name: "command palette" });
    await user.type(within(palette).getByRole("searchbox", { name: "Search TinyOS commands" }), "cancel active");
    await user.click(within(palette).getByRole("option", { name: /Cancel active Agent run/ }));
    expect(onCancelRun).toHaveBeenCalledTimes(1);
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

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const cancel = within(screen.getByRole("dialog", { name: "command palette" })).getByRole("option", { name: /Cancel active Agent run/ });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(cancel.getAttribute("title")).toBe("The run is waiting for user input.");
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

    const canvas = screen.getByLabelText("TinyOS shared desktop");
    expect(within(canvas).getByRole("heading", { name: "TinyOS" })).toBeTruthy();
    expect(within(canvas).getAllByText("Shared desktop").length).toBeGreaterThan(0);
    const desktop = within(canvas).getByRole("region", { name: "TinyOS desktop" });
    expect(within(desktop).getByRole("navigation", { name: "TinyOS applications" })).toBeTruthy();
    expect(within(desktop).getByText("Shared workspace")).toBeTruthy();
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(within(canvas).getAllByText("src/app.ts").length).toBeGreaterThan(0);
    expect(within(canvas).getAllByText(/npm test/).length).toBeGreaterThan(0);
    expect(within(canvas).getByText(/Tests passed/)).toBeTruthy();
    const shelf = within(canvas).getByRole("navigation", { name: "TinyOS recent operations" });
    expect(within(shelf).getAllByRole("button")).toHaveLength(1);
    expect(within(shelf).getByText("shell.exec")).toBeTruthy();
  });

  it("requires terminal command review and exposes the execution boundary", async () => {
    const user = userEvent.setup();
    const onExecuteTerminal = vi.fn(async () => undefined);
    render(<LiveCanvas {...canvasProps([], {
      canExecuteTerminal: true,
      onExecuteTerminal,
      sessionKey: "websocket:chat-1",
    })} />);

    const terminal = document.querySelector<HTMLElement>("[data-app='terminal']");
    expect(terminal).toBeTruthy();
    const command = within(terminal!).getByRole("textbox", { name: "TinyOS terminal command" });
    fireEvent.change(command, { target: { value: "npm test" } });
    expect((command as HTMLInputElement).value).toBe("npm test");
    expect((within(terminal!).getByRole("button", { name: /Run command/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(terminal!).getByRole("button", { name: "Review command" }));
    expect(within(terminal!).getByRole("status").textContent).toContain("Read-only sandbox");
    expect(within(terminal!).getByRole("status").textContent).toContain("network denied");
    await user.click(within(terminal!).getByRole("button", { name: /Run command/ }));

    expect(onExecuteTerminal).toHaveBeenCalledWith({ command: "npm test", cwd: "." });
  });

  it("routes Terminal cancellation through the registered runtime command", async () => {
    const onCancelTerminal = vi.fn(async () => undefined);
    render(<LiveCanvas {...canvasProps([], {
      canCancelTerminal: true,
      onCancelTerminal,
      runningTerminalRunId: "tinyos-host-terminal-1",
      sessionKey: "websocket:chat-1",
    })} />);

    const terminal = document.querySelector<HTMLElement>("[data-app='terminal']");
    expect(terminal).toBeTruthy();
    await userEvent.click(within(terminal!).getByRole("button", { name: "Cancel process" }));

    expect(onCancelTerminal).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a historical desktop without monitoring chrome and returns to live", async () => {
    const user = userEvent.setup();
    const onReturnToLive = vi.fn();
    const onSelectEntry = vi.fn();
    const entries = [
      entry(step({ id: "file", toolCall: { argsJson: { path: "src/main.ts" }, id: "file", name: "workspace.read_file" } })),
      entry(step({ id: "memory", title: "memory.search", toolCall: { argsJson: { query: "TinyOS" }, id: "memory", name: "memory.search" } })),
    ];

    const canonicalItems = entries.map((canvasEntry, index) => canonicalItemForEntry(canvasEntry, index));
    render(<LiveCanvas {...canvasProps(entries, {
      canonicalItems,
      mode: "history",
      onReturnToLive,
      onSelectEntry,
      selection: entries[0],
      selectionEventIndex: 0,
    })} />);

    const canvas = screen.getByLabelText("TinyOS shared desktop");
    expect(canvas.getAttribute("data-mode")).toBe("history");
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='memory']")).toBeNull();
    expect(within(canvas).queryByLabelText("Time Machine")).toBeNull();
    await user.click(within(canvas).getByRole("button", { name: "Return to live desktop" }));
    expect(onReturnToLive).toHaveBeenCalledTimes(1);
  });

  it("keeps layout preferences and restores runtime capabilities on Return to Live", () => {
    const fileEntry = entry(step({
      id: "history-layout-file",
      title: "Read workspace",
      toolCall: { argsJson: { path: "README.md" }, id: "history-layout-file", name: "workspace.read_file" },
    }));
    const canonicalItems = [canonicalItemForEntry(fileEntry, 0)];
    const shared = canvasProps([fileEntry], {
      canExecuteTerminal: true,
      canonicalItems,
      selection: fileEntry,
      selectionEventIndex: 0,
      sessionKey: "history-layout-session",
      widthPx: 680,
    });
    const { rerender } = render(<LiveCanvas {...shared} mode="history" />);

    const historicalTerminal = screen.getByLabelText("Terminal window");
    const historicalLayout = historicalTerminal.getAttribute("style");
    expect((within(historicalTerminal).getByLabelText("TinyOS terminal command") as HTMLInputElement).disabled).toBe(true);
    expect(within(historicalTerminal).getByRole("button", { name: "Review command" }).getAttribute("title")).toBe("History snapshots are read-only.");

    rerender(<LiveCanvas {...shared} mode="live_follow" />);
    const liveTerminal = screen.getByLabelText("Terminal window");
    expect(liveTerminal.getAttribute("style")).toBe(historicalLayout);
    expect((within(liveTerminal).getByLabelText("TinyOS terminal command") as HTMLInputElement).disabled).toBe(false);
    expect(within(liveTerminal).getByRole("button", { name: "Review command" }).getAttribute("title")).toBe("Review the exact command and execution boundary");
  });

  it("compares the same resource at two exact canonical boundaries without merging revisions", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({
      id: "versioned-file",
      title: "Read versioned file",
      toolCall: { argsJson: { path: "src/versioned.ts" }, id: "versioned-file", name: "workspace.read_file" },
    }));
    const first = canonicalItemForEntry(fileEntry, 0, {
      data: { id: "versioned-file", path: "src/versioned.ts", referenceKind: "file", revision: "rev-1", type: "file_reference" },
      kind: "file_reference",
      revision: 1,
    });
    const second = canonicalItemForEntry(fileEntry, 1, {
      data: { id: "versioned-file", path: "src/versioned.ts", referenceKind: "file", revision: "rev-2", type: "file_reference" },
      kind: "file_reference",
      revision: 2,
    });
    const canonicalItems = [first, second];
    const shared = canvasProps([fileEntry], {
      canonicalItems,
      mode: "history",
      selection: fileEntry,
      sessionKey: "history-inspector-session",
      widthPx: 680,
    });
    const { rerender } = render(<LiveCanvas {...shared} selectionEventIndex={0} />);

    await user.click(screen.getByRole("button", { name: "Inspect Files" }));
    rerender(<LiveCanvas {...shared} selectionEventIndex={1} />);
    await user.click(screen.getByRole("button", { name: "Inspect Files" }));

    const inspector = screen.getByLabelText("TinyOS Inspector");
    expect(inspector.dataset.split).toBe("true");
    expect(within(inspector).getByText("Canonical evidence · Event 1")).toBeTruthy();
    expect(within(inspector).getByText("Canonical evidence · Event 2")).toBeTruthy();
    expect(within(inspector).getByText("rev-1")).toBeTruthy();
    expect(within(inspector).getByText("rev-2")).toBeTruthy();
    expect(within(inspector).getAllByText(/canonical_event · versioned-file/)).toHaveLength(2);
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
    expect(screen.getByLabelText("TinyOS shared desktop").getAttribute("data-expanded")).toBe("true");
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

  it("allows continuous desktop widths beyond the former two presets", () => {
    expect(clampTinyOsWidth(900, 1_600)).toBe(900);
    expect(clampTinyOsWidth(1_400, 1_600)).toBe(1_080);
  });

  it("shows one focused application in compact mode and restores another from the launcher", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "file", toolCall: { argsJson: { path: "src/main.ts" }, id: "file", name: "workspace.read_file" } })),
      entry(step({ id: "shell", toolCall: { argsJson: { cmd: "npm test" }, id: "shell", name: "shell.exec" } })),
    ];

    render(<LiveCanvas {...canvasProps(entries, { widthPx: 480 })} />);

    const canvas = screen.getByLabelText("TinyOS shared desktop");
    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='files']")).toBeNull();
    const filesLauncher = within(canvas).getByRole("button", { name: "Open Files" });
    expect(filesLauncher.getAttribute("aria-pressed")).toBe("false");
    await user.click(filesLauncher);
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    expect(canvas.querySelector("[data-app='terminal']")).toBeNull();
    expect(within(canvas).getByRole("button", { name: "Open Files" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps kernel process telemetry out of the default shared desktop", () => {
    render(<LiveCanvas {...canvasProps([], { widthPx: 480 })} />);

    expect(screen.queryByRole("button", { name: "Open System Monitor" })).toBeNull();
    expect(screen.queryByRole("region", { name: "TinyOS processes" })).toBeNull();
  });

  it("uses one Agent filter for windows, notifications, operations, resources, and processes", async () => {
    const user = userEvent.setup();
    const mainEntry = entry(step({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "main-file",
      toolCall: { argsJson: { path: "src/main.ts" }, id: "main-file", name: "workspace.read_file" },
    }));
    const childEntry = entry(step({
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "child-shell",
      status: "failed",
      title: "Child tests",
      toolCall: { argsJson: { cmd: "npm test" }, id: "child-shell", name: "shell.exec" },
    }));
    const mainCanonical = canonicalItemForEntry(mainEntry, 1, {
      data: {
        ...canonicalItemForEntry(mainEntry, 1).data,
        agentId: "agent-main",
      },
    });
    const childCanonical = canonicalItemForEntry(childEntry, 3, {
      data: {
        ...canonicalItemForEntry(childEntry, 3).data,
        agentId: "agent-child",
      },
    });
    const lifecycle: BackendAgentTurnItem = {
      schemaVersion: "tinybot.turn_item.v2",
      createdAt: "2026-07-14T00:00:02Z",
      data: {
        action: "started",
        agentId: "agent-child",
        childRunId: "run-child",
        message: "Child started",
        name: "Reviewer",
        parentAgentId: "agent-main",
        parentRunId: "run-1",
        status: "running",
        task: "Run tests",
        traceRef: "trace-child",
        type: "subagent_lifecycle",
      },
      itemId: "child-lifecycle",
      kind: "subagent_lifecycle",
      revision: 1,
      runId: "run-child",
      sequence: 2,
      sessionId: "session-1",
      status: "running",
      turnId: "turn-1",
    };

    render(<LiveCanvas {...canvasProps([mainEntry, childEntry], {
      canonicalItems: [mainCanonical, lifecycle, childCanonical],
      widthPx: 680,
    })} />);

    const filter = screen.getByRole("combobox", { name: "Filter TinyOS by Agent" });
    await user.selectOptions(filter, "agent-child");
    expect(screen.getByRole("button", { name: "Open Terminal" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Open Files" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Open notification center" }).hasAttribute("disabled")).toBe(false);
    expect(within(screen.getByRole("navigation", { name: "TinyOS recent operations" })).getByText("shell.exec")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open window Overview" }));
    const missionControl = screen.getByRole("dialog", { name: "window Overview" });
    const missionGroups = within(missionControl).getByRole("region", { name: "Agent mission groups" });
    expect(within(missionGroups).getByText("Reviewer")).toBeTruthy();
    expect(within(missionGroups).getByText("Run tests")).toBeTruthy();
    expect(within(missionGroups).getByText("Terminal")).toBeTruthy();
    await user.click(within(missionControl).getByRole("button", { name: "Close window Overview" }));

    await user.selectOptions(filter, "agent-main");
    expect(screen.getByRole("button", { name: "Open Files" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Open Terminal" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Open notification center" }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("navigation", { name: "TinyOS recent operations" })).getByText("workspace.read_file")).toBeTruthy();
  });

  it("supports keyboard window movement, snapping, maximize, and minimize", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({ id: "file", toolCall: { id: "file", name: "workspace.read_file" } }));
    render(<LiveCanvas {...canvasProps([fileEntry], { widthPx: 680 })} />);

    const canvas = screen.getByLabelText("TinyOS shared desktop");
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
      executionId: "shell-a",
      kind: "terminal",
      provenance: { kind: "canonical", sourceItemId: "shell-a", turnId: "turn-1" },
      selectedText: "$ npm test\nPASS tinyos",
      sourceItemId: "shell-a",
      startLine: 1,
      turnId: "turn-1",
    });
  });

  it("labels retained terminal executions with real boundary, identity, byte, and lifecycle state", async () => {
    const user = userEvent.setup();
    const terminalEntry = entry(step({
      id: "retained-terminal",
      status: "completed",
      title: "Run checks",
      toolCall: {
        argsJson: { command: "npm test", cwd: "src", networkMode: "denied", sandboxMode: "read_only" },
        durationMs: 87,
        id: "retained-terminal-call",
        name: "shell.execute",
        resultJson: { droppedBytes: 32, exitCode: 0, processId: "native-process-7", stderr: "warn", stdout: "PASS", truncated: true },
      },
    }));
    const command = {
      schemaVersion: "tinybot.command.v1" as const,
      commandId: "terminal-command-1",
      issuedAt: "2026-07-14T00:00:00Z",
      kind: "terminal.execute" as const,
      source: { control: "terminal-execute", surface: "tinyos" as const },
      target: { runId: "tinyos-host-terminal-1", sessionId: "session-1" },
      terminal: { command: "npm test", confirmed: true as const, cwd: "src" },
    };
    render(<LiveCanvas {...canvasProps([terminalEntry], {
      commandLifecycle: { command, dispatchedAtMs: 1, transportAcceptedAtMs: 2, stage: "waiting_for_canonical" },
      sessionKey: "session-1",
      widthPx: 480,
    })} />);
    await user.click(screen.getByRole("button", { name: "Open Terminal" }));

    const identity = screen.getByRole("group", { name: "Terminal execution identity" });
    expect(within(identity).getByText("retained execution v1")).toBeTruthy();
    expect(within(identity).getByText("native-process-7")).toBeTruthy();
    expect(within(identity).getByText("read_only · network denied · non-TTY")).toBeTruthy();
    expect(within(identity).getByText(/4 B stdout · 4 B stderr · 32 B dropped/)).toBeTruthy();
    expect(within(identity).getByText("canonical_event · retained-terminal")).toBeTruthy();
    expect(screen.getByText("Execution awaiting runtime")).toBeTruthy();
    expect(screen.getByText(/Retained boundary · last 499 lines · 32 B dropped/)).toBeTruthy();
  });

  it("shows an explicit unavailable state instead of browser evidence fallbacks", () => {
    const browserEntry = entry(step({
      artifacts: [{ id: "preview-1", kind: "browser_snapshot", preview: "data:image/png;base64,AAAA", title: "Preview" }],
      id: "browser-unavailable",
      kind: "browser",
      summary: "Structured browser metadata",
    }));
    render(<LiveCanvas {...canvasProps([browserEntry])} />);

    const browser = screen.getByLabelText("Browser window");
    expect(within(browser).getByRole("alert").textContent).toContain("Live browser unavailable");
    expect(within(browser).queryByRole("img")).toBeNull();
    expect(within(browser).queryByText("Structured projection")).toBeNull();
    expect(within(browser).queryByText("Local preview")).toBeNull();
  });

  it("focuses Browser when its native session first becomes available", async () => {
    const props = canvasProps([], { sessionKey: "session-1" });
    const { rerender } = render(<LiveCanvas {...props} />);

    expect(screen.getByLabelText("Terminal window").getAttribute("data-active")).toBe("true");

    rerender(<LiveCanvas {...props} nativeSnapshots={[browserSessionSnapshot()]} />);

    await waitFor(() => expect(screen.getByLabelText("Browser window").getAttribute("data-active")).toBe("true"));
  });

  it("shows the native startup cause and retries the failed shared session", async () => {
    const runtime = browserRuntimeMock();
    const failed = browserSessionSnapshot();
    failed.data.lifecycle = "failed";
    failed.data.control = {
      controlEpoch: 0,
      reason: "Native browser navigation completion timed out",
      state: "failed",
    };
    failed.data.tabs[0]!.rendererLifecycle = "failed";
    render(<LiveCanvas {...canvasProps([], {
      browserRuntime: runtime.api,
      nativeSnapshots: [failed],
    })} />);

    const browser = screen.getByLabelText("Browser window");
    expect(within(browser).getByText("Browser failed to start")).toBeTruthy();
    expect(within(browser).getByText("Native browser navigation completion timed out")).toBeTruthy();
    await userEvent.click(within(browser).getByRole("button", { name: "Retry browser" }));
    expect(runtime.closeSession).toHaveBeenCalledWith("browser-session-1");
    expect(runtime.createSession).toHaveBeenCalledWith({
      ownerSessionId: "session-1",
      persistence: "persistent",
      profileId: "profile-session-1",
    });
  });

  it("shares a live browser surface across normal navigation and multiple tabs", async () => {
    const user = userEvent.setup();
    const runtime = browserRuntimeMock();
    const browserEntry = entry(step({ id: "browser-native", kind: "browser" }));
    render(<LiveCanvas {...canvasProps([browserEntry], {
      browserRuntime: runtime.api,
      nativeSnapshots: [browserSessionSnapshot()],
    })} />);

    const browser = screen.getByLabelText("Browser window");
    const tabs = within(browser).getAllByRole("tab");
    expect(within(browser).getByRole("tablist", { name: "Browser tabs" })).toBeTruthy();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(within(browser).getByRole("tabpanel", { name: "Current" })).toBeTruthy();
    expect(within(browser).getByText("Agent is using this tab")).toBeTruthy();
    expect(within(browser).queryByRole("img")).toBeNull();
    expect(within(browser).queryByText("Browser capture history")).toBeNull();

    await user.click(within(browser).getByRole("button", { name: "Browser back" }));
    expect(runtime.back).toHaveBeenCalledWith("browser-session-1", "tab-1");

    const address = within(browser).getByRole("textbox", { name: "Browser address" });
    fireEvent.change(address, { target: { value: "example.net/path" } });
    expect((address as HTMLInputElement).value).toBe("example.net/path");
    await user.click(within(browser).getByRole("button", { name: "Go" }));
    expect(runtime.navigate).toHaveBeenCalledWith("browser-session-1", "tab-1", "https://example.net/path");

    await user.click(within(browser).getByRole("button", { name: "New browser tab" }));
    expect(runtime.createTab).toHaveBeenCalledWith("browser-session-1");

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(runtime.activateTab).toHaveBeenCalledWith("browser-session-1", "tab-2");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect((within(browser).getByRole("textbox", { name: "Browser address" }) as HTMLInputElement).value).toBe("https://example.org");
    await user.click(within(browser).getByRole("button", { name: "Stop loading" }));
    expect(runtime.stop).toHaveBeenCalledWith("browser-session-1", "tab-2");
    await user.click(within(browser).getByRole("button", { name: "Close Second tab" }));
    expect(runtime.closeTab).toHaveBeenCalledWith("browser-session-1", "tab-2");
  });

  it("continues native browser surface revisions after the host remounts", async () => {
    const runtime = browserRuntimeMock();
    const snapshot = browserSessionSnapshot();
    snapshot.data.surface = {
      layoutRevision: 41,
      lifecycle: "visible",
      rect: { deviceScale: 1, height: 600, width: 800, x: 0, y: 0 },
      surfaceId: "tinyos-browser-surface-browser-session-1",
      tabId: "tab-1",
    };
    const browserEntry = entry(step({ id: "browser-native-remount", kind: "browser" }));
    render(<LiveCanvas {...canvasProps([browserEntry], {
      browserRuntime: runtime.api,
      nativeSnapshots: [snapshot],
    })} />);

    await waitFor(() => expect(runtime.updateSurface).toHaveBeenCalled());
    expect(runtime.updateSurface.mock.calls[0]?.[0]).toMatchObject({
      browserSessionId: "browser-session-1",
      layoutRevision: 42,
      tabId: "tab-1",
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
    const canvas = screen.getByLabelText("TinyOS shared desktop");

    expect(canvas.querySelector("[data-app='terminal']")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Move Terminal window"), { altKey: true, key: "1" });
    expect(canvas.querySelector("[data-app='files']")).toBeTruthy();
    await user.click(within(canvas).getByRole("button", { name: "Minimize Files" }));
    unmount();

    render(<LiveCanvas {...props} />);
    const restored = screen.getByLabelText("TinyOS shared desktop");
    expect(restored.querySelector("[data-app='terminal']")).toBeTruthy();
    expect(within(restored).getByRole("button", { name: "Open Files" }).getAttribute("data-minimized")).toBe("true");
  });

  it("switches available applications with an accessible Alt+Tab overlay", () => {
    const entries = [
      entry(step({ id: "switch-file", toolCall: { argsJson: { path: "README.md" }, id: "switch-file", name: "workspace.read_file" } })),
      entry(step({ id: "switch-shell", toolCall: { argsJson: { cmd: "npm test" }, id: "switch-shell", name: "shell.exec" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { widthPx: 480 })} />);

    const activeTitlebar = screen.getByLabelText("Move Terminal window");
    fireEvent.keyDown(activeTitlebar, { altKey: true, key: "Tab" });

    const switcher = screen.getByRole("dialog", { name: "application switcher" });
    expect(within(switcher).getByRole("listbox", { name: "Available TinyOS applications" })).toBeTruthy();
    expect(within(switcher).getAllByRole("option").length).toBeGreaterThan(1);
    fireEvent.keyUp(switcher, { key: "Alt" });
    expect(screen.queryByRole("dialog", { name: "application switcher" })).toBeNull();
  });

  it("restores minimized windows from Overview and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "overview-file", toolCall: { argsJson: { path: "README.md" }, id: "overview-file", name: "workspace.read_file" } })),
      entry(step({ id: "overview-shell", toolCall: { argsJson: { cmd: "npm test" }, id: "overview-shell", name: "shell.exec" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { widthPx: 680 })} />);

    await user.click(screen.getByRole("button", { name: "Minimize Files" }));
    const overviewTrigger = screen.getByRole("button", { name: "Open window Overview" });
    overviewTrigger.focus();
    await user.click(overviewTrigger);
    const overview = screen.getByRole("dialog", { name: "window Overview" });
    const filesPreview = within(overview).getByRole("button", { name: /Files.*Minimized/ });
    await user.click(filesPreview);

    expect(screen.queryByRole("dialog", { name: "window Overview" })).toBeNull();
    expect(screen.getByLabelText("Files window")).toBeTruthy();

    await user.click(overviewTrigger);
    await user.click(within(screen.getByRole("dialog", { name: "window Overview" })).getByRole("button", { name: "Close window Overview" }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(overviewTrigger);
  });

  it("traps keyboard focus inside compact shell overlays and closes with Escape", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({ id: "compact-overlay-file", toolCall: { argsJson: { path: "README.md" }, id: "compact-overlay-file", name: "workspace.read_file" } }));
    render(<LiveCanvas {...canvasProps([fileEntry], { widthPx: 480 })} />);

    await user.click(screen.getByRole("button", { name: "Open window Overview" }));
    const overview = screen.getByRole("dialog", { name: "window Overview" });
    const close = within(overview).getByRole("button", { name: "Close window Overview" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(overview.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "window Overview" })).toBeNull();
  });

  it("searches registered application and unavailable runtime commands from Ctrl+K", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({ id: "palette-file", toolCall: { argsJson: { path: "src/app.ts" }, id: "palette-file", name: "workspace.read_file" } }));
    render(<LiveCanvas {...canvasProps([fileEntry], { pauseUnavailableReason: "The backend did not advertise pause.", widthPx: 680 })} />);

    fireEvent.keyDown(screen.getByLabelText("Move Files window"), { ctrlKey: true, key: "k" });
    const palette = screen.getByRole("dialog", { name: "command palette" });
    const search = within(palette).getByRole("searchbox", { name: "Search TinyOS commands" });
    await user.type(search, "open files");
    expect(within(palette).getByRole("option", { name: /Open Files/ })).toBeTruthy();

    await user.clear(search);
    await user.type(search, "pause active");
    const pause = within(palette).getByRole("option", { name: /Pause active Agent run/ });
    expect((pause as HTMLButtonElement).disabled).toBe(true);
    expect(pause.getAttribute("title")).toBe("The backend did not advertise pause.");
  });

  it("runs Dock and window context-menu actions through registered commands", async () => {
    const user = userEvent.setup();
    const fileEntry = entry(step({ id: "menu-file", toolCall: { argsJson: { path: "README.md" }, id: "menu-file", name: "workspace.read_file" } }));
    render(<LiveCanvas {...canvasProps([fileEntry], { widthPx: 680 })} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Files" }), { clientX: 120, clientY: 180 });
    const menu = screen.getByRole("menu", { name: "Files menu" });
    await user.click(within(menu).getByRole("menuitem", { name: /Minimize Files/ }));

    expect(screen.queryByLabelText("Files window")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Files" }).getAttribute("data-minimized")).toBe("true");
  });

  it("keeps derived notification history and local read state in the notification center", async () => {
    const user = userEvent.setup();
    const failed = entry(step({ id: "notification-failed", kind: "error", status: "failed", summary: "Build exited with code 1", title: "Build failed" }));
    render(<LiveCanvas {...canvasProps([failed], { widthPx: 680 })} />);

    await user.click(screen.getByRole("button", { name: "Open notification center" }));
    const center = screen.getByRole("dialog", { name: "notification center" });
    expect(within(center).getByText("Build failed")).toBeTruthy();
    await user.click(within(center).getByRole("button", { name: "Mark read" }));
    expect(within(center).getByRole("button", { name: "Read" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Build failed").length).toBeGreaterThan(1);
  });

  it("pins dragged canonical evidence into Inspector", async () => {
    const user = userEvent.setup();
    const entries = [
      entry(step({ id: "drag-file", title: "Read config", toolCall: { id: "drag-file", name: "workspace.read_file" } })),
      entry(step({ id: "drag-shell", title: "Run tests", toolCall: { id: "drag-shell", name: "shell.exec" } })),
    ];
    render(<LiveCanvas {...canvasProps(entries, { widthPx: 680 })} />);
    await user.click(screen.getByRole("button", { name: "Inspect Files" }));
    const inspector = screen.getByLabelText("TinyOS Inspector");
    const latestOperation = within(screen.getByRole("navigation", { name: "TinyOS recent operations" })).getByRole("button", { name: /Latest canonical operation/ });
    const dataTransfer = dragTransfer();

    fireEvent.dragStart(latestOperation, { dataTransfer });
    fireEvent.dragOver(inspector, { dataTransfer });
    fireEvent.drop(inspector, { dataTransfer });

    expect(within(inspector).getByText("Read config")).toBeTruthy();
    expect(within(inspector).getByText("Run tests")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("pinned in Inspector");
  });

  it("visibly rejects a file-context drop on Inspector without attaching it", async () => {
    const user = userEvent.setup();
    const onAttachContext = vi.fn();
    const fileEntry = entry(step({
      id: "drop-file",
      title: "Read source",
      toolCall: { argsJson: { path: "src/app.ts" }, id: "drop-file", name: "workspace.read_file", resultPreview: "const ready = true;" },
    }));
    render(<LiveCanvas {...canvasProps([fileEntry], { onAttachContext, widthPx: 680 })} />);
    await user.click(screen.getByRole("button", { name: "Inspect Files" }));
    await user.click(within(screen.getByLabelText("Files window")).getByRole("button", { name: "const ready = true;" }));
    const source = within(screen.getByLabelText("Files window")).getByRole("button", { name: /Attach src\/app\.ts/ });
    const inspector = screen.getByLabelText("TinyOS Inspector");
    const dataTransfer = dragTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(inspector, { dataTransfer });
    fireEvent.drop(inspector, { dataTransfer });

    expect(screen.getByRole("alert").textContent).toBe("Inspector accepts canonical evidence, not context references.");
    expect(onAttachContext).not.toHaveBeenCalled();
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
