import { History, Play, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import type { SaveAutomation } from "../../app-core/native/desktopNativeAutomations";
import type { AppServices, SessionSummary, WorkspaceRegistryEntry } from "../services";

import type { ProviderModelsSettingsData } from "../../app-core/settings/providerModelsSettings";
import { AutomationSettings } from "./AutomationSettings";

export function AutomationEditor({ services, draft, workspaces, busy, error, onChange, onClose, onSave, onDelete, onHistory, workspaceAction }: {
  workspaceAction?: ReactNode;
  services: AppServices;
  draft: SaveAutomation;
  workspaces: WorkspaceRegistryEntry[];
  busy: boolean;
  error: string | null;
  onChange: (draft: SaveAutomation) => void;
  onClose: () => void;
  onSave: (runAfterSave: boolean) => void;
  onDelete: () => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const [options, setOptions] = useState<{ catalog: ProviderModelsSettingsData; sessions: SessionSummary[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (!services.settingsStore.loadProviderSettings) throw new Error("Provider settings are unavailable");
        const [catalog, sessions] = await Promise.all([services.settingsStore.loadProviderSettings(), services.sessionStore.list()]);
        if (active) setOptions({ catalog, sessions });
      } catch (error) { if (active) setLoadError(String(error)); }
    };
    void load();
    return () => { active = false; };
  }, [services]);
  const canSave = options && workspaces.some((workspace) => workspace.exists && workspace.path === draft.workspacePath);
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({ onClose, closeEnabled: !busy });
  return createPortal(
    <div className="automation-dialog-backdrop" onPointerDown={onBackdropPointerDown}>
      <div className="react-form-controls automation-ui automation-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="automation-dialog-header">
          <span id={titleId} className="automation-editor-status">{draft.id ? t("automations.savedTask") : t("automations.create")}</span>
          <div className="automation-actions">
            {draft.id && <button type="button" className="automation-icon-button" aria-label={t("automations.history")} title={t("automations.history")} disabled={busy} onClick={onHistory}><History size={19} /></button>}
            <button type="button" className="automation-icon-button" aria-label={t("automations.closeEditor")} title={t("automations.closeEditor")} disabled={busy} onClick={onClose}><X size={21} /></button>
          </div>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); if (canSave) onSave(false); }}>
          <div className="automation-editor-content">
            <input className="react-form-input automation-name-input" aria-label={t("automations.name")} placeholder={t("automations.namePlaceholder")} data-dialog-initial-focus required value={draft.name} disabled={busy} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
            <textarea className="react-form-input automation-instructions-input" aria-label={t("automations.instructions")} placeholder={t("automations.instructionsPlaceholder")} required rows={3} value={draft.instructions} disabled={busy} onChange={(e) => onChange({ ...draft, instructions: e.target.value })} />

            {workspaceAction}
            {options ? <AutomationSettings draft={draft} workspaces={workspaces} catalog={options.catalog} sessions={options.sessions} busy={busy} onChange={onChange} />
              : <p role={loadError ? "alert" : "status"}>{loadError ?? t("automations.loading")}</p>}
            {error && <p role="alert" className="automation-error">{error}</p>}
          </div>
          <footer className="automation-editor-footer">
            {draft.id && <button type="button" className="react-form-danger automation-delete" disabled={busy} title={t("automations.deleteHint")} onClick={onDelete}>{t("automations.delete")}</button>}
            <div className="automation-actions">
              <button type="button" disabled={busy} onClick={onClose}>{t("automations.cancel")}</button>
              {draft.id && <button type="button" disabled={busy || !canSave} onClick={(event) => { if (event.currentTarget.form?.reportValidity()) onSave(true); }}><Play size={15} />{t("automations.saveAndRun")}</button>}
              <button type="submit" className="react-form-primary" disabled={busy || !canSave}>{t("automations.save")}</button>
            </div>
          </footer>
        </form>
      </div>
    </div>, document.body,
  );
}
