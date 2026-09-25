// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { SidecarResources } from "../sidecar/SidecarResources";
import { createStores, sidecarBrowserRuntime } from "../chat/test/ChatPageTestHarness";

const browserRuntime = sidecarBrowserRuntime();
const stores = createStores({ browserRuntime });
function Workspace({ sessionId, loadRun, loadAttempt, teamsStore, children }: {
  sessionId: string; children: ReactNode;
  loadRun: ComponentProps<typeof SidecarResources>["loadTeamRun"];
  loadAttempt: ComponentProps<typeof SidecarResources>["loadTeamAttempt"];
  teamsStore?: ComponentProps<typeof SidecarResources>["teamsStore"];
}) {
  const session = { id: sessionId, title: "Research", updatedAtMs: 0 };
  return <SidecarResources activeSessionId={sessionId} activeSession={session} activeDisplaySession={session}
    chatStore={stores.chatStore} workspaceStore={{ readThreadFile: vi.fn() }} artifactReviewEpoch={0} sessionResponding={false}
    onLayoutChange={vi.fn()} onHide={vi.fn()} onReference={vi.fn()} onAskForSpreadsheetChange={vi.fn()} onHandoff={vi.fn()}
    onError={vi.fn()} loadTeamRun={loadRun} loadTeamAttempt={loadAttempt} teamsStore={teamsStore}>{children}</SidecarResources>;
}
import { ChatTeamCard, recruitedRunId } from "./ChatTeamCard";
import { ChatTeamHistory } from "./ChatTeamHistory";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";

afterEach(cleanup);
const run: TeamRun = {
  id:"team-1-1",schemaVersion:3,revision:4,parentThreadId:"parent",finalTaskId:"",status:"completed",error:null,createdAt:"",updatedAt:"",
  spec:{goal:"Research",workspacePath:"/workspace",maxConcurrency:2,members:[{id:"a",displayName:"Alice",instructions:"Verify all sources"},{id:"b",displayName:"Bob",instructions:"Compare findings"}]},
  tasks:["a","b"].map((id)=>({task:{id,title:`Research ${id}`,memberId:id,instructions:"Write a report",dependencies:[]},status:"succeeded",attempts:[{threadId:`team-1-1-${id}-1`,turnId:`turn-${id}`,status:"succeeded",startedAt:"",finishedAt:"",output:"Done",error:null}]})),
};

it("loads the board only on expansion and only the selected employee conversation", async () => {
  const loadRun=vi.fn().mockResolvedValue(run);
  const loadAttempt=vi.fn().mockResolvedValue([{id:"report",kind:"message",text:"Verified research",status:"completed"}]);
  const {container}=render(<Workspace sessionId="parent" loadRun={loadRun} loadAttempt={loadAttempt}><main><ChatTeamCard runId={run.id} loadRun={loadRun} /></main></Workspace>);
  expect(loadRun).not.toHaveBeenCalled();
  expect(loadAttempt).not.toHaveBeenCalled();
  const details=container.querySelector("details")!;
  details.open=true;
  fireEvent(details,new Event("toggle"));
  await screen.findByRole("button",{name:/Alice/});
  expect(loadRun).toHaveBeenCalledOnce();
  expect(loadAttempt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:/Alice/}));
  await screen.findByText("Verified research");
  expect(loadAttempt).toHaveBeenCalledExactlyOnceWith("team-1-1-a-1","turn-a");
  const panel=screen.getByRole("complementary");
  expect(panel.contains(screen.getByText("Verified research"))).toBe(true);
  fireEvent.click(panel.querySelectorAll("nav button")[1]);
  await waitFor(()=>expect(loadAttempt).toHaveBeenLastCalledWith("team-1-1-b-1","turn-b"));
  fireEvent.keyDown(screen.getByRole("region", { name: "Team workspace" }),{key:"Escape"});
  await waitFor(()=>expect(screen.queryByRole("complementary")).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole("button",{name:/Alice/})));
});

