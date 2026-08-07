export const CHAT_CURRENT_MODEL_STORAGE_KEY = "tinybot.ui.chat.composer-model";

export function readCurrentChatModel(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CHAT_CURRENT_MODEL_STORAGE_KEY)?.trim() ?? "";
  } catch (error) {
    console.warn("Unable to read the current chat model.", error);
    return "";
  }
}

export function writeCurrentChatModel(modelId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_CURRENT_MODEL_STORAGE_KEY, modelId);
  } catch (error) {
    console.warn("Unable to save the current chat model.", error);
  }
}

export function clearCurrentChatModel(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CHAT_CURRENT_MODEL_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to clear the stale current chat model.", error);
  }
}
