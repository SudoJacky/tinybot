import { useSyncExternalStore } from "react";
import { loadComposerRichText, subscribeComposerPreferences } from "../../app-core/settings/composerPreferences";

export function useComposerRichText(): boolean {
  return useSyncExternalStore(subscribeComposerPreferences, loadComposerRichText);
}
