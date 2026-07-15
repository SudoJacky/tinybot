import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import { createDesktopTaskNotificationController } from "./desktopTaskNotifications";

describe("desktop task notifications", () => {
  test("notifies only important task transitions when notifications are enabled and focus is elsewhere", async () => {
    const sent: { title: string; body: string }[] = [];
    const controller = createDesktopTaskNotificationController({
      enabled: true,
      isFocused: () => false,
      notify: async (notification) => {
        sent.push(notification);
        return true;
      },
    });

    await controller.update(buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:process",
          title: "Process Desktop Notes",
          status: "saving",
          canonical: { module: "files", href: "/files" },
        },
      ],
      gatewayOperations: [
        {
          id: "gateway:startup",
          title: "Start Tinybot gateway",
          status: "starting",
          canonical: { module: "gateway", href: "/api/status" },
        },
      ],
    }));

    await controller.update(buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:process",
          title: "Process Desktop Notes",
          status: "completed",
          detail: "File ready",
          canonical: { module: "files", href: "/files" },
        },
      ],
      gatewayOperations: [
        {
          id: "gateway:startup",
          title: "Start Tinybot gateway",
          status: "failed",
          detail: "shell / Tauri Rust backend",
          diagnostics: "port occupied",
          retryable: true,
          canonical: { module: "gateway", href: "/api/status" },
        },
      ],
      approvals: [
        {
          id: "approval:tool-1",
          title: "Approve shell_command",
          status: "waiting",
          detail: "Shell command approval required",
          canonical: { module: "approvals", href: "/chat/chat-1" },
        },
      ],
      coworkRuns: [
        {
          id: "cowork:session-1",
          title: "Review swarm plan",
          status: "intervention_needed",
          detail: "Needs review",
          canonical: { module: "cowork", href: "/cowork" },
        },
      ],
    }));

    expect(sent).toEqual([
      {
        title: "Tinybot approval required",
        body: "Approve shell_command - Shell command approval required",
      },
      {
        title: "Tinybot Cowork intervention needed",
        body: "Review swarm plan - Needs review",
      },
      {
        title: "Tinybot gateway needs attention",
        body: "Start Tinybot gateway - port occupied",
      },
      {
        title: "Tinybot task completed",
        body: "Process Desktop Notes - File ready",
      },
    ]);

    await controller.update(buildDesktopTaskCenterItems({
      fileOperations: [
        {
          id: "file:process",
          title: "Process Desktop Notes",
          status: "completed",
          detail: "File ready",
          canonical: { module: "files", href: "/files" },
        },
      ],
    }));
    expect(sent).toHaveLength(4);
  });

  test("skips OS notification when disabled, focused, unsupported, or permission is unavailable", async () => {
    const attempts: string[] = [];
    const baseItem = buildDesktopTaskCenterItems({
      failures: [
        {
          id: "failure:trace-export",
          title: "Export trace",
          status: "failed",
          detail: "Export failed",
          canonical: { module: "workspace", href: "/workspace" },
        },
      ],
    });

    await createDesktopTaskNotificationController({
      enabled: false,
      isFocused: () => false,
      notify: async () => {
        attempts.push("disabled");
        return true;
      },
    }).update(baseItem);

    await createDesktopTaskNotificationController({
      enabled: true,
      isFocused: () => true,
      notify: async () => {
        attempts.push("focused");
        return true;
      },
    }).update(baseItem);

    await createDesktopTaskNotificationController({
      enabled: true,
      isFocused: () => false,
      canNotify: async () => false,
      notify: async () => false,
    }).update(baseItem);

    expect(attempts).toEqual([]);
  });
});
