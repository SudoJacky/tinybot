import { SettingsChoiceList } from "../settings/SettingsChoiceList";
import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import type {
  TeamPlan,
  TeamRun,
  TeamTask,
} from "../../app-core/native/desktopNativeTeams";

export function TeamPlanEditor({
  plan,
  run,
  busy,
  onChange,
  onSubmit,
  onDiscard,
}: {
  plan: TeamPlan;
  run: TeamRun;
  busy: boolean;
  onChange(plan: TeamPlan): void;
  onSubmit(): void;
  onDiscard(): void;
}) {
  const { t } = useTranslation("common");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, []);
  function updateTask(id: string, patch: Partial<TeamTask>) {
    onChange({
      ...plan,
      tasks: plan.tasks.map((task) =>
        task.id === id ? { ...task, ...patch } : task,
      ),
    });
  }
  return (
    <form
      className="team-plan-editor"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="team-plan-fields">
        {plan.tasks.map((task) => (
          <fieldset
            key={task.id}
            disabled={
              busy ||
              !!run.tasks.find((record) => record.task.id === task.id)?.attempts
                .length
            }
          >
            <legend>{task.title}</legend>
            <label className="react-settings-choice__label">
              {t("teams.taskTitle")}
              <input
                className="react-form-input"
                required
                value={task.title}
                onChange={(event) =>
                  updateTask(task.id, { title: event.target.value })
                }
              />
            </label>
            <SettingsChoiceList
              menuPosition="fixed"
              label={t("teams.owner")}
              value={task.memberId}
              disabled={
                busy ||
                !!run.tasks.find((record) => record.task.id === task.id)?.attempts
                  .length
              }
              onChange={(memberId) => updateTask(task.id, { memberId })}
              options={run.spec.members.map((member) => ({
                value: member.id,
                label: member.displayName,
              }))}
            />
            <label className="react-settings-choice__label">
              {t("teams.instructions")}
              <textarea
                className="react-form-input"
                required
                value={task.instructions}
                onChange={(event) =>
                  updateTask(task.id, { instructions: event.target.value })
                }
              />
            </label>
            <div className="team-plan-dependencies">
              {t("teams.dependencies")}
              {plan.tasks
                .filter((item) => item.id !== task.id)
                .map((dependency) => (
                  <label className="team-check" key={dependency.id}>
                    <input
                      type="checkbox"
                      checked={task.dependencies.includes(dependency.id)}
                      onChange={(event) =>
                        updateTask(task.id, {
                          dependencies: event.target.checked
                            ? [...task.dependencies, dependency.id]
                            : task.dependencies.filter(
                                (id) => id !== dependency.id,
                              ),
                        })
                      }
                    />
                    {dependency.title}
                  </label>
                ))}
            </div>
          </fieldset>
        ))}
        <SettingsChoiceList
          menuPosition="fixed"
          label={t("teams.finalTask")}
          value={plan.finalTaskId}
          disabled={busy}
          onChange={(finalTaskId) => onChange({ ...plan, finalTaskId })}
          options={plan.tasks.map((task) => ({
            value: task.id,
            label: task.title,
          }))}
        />
      </div>
      <div className="team-editor-actions">
        <button className="react-form-primary" disabled={busy}>
          {t("teams.save")}
        </button>
        <button type="button" disabled={busy} onClick={onDiscard}>
          {t("teams.discard")}
        </button>
      </div>
    </form>
  );
}
