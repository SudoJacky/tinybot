export const COMPOSER_RICH_TEXT_STORAGE_KEY = "tinybot.ui.composer.rich-text";
const CHANGE_EVENT = "tinybot:composer-preferences-changed";

export function loadComposerRichText(): boolean {
  return window.localStorage.getItem(COMPOSER_RICH_TEXT_STORAGE_KEY) !== "false";
}

export function saveComposerRichText(enabled: boolean): void {
  window.localStorage.setItem(COMPOSER_RICH_TEXT_STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeComposerPreferences(listener: () => void): () => void {
  function onStorage(event: StorageEvent): void {
    if (event.key === COMPOSER_RICH_TEXT_STORAGE_KEY || event.key === null) listener();
  }
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
