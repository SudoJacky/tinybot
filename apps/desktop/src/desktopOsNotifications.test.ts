import { describe, expect, test } from "vitest";
import { createDesktopOsNotificationBridge } from "./desktopOsNotifications";

describe("desktop OS notifications", () => {
  test("skips notification plugin loading outside the Tauri runtime", async () => {
    let loaded = false;
    const bridge = createDesktopOsNotificationBridge({
      hasTauriRuntime: () => false,
      loadApi: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });

    expect(await bridge.canNotify()).toBe(false);
    expect(await bridge.notify({ title: "Tinybot", body: "Task complete" })).toBe(false);
    expect(loaded).toBe(false);
  });

  test("sends notifications when permission is already granted", async () => {
    const sent: { title: string; body: string }[] = [];
    const bridge = createDesktopOsNotificationBridge({
      hasTauriRuntime: () => true,
      loadApi: async () => ({
        isPermissionGranted: async () => true,
        requestPermission: async () => "granted" as const,
        sendNotification: (notification) => {
          sent.push(notification);
        },
      }),
    });

    expect(await bridge.canNotify()).toBe(true);
    expect(await bridge.notify({ title: "Tinybot", body: "Task failed" })).toBe(true);
    expect(sent).toEqual([{ title: "Tinybot", body: "Task failed" }]);
  });

  test("requests permission once and skips sending when permission is denied", async () => {
    let requests = 0;
    let sends = 0;
    const bridge = createDesktopOsNotificationBridge({
      hasTauriRuntime: () => true,
      loadApi: async () => ({
        isPermissionGranted: async () => false,
        requestPermission: async () => {
          requests += 1;
          return "denied" as const;
        },
        sendNotification: () => {
          sends += 1;
        },
      }),
    });

    expect(await bridge.canNotify()).toBe(false);
    expect(await bridge.notify({ title: "Tinybot", body: "Approval required" })).toBe(false);
    expect(requests).toBe(1);
    expect(sends).toBe(0);
  });
});
