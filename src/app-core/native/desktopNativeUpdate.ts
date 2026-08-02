import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "installing"
  | "failed";

export type DesktopUpdateSnapshot = {
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  displayNotes: string | null;
  publishedAt: string | null;
  phase: DesktopUpdatePhase;
  progressPercent: number | null;
  error: string | null;
};

export type DesktopUpdateClient = {
  status(): Promise<DesktopUpdateSnapshot>;
  check(): Promise<DesktopUpdateSnapshot>;
  install(expectedVersion: string): Promise<DesktopUpdateSnapshot>;
  listen(listener: (snapshot: DesktopUpdateSnapshot) => void): Promise<() => void>;
};

const DESKTOP_UPDATE_STATUS_EVENT = "desktop-update-status";

export function createDesktopNativeUpdateClient(): DesktopUpdateClient | null {
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    return null;
  }
  return {
    status: () => invoke<DesktopUpdateSnapshot>("desktop_update_status"),
    check: () => invoke<DesktopUpdateSnapshot>("desktop_check_for_update"),
    install: (expectedVersion) => invoke<DesktopUpdateSnapshot>("desktop_install_update", {
      input: { expectedVersion },
    }),
    listen: async (listener) => listen<DesktopUpdateSnapshot>(
      DESKTOP_UPDATE_STATUS_EVENT,
      ({ payload }) => listener(payload),
    ),
  };
}
