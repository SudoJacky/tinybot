// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionSearch } from "./useSessionSearch";
import type { SessionSearchResults } from "../services";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("debounces requests and ignores an older response after the query changes", async () => {
  vi.useFakeTimers();
  let finish!: (value: SessionSearchResults) => void;
  const search = vi.fn().mockImplementationOnce(() => new Promise<SessionSearchResults>((resolve) => { finish = resolve; }))
    .mockResolvedValue({ hits: [{ session: { id: "new", title: "Latest", updatedAtMs: 1 }, turnId: "turn", snippet: "new content" }], hasMore: false });
  const { result, rerender } = renderHook(({ query }) => useSessionSearch(query, search), { initialProps: { query: "old" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  rerender({ query: "new" });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(result.current.results?.hits[0].session.id).toBe("new");
  await act(async () => { finish({ hits: [], hasMore: false }); });
  expect(result.current.results?.hits[0].session.id).toBe("new");
  rerender({ query: "" });
  expect(result.current.results).toBeUndefined();
  expect(result.current.pending).toBe(false);
});

it("shows a failed search and permits an explicit retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const search = vi.fn().mockRejectedValueOnce(new Error("Search unavailable")).mockResolvedValue({ hits: [], hasMore: false });
  const { result } = renderHook(() => useSessionSearch("report", search));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(result.current.error).toBe("Search unavailable");
  act(() => result.current.retry());
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(result.current.error).toBeUndefined();
  expect(result.current.results).toEqual({ hits: [], hasMore: false });
});