it("recognizes only recruitment results and preserves native result envelopes",()=>{
  expect(recruitedRunId({id:"tool",name:"team.recruit",resultJson:{raw:{runId:run.id,tasks:[]}}})).toBe(run.id);
  expect(recruitedRunId({id:"tool",name:"read_file",resultJson:{raw:{runId:run.id,tasks:[]}}})).toBeUndefined();
});

it("discards late employee reads and closes inspection when switching conversations", async () => {
  const loadRun = vi.fn().mockResolvedValue(run);
  type Items = Awaited<ReturnType<NonNullable<Parameters<typeof Workspace>[0]["loadAttempt"]>>>;
  const pending = new Map<string, (items: Items) => void>();
  const loadAttempt = vi.fn((threadId: string) => new Promise<Items>(resolve => pending.set(threadId, resolve)));
  const props = { workspaceStore: { readThreadFile: vi.fn() }, sidecarPresentation: "closed", onHideSidecar: vi.fn(), loadRun, loadAttempt };
  const { container, rerender } = render(<Workspace {...props} sessionId="parent"><ChatTeamCard runId={run.id} loadRun={loadRun} /></Workspace>);
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  await waitFor(() => expect(pending.has("team-1-1-a-1")).toBe(true));
  fireEvent.click(screen.getByRole("complementary").querySelectorAll("nav button")[1]);
  await waitFor(() => expect(pending.has("team-1-1-b-1")).toBe(true));
  pending.get("team-1-1-a-1")!([{ id: "a", kind: "message", text: "Stale Alice record", status: "completed" }]);
  pending.get("team-1-1-b-1")!([{ id: "b", kind: "message", text: "Current Bob record", status: "completed" }]);
  await screen.findByText("Current Bob record");
  expect(screen.queryByText("Stale Alice record")).toBeNull();
  rerender(<Workspace {...props} sessionId="different-conversation"><p>New conversation</p></Workspace>);
  expect(screen.queryByRole("tab", { name: "Team workspace" })).toBeNull();
});


