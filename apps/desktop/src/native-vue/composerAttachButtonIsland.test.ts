// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountComposerAttachButtonIsland } from "./composerAttachButtonIsland";

describe("composer attach button Vue island", () => {
  test("renders the desktop composer attach button and dispatches attach", () => {
    const host = document.createElement("button");
    let attachCount = 0;

    const mounted = mountComposerAttachButtonIsland(host, {
      onAttach: () => {
        attachCount += 1;
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-attach-button");
    expect(host.getAttribute("id")).toBe("desktop-native-composer-attach");
    expect(host.className).toContain("desktop-native-composer-action");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-desktop-composer-action")).toBe("attach");
    expect(host.getAttribute("aria-label")).toBe("Attach temporary file to current session");
    expect(host.textContent).toContain("+");

    host.click();
    expect(attachCount).toBe(1);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
