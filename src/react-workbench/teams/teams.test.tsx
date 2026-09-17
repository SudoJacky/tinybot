import * as teamsApi from "../../app-core/native/desktopNativeTeams";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  TeamRun,
  TeamStore,
} from "../../app-core/native/desktopNativeTeams";
import {
  acceptRevision,
  canExecute,
  orderedTasks,
  taskState,
} from "./teamPresentation";
import { useTeamRuns } from "./useTeamRuns";
import { TeamDetail } from "./TeamDetail";
import { TeamElapsedTime } from "./TeamTaskStatus";
import TeamsRoute from "./TeamsRoute";
vi.mock("../chat/AssistantMarkdown", () => ({
  AssistantMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
afterEach(cleanup);
function fixture(): TeamRun {
  return {
    schemaVersion: 2,
    id: "team",
    revision: 1,
    spec: {
      goal: "Research",
      workspacePath: "D:/project",
      maxConcurrency: 2,
      members: [
        { id: "a", displayName: "Researcher", instructions: "Gather evidence" },
      ],
    },
    finalTaskId: "final",
    status: "planned",
    createdAt: "2026-09-16",
    updatedAt: "2026-09-16",
    error: null,
    tasks: [
      {
        task: {
          id: "final",
          title: "Synthesize",
          memberId: "a",
          instructions: "Compare evidence",
          dependencies: ["source"],
        },
        status: "pending",
        attempts: [],
      },
      {
        task: {
          id: "source",
          title: "Collect sources",
          memberId: "a",
          instructions: "Find primary sources",
          dependencies: [],
        },
        status: "pending",
        attempts: [],
      },
    ],
  };
}
function store(run: TeamRun): TeamStore {
  return {
    list: vi.fn(async () => [run]),
    get: vi.fn(async () => run),
    prepare: vi.fn(async () => run),
    revise: vi.fn(async () => run),
    execute: vi.fn(async () => run),
    control: vi.fn(async () => run),
  };
}
it("orders dependency rows stably and projects pending tasks in the run context", () => {
  const run = fixture();
  expect(orderedTasks(run.tasks).map((r) => r.task.id)).toEqual([
    "source",
    "final",
  ]);
  expect(taskState(run, run.tasks[0])).toBe("planned");
  run.status = "running";
  expect(taskState(run, run.tasks[0])).toBe("blocked");
  expect(taskState(run, run.tasks[1])).toBe("queued");
  run.status = "cancelled";
  expect(taskState(run, run.tasks[0])).toBe("unexecuted");
  expect(canExecute(run)).toBe(false);
  expect(acceptRevision([{ ...run, revision: 3 }], run)[0].revision).toBe(3);
  run.tasks[1].task.dependencies = ["final"];
  expect(() => orderedTasks(run.tasks)).toThrow("dependency graph");
});
it("navigates active work without overriding manual selection when tasks finish", async () => {
  const run = fixture();
  run.status = "running";
  run.tasks[1].status = "running";
  run.tasks[1].attempts = [{
    threadId: "active-thread", turnId: "turn", status: "running",
    startedAt: new Date().toISOString(), finishedAt: null, output: null, error: null,
  }];
  const props = {
    run, busy: false, onBack: vi.fn(), onExecute: vi.fn(), onControl: vi.fn(),
    onRevise: vi.fn(), onOpenThread: vi.fn(),
  };
  const user = userEvent.setup();
  const view = render(<TeamDetail {...props} run={fixture()} />);
  const inspector = () => within(screen.getByRole("complementary", { name: "Task details" }));
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  view.rerender(<TeamDetail {...props} />);
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await user.click(inspector().getByRole("button", { name: "View live activity" }));
  expect(props.onOpenThread).toHaveBeenCalledWith("active-thread");
  await user.click(screen.getByRole("button", { name: /02 Synthesize/ }));
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  view.rerender(<TeamDetail {...props} run={{ ...run, revision: 2 }} />);
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  await user.click(screen.getByRole("tab", { name: "Result" }));
  await user.click(screen.getByRole("button", { name: "View Researcher's task: Collect sources" }));
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
  const paused: TeamRun = {
    ...run, status: "paused", revision: 3,
    tasks: run.tasks.map((r) => r.task.id !== "source" ? r : {
      ...r, status: "succeeded", attempts: [{ ...r.attempts[0], status: "succeeded", finishedAt: new Date().toISOString(), output: "Sources gathered" }],
    }),
  };
  view.rerender(<TeamDetail {...props} run={paused} />);
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
  expect(inspector().getByText("Sources gathered")).toBeVisible();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  expect(screen.queryByRole("button", { name: "View live activity" })).toBeNull();
  expect(screen.queryByTitle("Locate next running task")).toBeNull();
  expect(view.container.querySelector(".team-running-indicator")).toBeNull();
});

it("updates elapsed time only during execution and cleans up its timer", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-16T12:01:00Z"));
    const attempt = {
      threadId: "thread", turnId: "turn", status: "running" as const,
      startedAt: "2026-09-16T12:00:00Z", finishedAt: null, output: null, error: null,
    };
    const view = render(<TeamElapsedTime attempt={attempt} />);
    expect(screen.getByText("Elapsed 1:00")).toBeVisible();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Elapsed 1:02")).toBeVisible();
    view.rerender(<TeamElapsedTime attempt={{ ...attempt, status: "succeeded", finishedAt: "2026-09-16T12:01:02Z" }} />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("Elapsed 1:02")).toBeVisible();
    view.rerender(<TeamElapsedTime attempt={attempt} />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the editor controls available and hands keyboard focus back on discard", async () => {
  const user = userEvent.setup();
  render(<TeamDetail run={fixture()} busy={false} onBack={vi.fn()} onExecute={vi.fn()}
    onControl={vi.fn()} onRevise={vi.fn()} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Edit plan" }));
  expect(screen.getAllByLabelText("Task title")[0]).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Result" })).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Tasks" }));
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: "Save plan" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit plan" })).toHaveFocus());
  expect(screen.getByRole("tab", { name: "Result" })).toBeEnabled();
});

it("polls active runs from the home page and stops once they finish", async () => {
  const run = { ...fixture(), status: "running" as const };
  const api = store(run);
  api.get = vi.fn(async () => ({ ...run, revision: 2, status: "completed" as const }));
  const { result } = renderHook(() => useTeamRuns(api));
  await waitFor(() => expect(result.current.runs[0]?.status).toBe("completed"));
  expect(result.current.selectedId).toBeNull();
  expect(api.get).toHaveBeenCalledWith(run.id);
  expect(api.get).toHaveBeenCalledTimes(1);
});

it("filters recent runs by workspace and clearly marks the selected project", async () => {
  const run = fixture();
  const other = { ...run, id: "other", spec: { ...run.spec, goal: "Other project work", workspacePath: "D:/other" } };
  const api = store(run);
  api.list = vi.fn(async () => [run, other]);
  const registry = {
    list: vi.fn(async () => [
      { path: "D:/project", name: "Project", exists: true, addedAtMs: 0, updatedAtMs: 0 },
      { path: "D:/other", name: "Other", exists: true, addedAtMs: 0, updatedAtMs: 0 },
    ]), register: vi.fn(), rename: vi.fn(), forget: vi.fn(),
  };
  render(<TeamsRoute services={{ teamStore: api, workspaceRegistryStore: registry }} onOpenThread={vi.fn()} onNavigate={vi.fn()} />);
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Workspace: Project" });
  expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute("aria-current", "true");
  expect(screen.queryByRole("button", { name: /Other project work/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Other" }));
  expect(screen.getByRole("button", { name: /Other project work/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Research project Ready/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Other" })).toHaveAttribute("aria-current", "true");
});
it("keeps pause available while execute is unresolved and rejects stale polling responses", async () => {
  const run = fixture();
  const api = store(run);
  let finish!: (run: TeamRun) => void;
  let poll!: (run: TeamRun) => void;
  api.execute = vi.fn(
    () =>
      new Promise<TeamRun>((resolve) => {
        finish = resolve;
      }),
  );
  api.get = vi.fn(
    () =>
      new Promise<TeamRun>((resolve) => {
        poll = resolve;
      }),
  );
  const { result } = renderHook(() => useTeamRuns(api));
  await waitFor(() => expect(result.current.runs.length).toBe(1));
  act(() => {
    result.current.setSelectedId(run.id);
    result.current.execute(run);
  });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await act(async () => poll({ ...run, status: "running", revision: 2 }));
  expect(result.current.busy).toBe(false);
  expect(result.current.pending).toBeUndefined();
  api.control = vi.fn(
    async (): Promise<TeamRun> => ({ ...run, status: "running", revision: 2 }),
  );
  await act(async () => {
    await result.current.control("pause");
  });
  expect(api.control).toHaveBeenCalledWith({
    runId: "team",
    expectedRevision: 2,
    action: "pause",
    taskIds: undefined,
  });
  expect(result.current.pending).toBe("pause");
  await act(async () => {
    finish({ ...run, status: "paused", revision: 4 });
  });
  await act(async () => {
    await result.current.action(async () => ({
      ...run,
      status: "running",
      revision: 3,
    }));
  });
  expect(result.current.run?.status).toBe("paused");
  expect(result.current.run?.revision).toBe(4);
});
it("preserves edits on a revision conflict and keeps attempted task definitions locked", async () => {
  const user = userEvent.setup();
  const run = fixture();
  run.status = "paused";
  run.tasks[1].status = "succeeded";
  run.tasks[1].attempts = [
    {
      threadId: "done",
      turnId: "turn",
      status: "succeeded",
      startedAt: "2026-09-16",
      finishedAt: "2026-09-16",
      output: "Evidence",
      error: null,
    },
  ];
  const props = {
    run,
    busy: false,
    onBack: vi.fn(),
    onExecute: vi.fn(),
    onControl: vi.fn(),
    onRevise: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<TeamDetail {...props} />);
  await user.click(screen.getByRole("button", { name: "Edit plan" }));
  expect(screen.getAllByLabelText("Task title")[1]).toBeDisabled();
  const title = screen.getAllByLabelText("Task title")[0];
  await user.clear(title);
  await user.type(title, "New synthesis title");
  view.rerender(<TeamDetail {...props} run={{ ...run, revision: 2 }} />);
  await user.click(screen.getByRole("button", { name: "Save plan" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your changes are preserved",
  );
  expect(title).toHaveValue("New synthesis title");
  expect(props.onRevise).not.toHaveBeenCalled();
});
it("exposes prior attempt records, explicit retry and final output on the same page", async () => {
  const run = fixture();
  run.status = "failed";
  run.tasks[0].status = "failed";
  run.tasks[0].attempts = [
    {
      threadId: "previous",
      turnId: "turn",
      status: "failed",
      startedAt: "2026-09-16",
      finishedAt: null,
      output: null,
      error: "Provider failed",
    },
  ];
  const onControl = vi.fn();
  const onOpenThread = vi.fn();
  const props = {
    run,
    busy: false,
    onBack: vi.fn(),
    onExecute: vi.fn(),
    onControl,
    onRevise: vi.fn(),
    onOpenThread,
  };
  const view = render(<TeamDetail {...props} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: /Open execution record/ }),
  );
  expect(onOpenThread).toHaveBeenCalledWith("previous");
  await user.click(screen.getByRole("button", { name: "Retry this task" }));
  expect(onControl).toHaveBeenCalledWith("retry", ["final"]);
  run.tasks[0].status = "succeeded";
  run.tasks[0].attempts[0].output = "Evidence based recommendation";
  view.rerender(
    <TeamDetail {...props} run={{ ...run, status: "completed" }} />,
  );
  await user.click(screen.getByRole("tab", { name: "Result" }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent(
    "Evidence based recommendation",
  );
  expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
});
it("prepares a real workspace-bound roster and waits for explicit start", async () => {
  const api = store(fixture());
  api.list = vi.fn(async () => []);
  const registry = {
    list: vi.fn(async () => [
      {
        path: "D:/project",
        name: "Project",
        exists: true,
        addedAtMs: 0,
        updatedAtMs: 0,
      },
    ]),
    register: vi.fn(),
    rename: vi.fn(),
    forget: vi.fn(),
  };
  render(
    <TeamsRoute
      services={{ teamStore: api, workspaceRegistryStore: registry }}
      onOpenThread={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Workspace: Project" });
  await user.type(
    screen.getByRole("textbox", { name: "Team goal" }),
    "Research tools",
  );
  await user.click(screen.getByRole("button", { name: "Generate plan" }));
  await screen.findByRole("button", { name: "Confirm and start" });
  expect(api.prepare).toHaveBeenCalledWith({
    spec: expect.objectContaining({
      goal: "Research tools",
      workspacePath: "D:/project",
      members: expect.arrayContaining([
        expect.objectContaining({ displayName: "Researcher" }),
      ]),
    }),
  });
  expect(api.execute).not.toHaveBeenCalled();
});

it("keeps polling when a resume request initially reads the previous paused snapshot", async () => {
  const run = fixture();
  run.status = "paused";
  const api = store(run);
  let finish!: (run: TeamRun) => void;
  api.execute = vi.fn(
    () =>
      new Promise<TeamRun>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useTeamRuns(api));
  await waitFor(() => expect(result.current.runs.length).toBe(1));
  await act(async () => {
    result.current.setSelectedId(run.id);
    result.current.execute(run);
  });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(result.current.pending).toBe("start");
  await act(async () => {
    finish({ ...run, status: "completed", revision: 4 });
  });
  expect(result.current.pending).toBeUndefined();
});

it("ignores late accepted control intent after a newer terminal snapshot", async () => {
  const run = { ...fixture(), status: "running" as const };
  const api = store(run);
  let controlReply!: (run: TeamRun) => void;
  api.control = vi.fn(
    () =>
      new Promise<TeamRun>((resolve) => {
        controlReply = resolve;
      }),
  );
  const { result } = renderHook(() => useTeamRuns(api));
  await waitFor(() => expect(result.current.runs.length).toBe(1));
  act(() => result.current.setSelectedId(run.id));
  let request!: Promise<void>;
  act(() => {
    request = result.current.control("pause");
  });
  await act(async () => {
    await result.current.refresh();
  });
  api.list = vi.fn(async (): Promise<TeamRun[]> => [{ ...run, status: "paused", revision: 3 }]);
  await act(async () => {
    await result.current.refresh();
  });
  await act(async () => {
    controlReply(run);
    await request;
  });
  expect(result.current.run?.status).toBe("paused");
  expect(result.current.pending).toBeUndefined();
});

it("shows shared messages and pages verified artifacts without loading them automatically", async () => {
  const run = fixture();
  run.tasks[1].status = "succeeded";
  run.tasks[1].attempts = [{ threadId: "producer", turnId: "turn", status: "succeeded", startedAt: "2026-09-17", finishedAt: "2026-09-17", error: null, output: "Evidence ready", message: {
    summary: "Evidence ready", unresolved: "Verify pagination", sequence: 3,
    artifacts: [{ path: "evidence.txt", bytes: 100000, sha256: "abc" }],
  } }];
  const read = vi.spyOn(teamsApi, "readTeamArtifact")
    .mockResolvedValueOnce({ text: "first", byteOffset: 0, nextByteOffset: 5, totalBytes: 100000, path: "evidence.txt", sha256: "abc" })
    .mockRejectedValueOnce(new Error("Artifact changed since publication"));
  const open = vi.fn(async () => {});
  render(<TeamDetail run={run} busy={false} onBack={() => {}} onExecute={() => {}} onControl={async () => {}} onRevise={async () => undefined} onOpenThread={open} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Message board" }));
  const board = screen.getByRole("tabpanel", { name: "Message board" });
  expect(within(board).getByText("Evidence ready")).toBeVisible();
  expect(within(board).getByText(/Verify pagination/)).toBeVisible();
  expect(read).not.toHaveBeenCalled();
  await user.click(within(board).getByRole("button", { name: "evidence.txt" }));
  expect(await within(board).findByText("first")).toBeVisible();
  await user.click(within(board).getByRole("button", { name: "Next section" }));
  expect(read).toHaveBeenLastCalledWith("team", "producer", 0, 5);
  expect(await within(board).findByRole("alert")).toHaveTextContent("Artifact changed");
  expect(within(board).queryByText("first")).not.toBeInTheDocument();
  read.mockRestore();
});
