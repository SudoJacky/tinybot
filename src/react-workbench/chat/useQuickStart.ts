import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { ChatModelOption, SettingsStore } from "../services";

export const QUICK_START_STORAGE_KEY = "tinybot.quick-start.v1";
type Progress = "started" | "dismissed" | "completed" | null;

/** Owns model readiness and onboarding progress; configuration stays in SettingsStore. */
export function useQuickStart(settingsStore: SettingsStore | undefined) {
  const [progress, setProgress] = useState<Progress>(() => {
    const saved = localStorage.getItem(QUICK_START_STORAGE_KEY);
    if (saved === null || saved === "started" || saved === "dismissed" || saved === "completed") return saved;
    throw new Error(`Invalid quick-start progress: ${saved}`);
  });
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [requested, setRequested] = useState(false);
  const supported = Boolean(settingsStore?.loadChatModels && settingsStore.loadProviderSettings && settingsStore.saveProviderSettings);
  const saveProgress = useCallback((next: Exclude<Progress, null>) => {
    localStorage.setItem(QUICK_START_STORAGE_KEY, next);
    setProgress(next);
  }, []);
  const startIfNew = useEffectEvent((next: ChatModelOption[]) => {
    if (supported && !next.length && progress === null) saveProgress("started");
  });

  useEffect(() => {
    if (!settingsStore?.loadChatModels) return;
    let cancelled = false;
    setLoaded(false);
    setError("");
    void settingsStore.loadChatModels().then((next) => {
      if (cancelled) return;
      setModels(next);
      setLoaded(true);
      startIfNew(next);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      console.error("[quick-start] models.load.failed", cause);
    });
    return () => { cancelled = true; };
  }, [settingsStore, supported, revision, saveProgress]);

  const completeTask = useCallback(() => {
    if (progress === "started" && !requested) saveProgress("completed");
  }, [progress, requested, saveProgress]);

  return {
    models, loaded, error,
    completeTask,
    visible: supported && (requested || progress === "started"),
    open: () => { setRequested(true); },
    beginTask: () => { saveProgress("started"); setRequested(false); },
    dismiss: () => { saveProgress("dismissed"); setRequested(false); },
    reloadModels: () => setRevision((current) => current + 1),
  };
}
