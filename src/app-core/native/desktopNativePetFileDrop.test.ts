import { describe, expect, it, vi } from "vitest";
import { createDesktopNativePetFileDropImporter } from "./desktopNativePetFileDrop";

describe("createDesktopNativePetFileDropImporter", () => {
  it("listens before posting files and returns validated native metadata", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    const calls: string[] = [];
    const importer = createDesktopNativePetFileDropImporter({
      listen: vi.fn(async (_event, nextListener) => {
        calls.push("listen");
        listener = nextListener;
        return () => calls.push("unlisten");
      }),
      post: vi.fn(async (requestId) => {
        calls.push("post");
        listener?.({
          payload: {
            schemaVersion: "tinybot.desktop_pet_file_drop.v1",
            requestId,
            files: [{
              contentHash: "abc123",
              mimeType: "image/png",
              name: "diagram.png",
              path: "C:\\Tinybot\\diagram.png",
              sizeBytes: 2048,
            }],
          },
        });
      }),
      requestId: () => "drop-1",
    });

    const files = [new File(["image"], "diagram.png", { type: "image/png" })];
    await expect(importer(files)).resolves.toEqual([{
      contentHash: "abc123",
      mimeType: "image/png",
      name: "diagram.png",
      path: "C:\\Tinybot\\diagram.png",
      sizeBytes: 2048,
    }]);
    expect(calls).toEqual(["listen", "post", "unlisten"]);
  });

  it("surfaces native import failures without returning partial attachments", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    const importer = createDesktopNativePetFileDropImporter({
      listen: vi.fn(async (_event, nextListener) => {
        listener = nextListener;
        return () => undefined;
      }),
      post: vi.fn(async (requestId) => {
        listener?.({
          payload: {
            schemaVersion: "tinybot.desktop_pet_file_drop.v1",
            requestId,
            error: "Dropped paths must point to regular files.",
          },
        });
      }),
      requestId: () => "drop-2",
    });

    await expect(importer([new File(["x"], "folder")])).rejects.toThrow(
      "Dropped paths must point to regular files.",
    );
  });

  it("times out even when the WebView2 signal callback never settles", async () => {
    const importer = createDesktopNativePetFileDropImporter({
      listen: vi.fn(async () => () => undefined),
      post: vi.fn(() => new Promise<void>(() => undefined)),
      requestId: () => "drop-3",
      timeoutMs: 1,
    });

    await expect(importer([new File(["x"], "notes.txt")])).rejects.toThrow(
      "Desktop pet file import timed out after 1 ms.",
    );
  });
});
