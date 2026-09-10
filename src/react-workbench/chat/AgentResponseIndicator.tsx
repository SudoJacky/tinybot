import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SplitFlapText from "../lib/SplitFlapText";
import "./AgentResponseIndicator.css";

export const AgentResponseIndicator = memo(function AgentResponseIndicator() {
  const { t, i18n } = useTranslation("chat");
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let inView = true;
    const update = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(ref.current!);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const words = [
    t("turn.flapWords.building"),
    t("turn.flapWords.stirring"),
    t("turn.flapWords.polishing"),
    t("turn.flapWords.baking"),
  ];
  return (
    <div ref={ref} className="react-agent-response" role="img" aria-label={t("turn.agentResponding")}>
      <SplitFlapText
        aria-hidden="true"
        className="react-agent-response__board"
        data-cjk={i18n.resolvedLanguage?.startsWith("zh") || undefined}
        words={words}
        loop={visible}
        text={visible ? undefined : words[0]}
        charset={words.join("")}
        padTo={0}
        fontSize={13}
        gap={2}
        tileRadius={3}
        tileColor="var(--color-surface-soft)"
        textColor="var(--color-muted)"
        cycleDelay={3200}
        flipDuration={0.1}
        stagger={0.015}
        flipsPerChar={1}
      />
    </div>
  );
});
