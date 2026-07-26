import { describe, expect, it, vi } from "vitest";
import { createDesktopNativeWorkspacePicker } from "./desktopNativeWorkspacePicker";

describe("desktop native workspace picker", () => {
  it("invokes the native folder picker with the workspace title", async () => {
    const invoke = vi.fn(async () => "D:\\Code\\py\\tinybot");
    const pickWorkspaceDirectory = createDesktopNativeWorkspacePicker({ invoke });

    await expect(pickWorkspaceDirectory()).resolves.toBe("D:\\Code\\py\\tinybot");
    expect(invoke).toHaveBeenCalledWith("pick_workspace_directory", {
      options: { title: "Select workspace folder" },
    });
  });
});
