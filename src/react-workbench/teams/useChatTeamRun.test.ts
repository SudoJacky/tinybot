// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
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
