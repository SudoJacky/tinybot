// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as teamsApi from "../../app-core/native/desktopNativeTeams";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { WorkspaceStore } from "../services";
import { TeamFiles } from "./TeamFiles";
import { TeamMessage } from "./TeamMessage";
import { acceptRevision, canExecute, orderedTasks, taskState } from "./teamPresentation";

vi.mock("../chat/AssistantMarkdown", () => ({ AssistantMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));
afterEach(cleanup);
const workspaceStore = { readThreadFile: vi.fn(), readThreadFileBytes: vi.fn() } as unknown as WorkspaceStore;

function run(): TeamRun {
  return {
    schemaVersion: 2, id: "team", revision: 1, parentThreadId: null, status: "completed",
    spec: { goal: "Research", workspacePath: "D:/project", maxConcurrency: 1,
      members: [{ id: "researcher", displayName: "Researcher", instructions: "Gather evidence" }] },
    finalTaskId: "final", createdAt: "2026-09-16", updatedAt: "2026-09-16", error: null,
    tasks: [
      { task: { id: "final", title: "Synthesize", memberId: "researcher", instructions: "Report", dependencies: ["source"] }, status: "pending", attempts: [] },
      { task: { id: "source", title: "Collect sources", memberId: "researcher", instructions: "Find sources", dependencies: [] }, status: "succeeded", attempts: [
        { threadId: "earlier", turnId: "old-turn", status: "failed", startedAt: "2026-09-16", finishedAt: "2026-09-16", error: "Old failure", output: null,
          message: { summary: "Old evidence", unresolved: "", sequence: 1, artifacts: [{ path: "earlier.txt", sha256: "old", bytes: 4 }] } },
        { threadId: "latest", turnId: "new-turn", status: "succeeded", startedAt: "2026-09-17", finishedAt: "2026-09-17", error: null, output: "Evidence ready",
          message: { summary: "Evidence ready", unresolved: "Verify pagination", sequence: 2, artifacts: [{ path: "evidence.txt", sha256: "abc", bytes: 100000 }] } },
      ] },
    ],
  };
}

it("preserves dependency and status projection used by the Chat team panel", () => {
  const current = run();
  expect(orderedTasks(current.tasks).map(record => record.task.id)).toEqual(["source", "final"]);
  current.status = "running";
  expect(taskState(current, current.tasks[0])).toBe("queued");
  current.tasks[1].status = "pending";
  expect(taskState(current, current.tasks[0])).toBe("blocked");
  expect(acceptRevision([{ ...current, revision: 3 }], current)[0].revision).toBe(3);
  current.status = "cancelled";
  expect(canExecute(current)).toBe(false);
  current.tasks[1].task.dependencies = ["final"];
  expect(() => orderedTasks(current.tasks)).toThrow("dependency graph");
});

it("keeps historical files folded and loads verified artifact bytes only on request", async () => {
  const read = vi.spyOn(teamsApi, "readTeamArtifact").mockResolvedValue({
    text: "data", byteOffset: 0, nextByteOffset: null, totalBytes: 4, path: "earlier.txt", sha256: "old",
  });
  try {
    const onOpenThread = vi.fn();
    render(<TeamFiles run={run()} workspaceStore={workspaceStore} onSelectTask={vi.fn()} onOpenThread={onOpenThread} />);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "evidence.txt" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "earlier.txt" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByText("Earlier attempts (1)"));
    await user.click(screen.getByRole("button", { name: "earlier.txt" }));
    expect(read).toHaveBeenCalledWith("team", "earlier", 0, 0);
    expect(await screen.findByText("data")).toBeVisible();
    await user.click(within(screen.getByRole("button", { name: "earlier.txt" }).closest("article")!).getByRole("button", { name: "Open execution record" }));
    expect(onOpenThread).toHaveBeenCalledWith("earlier");
  } finally { read.mockRestore(); }
});

it("shows a saved handoff and clears a stale artifact page after verification fails", async () => {
  const attempt = run().tasks[1].attempts[1];
  const read = vi.spyOn(teamsApi, "readTeamArtifact")
    .mockResolvedValueOnce({ text: "first", byteOffset: 0, nextByteOffset: 5, totalBytes: 100000, path: "evidence.txt", sha256: "abc" })
    .mockRejectedValueOnce(new Error("Artifact changed since publication"));
  try {
    render(<TeamMessage runId="team" attempt={attempt} workspacePath="D:/project" workspaceStore={workspaceStore} />);
    const user = userEvent.setup();
    expect(screen.getByText("Evidence ready")).toBeVisible();
    expect(screen.getByText(/Verify pagination/)).toBeVisible();
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "evidence.txt" }));
    expect(await screen.findByText("first")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next section" }));
    expect(read).toHaveBeenLastCalledWith("team", "latest", 0, 5);
    expect(await screen.findByRole("alert")).toHaveTextContent("Artifact changed");
    expect(screen.queryByText("first")).toBeNull();
  } finally { read.mockRestore(); }
});
