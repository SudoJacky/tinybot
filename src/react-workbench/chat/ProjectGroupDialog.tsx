import { FolderPlus, Loader2, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import type { ProjectGroup } from "../services";
import { normalizedWorkspacePathKey, sessionWorkspaceName } from "./sessionWorkspaces";

type ProjectGroupDialogProps = {
  availableWorkspaceIds: string[];
  group?: ProjectGroup;
  onChooseWorkspace: () => Promise<string | undefined>;
  onClose: () => void;
  onDelete?: (projectGroupId: string) => Promise<void>;
  onSave: (input: {
    projectGroupId?: string;
    name: string;
    workspaceIds: string[];
  }) => Promise<void>;
};

export function ProjectGroupDialog({
  availableWorkspaceIds,
  group,
  onChooseWorkspace,
  onClose,
  onDelete,
  onSave,
}: ProjectGroupDialogProps) {
  const { t } = useTranslation("chat");
  const [name, setName] = useState(group?.name ?? "");
  const [selectedIds, setSelectedIds] = useState(() => new Set(group?.workspaceIds ?? []));
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [error, setError] = useState("");
  const workspaceIds = useMemo(() => uniqueWorkspaceIds([
    ...(group?.workspaceIds ?? []),
    ...availableWorkspaceIds,
    ...addedIds,
  ]), [addedIds, availableWorkspaceIds, group?.workspaceIds]);
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({
    closeEnabled: !pending,
    onClose,
  });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !selectedIds.size || pending) return;
    setPending(true);
    setError("");
    try {
      await onSave({
        ...(group ? { projectGroupId: group.projectGroupId } : {}),
        name: name.trim(),
        workspaceIds: workspaceIds.filter((workspaceId) => selectedIds.has(workspaceId)),
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  }

  async function handleChooseWorkspace() {
    if (pending) return;
    setError("");
    try {
      const workspaceId = await onChooseWorkspace();
      if (!workspaceId) return;
      setAddedIds((current) => uniqueWorkspaceIds([...current, workspaceId]));
      setSelectedIds((current) => new Set(current).add(workspaceId));
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    }
  }

  async function handleDelete() {
    if (!group || !onDelete || pending) return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setPending(true);
    setError("");
    try {
      await onDelete(group.projectGroupId);
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      setPending(false);
    }
  }

  return (
    <div
      className="react-project-dialog-backdrop"
      onPointerDown={onBackdropPointerDown}
    >
      <div
        aria-describedby="project-group-dialog-description"
        aria-labelledby="project-group-dialog-title"
        aria-modal="true"
        className="react-project-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="project-group-dialog-title">
              {group ? t("projectGroups.editTitle") : t("projectGroups.createTitle")}
            </h2>
            <p id="project-group-dialog-description">{t("projectGroups.description")}</p>
          </div>
          <button aria-label={t("projectGroups.close")} disabled={pending} onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <label className="react-project-dialog__name" htmlFor="project-group-name">
            <span>{t("projectGroups.name")}</span>
            <input
              autoComplete="off"
              data-dialog-initial-focus
              id="project-group-name"
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder={t("projectGroups.namePlaceholder")}
              value={name}
            />
          </label>

          <fieldset>
            <legend>{t("projectGroups.workspaces")}</legend>
            <p>{t("projectGroups.workspacesHelp")}</p>
            <div className="react-project-dialog__workspace-list">
              {workspaceIds.map((workspaceId) => (
                <label key={normalizedWorkspacePathKey(workspaceId)}>
                  <input
                    checked={selectedIds.has(workspaceId)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (checked) next.add(workspaceId);
                        else next.delete(workspaceId);
                        return next;
                      });
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>{sessionWorkspaceName(workspaceId)}</strong>
                    <small>{workspaceId}</small>
                  </span>
                </label>
              ))}
              {!workspaceIds.length ? <p className="react-project-dialog__empty">{t("projectGroups.noWorkspaces")}</p> : null}
            </div>
            <button className="react-project-dialog__choose" disabled={pending} onClick={() => void handleChooseWorkspace()} type="button">
              <FolderPlus aria-hidden="true" size={15} />
              {t("projectGroups.chooseFolder")}
            </button>
          </fieldset>

          {error ? <p className="react-project-dialog__error" role="alert">{error}</p> : null}

          <footer>
            {group && onDelete ? (
              <button className="react-project-dialog__delete" disabled={pending} onClick={() => void handleDelete()} type="button">
                <Trash2 aria-hidden="true" size={14} />
                {deleteConfirm ? t("projectGroups.confirmDelete") : t("projectGroups.delete")}
              </button>
            ) : <span />}
            <div>
              <button disabled={pending} onClick={onClose} type="button">{t("projectGroups.cancel")}</button>
              <button disabled={pending || !name.trim() || !selectedIds.size} type="submit">
                {pending ? <Loader2 aria-hidden="true" className="react-session-list__pending" size={14} /> : null}
                {t("projectGroups.save")}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}

function uniqueWorkspaceIds(workspaceIds: string[]): string[] {
  const seen = new Set<string>();
  return workspaceIds.filter((workspaceId) => {
    const value = workspaceId.trim();
    if (!value) return false;
    const key = normalizedWorkspacePathKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
