import { useEffect, useRef, useState } from "react";
import { Lightbulb } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ChatStep } from "../../app-core/chat/chatTurnContracts";
import { TimelineActivity } from "./TimelineActivity";

export function MessageReasoning({ durationMs, streaming, text }: { durationMs?: number; streaming: boolean; text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(streaming);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (wasStreaming.current !== streaming) {
      setExpanded(streaming);
      wasStreaming.current = streaming;
    }
  }, [streaming]);

  return (
    <section className="react-message-reasoning" aria-label={t("reasoning.label")}>
      <TimelineActivity
        icon={<Lightbulb size={16} />}
        onOpenChange={setExpanded}
        open={expanded}
        title={streaming ? t("reasoning.thinking") : formatThinkingLabel(durationMs, t)}
      >
        <div className="react-message-reasoning__content">
          {text.trim() ? <div className="react-message-plain-text"><p>{text}</p></div> : null}
        </div>
      </TimelineActivity>
    </section>
  );
}

export function reasoningDurationMs(step: Pick<ChatStep, "startedAt" | "completedAt">): number | undefined {
  if (!step.startedAt || !step.completedAt) return undefined;
  const duration = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function formatThinkingLabel(durationMs: number | undefined, t: TFunction<"chat">): string {
  if (durationMs === undefined) return t("reasoning.label");
  if (durationMs < 1000) return t("reasoning.underSecond");
  return t("reasoning.seconds", { count: Math.max(1, Math.round(durationMs / 1000)) });
}
