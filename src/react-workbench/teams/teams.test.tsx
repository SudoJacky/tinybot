import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
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
