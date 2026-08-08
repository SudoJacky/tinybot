export const REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number];

export const CHAT_REASONING_EFFORT_STORAGE_KEY = "tinybot.ui.chat.composer-reasoning-effort";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORT_VALUES.some((effort) => effort === value);
}

export function readCurrentChatReasoningEffort(): ReasoningEffort {
  if (typeof window === "undefined") return DEFAULT_REASONING_EFFORT;
  try {
    const effort = window.localStorage.getItem(CHAT_REASONING_EFFORT_STORAGE_KEY)?.trim() ?? "";
    if (!effort) return DEFAULT_REASONING_EFFORT;
    if (isReasoningEffort(effort)) return effort;
    window.localStorage.removeItem(CHAT_REASONING_EFFORT_STORAGE_KEY);
    return DEFAULT_REASONING_EFFORT;
  } catch (error) {
    console.warn("Unable to read the current chat reasoning effort.", error);
    return DEFAULT_REASONING_EFFORT;
  }
}

export function writeCurrentChatReasoningEffort(effort: ReasoningEffort): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_REASONING_EFFORT_STORAGE_KEY, effort);
  } catch (error) {
    console.warn("Unable to save the current chat reasoning effort.", error);
  }
}
