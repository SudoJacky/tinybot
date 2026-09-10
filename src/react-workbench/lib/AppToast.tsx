import { Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "./AppToast.css";

type Toast = { id: number; message: string; tone: "info" | "error" };
let current: Toast | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const snapshot = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function showAppToast(message: string, tone: Toast["tone"] = "info") {
  current = { id: ++nextId, message, tone };
  listeners.forEach((listener) => listener());
}

export function dismissAppToast(id?: number) {
  if (id !== undefined && current?.id !== id) return;
  current = null;
  listeners.forEach((listener) => listener());
}

/** One window-level host, independent of the route or card that sent a notice. */
export function AppToastViewport() {
  const toast = useSyncExternalStore(subscribe, snapshot);
  return toast ? createPortal(<ToastBubble key={toast.id} toast={toast} />, document.body) : null;
}

function ToastBubble({ toast }: { toast: Toast }) {
  const { t } = useTranslation("common");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (hovered || focused || exiting) return;
    const timer = window.setTimeout(() => setExiting(true), toast.tone === "error" ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [hovered, focused, exiting, toast.tone]);
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => dismissAppToast(toast.id), 220);
    return () => window.clearTimeout(timer);
  }, [exiting, toast.id]);
  const Icon = toast.tone === "error" ? TriangleAlert : Info;
  return (
    <div className="react-app-toast-position">
      <div
        className="react-app-toast"
        data-tone={toast.tone}
        data-exiting={exiting || undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      >
        <Icon aria-hidden="true" size={19} />
        <p role={toast.tone === "error" ? "alert" : "status"} aria-atomic="true">{toast.message}</p>
        <button aria-label={t("notifications.dismiss")} type="button" onClick={() => setExiting(true)}>
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  );
}
