import type { TFunction } from "i18next";

export function displaySessionTitle(title: string, t: TFunction<"chat">): string {
  return isDefaultSessionTitle(title) ? t("shell.newChat") : title;
}

export function deriveSessionTitle(prompt: string, t: TFunction<"chat">): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || t("shell.newChat");
}

export function isDefaultSessionTitle(title: string): boolean {
  return /^(new (chat|session)|新(建)?会话|未命名)/i.test(title.trim());
}
