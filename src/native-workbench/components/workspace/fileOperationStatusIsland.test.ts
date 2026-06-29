// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountFileOperationStatusIsland } from "./fileOperationStatusIsland";

describe("file operation status Vue island", () => {
  test("renders and updates file operation status copy", async () => {
    const host = document.createElement("div");

    const mounted = mountFileOperationStatusIsland(host, {
      label: "Knowledge upload",
      status: "Waiting",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("file-operation-status");
    expect(host.className).toContain("desktop-file-operation-status");
    expect(host.textContent).toContain("Knowledge upload");
    expect(host.textContent).toContain("Waiting");

    mounted.update({
      label: "Knowledge upload",
      status: "Uploading",
    });
    await nextTick();
    expect(host.textContent).toContain("Uploading");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
