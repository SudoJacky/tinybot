import type { WorkspaceStore } from "../services";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import * as teamsApi from "../../app-core/native/desktopNativeTeams";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
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
const workspaceStore = { readThreadFile: vi.fn(), readThreadFileBytes: vi.fn() } as unknown as WorkspaceStore;
afterEach(cleanup);
it("shows recent progress in the task and inspector while folding earlier activity and attempts", async () => {
  const run = fixture();
  run.status = "running";
  const record = run.tasks[1];
  record.status = "running";
  record.attempts = [
    { threadId: "old", turnId: "old-turn", status: "failed", startedAt: "2026-09-16", finishedAt: "2026-09-16", output: null, error: "Old failure" },
    { threadId: "live", turnId: "turn", status: "running", startedAt: "2026-09-16", finishedAt: null, output: null, error: null },
  ];
  const snapshot: ChatTimelineSnapshot = {
    schemaVersion: "tinybot.chat_timeline.v1", sessionId: "live", source: "canonical", diagnostics: [], turnRevisions: {},
    turns: [{ id: "turn", sessionKey: "live", startedAt: "", updatedAt: "", status: "running", userMessageId: "user",
      userMessage: { id: "user", role: "user", text: "Instructions", timestamp: "" },
      steps: Array.from({ length: 7 }, (_, i) => ({ id: String(i), kind: "message", title: "Progress", summary: `Reading source ${i + 1}`,
        sequence: i, status: "completed", agentContext: { id: "main", title: "Agent", type: "main" } })),
    }],
  };
  const source = { readTimeline: vi.fn(async () => snapshot), subscribe: vi.fn(() => vi.fn()) };
  const onOpenThread = vi.fn();
  render(<TeamDetail workspaceStore={workspaceStore} activitySource={source} run={run} busy={false}
    onBack={vi.fn()} onExecute={vi.fn()} onControl={vi.fn()} onRevise={vi.fn()} onOpenThread={onOpenThread} />);
  const user = userEvent.setup();
  const inspector = within(screen.getByRole("complementary", { name: "Task details" }));
  expect(await inspector.findByText("Reading source 7")).toBeVisible();
  expect(screen.getByRole("button", { name: /01 Collect sources/ })).toHaveTextContent("Reading source 7");
  expect(inspector.queryByText("Reading source 1")).not.toBeInTheDocument();
  await user.click(inspector.getByText("Earlier activity (2)"));
  expect(await inspector.findByText("Reading source 1")).toBeVisible();
  expect(inspector.getByRole("button", { name: /1 · Failed/ }).closest("details")).not.toHaveAttribute("open");
  await user.click(inspector.getByText("Earlier attempts (1)"));
  await user.click(inspector.getByRole("button", { name: /1 · Failed/ }));
  expect(onOpenThread).toHaveBeenCalledWith("old");
});

