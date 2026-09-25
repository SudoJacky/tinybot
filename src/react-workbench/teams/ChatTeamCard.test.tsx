// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { SidecarResources } from "../sidecar/SidecarResources";
import { createStores, sidecarBrowserRuntime } from "../chat/test/ChatPageTestHarness";

const browserRuntime = sidecarBrowserRuntime();
const stores = createStores({ browserRuntime });
function Workspace({ sessionId, loadRun, loadAttempt, children }: {
  sessionId: string; children: ReactNode;
  loadRun: ComponentProps<typeof SidecarResources>["loadTeamRun"];
  loadAttempt: ComponentProps<typeof SidecarResources>["loadTeamAttempt"];
}) {
  const session = { id: sessionId, title: "Research", updatedAtMs: 0 };
  return <SidecarResources activeSessionId={sessionId} activeSession={session} activeDisplaySession={session}
    chatStore={stores.chatStore} workspaceStore={{ readThreadFile: vi.fn() }} artifactReviewEpoch={0} sessionResponding={false}
    onLayoutChange={vi.fn()} onHide={vi.fn()} onReference={vi.fn()} onAskForSpreadsheetChange={vi.fn()} onHandoff={vi.fn()}
    onError={vi.fn()} loadTeamRun={loadRun} loadTeamAttempt={loadAttempt}>{children}</SidecarResources>;
}
import { ChatTeamCard, recruitedRunId } from "./ChatTeamCard";
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
