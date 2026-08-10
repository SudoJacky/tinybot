import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  SHORTCUT_COMMAND_IDS,
  type ShortcutCommandId,
  type ShortcutPreferences,
} from "../settings/appShortcuts";

export type DesktopMenuShortcutBinding = {
  id: ShortcutCommandId;
  accelerator: string | null;
};

export type DesktopMenuCommandPayload = {
  id: string;
};

export type DesktopNativeShortcutClient = {
  sync(preferences: ShortcutPreferences): Promise<void>;
  listen(listener: (commandId: string) => void): Promise<() => void>;
};

type DesktopNativeShortcutClientOptions = {
  hasTauriRuntime: () => boolean;
  invoke: (command: string, args: { bindings: DesktopMenuShortcutBinding[] }) => Promise<unknown>;
  listen: (
    event: string,
    listener: (event: { payload: DesktopMenuCommandPayload }) => void,
  ) => Promise<() => void>;
};

const DESKTOP_MENU_COMMAND_EVENT = "desktop-menu-command";

const defaultOptions: DesktopNativeShortcutClientOptions = {
  hasTauriRuntime: () => "__TAURI_INTERNALS__" in globalThis,
  invoke: (command, args) => invoke(command, args),
  listen: (event, listener) => listen<DesktopMenuCommandPayload>(event, listener),
};

export function createDesktopNativeShortcutClient(
  options: DesktopNativeShortcutClientOptions = defaultOptions,
): DesktopNativeShortcutClient | null {
  if (!options.hasTauriRuntime()) {
    return null;
  }
  return {
    async sync(preferences) {
      const bindings = SHORTCUT_COMMAND_IDS.map((id) => ({
        id,
        accelerator: preferences[id],
      }));
      await options.invoke("desktop_set_menu_shortcuts", { bindings });
    },
    listen: async (listener) => options.listen(
      DESKTOP_MENU_COMMAND_EVENT,
      ({ payload }) => listener(payload.id),
    ),
  };
}
