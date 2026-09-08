import { describe, expect, test, vi } from "vitest";
import type { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { createDesktopNativeFileImporter, createDesktopNativeFilePicker, MAX_IMPORTED_FILE_BYTES } from "./desktopNativeFilePicker";

describe("desktop native file picker", () => {
  test("imports Unicode filenames and exact binary contents, one file at a time", async () => {
    const files = [new File([new Uint8Array([0, 255, 12])], "截图.png"), new File(["notes"], "notes.md")];
    const invokeMock = vi.fn(async (_command: string, body: unknown, options: unknown) => {
      const headers = (options as { headers: Record<string, string> }).headers;
      const name = new TextDecoder().decode(Uint8Array.from(atob(headers["x-tinybot-file-name"]), (c) => c.charCodeAt(0)));
      return { name, path: `managed/${name}`, sizeBytes: (body as ArrayBuffer).byteLength, mimeType: "application/octet-stream" };
    });
    const importFiles = createDesktopNativeFileImporter({ invoke: invokeMock as never });
    const result = await importFiles(files);
    expect(result.map((file) => file.name)).toEqual(["截图.png", "notes.md"]);
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(["import_chat_file", "import_chat_file"]);
    expect(new Uint8Array(invokeMock.mock.calls[0][1] as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 12]));
  });

  test("rejects oversized batches before reading any file and preserves native error details", async () => {
    const invokeMock = vi.fn().mockRejectedValue("storage is read-only");
    const importFiles = createDesktopNativeFileImporter({ invoke: invokeMock });
    const oversized = new File([], "large.pdf");
    Object.defineProperty(oversized, "size", { value: MAX_IMPORTED_FILE_BYTES + 1 });
    await expect(importFiles([new File(["ok"], "first.txt"), oversized])).rejects.toThrow("large.pdf");
    expect(invokeMock).not.toHaveBeenCalled();
    await expect(importFiles([new File(["test"], "notes.txt")])).rejects.toThrow("notes.txt: storage is read-only");
  });

  test("returns native file metadata without reading file contents", async () => {
    const selected = [{
      name: "notes.md",
      path: "C:\\Users\\tester\\notes.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
    }];
    const invokeMock = vi.fn(async () => selected);
    const invoke = invokeMock as unknown as typeof tauriInvoke;

    await expect(createDesktopNativeFilePicker({ invoke })()).resolves.toEqual(selected);
    expect(invokeMock).toHaveBeenCalledWith("pick_chat_files", {
      options: { title: "Select files" },
    });
  });
});
