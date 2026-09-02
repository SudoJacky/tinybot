import { readFileSync } from "node:fs";
import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { useState } from "react";
import { ChatPage, type ChatPageProps } from "../ChatPage";
import type { ChatStore, SessionStore, SessionSummary, WorkspaceRegistryEntry, WorkspaceRegistryStore } from "../../services";
import type { DesktopTurnSubmitCommand } from "../../../app-core/chat/desktopCommand";
import type { ReactChatMessage } from "../messageActions";
import { createNativeBrowserSessionSnapshot } from "../../../app-core/native/nativeBrowserSnapshot";
import type { NativeBrowserRuntimeApi } from "../../../app-core/native/desktopNativeBrowser";
import type { NativeTerminalRuntimeApi } from "../../../app-core/native/desktopNativeTerminal";
import type { ThreadEffectiveCapabilities } from "../../../app-core/chat/threadCapabilities";
import { timelineFromReactMessages } from "./timelineFixtures";

export function ChatPageUnderTest(props: ChatPageProps) {
  const [workspaceRegistryStore] = useState(() => (
    testWorkspaceRegistryStores.get(props.sessionStore) ?? createTestWorkspaceRegistryStore()
  ));
  return (
    <ChatPage
      {...props}
      workspaceRegistryStore={props.workspaceRegistryStore ?? workspaceRegistryStore}
    />
  );
}

const testWorkspaceRegistryStores = new WeakMap<SessionStore, WorkspaceRegistryStore>();

function createTestWorkspaceRegistryStore(sessions: SessionSummary[] = []): WorkspaceRegistryStore {
  const registered = new Map<string, WorkspaceRegistryEntry>();
  for (const session of sessions) {
    if (!session.workingDirectory || session.pluginMigration) continue;
    const path = portableTestWorkspacePath(session.workingDirectory);
    const key = testWorkspaceKey(path);
    if (!registered.has(key)) {
      registered.set(key, testWorkspaceEntry(path, session.updatedAtMs));
    }
  }
  return {
    async list() {
      return [...registered.values()];
    },
    async register(value) {
      const path = portableTestWorkspacePath(value);
      const workspace = registered.get(testWorkspaceKey(path)) ?? testWorkspaceEntry(path, Date.now());
      registered.set(testWorkspaceKey(path), workspace);
      return workspace;
    },
    async rename(path, name) {
      const current = registered.get(testWorkspaceKey(path)) ?? testWorkspaceEntry(path, Date.now());
      const renamed = { ...current, name, updatedAtMs: Date.now() };
      registered.set(testWorkspaceKey(path), renamed);
      return renamed;
    },
    async forget(path) {
      registered.delete(testWorkspaceKey(path));
    },
  };
}

function portableTestWorkspacePath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

function testWorkspaceKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function testWorkspaceEntry(path: string, updatedAtMs: number): WorkspaceRegistryEntry {
  return {
    addedAtMs: updatedAtMs,
    exists: true,
    name: path.split(/[\\/]+/).filter(Boolean).slice(-1)[0] ?? path,
    path,
    updatedAtMs,
  };
}

const nativeFilePickerMockState = vi.hoisted(() => ({
  pickDesktopChatFiles: vi.fn(),
}));

const nativeWorkspacePickerMockState = vi.hoisted(() => ({
  pickDesktopWorkspaceDirectory: vi.fn(),
}));

export const nativeFilePickerMocks = {
  pickDesktopChatFiles: nativeFilePickerMockState.pickDesktopChatFiles,
};

export const nativeWorkspacePickerMocks = {
  pickDesktopWorkspaceDirectory: nativeWorkspacePickerMockState.pickDesktopWorkspaceDirectory,
};

vi.mock("../../../app-core/native/desktopNativeFilePicker", () => ({
  pickDesktopChatFiles: nativeFilePickerMockState.pickDesktopChatFiles,
}));

vi.mock("../../../app-core/native/desktopNativeWorkspacePicker", () => ({
  pickDesktopWorkspaceDirectory: nativeWorkspacePickerMockState.pickDesktopWorkspaceDirectory,
}));

vi.mock("../../sidecar/SidecarTerminal", () => ({
  SidecarTerminal: ({ tab }: { tab: { title: string } }) => <div>{tab.title} terminal surface</div>,
}));