it("shares tabs, expansion and hide controls with Browser while retaining the selected employee", async () => {
  const loadRun = vi.fn().mockResolvedValue(run);
  const loadAttempt = vi.fn().mockImplementation(async (threadId: string) => [
    { id: "report", kind: "message", text: `Report from ${threadId}`, status: "completed" },
  ]);
  const { container } = render(<Workspace sessionId="s1" loadRun={loadRun} loadAttempt={loadAttempt}>
    <ChatTeamCard runId={run.id} loadRun={loadRun} />
  </Workspace>);
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  await screen.findByText("Report from team-1-1-a-1");
  fireEvent.click(screen.getByRole("button", { name: /View Bob/ }));
  await screen.findByText("Report from team-1-1-b-1");
  expect(screen.getAllByRole("complementary")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Expand Sidecar" }));
  expect(container.querySelector(".react-chat-workspace")?.getAttribute("data-sidecar-presentation")).toBe("expanded");
  fireEvent.click(screen.getByRole("button", { name: "Restore Sidecar" }));
  fireEvent.click(screen.getByRole("button", { name: "New Sidecar tab" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Browser/ }));
  await waitFor(() => expect(browserRuntime.createSession).toHaveBeenCalled());
  expect(screen.queryByRole("region", { name: "Team workspace" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Team workspace" }));
  await screen.findByText("Report from team-1-1-b-1");
  expect(browserRuntime.closeSession).not.toHaveBeenCalled();
  expect(browserRuntime.closeTab).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
  expect(Number(screen.getByRole("separator").getAttribute("aria-valuenow"))).toBeGreaterThan(520);
  fireEvent.click(screen.getByRole("button", { name: "Hide Sidecar" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
  await screen.findByText("Report from team-1-1-a-1");
  expect(screen.getAllByRole("tab", { name: "Team workspace" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Close Team workspace tab" }));
  expect(screen.queryByRole("tab", { name: "Team workspace" })).toBeNull();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(browserRuntime.closeSession).not.toHaveBeenCalled();
});

it("opens a legacy independent run from an empty Chat without changing its ownership", async () => {
  const legacy = { ...run, id: "legacy", parentThreadId: null };
  const loadRun = vi.fn().mockResolvedValue(legacy);
  const loadAttempt = vi.fn().mockResolvedValue([{ id: "old", kind: "message", text: "Saved worker result", status: "completed" }]);
  const loadRuns = vi.fn().mockResolvedValue([legacy]);
  const { container } = render(<Workspace sessionId="" loadRun={loadRun} loadAttempt={loadAttempt}>
    <ChatTeamHistory sessionId="" loadRuns={loadRuns} />
  </Workspace>);
  const history = container.querySelector(".chat-team-history") as HTMLDetailsElement;
  history.open = true;
  fireEvent(history, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Research.*Independent team run/ }));
  await screen.findByText("Saved worker result");
  expect(legacy.parentThreadId).toBeNull();
  expect(loadAttempt).toHaveBeenCalledExactlyOnceWith("team-1-1-a-1", "turn-a");
  expect(screen.getByRole("tab", { name: "Team workspace" })).toBeTruthy();
});

it("opens historical artifact records inside the Sidecar attempt view", async () => {
  const historyRun = structuredClone(run);
  historyRun.tasks[0].attempts.unshift({
    threadId: "old-thread", turnId: "old-turn", status: "failed", startedAt: "", finishedAt: "", output: null,
    error: "Old attempt failed", message: { summary: "", unresolved: "", sequence: 1,
      artifacts: [{ path: "report.md", bytes: 5, sha256: "hash" }] },
  });
  const loadRun = vi.fn().mockResolvedValue(historyRun);
  const loadAttempt = vi.fn().mockImplementation(async (threadId: string) => [
    { id: threadId, kind: "message", text: `Record ${threadId}`, status: "completed" },
  ]);
  const { container } = render(<Workspace sessionId="parent" loadRun={loadRun} loadAttempt={loadAttempt}>
    <ChatTeamCard runId={historyRun.id} loadRun={loadRun} />
  </Workspace>);
  const card = container.querySelector(".chat-team-card") as HTMLDetailsElement;
  card.open = true;
  fireEvent(card, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
  await screen.findByText("Record team-1-1-a-1");
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  const earlier = screen.getByText("Earlier attempts (1)").closest("details") as HTMLDetailsElement;
  earlier.open = true;
  fireEvent(earlier, new Event("toggle"));
  fireEvent.click(screen.getByRole("button", { name: "Open execution record" }));
  await screen.findByText("Record old-thread");
  expect(loadAttempt).toHaveBeenLastCalledWith("old-thread", "old-turn");
  expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps an in-flight control response with its own run when opening another history row", async () => {
  const first = structuredClone(run);
  first.id = "run-a";
  first.status = "running";
  first.spec.goal = "Goal A";
  first.tasks[0].task.title = "A task";
  const second = structuredClone(run);
  second.id = "run-b";
  second.status = "running";
  second.spec.goal = "Goal B";
  second.tasks[0].task.title = "B task";
  let resolvePause!: (value: TeamRun) => void;
  const control = vi.fn(() => new Promise<TeamRun>(resolve => { resolvePause = resolve; }));
  const loadRun = vi.fn(async (id: string) => id === first.id ? first : second);
  const loadAttempt = vi.fn().mockResolvedValue([]);
  const { container } = render(<Workspace sessionId="parent" loadRun={loadRun} loadAttempt={loadAttempt}
    teamsStore={{ control } as unknown as ComponentProps<typeof SidecarResources>["teamsStore"]}>
    <ChatTeamHistory sessionId="parent" loadRuns={async () => [first, second]} />
  </Workspace>);
  const history = container.querySelector(".chat-team-history") as HTMLDetailsElement;
  history.open = true;
  fireEvent(history, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Goal A.*This conversation/ }));
  await screen.findByText("A task");
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(control).toHaveBeenCalledOnce();
  history.open = true;
  fireEvent(history, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Goal B.*This conversation/ }));
  await screen.findByText("B task");
  await act(async () => resolvePause({ ...first, status: "paused", revision: first.revision + 1 }));
  expect(screen.getByText("B task")).toBeTruthy();
  expect(screen.queryByText("Pausing…")).toBeNull();
  history.open = true;
  fireEvent(history, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: /Goal A.*This conversation/ }));
  await screen.findByText("A task");
  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
});
