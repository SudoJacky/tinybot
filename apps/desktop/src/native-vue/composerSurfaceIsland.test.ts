// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountComposerSurfaceIsland } from "./composerSurfaceIsland";

describe("composer surface Vue island", () => {
  test("renders composer controls and routes attach, rag, and send actions", async () => {
    const host = document.createElement("form");
    const sends: unknown[] = [];
    const attaches: string[] = [];
    const rags: boolean[] = [];

    const mounted = mountComposerSurfaceIsland(host, {
      activeSessionKey: "WebSocket:chat-live",
      composerState: "idle",
      model: "deepseek-chat",
      responding: false,
      tokenUsage: "42%",
      usePersistentRag: false,
      onAttach: () => attaches.push("attach"),
      onPersistentRagChange: (enabled) => rags.push(enabled),
      onSend: (event) => sends.push(event),
    });

    expect(host.id).toBe("desktop-native-composer");
    expect(host.className).toBe("desktop-native-composer");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("composer-surface");
    expect(host.getAttribute("aria-label")).toBe("Native desktop composer");
    expect(host.getAttribute("data-active-session-key")).toBe("WebSocket:chat-live");
    expect(host.getAttribute("data-desktop-composer-responding")).toBe("false");
    expect(host.getAttribute("data-desktop-composer-rag")).toBe("false");
    expect(host.getAttribute("data-desktop-composer-state")).toBe("idle");
    const layout = host.querySelector(".desktop-native-composer-layout");
    expect(layout).not.toBeNull();
    expect(layout?.querySelector(".desktop-native-composer-context")).toBeNull();
    expect(layout?.querySelectorAll(".desktop-native-composer-chip")).toHaveLength(0);
    expect(layout?.querySelector(":scope > #desktop-native-composer-input")).not.toBeNull();
    expect(layout?.querySelector(":scope > #desktop-native-composer-attach")).not.toBeNull();
    expect(layout?.querySelector(":scope > #desktop-native-composer-runtime")).not.toBeNull();
    expect(layout?.querySelector(":scope > #desktop-native-composer-send")).not.toBeNull();

    const input = host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input");
    const send = host.querySelector<HTMLButtonElement>("#desktop-native-composer-send");
    expect(input?.getAttribute("aria-label")).toBe("Native composer input");
    expect(input?.getAttribute("placeholder")).toBe("Ask Tinybot");
    expect(input?.getAttribute("rows")).toBe("1");
    expect(input?.getAttribute("data-max-rows")).toBe("3");
    expect(send?.getAttribute("disabled")).toBe("");
    expect(send?.textContent).not.toContain("Send");
    expect(send?.querySelector('[data-desktop-composer-send-icon="true"]')?.tagName).toBe("svg");
    expect(send?.querySelector('[data-desktop-composer-send-icon="true"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("#desktop-native-composer-runtime")?.getAttribute("data-desktop-vue-island")).toBe("composer-runtime");
    expect(host.querySelector("#desktop-native-composer-runtime")?.textContent).toContain("deepseek-chat");
    expect(host.querySelector(".desktop-native-token-orb")?.getAttribute("data-token-usage")).toBe("42");

    host.querySelector<HTMLButtonElement>('[data-desktop-composer-action="attach"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-composer-action="rag-toggle"]')?.click();
    input!.value = "Run live composer";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(send?.getAttribute("disabled")).toBeNull();
    send?.click();

    expect(attaches).toEqual(["attach"]);
    expect(rags).toEqual([true]);
    expect(sends).toEqual([{ content: "Run live composer", usePersistentRag: false }]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("keeps send disabled while queued", () => {
    const host = document.createElement("form");
    const sends: unknown[] = [];

    mountComposerSurfaceIsland(host, {
      activeSessionKey: "",
      composerState: "queued",
      model: null,
      responding: true,
      tokenUsage: "-",
      usePersistentRag: true,
      onSend: (event) => sends.push(event),
    });

    const input = host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input");
    const send = host.querySelector<HTMLButtonElement>("#desktop-native-composer-send");
    input!.value = "Queued message";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    send?.click();

    expect(host.getAttribute("data-active-session-key")).toBeNull();
    expect(host.getAttribute("data-desktop-composer-responding")).toBe("true");
    expect(host.getAttribute("data-desktop-composer-state")).toBe("queued");
    expect(send?.getAttribute("disabled")).toBe("");
    expect(sends).toEqual([]);
  });

  test("updates composer state without replacing editable input", async () => {
    const host = document.createElement("form");
    const sends: unknown[] = [];

    const mounted = mountComposerSurfaceIsland(host, {
      activeSessionKey: "session-1",
      composerState: "idle",
      model: "deepseek-chat",
      responding: false,
      tokenUsage: "10%",
      usePersistentRag: true,
      onSend: (event) => sends.push(event),
    });

    const input = host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input");
    input!.value = "Keep this draft";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    mounted.update({
      activeSessionKey: "session-1",
      composerState: "sending",
      model: "deepseek-v4-flash",
      responding: true,
      tokenUsage: "57%",
      usePersistentRag: false,
      onSend: (event) => sends.push(event),
    });
    await nextTick();

    const nextInput = host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input");
    const send = host.querySelector<HTMLButtonElement>("#desktop-native-composer-send");
    expect(nextInput).toBe(input);
    expect(nextInput?.value).toBe("Keep this draft");
    expect(host.getAttribute("data-desktop-composer-state")).toBe("sending");
    expect(host.querySelector("#desktop-native-composer-runtime")?.textContent).toContain("deepseek-v4-flash");
    expect(host.querySelector(".desktop-native-token-orb")?.getAttribute("data-token-usage")).toBe("57");
    expect(send?.getAttribute("disabled")).toBe("");
    send?.click();
    expect(sends).toEqual([]);

    mounted.update({
      activeSessionKey: "session-1",
      composerState: "idle",
      model: "deepseek-v4-flash",
      responding: false,
      tokenUsage: "58%",
      usePersistentRag: false,
      onSend: (event) => sends.push(event),
    });
    await nextTick();

    expect(host.querySelector<HTMLTextAreaElement>("#desktop-native-composer-input")).toBe(input);
    expect(send?.getAttribute("disabled")).toBeNull();
    send?.click();
    expect(sends).toEqual([{ content: "Keep this draft", usePersistentRag: false }]);
  });
});
