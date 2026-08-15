// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProjectGroupStore, SessionSummary } from "../services";
import {
  ChatSessionWorkspace,
  type ChatSessionWorkspaceActions,
} from "./ChatSessionWorkspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatSessionWorkspace", () => {
  test("owns sidebar selection and search lifecycle behind one actions interface", async () => {
    const actions = createActions();
    const session = planningSession();
    renderWorkspace({ actions, sessions: [session] });

    fireEvent.click(screen.getByRole("button", { name: "Planning notes" }));
    expect(actions.onSelectSession).toHaveBeenCalledWith(session);

    fireEvent.click(screen.getByRole("button", { name: /search chats/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Planning notes")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /new chat/i }));
    await waitFor(() => expect(actions.onCreateSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("surfaces and diagnoses project-group loading failures", async () => {
    const loadError = new Error("Project catalog unavailable");
    const projectGroupStore: ProjectGroupStore = {
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => { throw loadError; }),
      save: vi.fn(async (input) => ({
        name: input.name,
        projectGroupId: input.projectGroupId ?? "project-1",
        workspaceIds: input.workspaceIds,
      })),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderWorkspace({ projectGroupStore });

    expect((await screen.findByRole("alert")).textContent).toContain("Project catalog unavailable");
    expect(consoleError).toHaveBeenCalledWith(
      "[session-workspaces] project-groups.load.failed",
      { error: "Project catalog unavailable" },
    );
  });
});

function renderWorkspace({
  actions = createActions(),
  projectGroupStore,
  sessions = [planningSession()],
}: {
  actions?: ChatSessionWorkspaceActions;
  projectGroupStore?: ProjectGroupStore;
  sessions?: SessionSummary[];
} = {}) {
  return render(
    <ChatSessionWorkspace
      actions={actions}
      activeSessionId="session-1"
      collapsed={false}
      confirmingDeleteSessionId=""
      createPending={false}
      dissolvingSessionIds={new Set()}
      error=""
      now={() => Date.UTC(2026, 7, 15)}
      projectGroupStore={projectGroupStore}
      sessions={sessions}
    >
      <main>Conversation surface</main>
    </ChatSessionWorkspace>,
  );
}

function createActions(): ChatSessionWorkspaceActions {
  return {
    onCancelDeleteConfirmation: vi.fn(),
    onCollapsedChange: vi.fn(),
    onCreateSession: vi.fn(async () => planningSession()),
    onDeleteSession: vi.fn(async () => undefined),
    onSelectSession: vi.fn(),
  };
}

function planningSession(): SessionSummary {
  return {
    id: "session-1",
    status: "idle",
    title: "Planning notes",
    updatedAtMs: Date.UTC(2026, 7, 14),
    workingDirectory: "D:\\Code\\tinybot",
  };
}