afterEach(() => {
  cleanup();
  nativeFilePickerMocks.pickDesktopChatFiles.mockReset();
  nativeWorkspacePickerMocks.pickDesktopWorkspaceDirectory.mockReset();
  window.localStorage.clear();
  document.head.querySelectorAll("[data-test-style='workbench']").forEach((element) => element.remove());
  vi.useRealTimers();
});

export function mountWorkbenchCss(): void {
  const style = document.createElement("style");
  style.dataset.testStyle = "workbench";
  style.textContent = readWorkbenchCss();
  document.head.append(style);
}

export function readWorkbenchCss(): string {
  return [
    "src/react-workbench/styles/workbench.css",
    "src/react-workbench/chat/ChatPage.css",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
}


export function effectiveCapabilities(threadId: string, cancelAvailable = true): ThreadEffectiveCapabilities {
  const unavailable = { available: false, reasonCode: "runtime_unsupported", reason: "Not supported." };
  const available = { available: true };
  return {
    schemaVersion: "tinybot.effective_capabilities.v2",
    threadId,
    capabilities: {
      agent: { cancel: cancelAvailable ? available : unavailable, retry: unavailable },
    },
  };
}

export function createStores(options: {
  browserRuntime?: NativeBrowserRuntimeApi;
  sessions?: SessionSummary[];
  terminalRuntime?: NativeTerminalRuntimeApi;
} = {}): { chatStore: ChatStore; sessionStore: SessionStore } {
  const sessions = options.sessions ?? [
    {
      id: "s1",
      chatId: "chat-1",
      title: "Planning notes",
      updatedAtMs: Date.UTC(2026, 6, 4, 11, 56, 0),
      status: "idle" as const,
    },
  ];
  const messages: ReactChatMessage[] = [
    {
      id: "u1",
      role: "user",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 57, 0),
      text: "Can you help?",
      status: "complete",
    },
    {
      id: "a1",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 58, 0),
      text: "Yes.",
      status: "complete",
    },
    {
      id: "a2",
      role: "assistant",
      createdAtMs: Date.UTC(2026, 6, 4, 11, 59, 0),
      text: "I ran a tool.",
      status: "complete",
      toolCalls: [{ id: "tool-1", name: "shell", status: "complete", summary: "Done" }],
    },
  ];
  const stores = {
    sessionStore: {
      list: vi.fn(async () => sessions),
      create: vi.fn(async () => ({
        id: "s2",
        chatId: "chat-2",
        title: "New session",
        updatedAtMs: Date.UTC(2026, 6, 4, 12, 0, 0),
      })),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    },
    chatStore: {
      browserRuntime: options.browserRuntime,
      terminalRuntime: options.terminalRuntime,
      load: vi.fn(async (sessionId) => timelineFromReactMessages(sessionId, messages)),
      loadEffectiveCapabilities: vi.fn(async (sessionId) => effectiveCapabilities(sessionId)),
      dispatch: vi.fn(async () => undefined),
      listAgentUiForms: vi.fn(async () => []),
      branchFromMessage: vi.fn(async () => sessions[0]),
      copyMarkdown: vi.fn(async () => "# Planning notes"),
      subscribe: vi.fn(() => () => undefined),
    },
  };
  testWorkspaceRegistryStores.set(stores.sessionStore, createTestWorkspaceRegistryStore(sessions));
  return stores;
}

