import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationStore } from "../../app-core/native/desktopNativeAutomations";
import { showAppToast } from "../lib/AppToast";

const STORAGE_KEY = "tinybot.ui.automations.notified-misses.v1";

function readNotified(): Record<string, string> {
  const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some((id) => typeof id !== "string")) {
    throw new Error("Invalid missed automation notification state");
  }
  return value as Record<string, string>;
}

/** Window-level reminders; the native store remains the authority for missed work. */
export function useMissedAutomationNotice(store: AutomationStore, onOpenTasks: () => void) {
  const { t } = useTranslation("common");
  useEffect(() => {
    let disposed = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (disposed || checking || document.hidden) return;
      clearTimeout(timer);
      checking = true;
      let failed = false;
      try {
        const snapshot = await store.list();
        if (disposed || document.hidden) return;
        const notified = readNotified();
        // Only unresolved misses on existing definitions need a reminder. A new
        // manual/scheduled run supersedes the old miss without deleting history.
        const pending = snapshot.definitions.flatMap((definition) => {
          const latest = snapshot.runs.find((run) => run.definition.id === definition.id);
          return latest?.status === "missed" && notified[definition.id] !== latest.id ? [latest] : [];
        });
        if (pending.length) {
          const next = Object.fromEntries(snapshot.definitions
            .filter((definition) => notified[definition.id])
            .map((definition) => [definition.id, notified[definition.id]]));
          for (const run of pending) next[run.definition.id] = run.id;
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          showAppToast(
            pending.length === 1
              ? t("automations.missedNotice", { name: pending[0].definition.name })
              : t("automations.missedNotices", { count: pending.length }),
            "warning",
            { label: t("automations.viewTasks"), onClick: onOpenTasks },
          );
        }
      } catch (error) {
        failed = true;
        console.error("[automation-notifications] Failed to check missed schedules.", error);
        if (!disposed) showAppToast(t("automations.noticeFailed", { error: String(error) }), "error");
      } finally {
        checking = false;
        // Stop on failure rather than repeatedly replacing messages with errors.
        // Returning to the window provides an explicit opportunity to retry.
        if (!disposed && !failed) timer = setTimeout(() => { void check(); }, 10_000);
      }
    };
    const visible = () => { if (!document.hidden) void check(); };
    void check();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [store, onOpenTasks, t]);
}
