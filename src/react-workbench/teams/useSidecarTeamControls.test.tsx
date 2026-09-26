// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamRun, TeamStore } from "../../app-core/native/desktopNativeTeams";
import { useSidecarTeamControls } from "./useSidecarTeamControls";

afterEach(cleanup);
const run = (id: string, status: TeamRun["status"] = "running"): TeamRun => ({
  id, status, revision: 4, schemaVersion: 3, parentThreadId: null, createdAt: "", updatedAt: "", error: null,
  finalTaskId: "task", spec: { goal: id, workspacePath: "/work", maxConcurrency: 1, members: [] },
  tasks: [{ task: { id: "task", title: "Task", memberId: "member", instructions: "", dependencies: [] }, status: "pending", attempts: [] }],
});

it("keeps pause and cancel available while the long execute request is running, and prevents duplicate controls", async () => {
  let finishExecute!: (value: TeamRun) => void;
  let finishPause!: (value: TeamRun) => void;
  const store = {
    execute: vi.fn(() => new Promise<TeamRun>(resolve => { finishExecute = resolve; })),
    control: vi.fn(() => new Promise<TeamRun>(resolve => { finishPause = resolve; })),
  } as unknown as TeamStore;
  const accept = vi.fn();
  const refresh = vi.fn();
  const planned = run("a", "planned");
  const running = run("a", "running");
  const { result, rerender } = renderHook(({ value }) => useSidecarTeamControls(value, store, accept, refresh), {
    initialProps: { value: planned },
  });
  act(() => result.current.execute());
  expect(store.execute).toHaveBeenCalledOnce();
  rerender({ value: running });
  await act(async () => {
    const first = result.current.control("pause");
    const duplicate = result.current.control("pause");
    expect(store.control).toHaveBeenCalledOnce();
    finishPause(running);
    await Promise.all([first, duplicate]);
  });
  expect(result.current.pending).toBe("pause");
  expect(result.current.busy).toBe(false);
  expect(store.execute).toHaveBeenCalledOnce();
  await act(async () => {
    const cancel = result.current.control("cancel");
    finishPause(running);
    await cancel;
  });
  expect(store.control).toHaveBeenCalledTimes(2);
  await act(async () => finishExecute(run("a", "paused")));
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps a late failure with its original run after switching to another run", async () => {
  let rejectPause!: (reason: Error) => void;
  const store = { control: vi.fn(() => new Promise<TeamRun>((_, reject) => { rejectPause = reject; })) } as unknown as TeamStore;
  const accept = vi.fn();
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ value }) => useSidecarTeamControls(value, store, accept, refresh), {
    initialProps: { value: run("a") },
  });
  let request!: Promise<void>;
  act(() => { request = result.current.control("pause"); });
  rerender({ value: run("b") });
  await act(async () => { rejectPause(new Error("A failed")); await request; });
  expect(result.current.error).toBeUndefined();
  expect(result.current.busy).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  rerender({ value: run("a") });
  expect(result.current.error).toContain("A failed");
});

it("does not restore a pending pause from an older running response after polling sees paused", async () => {
  let finishPause!: (value: TeamRun) => void;
  const store = { control: vi.fn(() => new Promise<TeamRun>(resolve => { finishPause = resolve; })) } as unknown as TeamStore;
  const initial = run("a");
  const { result, rerender } = renderHook(({ value }) => useSidecarTeamControls(value, store, vi.fn(), vi.fn()), {
    initialProps: { value: initial },
  });
  let request!: Promise<void>;
  act(() => { request = result.current.control("pause"); });
  rerender({ value: { ...initial, revision: 5, status: "paused" } });
  await act(async () => { finishPause(initial); await request; });
  expect(result.current.pending).toBeUndefined();
  expect(result.current.busy).toBe(false);
});

it("allows only an explicit idle failed-task retry and never requeues successful work", async () => {
  const failed = run("a", "failed");
  failed.tasks.push({ task: { id: "failed", title: "Failed", memberId: "member", instructions: "", dependencies: [] }, status: "failed", attempts: [] });
  failed.tasks[0].status = "succeeded";
  const store = { control: vi.fn(async () => ({ ...failed, status: "paused", revision: 5 })) } as unknown as TeamStore;
  const { result } = renderHook(() => useSidecarTeamControls(failed, store, vi.fn(), vi.fn()));
  await act(async () => { await result.current.control("retry", ["task"]); });
  expect(store.control).not.toHaveBeenCalled();
  await act(async () => { await result.current.control("retry", ["failed"]); });
  expect(store.control).toHaveBeenCalledExactlyOnceWith({ runId: "a", expectedRevision: 4, action: "retry", taskIds: ["failed"] });
});
