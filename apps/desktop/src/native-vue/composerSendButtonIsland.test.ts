// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountComposerSendButtonIsland } from "./composerSendButtonIsland";

describe("composer send button Vue island", () => {
  test("renders enabled desktop composer send button and dispatches send", () => {
    const host = document.createElement("button");
    let sendCount = 0;

    const mounted = mountComposerSendButtonIsland(host, {
      disabled: false,
      onSend: () => {
        sendCount += 1;
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-send-button");
    expect(host.getAttribute("id")).toBe("desktop-native-composer-send");
    expect(host.className).toContain("desktop-native-composer-send");
    expect(host.getAttribute("type")).toBe("button");
    expect(host.getAttribute("data-desktop-composer-action")).toBe("send");
    expect(host.getAttribute("aria-label")).toBe("Send message");
    expect(host.getAttribute("disabled")).toBeNull();
    expect(host.textContent).toContain("Send");

    host.click();
    expect(sendCount).toBe(1);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders disabled state without dispatching send", () => {
    const host = document.createElement("button");
    let sendCount = 0;

    const mounted = mountComposerSendButtonIsland(host, {
      disabled: true,
      onSend: () => {
        sendCount += 1;
      },
    });

    expect(host.getAttribute("disabled")).toBe("");
    expect((host as HTMLButtonElement).disabled).toBe(true);

    host.click();
    expect(sendCount).toBe(0);

    mounted.unmount();
  });
});
