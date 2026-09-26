import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlanState } from "../../app-core/chat/chatTurnContracts";
import { PlanSteps } from "../chat/PlanSteps";

export function TeamMainPlan({ plan }: { plan: PlanState }) {
  const { t } = useTranslation("chat");
  const status = plan.currentStep ?? (plan.completed === plan.total ? t("plan.status.completed")
    : plan.steps.some(step => step.status === "failed") ? t("plan.status.failed")
    : plan.steps.some(step => step.status === "cancelled") ? t("plan.status.cancelled") : t("plan.noCurrentStep"));
  return <details className="team-main-plan" onKeyDown={event => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary>
      <strong>{t("plan.mainTask")} {plan.completed}/{plan.total}</strong>
      <span title={status}>· {status}</span><ChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="team-main-plan__steps"><PlanSteps plan={plan} /></div>
  </details>;
}
