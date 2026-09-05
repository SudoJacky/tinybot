import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import { turnDurationMs } from "../../app-core/chat/turnMetrics";
import "./TurnMetrics.css";

export function TurnMetrics({ turn }: { turn: ChatTurn }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const duration = turnDurationMs(turn);
  const terminal = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
  const positioned = position !== undefined;

  useEffect(() => {
    if (open && positioned) panelRef.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const top = anchor.top - panel.height - 8;
      setPosition({
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - panel.width - 12)),
        top: Math.max(12, Math.min(top >= 12 ? top : anchor.bottom + 8, window.innerHeight - panel.height - 12)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
      if (event.key === "Tab") {
        triggerRef.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!terminal || duration === undefined) return null;
  const formatDuration = (ms: number) => ms < 60_000
    ? t("metrics.seconds", { value: Number((ms / 1_000).toFixed(1)) })
    : t("metrics.minutesSeconds", { minutes: Math.floor(ms / 60_000), seconds: Math.floor(ms % 60_000 / 1_000) });
  return (
    <>
      <button
        ref={triggerRef}
        className="react-turn-metrics__trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => { setPosition(undefined); setOpen(!open); }}
      >
        <Clock3 aria-hidden="true" size={15} />
        {t("metrics.elapsed", { duration: formatDuration(duration) })}
      </button>
      {open && createPortal(
        <div ref={panelRef} id={id} className="react-turn-metrics__panel" role="dialog" aria-label={t("metrics.title")} tabIndex={-1} style={position ?? { visibility: "hidden" }}>
          <div className="react-turn-metrics__title"><Clock3 aria-hidden="true" size={17} />{t("metrics.title")}</div>
          <dl>
            <dt>{t("metrics.duration")}</dt><dd>{formatDuration(duration)}</dd>
            {turn.metrics?.tokensPerSecond !== undefined && <><dt>{t("metrics.speed")}</dt><dd>{t("metrics.tokensPerSecond", { value: Number(turn.metrics.tokensPerSecond.toFixed(turn.metrics.tokensPerSecond < 10 ? 1 : 0)) })}</dd></>}
            {turn.metrics?.timeToFirstTokenMs !== undefined && <><dt>{t("metrics.ttft")}</dt><dd>{formatDuration(turn.metrics.timeToFirstTokenMs)}</dd></>}
          </dl>
          {turn.metrics && <p>{t("metrics.description")}</p>}
        </div>, document.body,
      )}
    </>
  );
}
