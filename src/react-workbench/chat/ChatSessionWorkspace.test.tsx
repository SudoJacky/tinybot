// @vitest-environment happy-dom

import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProjectGroupStore, SessionSummary } from "../services";
import {
  ChatSessionWorkspace,
  type ChatSessionWorkspaceActions,
} from "./ChatSessionWorkspace";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

  test("uses the workspace and session rows themselves as drag sources", () => {
    renderWorkspace();
    const workspace = screen.getByRole("group", { name: "Workspace tinybot" });
    const sessionRow = within(workspace).getByRole("button", { name: "Planning notes" })
      .closest(".react-session-row")!;

    expect(workspace.querySelector("summary")?.getAttribute("draggable")).toBe("true");
    expect(sessionRow.getAttribute("draggable")).toBe("true");
    expect(document.querySelector(".react-sidebar-reorder-handle")).toBeNull();
  });

  test("drags workspace groups into a persisted user order", () => {
    const sessions = [
      planningSession(),
      {
        ...planningSession(),
        id: "session-2",
        title: "Release notes",
        updatedAtMs: Date.UTC(2026, 7, 13),
        workingDirectory: "D:\\Code\\release",
      },
    ];
    const rendered = renderWorkspace({ sessions });
    const rows = screen.getByLabelText("Session list rows");
    expect(sidebarGroupLabels(rows)).toEqual(["Workspace tinybot", "Workspace release"]);

    const source = screen.getByRole("group", { name: "Workspace release" }).querySelector("summary")!;
    const target = screen.getByRole("group", { name: "Workspace tinybot" }).querySelector("summary")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 44));
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireDragOverAt(target, 1, dataTransfer);
    fireEvent.drop(target, { clientY: 1, dataTransfer });

    expect(sidebarGroupLabels(rows)).toEqual(["Workspace release", "Workspace tinybot"]);

    rendered.unmount();
    renderWorkspace({ sessions });
    expect(sidebarGroupLabels(screen.getByLabelText("Session list rows")))
      .toEqual(["Workspace release", "Workspace tinybot"]);
  });

  test("drags member workspaces only within their project group", async () => {
    const projectGroupStore: ProjectGroupStore = {
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => [{
        name: "group-1",
        projectGroupId: "project-1",
        workspaceIds: ["D:\\Code\\tinybot", "D:\\Code\\release"],
      }]),
      save: vi.fn(async (input) => ({
        name: input.name,
        projectGroupId: input.projectGroupId ?? "project-1",
        workspaceIds: input.workspaceIds,
      })),
    };
    renderWorkspace({
      projectGroupStore,
      sessions: [
        { ...planningSession(), projectGroupId: "project-1" },
        {
          ...planningSession(),
          id: "session-2",
          projectGroupId: "project-1",
          title: "Release notes",
          updatedAtMs: Date.UTC(2026, 7, 13),
          workingDirectory: "D:\\Code\\release",
        },
      ],
    });
    const project = await screen.findByRole("group", { name: "Project group-1" });
    expect(projectWorkspaceLabels(project)).toEqual(["Workspace tinybot", "Workspace release"]);

    const source = within(project).getByRole("group", { name: "Workspace release" })
      .querySelector(".react-project-group__member-title")!;
    const target = within(project).getByRole("group", { name: "Workspace tinybot" })
      .querySelector(".react-project-group__member-title")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 34));
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireDragOverAt(target, 1, dataTransfer);
    fireEvent.drop(target, { dataTransfer });

    expect(projectWorkspaceLabels(project)).toEqual(["Workspace release", "Workspace tinybot"]);
  });

  test("drags sessions only within their current workspace", () => {
    const sessions = [
      planningSession(),
      {
        ...planningSession(),
        id: "session-2",
        title: "Knowledge review",
        updatedAtMs: Date.UTC(2026, 7, 13),
      },
      {
        ...planningSession(),
        id: "session-3",
        title: "Release notes",
        updatedAtMs: Date.UTC(2026, 7, 12),
        workingDirectory: "D:\\Code\\release",
      },
    ];
    renderWorkspace({ sessions });
    const tinybot = screen.getByRole("group", { name: "Workspace tinybot" });
    expect(sessionTitles(tinybot)).toEqual(["Planning notes", "Knowledge review"]);

    const source = within(tinybot).getByRole("button", { name: "Knowledge review" })
      .closest(".react-session-row")!;
    const target = within(tinybot).getByRole("button", { name: "Planning notes" }).closest(".react-session-row")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 34));
    const dataTransfer = dragDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireDragOverAt(target, 1, dataTransfer);
    fireEvent.drop(target, { clientY: 1, dataTransfer });

    expect(sessionTitles(tinybot)).toEqual(["Knowledge review", "Planning notes"]);
    const release = screen.getByRole("group", { name: "Workspace release" });
    expect(sessionTitles(release)).toEqual(["Release notes"]);

    const crossWorkspaceTarget = within(release).getByRole("button", { name: "Release notes" })
      .closest(".react-session-row")!;
    fireEvent.dragStart(source, { dataTransfer });
    fireDragOverAt(crossWorkspaceTarget, 1, dataTransfer);
    fireEvent.drop(crossWorkspaceTarget, { dataTransfer });

    expect(sessionTitles(tinybot)).toEqual(["Knowledge review", "Planning notes"]);
    expect(sessionTitles(release)).toEqual(["Release notes"]);
  });

  test("reorders with Alt+Arrow keys and announces the result", () => {
    renderWorkspace({
      sessions: [
        planningSession(),
        {
          ...planningSession(),
          id: "session-2",
          title: "Knowledge review",
          updatedAtMs: Date.UTC(2026, 7, 13),
        },
      ],
    });
    const workspace = screen.getByRole("group", { name: "Workspace tinybot" });
    const row = within(workspace).getByRole("button", { name: "Planning notes" });

    fireEvent.keyDown(row, { altKey: true, key: "ArrowDown" });

    expect(sessionTitles(workspace)).toEqual(["Knowledge review", "Planning notes"]);
    expect(screen.getByText("Moved Planning notes after Knowledge review.")).toBeTruthy();
  });
});

function sidebarGroupLabels(rows: HTMLElement): string[] {
  return Array.from(rows.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.matches("details[role='group']"))
    .sort((left, right) => Number(left.style.order) - Number(right.style.order))
    .map((element) => element.getAttribute("aria-label") ?? "");
}

function sessionTitles(group: HTMLElement): string[] {
  return Array.from(group.querySelectorAll<HTMLElement>(".react-session-row__title"))
    .map((element) => element.textContent ?? "");
}

function projectWorkspaceLabels(project: HTMLElement): string[] {
  return Array.from(project.querySelectorAll<HTMLElement>(".react-project-workspace"))
    .map((element) => element.getAttribute("aria-label") ?? "");
}

function dragDataTransfer(): DataTransfer {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
  } as unknown as DataTransfer;
}

function fireDragOverAt(target: Element, clientY: number, dataTransfer: DataTransfer): void {
  const event = createEvent.dragOver(target, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(target, event);
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 240,
    top,
    width: 240,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

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
