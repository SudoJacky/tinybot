// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_REFRESH_INTERVAL_MS, useArtifactFile } from "./useArtifactFile";
import type { WorkspaceFileChunk } from "../services";

const artifact = { id: "workbook", title: "report.xlsx", fetchPath: "report.xlsx", kind: "file" };
const chunk = (revision: string, contentType: WorkspaceFileChunk["contentType"] = "binary"): WorkspaceFileChunk => ({ path: "report.xlsx", contentType, revision, sizeBytes: 4 });
const base = { artifact, enabled: true, threadId: "s1", unavailableMessage: "Unavailable", binaryMessage: "Unsupported" };
async function flush() { await act(async () => { await Promise.resolve(); }); }

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Local artifact observation", () => {
  it("polls conditionally without reloading unchanged Office bytes, then reloads the new revision", async () => {
    vi.useFakeTimers();
    const readThreadFile = vi.fn().mockResolvedValueOnce(chunk("v1")).mockResolvedValueOnce(chunk("v1", "unchanged")).mockResolvedValueOnce(chunk("v2"));
    const readThreadFileBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { result } = renderHook(() => useArtifactFile({ ...base, workspaceStore: { readThreadFile, readThreadFileBytes } }));
    await flush();
    const first = result.current.office;
    await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_INTERVAL_MS); });
    expect(result.current.office).toBe(first);
    expect(readThreadFileBytes).toHaveBeenCalledTimes(1);
    expect(readThreadFile).toHaveBeenLastCalledWith({ path: "report.xlsx", threadId: "s1", knownRevision: "v1" });
    await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_INTERVAL_MS); });
    expect(readThreadFileBytes).toHaveBeenLastCalledWith({ path: "report.xlsx", threadId: "s1", expectedRevision: "v2" });
    expect(result.current.revision).toBe("v2");
  });

  it("serializes slow reads and discards late results when the task changes", async () => {
    vi.useFakeTimers();
    let resolve!: (value: WorkspaceFileChunk) => void;
    const readThreadFile = vi.fn().mockImplementationOnce(() => new Promise<WorkspaceFileChunk>((done) => { resolve = done; })).mockResolvedValue(chunk("other-task", "text"));
    const workspaceStore = { readThreadFile };
    const { result, rerender } = renderHook(({ threadId }) => useArtifactFile({ ...base, threadId, workspaceStore }), { initialProps: { threadId: "s1" } });
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(9000); });
    expect(readThreadFile).toHaveBeenCalledTimes(1);
    rerender({ threadId: "s2" });
    await flush();
    await act(async () => { resolve(chunk("old-task", "text")); });
    expect(result.current.revision).toBe("other-task");
  });

  it("keeps the last preview with a visible error and recovers after a failed read", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readThreadFile = vi.fn().mockResolvedValueOnce(chunk("v1", "text")).mockRejectedValueOnce(new Error("File is locked")).mockResolvedValueOnce(chunk("v1", "unchanged"));
    const { result } = renderHook(() => useArtifactFile({ ...base, workspaceStore: { readThreadFile } }));
    await flush();
    const detail = result.current.detail;
    await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_INTERVAL_MS); });
    expect(result.current.error).toBe("File is locked");
    expect(result.current.detail).toBe(detail);
    await act(async () => { await vi.advanceTimersByTimeAsync(ARTIFACT_REFRESH_INTERVAL_MS); });
    expect(result.current.error).toBeUndefined();
  });

  it("stops reads while hidden and resumes when the window becomes visible", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const readThreadFile = vi.fn().mockResolvedValue(chunk("v1", "text"));
    const workspaceStore = { readThreadFile };
    const { rerender } = renderHook(({ enabled }) => useArtifactFile({ ...base, enabled, workspaceStore }), { initialProps: { enabled: true } });
    await flush();
    visibility.mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(readThreadFile).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(readThreadFile).toHaveBeenCalledTimes(2);
    rerender({ enabled: false });
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(9000); });
    expect(readThreadFile).toHaveBeenCalledTimes(2);
  });
});
