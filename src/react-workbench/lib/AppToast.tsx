import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "./AppToast.css";

type Toast = {
  id: number;
  message: string;
  tone: "info" | "success" | "warning" | "error";
  action?: { label: string; onClick: () => void };
};
let current: Toast | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const snapshot = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function showAppToast(message: string, tone: Toast["tone"] = "info", action?: Toast["action"]) {
  current = { id: ++nextId, message, tone, action };
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
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (hovered || focused || hidden || exiting) return;
    const timer = window.setTimeout(() => setExiting(true), toast.tone === "error" || toast.tone === "warning" ? 8000 : 3000);
    return () => window.clearTimeout(timer);
  }, [hovered, focused, hidden, exiting, toast.tone]);
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => dismissAppToast(toast.id), 220);
    return () => window.clearTimeout(timer);
  }, [exiting, toast.id]);
  const Icon = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleX }[toast.tone];
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
        <Icon aria-hidden="true" size={16} />
        <p role={toast.tone === "error" ? "alert" : "status"} aria-atomic="true">{toast.message}</p>
        {toast.action && <button className="react-app-toast-action" type="button" onClick={() => { toast.action!.onClick(); dismissAppToast(toast.id); }}>{toast.action.label}</button>}
        <button className="react-app-toast-close" aria-label={t("notifications.dismiss")} type="button" onClick={() => setExiting(true)}>
          <X aria-hidden="true" size={14} />
        </button>
      </div>
    </div>
  );
}
