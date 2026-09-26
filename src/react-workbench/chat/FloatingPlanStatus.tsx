import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanState } from "../../app-core/chat/chatTurnContracts";
import { PlanSteps } from "./PlanSteps";

export const FLOATING_PLAN_AUTO_COLLAPSE_MS = 5_000;

type FloatingPlanStatusProps = {
  identityKey: string;
  plan: PlanState;
  revisionKey: string;
  hidden?: boolean;
};

type DisplayMode = "auto" | "expanded" | "collapsed";
export function FloatingPlanStatus({ identityKey, plan, revisionKey, hidden = false }: FloatingPlanStatusProps) {
  const { t } = useTranslation("chat");
  const contentId = useId();
  const [displayMode, setDisplayMode] = useState<DisplayMode>("auto");
  const previousIdentityRef = useRef(identityKey);
  const previousRevisionRef = useRef(revisionKey);
  const expanded = displayMode !== "collapsed";

  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identityKey;
    const revisionChanged = previousRevisionRef.current !== revisionKey;
    previousIdentityRef.current = identityKey;
    previousRevisionRef.current = revisionKey;

    if (identityChanged) {
      setDisplayMode("auto");
      return;
    }
    if (revisionChanged) {
      setDisplayMode((current) => current === "expanded" ? current : "auto");
    }
  }, [identityKey, revisionKey]);

  useEffect(() => {
    if (displayMode !== "auto" || hidden) return;
    const timer = window.setTimeout(() => {
      setDisplayMode("collapsed");
    }, FLOATING_PLAN_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [displayMode, revisionKey, hidden]);

  // Keep disclosure state while another surface displays this plan. Hidden time
  // does not consume the automatic reading interval when the note returns.
  if (hidden || !plan.steps.length) return null;

  const progressLabel = t("plan.completed", {
    completed: plan.completed,
    total: plan.total,
  });

  return (
    <div className="react-floating-plan" data-expanded={expanded ? "true" : "false"}>
      <section
        aria-hidden={!expanded}
        aria-label={t("plan.floatingLabel")}
        aria-live="polite"
        className="react-floating-plan__note"
      >
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${t("plan.floatingCollapse")}. ${progressLabel}`}
          className="react-floating-plan__heading"
          tabIndex={expanded ? 0 : -1}
          type="button"
          onClick={() => setDisplayMode("collapsed")}
        >
          <span className="react-floating-plan__title">
            <ListChecks aria-hidden="true" size={16} />
            <strong>{t("plan.label")}</strong>
          </span>
          <span className="react-floating-plan__count">{progressLabel}</span>
          <ChevronUp aria-hidden="true" size={15} />
        </button>
        <div className="react-floating-plan__content" id={contentId}>
          <progress
            aria-label={progressLabel}
            aria-valuemax={plan.total}
            aria-valuemin={0}
            aria-valuenow={plan.completed}
            max={Math.max(plan.total, 1)}
            value={plan.completed}
          />
          <PlanSteps plan={plan} />
        </div>
      </section>

      <button
        aria-hidden={expanded}
        aria-label={`${t("plan.floatingExpand")}. ${progressLabel}`}
        className="react-floating-plan__capsule"
        tabIndex={expanded ? -1 : 0}
        type="button"
        onClick={() => setDisplayMode("expanded")}
      >
        <ListChecks aria-hidden="true" size={15} />
        <span>{plan.completed}/{plan.total}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