it("opens the most recent completed member task and restores reading positions across tasks", async () => {
  const run = fixture();
  run.status = "completed";
  run.tasks.forEach((record) => {
    record.status = "succeeded";
    record.attempts = [{ threadId: record.task.id, turnId: "turn", status: "succeeded",
      startedAt: record.task.id === "final" ? "2026-09-16T12:00:00Z" : "2026-09-16T11:00:00Z",
      finishedAt: "2026-09-16T13:00:00Z", output: `Output for ${record.task.id}`, error: null }];
  });
  render(<TeamDetail workspaceStore={workspaceStore} run={run} busy={false}
    onBack={vi.fn()} onExecute={vi.fn()} onControl={vi.fn()} onRevise={vi.fn()} onOpenThread={vi.fn()} />);
  const user = userEvent.setup();
  const dock = within(screen.getByRole("navigation", { name: "Team members" }));
  await user.click(dock.getByRole("button", { name: "View Researcher's task: Synthesize" }));
  const inspector = screen.getByRole("complementary", { name: "Task details" });
  expect(within(inspector).getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  inspector.scrollTop = 240;
  fireEvent.scroll(inspector);
  await user.click(within(inspector).getByText("Member tasks (2)"));
  const memberTasks = within(within(inspector).getByRole("group", { name: "Member tasks (2)" }));
  await user.click(memberTasks.getByRole("button", { name: "Collect sources Completed" }));
  expect(inspector.scrollTop).toBe(0);
  inspector.scrollTop = 80;
  fireEvent.scroll(inspector);
  await user.click(dock.getByRole("button", { name: "View Researcher's task: Synthesize" }));
  expect(inspector.scrollTop).toBe(240);
  await user.click(memberTasks.getByRole("button", { name: "Collect sources Completed" }));
  expect(inspector.scrollTop).toBe(80);
  expect(within(inspector).getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
});

it("shows dependency, member and capacity waits without marking a member with pending work complete", () => {
  const run = fixture();
  run.status = "running";
  const source = run.tasks[1];
  source.status = "running";
  run.spec.maxConcurrency = 1;
  run.spec.members.push({ id: "b", displayName: "Reviewer", instructions: "Review" });
  run.tasks.push({ task: { ...source.task, id: "extra", title: "Extra research" }, status: "pending", attempts: [] },
    { task: { ...source.task, id: "review", title: "Review", memberId: "b" }, status: "pending", attempts: [] });
  const props = { workspaceStore, busy: false, onBack: vi.fn(), onExecute: vi.fn(), onControl: vi.fn(), onRevise: vi.fn(), onOpenThread: vi.fn() };
  const view = render(<TeamDetail {...props} run={run} />);
  expect(screen.getByText("Waiting for: Collect sources")).toBeVisible();
  expect(screen.getByText("Member is working on: Collect sources")).toBeVisible();
  expect(screen.getByText("Waiting for an execution slot")).toBeVisible();
  const updated = structuredClone(run);
  updated.tasks[1].status = "succeeded";
  updated.tasks[1].attempts = [{ threadId: "source", turnId: "turn", status: "succeeded", startedAt: "2026-09-16",
    finishedAt: "2026-09-16", output: "Evidence", error: null }];
  view.rerender(<TeamDetail {...props} run={updated} />);
  const dock = within(screen.getByRole("navigation", { name: "Team members" }));
  expect(dock.getByRole("button", { name: "View Researcher's task: Collect sources" })).toHaveTextContent("Queued");
});

it("aggregates artifacts with their producer and attempt, keeps history folded and reads only on request", async () => {
  const run = fixture();
  run.status = "completed";
  run.tasks[1].status = "succeeded";
  run.tasks[1].attempts = ["earlier", "latest"].map((threadId, index) => ({
    threadId, turnId: "turn", status: "succeeded", startedAt: "2026-09-16", finishedAt: "2026-09-16", output: "Report", error: null,
    message: { summary: "Report", unresolved: "", sequence: index, artifacts: [{ path: `${threadId}.txt`, sha256: "hash", bytes: 4 }] },
  }));
  const read = vi.spyOn(teamsApi, "readTeamArtifact").mockResolvedValue({ text: "data", byteOffset: 0, nextByteOffset: null, totalBytes: 4, path: "latest.txt", sha256: "hash" });
  const onOpenThread = vi.fn();
  try {
    render(<TeamDetail workspaceStore={workspaceStore} run={run} busy={false} onBack={vi.fn()} onExecute={vi.fn()}
      onControl={vi.fn()} onRevise={vi.fn()} onOpenThread={onOpenThread} />);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Tasks" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    const files = within(screen.getByRole("tabpanel", { name: "Files" }));
    expect(files.getByText(/Researcher · Attempt 2/)).toBeVisible();
    expect(files.getByRole("button", { name: "latest.txt" })).toBeVisible();
    expect(files.queryByRole("button", { name: "earlier.txt" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await user.click(files.getByRole("button", { name: "latest.txt" }));
    expect(read).toHaveBeenCalledWith("team", "latest", 0, 0);
    expect(await files.findByText("data")).toBeVisible();
    await user.click(files.getByText("Earlier attempts (1)"));
    await user.click(files.getByRole("button", { name: "earlier.txt" }));
    expect(read).toHaveBeenLastCalledWith("team", "earlier", 0, 0);
    await user.click(files.getAllByRole("button", { name: "Collect sources" })[0]);
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("complementary", { name: "Task details" })).getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
  } finally { read.mockRestore(); }
});
it("reconciles planner, task and background usage in the Team usage tab", async () => {
  const usage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 };
  const loadUsageDetails = vi.fn(async () => ({
    groups: (["team_planning", "team_task", "subagent", "memory_extraction"] as const).map(purpose => ({
      date: "2026-09-18", providerId: "fixture", modelId: "model", purpose,
      teamRunId: "team", taskId: purpose === "team_planning" ? null : "source", attemptId: null,
      calls: 1, reportedCalls: 1, failedCalls: 0, pendingCalls: 0, retryCalls: 0, usage,
    })), invocations: [], nextCursor: null,
  }));
  render(<TeamDetail workspaceStore={workspaceStore} run={fixture()} busy={false} loadUsageDetails={loadUsageDetails}
    onBack={vi.fn()} onExecute={vi.fn()} onControl={vi.fn()} onRevise={vi.fn()} onOpenThread={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Usage" }));
  const table = await screen.findByRole("table", { name: "Usage by purpose" });
  expect(loadUsageDetails).toHaveBeenCalledWith({ teamRunId: "team", before: undefined });
  expect(within(table).getByRole("row", { name: /^Run-level work Team planning/ })).toBeVisible();
  expect(within(table).getByRole("row", { name: /^Collect sources Memory extraction/ })).toBeVisible();
  expect(within(within(table).getByRole("row", { name: /^Total reported usage/ })).getAllByRole("cell").map(cell => cell.textContent))
    .toEqual(["4", "0", "0", "0", "0", "400", "320", "80", "80", "20", "480"]);
});
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
  const view = render(<TeamDetail workspaceStore={workspaceStore} {...props} run={fixture()} />);
  const inspector = () => within(screen.getByRole("complementary", { name: "Task details" }));
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  view.rerender(<TeamDetail workspaceStore={workspaceStore} {...props} />);
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Collect sources");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await user.click(inspector().getByRole("button", { name: "View live activity" }));
  expect(props.onOpenThread).toHaveBeenCalledWith("active-thread");
  await user.click(screen.getByRole("button", { name: /02 Synthesize/ }));
  expect(inspector().getByRole("heading", { level: 2 })).toHaveTextContent("Synthesize");
  view.rerender(<TeamDetail workspaceStore={workspaceStore} {...props} run={{ ...run, revision: 2 }} />);
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
  view.rerender(<TeamDetail workspaceStore={workspaceStore} {...props} run={paused} />);
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
  render(<TeamDetail workspaceStore={workspaceStore} run={fixture()} busy={false} onBack={vi.fn()} onExecute={vi.fn()}
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
  render(<TeamsRoute services={{ workspaceStore, teamStore: api, workspaceRegistryStore: registry }} onOpenThread={vi.fn()} onNavigate={vi.fn()} />);
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
  const view = render(<TeamDetail workspaceStore={workspaceStore} {...props} />);
  await user.click(screen.getByRole("button", { name: "Edit plan" }));
  expect(screen.getAllByLabelText("Task title")[1]).toBeDisabled();
  const title = screen.getAllByLabelText("Task title")[0];
  await user.clear(title);
  await user.type(title, "New synthesis title");
  view.rerender(<TeamDetail workspaceStore={workspaceStore} {...props} run={{ ...run, revision: 2 }} />);
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
  const view = render(<TeamDetail workspaceStore={workspaceStore} {...props} />);
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
    <TeamDetail workspaceStore={workspaceStore} {...props} run={{ ...run, status: "completed" }} />,
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
      services={{ workspaceStore, teamStore: api, workspaceRegistryStore: registry }}
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
  await user.click(screen.getByRole("button", { name: "Configure members · 3" }));
  await user.click(screen.getByRole("checkbox", { name: "Analyst" }));
  await user.click(screen.getByRole("button", { name: "Edit Researcher" }));
  await user.clear(screen.getByRole("textbox", { name: "Display name" }));
  await user.type(screen.getByRole("textbox", { name: "Display name" }), "Lead researcher");
  await user.selectOptions(screen.getByRole("combobox", { name: "Tools" }), "review");
  await user.click(screen.getByRole("button", { name: "Done" }));
  await user.click(screen.getByRole("button", { name: "Generate plan" }));
  await screen.findByRole("button", { name: "Confirm and start" });
  expect(api.prepare).toHaveBeenCalledWith({
    spec: expect.objectContaining({
      goal: "Research tools",
      workspacePath: "D:/project",
      maxConcurrency: 2,
      members: [
        expect.objectContaining({ id: "research", displayName: "Lead researcher", toolProfile: "review" }),
        expect.objectContaining({ id: "editor", displayName: "Editor" }),
      ],
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
  render(<TeamDetail workspaceStore={workspaceStore} run={run} busy={false} onBack={() => {}} onExecute={() => {}} onControl={async () => {}} onRevise={async () => undefined} onOpenThread={open} />);
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