export function sidecarBrowserSnapshot(
  activeTabId = "native-tab-1",
  includeSecondTab = false,
  revision = 1,
  lifecycle: "creating" | "ready" = "ready",
) {
  return createNativeBrowserSessionSnapshot({
    activeTabId,
    browserSessionId: "browser-session-1",
    contract: "browser_session_v1",
    control: { controlEpoch: 0, state: "idle" },
    interaction: { click: true, navigate: true, type: true },
    kind: "browser_session",
    lifecycle,
    operationId: "operation-1",
    profilePersistence: "persistent",
    runtimeKind: "windows_webview2",
    runtimeVersion: "test",
    sessionId: "s1",
    state: "running",
    surface: { layoutRevision: 0, lifecycle: "hidden" },
    tabs: [
      {
        activeHistoryIndex: 0,
        captures: [],
        history: [{ title: "Example", url: "https://example.com" }],
        loading: lifecycle === "creating",
        rendererLifecycle: lifecycle === "creating" ? "starting" : "running",
        tabId: "native-tab-1",
        title: "Example",
        url: "https://example.com",
      },
      ...(includeSecondTab ? [{
        activeHistoryIndex: 0,
        captures: [],
        history: [{ title: "Second", url: "https://second.example.com" }],
        loading: false,
        rendererLifecycle: "running" as const,
        tabId: "native-tab-2",
        title: "Second",
        url: "https://second.example.com",
      }] : []),
    ],
  }, {
    observedAt: "2026-08-18T08:00:00Z",
    revision,
    sourceId: "native-browser:browser-session-1",
  });
}

export function sidecarBrowserRuntime(snapshot = sidecarBrowserSnapshot()) {
  return {
    activateTab: vi.fn(async () => snapshot),
    back: vi.fn(async () => undefined),
    capabilities: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => snapshot),
    createSession: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => snapshot),
    deleteProfile: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    interact: vi.fn(async () => undefined),
    navigate: vi.fn(async () => snapshot),
    observe: vi.fn(),
    reload: vi.fn(async () => undefined),
    resolvePolicyRequest: vi.fn(async () => snapshot),
    restartTab: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    stop: vi.fn(async () => undefined),
    updateSurface: vi.fn(async () => snapshot),
  } as unknown as NativeBrowserRuntimeApi;
}

export function turnSubmitCommands(chatStore: ChatStore): DesktopTurnSubmitCommand[] {
  return vi.mocked(chatStore.dispatch).mock.calls
    .map(([command]) => command)
    .filter((command): command is DesktopTurnSubmitCommand => command.kind === "turn.submit");
}

export function expectTurnSubmit(chatStore: ChatStore, sessionId: string, input: unknown): void {
  expect(turnSubmitCommands(chatStore)).toContainEqual(expect.objectContaining({
    input,
    kind: "turn.submit",
    target: { sessionId },
  }));
}

export async function mockLatestTurnStatus(
  chatStore: ChatStore,
  status: "pending" | "running" | "awaiting_user" | "completed" | "failed" | "interrupted",
): Promise<void> {
  const timeline = await chatStore.load("s1");
  timeline.turns[timeline.turns.length - 1].status = status;
  vi.mocked(chatStore.load).mockReset();
  vi.mocked(chatStore.load).mockResolvedValue(timeline);
}

export function mockTurnSubmit(
  chatStore: ChatStore,
  implementation: (command: DesktopTurnSubmitCommand) => void | Promise<void>,
): void {
  const fallback = chatStore.dispatch;
  chatStore.dispatch = vi.fn(async (command) => {
    if (command.kind === "turn.submit") {
      await implementation(command);
      return;
    }
    await fallback(command);
  });
}


export function failedPlanTimeline(sessionId = "s1") {
  const timeline = timelineFromReactMessages(sessionId, [{
    id: "u-failed-plan",
    role: "user" as const,
    createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
    text: "Inspect the project and report findings",
    status: "complete" as const,
  }]);
  const turn = timeline.turns[0];
  turn.status = "failed";
  turn.steps = [
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "tool-failed-plan",
      kind: "tool_call",
      sequence: 1,
      status: "failed",
      title: "workspace.read_file",
      toolCall: { id: "call-failed-plan", name: "workspace.read_file", resultPreview: "Stopped" },
    },
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "plan-failed",
      kind: "plan",
      plan: {
        completed: 1,
        steps: [
          { step: "Inspect inputs", status: "completed" },
          { step: "Read project files", status: "failed" },
          { step: "Report findings", status: "cancelled" },
        ],
        total: 3,
      },
      sequence: 2,
      status: "failed",
      title: "Plan 1/3",
    },
    {
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      error: { code: "max_iterations", message: "Rust agent runtime reached max iterations before final response." },
      id: "error-failed-plan",
      kind: "error",
      sequence: 3,
      status: "failed",
      summary: "Rust agent runtime reached max iterations before final response.",
      title: "Error",
    },
  ];
  return timeline;
}
