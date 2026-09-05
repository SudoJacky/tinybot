// @vitest-environment happy-dom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import type { ProjectGroupStore, SessionSummary, WorkspaceRegistryStore } from "../services";
import {
  ChatSessionWorkspace,
  type ChatSessionWorkspaceActions,
} from "./ChatSessionWorkspace";

vi.mock("../../app-core/native/desktopNativeWorkspacePicker", () => ({
  pickDesktopWorkspaceDirectory: vi.fn(),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatSessionWorkspace", () => {
  test("keeps workspace order when session recency changes, including after remount", async () => {
    const first = { ...planningSession(), title: "First workspace chat", updatedAtMs: 30 };
    const older = { ...first, id: "older", title: "Older chat", updatedAtMs: 10 };
    const second = { ...first, id: "second", title: "Second workspace chat", workingDirectory: "D:\\Code\\another", updatedAtMs: 20 };
    const workspaceRegistryStore = createWorkspaceRegistryStore([first, second]);
    const view = renderWorkspace({ sessions: [first, second, older], workspaceRegistryStore });
    await act(async () => undefined);
    const rows = screen.getByLabelText("Session list rows");
    const originalOrder = sidebarGroupLabels(rows);
    const updated = [{ ...second, updatedAtMs: 60 }, { ...older, updatedAtMs: 50 }, first];

    view.rerenderSessions(updated);
    expect(sidebarGroupLabels(rows)).toEqual(originalOrder);
    expect(sessionTitles(screen.getByRole("group", { name: "Workspace tinybot" })))
      .toEqual(["Older chat", "First workspace chat"]);

    view.unmount();
    renderWorkspace({ sessions: updated, workspaceRegistryStore });
    await act(async () => undefined);
    expect(sidebarGroupLabels(screen.getByLabelText("Session list rows"))).toEqual(originalOrder);
  });

  test("bounds first content entrance to three rows across groups and consumes each animation", () => {
    renderWorkspace({ sessions: manySessions() });
    const rows = screen.getByLabelText("Session list rows");
    const entering = Array.from(rows.querySelectorAll<HTMLElement>("[data-entering='true']"));
    expect(rows.querySelectorAll(".react-session-row")).toHaveLength(60);
    expect(entering).toHaveLength(3);
    expect(entering.map((row) => row.style.getPropertyValue("--react-session-row-index")))
      .toEqual(["0", "1", "2"]);
    expect(entering.map((row) => row.closest("[role='group']")?.getAttribute("aria-label")))
      .toEqual(["Workspace group-0", "Workspace group-1", "Workspace group-10"]);

    fireEvent.animationEnd(entering[0], { animationName: "unrelated-animation" });
    fireEvent.animationEnd(entering[0].querySelector("button")!, { animationName: "react-list-enter" });
    expect(rows.querySelectorAll("[data-entering='true']")).toHaveLength(3);
    for (const row of entering) {
      fireEvent.animationEnd(row, { animationName: "react-list-enter" });
    }
    expect(rows.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("settles an unfinished entrance when searching and never replays on clearing search", () => {
    renderWorkspace({ sessions: manySessions() });
    const rows = screen.getByLabelText("Session list rows");
    expect(rows.querySelectorAll("[data-entering='true']")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /search chats/i }));
    const input = screen.getByRole("textbox", { name: "Search chats" });
    fireEvent.change(input, { target: { value: "Session 59" } });
    expect(screen.getByRole("button", { name: "Session 59" })).toBeTruthy();
    expect(rows.querySelectorAll(".react-session-row")).toHaveLength(1);
    expect(rows.querySelectorAll("[data-entering='true']")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "" } });
    expect(rows.querySelectorAll(".react-session-row")).toHaveLength(60);
    expect(rows.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("waits for the first nonempty session batch without rearming on later refreshes", async () => {
    const view = renderWorkspace({ sessions: [] });
    await act(async () => undefined);
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
    view.rerenderSessions(manySessions());
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(3);
    view.rerenderSessions(manySessions());
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("selection settles the batch even if the parent keeps the same active session", () => {
    const actions = createActions();
    const sessions = manySessions();
    renderWorkspace({ actions, sessions });
    fireEvent.click(screen.getByRole("button", { name: "Session 0" }));
    expect(actions.onSelectSession).toHaveBeenCalledWith(sessions[0]);
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("data refresh and workspace reorder keep all rows immediately available", () => {
    const sessions = manySessions();
    const view = renderWorkspace({ sessions });
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(3);
    view.rerenderSessions([...sessions]);
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
    const firstGroup = screen.getByRole("group", { name: "Workspace group-0" });
    fireEvent.keyDown(firstGroup.querySelector("summary")!, { altKey: true, key: "ArrowDown" });
    expect(sidebarGroupLabels(screen.getByLabelText("Session list rows")).slice(0, 2))
      .toEqual(["Workspace group-1", "Workspace group-0"]);
    expect(document.querySelectorAll(".react-session-row")).toHaveLength(60);
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test.each([true, false])("reduced motion consumes entrance eligibility (initially %s)", (initiallyReduced) => {
    const preference = Object.assign(new EventTarget(), { matches: initiallyReduced });
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => query === "(prefers-reduced-motion: reduce)"
      ? preference as unknown as MediaQueryList
      : originalMatchMedia(query));
    renderWorkspace({ sessions: manySessions() });
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(initiallyReduced ? 0 : 3);
    act(() => {
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
    act(() => {
      preference.matches = false;
      preference.dispatchEvent(new Event("change"));
    });
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("owns sidebar selection and inline search lifecycle behind one actions interface", () => {
    const actions = createActions();
    const session = planningSession();
    renderWorkspace({ actions, sessions: [session] });

    fireEvent.click(screen.getByRole("button", { name: "Planning notes" }));
    expect(actions.onSelectSession).toHaveBeenCalledWith(session);

    fireEvent.click(screen.getByRole("button", { name: /search chats/i }));
    const search = screen.getByRole("search", { name: "Session search" });
    const input = within(search).getByRole("textbox", { name: "Search chats" });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.queryByRole("button", { name: "Planning notes" })).toBeNull();
    expect(screen.getByText("No matching sessions.")).toBeTruthy();

    fireEvent.click(within(search).getByRole("button", { name: "Close session search" }));
    expect(screen.queryByRole("search", { name: "Session search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(actions.onCreateSession).not.toHaveBeenCalled();
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

  test("keeps workspace actions outside the native details content box", async () => {
    renderWorkspace();
    const workspace = screen.getByRole("group", { name: "Workspace tinybot" });
    const details = workspace.querySelector(":scope > details");
    const manageButton = await within(workspace).findByRole("button", { name: "Manage tinybot" });

    expect(workspace.tagName).toBe("DIV");
    expect(details?.querySelector(":scope > summary")).toBeTruthy();
    expect(manageButton.closest(".react-session-workspace__actions")?.parentElement).toBe(workspace);
  });

  test("drags workspace groups into a persisted user order", async () => {
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
    await act(async () => undefined);
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
    await act(async () => undefined);
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
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(2);

    fireEvent.keyDown(row, { altKey: true, key: "ArrowDown" });

    expect(sessionTitles(workspace)).toEqual(["Knowledge review", "Planning notes"]);
    expect(screen.getByText("Moved Planning notes after Knowledge review.")).toBeTruthy();
    expect(document.querySelectorAll("[data-entering='true']")).toHaveLength(0);
  });

  test("registers a picked workspace before creating its first session", async () => {
    const actions = createActions();
    const workspaceRegistryStore = createWorkspaceRegistryStore([]);
    vi.mocked(pickDesktopWorkspaceDirectory).mockResolvedValue("\\\\?\\D:\\Code\\new-workspace");
    vi.mocked(workspaceRegistryStore.register).mockResolvedValue({
      addedAtMs: 1,
      exists: true,
      name: "new-workspace",
      path: "D:\\Code\\new-workspace",
      updatedAtMs: 1,
    });
    renderWorkspace({ actions, sessions: [], workspaceRegistryStore });

    fireEvent.click(screen.getByRole("button", { name: "Workspace and project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add workspace folder" }));

    await waitFor(() => expect(workspaceRegistryStore.register).toHaveBeenCalledWith(
      "\\\\?\\D:\\Code\\new-workspace",
    ));
    await waitFor(() => expect(actions.onCreateSession).toHaveBeenCalledWith(
      "D:\\Code\\new-workspace",
    ));
  });

  test("renames and forgets workspaces through the registry", async () => {
    const workspaceRegistryStore = createWorkspaceRegistryStore([planningSession()]);
    renderWorkspace({ workspaceRegistryStore });

    fireEvent.click(await screen.findByRole("button", { name: "Manage tinybot" }));
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "Tinybot Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(workspaceRegistryStore.rename).toHaveBeenCalledWith(
      "D:\\Code\\tinybot",
      "Tinybot Desktop",
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Manage Tinybot Desktop" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));
    await waitFor(() => expect(workspaceRegistryStore.forget).toHaveBeenCalledWith(
      "D:\\Code\\tinybot",
    ));
    expect(screen.queryByRole("button", { name: /Manage Tinybot Desktop/ })).toBeNull();
  });
});

function sidebarGroupLabels(rows: HTMLElement): string[] {
  return Array.from(rows.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.matches("[role='group']"))
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
  workspaceRegistryStore = createWorkspaceRegistryStore(sessions),
}: {
  actions?: ChatSessionWorkspaceActions;
  projectGroupStore?: ProjectGroupStore;
  sessions?: SessionSummary[];
  workspaceRegistryStore?: WorkspaceRegistryStore;
} = {}) {
  const workspace = (nextSessions: SessionSummary[]) => (
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
      sessions={nextSessions}
      workspaceRegistryStore={workspaceRegistryStore}
    >
      <main>Conversation surface</main>
    </ChatSessionWorkspace>
  );
  const view = render(workspace(sessions));
  return { ...view, rerenderSessions: (nextSessions: SessionSummary[]) => view.rerender(workspace(nextSessions)) };
}

function manySessions(): SessionSummary[] {
  return Array.from({ length: 60 }, (_, index) => ({
    ...planningSession(),
    id: `session-${index}`,
    title: `Session ${index}`,
    workingDirectory: `D:\\Code\\group-${index}`,
    updatedAtMs: 60 - index,
  }));
}

function createWorkspaceRegistryStore(sessions: SessionSummary[]): WorkspaceRegistryStore {
  const workspaces = sessions.flatMap((session) => session.workingDirectory ? [{
    addedAtMs: session.updatedAtMs,
    exists: true,
    name: session.workingDirectory.split(/[\\/]+/).filter(Boolean).slice(-1)[0] ?? session.workingDirectory,
    path: session.workingDirectory,
    updatedAtMs: session.updatedAtMs,
  }] : []);
  return {
    list: vi.fn(async () => workspaces),
    register: vi.fn(async (path) => ({
      addedAtMs: 0,
      exists: true,
      name: path.split(/[\\/]+/).filter(Boolean).slice(-1)[0] ?? path,
      path,
      updatedAtMs: 0,
    })),
    rename: vi.fn(async (path, name) => ({
      addedAtMs: 0,
      exists: true,
      name,
      path,
      updatedAtMs: 1,
    })),
    forget: vi.fn(async () => undefined),
  };
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
