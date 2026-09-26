// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatTeamRun } from "./useChatTeamRun";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("observes later recruitment waves in a completed run and stops reading when closed", async () => {
  vi.useFakeTimers();
  const completed = { id: "team-1", status: "completed", revision: 1 } as TeamRun;
  const recruited = { ...completed, status: "running", revision: 2 } as TeamRun;
  const load = vi.fn().mockResolvedValueOnce(completed).mockResolvedValue(recruited);
  const { result, rerender } = renderHook(({ open }) => useChatTeamRun("team-1", open, load), { initialProps: { open: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.run?.status).toBe("completed");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.run?.revision).toBe(2);
  rerender({ open: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(2);
});

it("does not let an older poll overwrite a newer control snapshot", async () => {
  let resolvePoll!: (run: TeamRun) => void;
  const poll = new Promise<TeamRun>(resolve => { resolvePoll = resolve; });
  const old = { id: "team-1", status: "running", revision: 4 } as TeamRun;
  const newer = { ...old, status: "paused", revision: 5 } as TeamRun;
  const { result } = renderHook(() => useChatTeamRun(old.id, true, () => poll));
  act(() => result.current.accept(newer));
  await act(async () => resolvePoll(old));
  expect(result.current.run).toMatchObject({ revision: 5, status: "paused" });
});

it("keeps a load failure with its run while another run starts loading", async () => {
  let rejectB!: (reason: Error) => void;
  const load = vi.fn((id: string) => id === "a" ? Promise.reject(new Error("A unavailable"))
    : new Promise<TeamRun>((_, reject) => { rejectB = reject; }));
  const { result, rerender } = renderHook(({ id }) => useChatTeamRun(id, true, load), { initialProps: { id: "a" } });
  await waitFor(() => expect(result.current.error).toContain("A unavailable"));
  rerender({ id: "b" });
  expect(result.current.error).toBeUndefined();
  await act(async () => rejectB(new Error("B unavailable")));
  expect(result.current.error).toContain("B unavailable");
});
