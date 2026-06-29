import type { DesktopTaskNotification } from "../tasks/desktopTaskNotifications";

type NotificationPermission = "granted" | "denied" | "default";

export interface DesktopNotificationApi {
  isPermissionGranted: () => boolean | Promise<boolean>;
  requestPermission: () => NotificationPermission | Promise<NotificationPermission>;
  sendNotification: (notification: DesktopTaskNotification) => void;
}

export interface DesktopOsNotificationBridgeOptions {
  hasTauriRuntime: () => boolean;
  loadApi: () => Promise<DesktopNotificationApi>;
}

export interface DesktopOsNotificationBridge {
  canNotify: () => Promise<boolean>;
  notify: (notification: DesktopTaskNotification) => Promise<boolean>;
}

export function createDesktopOsNotificationBridge({
  hasTauriRuntime,
  loadApi,
}: DesktopOsNotificationBridgeOptions): DesktopOsNotificationBridge {
  let apiPromise: Promise<DesktopNotificationApi> | null = null;
  let permissionKnown: boolean | null = null;

  const getApi = async (): Promise<DesktopNotificationApi | null> => {
    if (!hasTauriRuntime()) {
      return null;
    }
    apiPromise ??= loadApi();
    return apiPromise;
  };

  const ensurePermission = async (): Promise<boolean> => {
    if (permissionKnown !== null) {
      return permissionKnown;
    }
    const api = await getApi();
    if (!api) {
      permissionKnown = false;
      return false;
    }
    if (await api.isPermissionGranted()) {
      permissionKnown = true;
      return true;
    }
    permissionKnown = (await api.requestPermission()) === "granted";
    return permissionKnown;
  };

  return {
    canNotify: ensurePermission,
    async notify(notification: DesktopTaskNotification): Promise<boolean> {
      const api = await getApi();
      if (!api || !(await ensurePermission())) {
        return false;
      }
      api.sendNotification(notification);
      return true;
    },
  };
}
