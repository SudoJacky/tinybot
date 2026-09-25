// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStep } from "../../app-core/chat/chatTurnContracts";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";
import type { ChatEvent } from "../services";
import { projectTeamActivity, useTeamActivity } from "./useTeamActivity";

afterEach(cleanup);
function timeline(threadId: string, text: string): ChatTimelineSnapshot {
  return {
    schemaVersion: "tinybot.chat_timeline.v1", sessionId: threadId, source: "canonical", turnRevisions: {}, diagnostics: [],
    turns: [{ id: "turn", sessionKey: threadId, status: "running", startedAt: "", updatedAt: "", userMessageId: "user",
      userMessage: { id: "user", role: "user", text: "private instructions", timestamp: "" },
      steps: [{ id: "step", kind: "message", title: "Update", summary: text, sequence: 1, status: "running", agentContext: { id: "main", title: "Agent", type: "main" } }],
    }],
  };
}
function run(threadId = "worker"): TeamRun {
  return { id: "run", schemaVersion: 2, revision: 1, finalTaskId: "task", status: "running", createdAt: "", updatedAt: "", error: null,
    spec: { goal: "Research", workspacePath: "D:/work", members: [], maxConcurrency: 1 },
    tasks: [{ task: { id: "task", title: "Research", instructions: "", memberId: "a", dependencies: [] }, status: "running",
      attempts: [{ threadId, turnId: "turn", status: "running", startedAt: "", finishedAt: null, output: null, error: null }],
    }],
  };
}
it("keeps live activity ahead of a late initial read and unsubscribes old attempts", async () => {
  const listeners = new Map<string, (event: ChatEvent) => void>();
  let resolve!: (value: ChatTimelineSnapshot) => void;
  const source = {
    readTimeline: vi.fn((id: string) => id === "worker"
      ? new Promise<ChatTimelineSnapshot>((done) => { resolve = done; })
      : Promise.resolve(timeline(id, "Retry progress"))),
    subscribe: vi.fn((id: string, listener: (event: ChatEvent) => void) => {
      listeners.set(id, listener); return () => { listeners.delete(id); };
    }),
  };
  const view = renderHook(({ value }) => useTeamActivity(source, value, "task"), { initialProps: { value: run() } });
  act(() => listeners.get("worker")!({ type: "timeline.patch", timeline: timeline("worker", "Live progress") }));
  await act(async () => resolve(timeline("worker", "Old progress")));
  await waitFor(() => expect(view.result.current.activity.worker?.items[0].text).toBe("Live progress"));
  view.rerender({ value: run("retry") });
  expect(listeners.has("worker")).toBe(false);
  await waitFor(() => expect(view.result.current.activity.retry?.items[0].text).toBe("Retry progress"));
  view.unmount();
  expect(listeners.size).toBe(0);
});
it("surfaces load and stream failures and allows an explicit refresh", async () => {
  let receive!: (event: ChatEvent) => void;
  const source = {
    readTimeline: vi.fn().mockRejectedValueOnce(new Error("Read failed")).mockResolvedValue(timeline("worker", "Recovered")),
    subscribe: vi.fn((_id: string, listener: (event: ChatEvent) => void) => { receive = listener; return vi.fn(); }),
  };
  const { result } = renderHook(() => useTeamActivity(source, run(), "task"));
  await waitFor(() => expect(result.current.activity.worker?.error).toContain("Read failed"));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.activity.worker?.items[0].text).toBe("Recovered"));
  expect(result.current.activity.worker.error).toBeUndefined();
  act(() => receive({ type: "timeline.error", error: "Stream failed" }));
  await waitFor(() => expect(result.current.activity.worker.error).toBe("Stream failed"));
});
it("reads only running or inspected attempts and retains recorded reasoning and tool details for the selected turn", async () => {
  const current = run();
  current.tasks.push({ ...current.tasks[0], task: { ...current.tasks[0].task, id: "history" }, status: "succeeded",
    attempts: [{ ...current.tasks[0].attempts[0], threadId: "history", status: "succeeded" }],
  });
  const source = { readTimeline: vi.fn(async (id: string) => timeline(id, "Progress")), subscribe: vi.fn(() => vi.fn()) };
  const view = renderHook(({ selected }) => useTeamActivity(source, current, selected), { initialProps: { selected: "task" } });
  await waitFor(() => expect(source.readTimeline).toHaveBeenCalledTimes(1));
  expect(source.readTimeline).toHaveBeenCalledWith("worker");
  view.rerender({ selected: "history" });
  await waitFor(() => expect(source.readTimeline).toHaveBeenCalledWith("history"));
  const snapshot = timeline("worker", "Public progress");
  snapshot.turns[0].steps.push({ ...snapshot.turns[0].steps[0], id: "reasoning", kind: "reasoning", summary: "Recorded reasoning" });
  snapshot.turns.push({ ...snapshot.turns[0], id: "other" });
  expect(projectTeamActivity(snapshot, "turn").map((item) => item.text)).toEqual(["Public progress", "Recorded reasoning"]);
  const tool = { ...snapshot.turns[0].steps[0], id: "tool", kind: "tool_call", toolCall: { id: "call", name: "read_file", argsJson: { path: "report.txt" }, resultPreview: "File contents", durationMs: 300 } } satisfies ChatStep;
  snapshot.turns[0].steps.push(tool);
  expect(projectTeamActivity(snapshot, "turn")[2].toolCall).toEqual(tool.toolCall);
  expect(JSON.stringify(projectTeamActivity(snapshot, "turn"))).not.toContain("private instructions");
  expect(projectTeamActivity(snapshot, "missing")).toEqual([]);
});

it("retains full public messages and older activity for reading on demand", () => {
  const text = "Verified detail. ".repeat(100);
  const snapshot = timeline("worker", text);
  snapshot.turns[0].steps = Array.from({ length: 60 }, (_, index) => ({
    ...snapshot.turns[0].steps[0], id: String(index), sequence: index,
  }));
  const activity = projectTeamActivity(snapshot, "turn");
  expect(activity).toHaveLength(60);
  expect(activity[0].text).toBe(text);
});
