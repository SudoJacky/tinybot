import { AlertTriangle, Circle, Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import type { SessionSummary } from "../services";

type SessionStatusProps = Pick<SessionSummary, "status"> & { unread?: boolean };

export function SessionStatus({ status, unread }: SessionStatusProps) {
  if (status === "running") {
    return <Loader2 aria-hidden="true" className="react-session-status" data-kind="running" size={11} />;
  }
  if (status === "failed") {
    return <AlertTriangle aria-hidden="true" className="react-session-status" data-kind="failed" size={11} />;
  }
  if (unread) {
    return <Circle aria-hidden="true" className="react-session-status" data-kind="unread" fill="currentColor" size={8} />;
  }
  return null;
}

export function sessionStatusLabel({ status, unread }: SessionStatusProps, t: TFunction<"chat">): string {
  if (status === "running") return t("tabs.status.running");
  if (status === "failed") return t("tabs.status.failed");
  if (unread) return t("tabs.status.unread");
  return "";
}
