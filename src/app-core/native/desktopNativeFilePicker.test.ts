import { describe, expect, test, vi } from "vitest";

import { createDesktopNativeFilePicker } from "./desktopNativeFilePicker";

describe("desktop native file picker", () => {
  test("returns native file metadata without reading file contents", async () => {
    const selected = [{
      name: "notes.md",
      path: "C:\\Users\\tester\\notes.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
    }];
    const invokeMock = vi.fn(async () => selected);
    const invoke = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

    await expect(createDesktopNativeFilePicker({ invoke })()).resolves.toEqual(selected);
    expect(invokeMock).toHaveBeenCalledWith("pick_chat_files", {
      options: { title: "Select files" },
    });
  });
});
