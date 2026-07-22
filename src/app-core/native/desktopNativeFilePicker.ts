import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type NativePickedFile = {
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export function createDesktopNativeFilePicker(options: { invoke?: TauriInvoke } = {}) {
  const invoke = options.invoke ?? tauriInvoke;
  return () => invoke<NativePickedFile[]>("pick_chat_files", {
    options: { title: "Select files" },
  });
}

export const pickDesktopChatFiles = createDesktopNativeFilePicker();
