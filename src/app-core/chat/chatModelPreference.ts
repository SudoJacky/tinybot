export const CHAT_DEFAULT_MODEL_STORAGE_KEY = "tinybot.ui.chat.composer-model";
export const CHAT_DEFAULT_MODEL_PROVIDER_STORAGE_KEY = "tinybot.ui.chat.composer-provider";

export type ChatModelPreference = {
  modelId: string;
  providerId?: string;
};

export function readDefaultChatModelPreference(): ChatModelPreference | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const modelId = window.localStorage.getItem(CHAT_DEFAULT_MODEL_STORAGE_KEY)?.trim() ?? "";
    if (!modelId) return undefined;
    const providerId = window.localStorage.getItem(CHAT_DEFAULT_MODEL_PROVIDER_STORAGE_KEY)?.trim() ?? "";
    return {
      modelId,
      ...(providerId ? { providerId } : {}),
    };
  } catch (error) {
    console.warn("Unable to read the default chat model.", error);
    return undefined;
  }
}

export function readDefaultChatModel(): string {
  return readDefaultChatModelPreference()?.modelId ?? "";
}

export function writeDefaultChatModel(modelId: string, providerId?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_DEFAULT_MODEL_STORAGE_KEY, modelId);
    if (providerId?.trim()) {
      window.localStorage.setItem(CHAT_DEFAULT_MODEL_PROVIDER_STORAGE_KEY, providerId.trim());
    } else {
      window.localStorage.removeItem(CHAT_DEFAULT_MODEL_PROVIDER_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("Unable to save the default chat model.", error);
  }
}

export function clearDefaultChatModel(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CHAT_DEFAULT_MODEL_STORAGE_KEY);
    window.localStorage.removeItem(CHAT_DEFAULT_MODEL_PROVIDER_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to clear the stale default chat model.", error);
  }
}
