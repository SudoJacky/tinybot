// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
  const {container}=render(<ChatTeamCard runId={run.id} loadRun={loadRun} loadAttempt={loadAttempt} />);
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
  details.open=false;
  fireEvent(details,new Event("toggle"));
  await waitFor(()=>expect(screen.queryByText("Verified research")).toBeNull());
});

it("recognizes only recruitment results and preserves native result envelopes",()=>{
  expect(recruitedRunId({id:"tool",name:"team.recruit",resultJson:{raw:{runId:run.id,tasks:[]}}})).toBe(run.id);
  expect(recruitedRunId({id:"tool",name:"read_file",resultJson:{raw:{runId:run.id,tasks:[]}}})).toBeUndefined();
});
