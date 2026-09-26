import { AlertTriangle, Check, Circle, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlanState } from "../../app-core/chat/chatTurnContracts";

/** The same recorded explanation and step states in both progress locations. */
export function PlanSteps({ plan }: { plan: PlanState }) {
  const { t } = useTranslation("chat");
  return <>
    {plan.explanation ? <p className="react-canonical-plan__explanation">{plan.explanation}</p> : null}
    <ol className="react-canonical-plan__steps">
      {plan.steps.map((step, index) => {
        const status = step.status === "in_progress" ? "inProgress" : step.status;
        const Icon = { completed: Check, in_progress: Loader2, failed: AlertTriangle, cancelled: X, pending: Circle }[step.status];
        return <li data-status={step.status} key={`${index}:${step.step}`}>
          <span aria-label={t(`plan.status.${status}`)} className="react-canonical-plan__step-icon" role="img"><Icon size={step.status === "pending" ? 10 : 13} /></span>
          <span>{step.step}</span>
        </li>;
      })}
    </ol>
  </>;
}
