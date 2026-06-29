// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountFileUploadStatusIsland } from "./fileUploadStatusIsland";

describe("file upload status Vue island", () => {
  test("renders the desktop file upload status host for runtime updates", () => {
    const host = document.createElement("p");

    const mounted = mountFileUploadStatusIsland(host, {
      message: "No file operation running.",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("file-upload-status");
    expect(host.getAttribute("id")).toBe("desktop-file-upload-status");
    expect(host.className).toContain("desktop-file-upload-status");
    expect(host.textContent).toContain("No file operation running.");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
