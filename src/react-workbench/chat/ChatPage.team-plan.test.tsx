// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ChatEvent } from "../services";
import { chatTeamsApi } from "../teams/useChatTeamRun";
import { ChatPageUnderTest as ChatPage, createStores, sidecarBrowserRuntime, sidecarBrowserSnapshot } from "./test/ChatPageTestHarness";
import { recruitmentRun } from "./test/teamRecruitmentFixtures";
import { mainPlan, teamPlanTimeline } from "./test/teamPlanFixtures";
import { timelineFromReactMessages } from "./test/timelineFixtures";

vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function setup(withPlan = true) {
  let run = recruitmentRun();
  let timeline = teamPlanTimeline(run, withPlan ? mainPlan : null);
  const legacy = { ...run, id: "legacy", parentThreadId: null, spec: { ...run.spec, goal: "Independent archive" } };
  const other = { ...run, id: "other", parentThreadId: "another-chat", spec: { ...run.spec, goal: "Other conversation archive" } };
  vi.spyOn(chatTeamsApi, "get").mockImplementation(async id => id === legacy.id ? legacy : id === other.id ? other : run);
  vi.spyOn(chatTeamsApi, "list").mockResolvedValue([run, legacy, other]);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "worker_token_usage_details") return { groups: [], invocations: [], nextCursor: null };
    if (command !== "thread_get_turn_runtime_state") throw Error(`Unexpected ${command}`);
    return { status: "completed", timeline: { schemaVersion: "tinybot.timeline.v2", sessionId: "sources-worker", turnId: "worker-turn", snapshotRevision: 1, items: [] } };
  });
  const snapshot = sidecarBrowserSnapshot(); snapshot.data.sessionId = "recruitment-chat";
  const browserRuntime = sidecarBrowserRuntime(snapshot);
  const stores = createStores({ browserRuntime, sessions: [
    { id: "recruitment-chat", title: "Team research", updatedAtMs: 2, status: "running", workingDirectory: "/workspace" },
    { id: "second-chat", title: "Other chat", updatedAtMs: 1, status: "idle" },
  ] });
  const listeners = new Map<string, (event: ChatEvent) => void>();
  stores.chatStore.subscribe = vi.fn((id, listener) => { listeners.set(id, listener); return () => { listeners.delete(id); }; });
  stores.chatStore.load = vi.fn(async id => id === "recruitment-chat" ? timeline : timelineFromReactMessages(id, []));
  const props = { ...stores, workspaceStore: { readThreadFile: vi.fn().mockResolvedValue({ content: "Report", path: "report.md" }) } };
  const view = render(<ChatPage {...props} />);
  return { ...view, props, browserRuntime, setRun: (next: typeof run) => { run = next; }, run,
    listenerFor: (id: string) => listeners.get(id),
    update(next: typeof timeline, sessionId = "recruitment-chat") { timeline = next; act(() => listeners.get(sessionId)?.({ type: "timeline.patch", timeline: next })); } };
}
function heading() { return document.querySelector(".team-main-plan > summary") as HTMLElement | null; }
function toggle(details: HTMLDetailsElement) { details.open = !details.open; fireEvent(details, new Event("toggle")); }
async function openEmployee() {
  const card = await waitFor(() => { const element = document.querySelector(".chat-team-card"); expect(element).toBeTruthy(); return element as HTMLDetailsElement; });
  if (!card.open) toggle(card);
  fireEvent.click(await within(card).findByRole("button", { name: /Alex.*Collect sources/ }));
  await screen.findByRole("region", { name: "Team workspace" });
}
function expectFloating() {
  expect(heading()).toBeNull();
  expect(document.querySelector(".react-floating-plan")).not.toBeNull();
}

