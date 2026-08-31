import type { TFunction } from "i18next";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Circle, ListChecks, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanState } from "../../app-core/chat/chatTurnContracts";

export const FLOATING_PLAN_AUTO_COLLAPSE_MS = 5_000;

type FloatingPlanStatusProps = {
  identityKey: string;
  plan: PlanState;
  revisionKey: string;
};

type DisplayMode = "auto" | "expanded" | "collapsed";
type PlanStepStatus = PlanState["steps"][number]["status"];

export function FloatingPlanStatus({ identityKey, plan, revisionKey }: FloatingPlanStatusProps) {
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
    if (displayMode !== "auto") return;
    const timer = window.setTimeout(() => {
      setDisplayMode("collapsed");
    }, FLOATING_PLAN_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [displayMode, revisionKey]);

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
          {plan.explanation ? <p className="react-canonical-plan__explanation">{plan.explanation}</p> : null}
          <ol className="react-canonical-plan__steps">
            {plan.steps.map((step, index) => (
              <li data-status={step.status} key={`${index}:${step.step}`}>
                <span aria-hidden="true" className="react-canonical-plan__step-icon">
                  <FloatingPlanStepIcon status={step.status} />
                </span>
                <span>{step.step}</span>
                <small>{planStepStatusLabel(step.status, t)}</small>
              </li>
            ))}
          </ol>
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

function FloatingPlanStepIcon({ status }: { status: PlanStepStatus }) {
  switch (status) {
    case "completed": return <Check size={13} />;
    case "in_progress": return <Loader2 size={13} />;
    case "failed": return <AlertTriangle size={13} />;
    case "cancelled": return <X size={13} />;
    default: return <Circle size={10} />;
  }
}

function planStepStatusLabel(status: PlanStepStatus, t: TFunction<"chat">): string {
  switch (status) {
    case "completed": return t("plan.status.completed");
    case "in_progress": return t("plan.status.inProgress");
    case "failed": return t("plan.status.failed");
    case "cancelled": return t("plan.status.cancelled");
    default: return t("plan.status.pending");
  }
}
