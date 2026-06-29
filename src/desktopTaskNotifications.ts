import type { DesktopTaskCenterItem } from "./desktopTaskCenter";

export interface DesktopTaskNotification {
  title: string;
  body: string;
}

export interface DesktopTaskNotificationControllerOptions {
  enabled: boolean;
  isFocused: () => boolean;
  canNotify?: () => boolean | Promise<boolean>;
  notify: (notification: DesktopTaskNotification) => boolean | Promise<boolean>;
}

export interface DesktopTaskNotificationController {
  update: (items: DesktopTaskCenterItem[]) => Promise<void>;
}

type NotificationKey = `${string}:${string}`;

export function createDesktopTaskNotificationController({
  enabled,
  isFocused,
  canNotify = () => true,
  notify,
}: DesktopTaskNotificationControllerOptions): DesktopTaskNotificationController {
  const seen = new Set<NotificationKey>();
  let initialized = false;

  return {
    async update(items: DesktopTaskCenterItem[]): Promise<void> {
      if (!initialized) {
        initialized = true;
        rememberNotifiableStates(items, seen);
        return;
      }
      if (!enabled || isFocused() || !(await canNotify())) {
        rememberNotifiableStates(items, seen);
        return;
      }
      for (const item of items) {
        const notification = taskNotificationForItem(item);
        if (!notification) {
          continue;
        }
        const key: NotificationKey = `${item.id}:${item.state}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        await notify(notification);
      }
    },
  };
}

function rememberNotifiableStates(items: DesktopTaskCenterItem[], seen: Set<NotificationKey>): void {
  for (const item of items) {
    if (taskNotificationForItem(item)) {
      seen.add(`${item.id}:${item.state}`);
    }
  }
}

function taskNotificationForItem(item: DesktopTaskCenterItem): DesktopTaskNotification | null {
  if (item.state === "completed") {
    return {
      title: "Tinybot task completed",
      body: notificationBody(item),
    };
  }
  if (item.source === "gateway" && item.state === "failed") {
    return {
      title: "Tinybot gateway needs attention",
      body: notificationBody(item),
    };
  }
  if (item.source === "approval" && item.state === "blocked") {
    return {
      title: "Tinybot approval required",
      body: notificationBody(item),
    };
  }
  if (item.source === "cowork" && item.state === "blocked") {
    return {
      title: "Tinybot Cowork intervention needed",
      body: notificationBody(item),
    };
  }
  if (item.state === "failed") {
    return {
      title: "Tinybot task failed",
      body: notificationBody(item),
    };
  }
  return null;
}

function notificationBody(item: DesktopTaskCenterItem): string {
  const detail = item.diagnostics || item.detail || item.status;
  return [item.title, detail].filter(Boolean).join(" - ");
}