it("moves one plan entry with real Team visibility across subpages, resources and the hide animation", async () => {
  const user = userEvent.setup(); const { browserRuntime } = setup();
  await screen.findByRole("region", { name: "Task progress" });
  await openEmployee();
  expect(heading()?.textContent).toContain("Main task 1/4· Compare the designs");
  expect(document.querySelector(".react-floating-plan")).toBeNull();
  toggle(heading()!.parentElement as HTMLDetailsElement);
  expect(within(heading()!.parentElement!).getByText(mainPlan.explanation!)).toBeTruthy();
  for (const tab of ["Files", "Usage", "Tasks"]) {
    await user.click(screen.getByRole("tab", { name: tab }));
    expect(heading()?.textContent).toContain("Main task 1/4");
    expect(document.querySelector(".react-floating-plan")).toBeNull();
  }
  await user.click(screen.getByRole("link", { name: "research report" }));
  await screen.findByRole("tab", { name: "report.md" }); expectFloating();
  await user.click(screen.getByRole("tab", { name: "Team workspace" }));
  expect(heading()).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));
  await user.click(screen.getByRole("menuitem", { name: /Browser/ }));
  await screen.findByRole("tab", { name: "Example" }); expectFloating();
  await user.click(screen.getByRole("tab", { name: "Team workspace" }));
  expect(heading()).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "New Sidecar tab" }));
  await user.click(screen.getByRole("menuitem", { name: /Terminal/ }));
  await user.click(screen.getByRole("menuitem", { name: "PowerShell" })); expectFloating();
  await user.click(screen.getByRole("tab", { name: "Team workspace" }));
  const sidecar = screen.getByRole("complementary", { name: "Sidecar" });
  let finish!: () => void;
  const animation = { transitionProperty: "transform", playState: "running", finished: new Promise<void>(resolve => { finish = resolve; }) };
  Object.defineProperty(sidecar, "getAnimations", { value: () => [animation] });
  await user.click(screen.getByRole("button", { name: "Hide Sidecar" }));
  expectFloating();
  expect(sidecar.getAttribute("aria-hidden")).toBe("true");
  await act(async () => { animation.playState = "finished"; finish(); });
  await openEmployee(); expect(heading()).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Close Team workspace tab" })); expectFloating();
  expect(browserRuntime.closeSession).not.toHaveBeenCalled();
});

it("keeps unrelated history and other conversations from borrowing the main plan, including reload", async () => {
  const user = userEvent.setup(); const view = setup(); await openEmployee();
  for (const name of ["Independent archive", "Other conversation archive"]) {
    toggle(document.querySelector(".chat-team-history") as HTMLDetailsElement);
    await user.click(await screen.findByRole("button", { name: new RegExp(name) })); expectFloating();
  }
  await openEmployee(); expect(heading()).not.toBeNull();
  const latePreviousSessionEvent = view.listenerFor("recruitment-chat");
  await user.click(within(screen.getByLabelText("Sessions")).getByRole("button", { name: "Other chat" }));
  await waitFor(() => expect(view.props.chatStore.load).toHaveBeenLastCalledWith("second-chat"));
  act(() => latePreviousSessionEvent?.({ type: "timeline.patch", timeline: teamPlanTimeline(view.run) }));
  expect(heading()).toBeNull(); expect(document.querySelector(".react-floating-plan")).toBeNull();
  await user.click(within(screen.getByLabelText("Sessions")).getByRole("button", { name: "Team research" }));
  await waitFor(() => expect(heading()).not.toBeNull());
  view.unmount(); render(<ChatPage {...view.props} />);
  await screen.findByRole("region", { name: "Task progress" });
  await openEmployee(); expect(heading()?.textContent).toContain("Main task 1/4");
});

it("uses canonical revisions and terminal states while employee completion does not change main progress", async () => {
  const view = setup(); await openEmployee();
  const completedEmployees = { ...view.run, revision: 10, tasks: view.run.tasks.map(record => ({ ...record, status: "succeeded" as const })) };
  view.setRun(completedEmployees);
  fireEvent.click(screen.getByRole("button", { name: "Hide Sidecar" })); await openEmployee();
  expect(heading()?.textContent).toContain("Main task 1/4");
  const revised = { ...mainPlan, total: 5, steps: [...mainPlan.steps, { step: "Publish references", status: "pending" as const }] };
  view.update(teamPlanTimeline(view.run, revised, "running", 2));
  await waitFor(() => expect(heading()?.textContent).toContain("Main task 1/5"));
  for (const [status, label] of [["failed", "Failed"], ["interrupted", "Cancelled"]]) {
    view.update(teamPlanTimeline(view.run, revised, status, 3));
    await waitFor(() => expect(heading()?.textContent).toContain(label));
    expect(heading()?.textContent).not.toContain(mainPlan.currentStep);
  }
  const pending = { ...revised, currentStep: undefined, steps: revised.steps.map(step => step.status === "in_progress" ? { ...step, status: "pending" as const } : step) };
  view.update(teamPlanTimeline(view.run, pending, "running", 4));
  await waitFor(() => expect(heading()?.textContent).toContain("No step in progress"));
  const done = { ...revised, completed: 5, currentStep: undefined, steps: revised.steps.map(step => ({ ...step, status: "completed" as const })) };
  view.update(teamPlanTimeline(view.run, done, "completed", 5));
  await waitFor(() => expect(heading()?.textContent).toContain("Main task 5/5· Completed"));
});

it("renders no progress count without a real plan and reacts when one is added", async () => {
  const view = setup(false); await openEmployee();
  expect(heading()).toBeNull(); expect(document.querySelector(".react-floating-plan")).toBeNull();
  view.update(teamPlanTimeline(view.run));
  await waitFor(() => expect(heading()?.textContent).toContain("Main task 1/4"));
  expect(document.querySelector(".react-floating-plan")).toBeNull();
});
