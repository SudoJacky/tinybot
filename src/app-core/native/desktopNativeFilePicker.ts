import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

type TauriInvoke = <T>(command: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>;

export type NativePickedFile = {
  contentHash?: string;
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

export const MAX_IMPORTED_FILE_BYTES = 32 * 1024 * 1024;

export function createDesktopNativeFileImporter(options: { invoke?: TauriInvoke } = {}) {
  const invoke = options.invoke ?? tauriInvoke;
  return async (files: File[]): Promise<NativePickedFile[]> => {
    for (const file of files) {
      if (file.size > MAX_IMPORTED_FILE_BYTES) {
        throw new Error(`${file.name}: file exceeds the 32 MiB import limit.`);
      }
    }
    const imported: NativePickedFile[] = [];
    // Import sequentially so several drops do not allocate every file's bytes at once.
    for (const file of files) {
      try {
        const nameBytes = new TextEncoder().encode(file.name);
        const encodedName = btoa(Array.from(nameBytes, (byte) => String.fromCharCode(byte)).join(""));
        imported.push(await invoke<NativePickedFile>("import_chat_file", await file.arrayBuffer(), {
          headers: { "x-tinybot-file-name": encodedName },
        }));
      } catch (error) {
        throw Object.assign(new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`), { cause: error });
      }
    }
    return imported;
  };
}

export const importDesktopChatFiles = createDesktopNativeFileImporter();
