import { memo, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CirclePause, Sparkles } from "lucide-react";
import { TimelineActivity } from "./TimelineActivity";
import "./ThoughtLine.css";

export type ThoughtPhase = "thinking" | "running" | "responding" | "completed" | "failed" | "interrupted" | "awaiting";

/** A single status line for dispatch, execution, and the settled trace. */
export const ThoughtLine = memo(function ThoughtLine({
  phase, summary = "", startedAt, endedAt, open = false, onOpenChange = () => undefined, children,
}: {
  phase: ThoughtPhase;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const working = phase === "thinking" || phase === "running" || phase === "responding";
  const [workingPhase, setWorkingPhase] = useState(working ? phase : "running");
  if (working && workingPhase !== phase) setWorkingPhase(phase);
  const label = t(`execution.status.${phase}`);
  const activeLabel = t(`execution.status.${workingPhase}`);
  const settledLabel = working ? t("execution.status.completed") : label;
  const symbol = working ? <Sparkles size={16} /> : phase === "completed" ? <Check size={16} />
    : phase === "failed" ? <AlertTriangle size={16} /> : <CirclePause size={16} />;
  return (
    <div className="react-thought-line" data-working={working || undefined} data-phase={phase}>
      <TimelineActivity
        className="react-execution-timeline__activity"
        icon={<span className="react-thought-line__glyph">{symbol}</span>}
        keepMounted
        open={open}
        onOpenChange={onOpenChange}
        title={<>
          <span className="react-thought-line__labels" aria-hidden="true">
            <span className="react-thought-line__text" data-active={working || undefined}>
              <span className="react-thought-line__shimmer">{activeLabel}</span>
            </span>
            <span className="react-thought-line__text react-thought-line__text--settled" data-active={!working || undefined}>{settledLabel}</span>
          </span>
          <span className="react-thought-line__spoken" aria-live="polite">{label}</span>
          <ThoughtElapsed startedAt={startedAt} endedAt={endedAt} working={working} />
          {summary ? <span className="react-thought-line__summary" title={summary}>{summary}</span> : null}
        </>}
        triggerLabel={`${t("turn.workPerformed")}: ${label}${summary ? ` · ${summary}` : ""}`}
      >{children}</TimelineActivity>
    </div>
  );
});

// Only this small leaf ticks; elapsed time never rerenders the trace or its tools.
function ThoughtElapsed({ startedAt, endedAt, working }: { startedAt?: string; endedAt?: string; working: boolean }) {
  const { t } = useTranslation("chat");
  const [now, setNow] = useState(Date.now);
  const start = timestamp(startedAt);
  useEffect(() => {
    if (!working || start === undefined) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [start, working]);
  const end = working ? now : timestamp(endedAt);
  if (start === undefined || end === undefined || end < start) return null;
  const seconds = Math.floor((end - start) / 1_000);
  const duration = seconds < 60 ? t("metrics.seconds", { value: seconds })
    : t("metrics.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  return <span className="react-thought-line__timer" title={t("metrics.duration")}>{duration}</span>;
}

function timestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
