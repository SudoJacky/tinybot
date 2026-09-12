import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import { SettingsChoiceList, type SettingsChoiceOption } from "../settings/SettingsChoiceList";
import type { MemoryEntry, MemoryMutation } from "../services";

export function MemoryEditor({
  entry,
  workspaceOptions,
  pending,
  error,
  onClose,
  onSave,
}: {
  entry: MemoryEntry | null;
  workspaceOptions: SettingsChoiceOption[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (mutation: MemoryMutation) => void;
}) {
  const { t } = useTranslation("memory");
  const [content, setContent] = useState(entry?.content ?? "");
  const [scope, setScope] = useState<"user" | "workspace">(entry?.scope ?? "user");
  const [path, setPath] = useState(
    entry?.path ?? workspaceOptions.find((option) => !option.disabled)?.value ?? "",
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const busy = pending || picking;
  const options =
    path && !workspaceOptions.some((option) => option.value === path)
      ? [
          ...workspaceOptions,
          {
            value: path,
            label: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
            description: path,
          },
        ]
      : workspaceOptions;
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLFormElement>({
    onClose,
    closeEnabled: !busy,
  });
  async function chooseWorkspace() {
    setPicking(true);
    setLocalError(null);
    try {
      const selected = await pickDesktopWorkspaceDirectory();
      if (selected) setPath(selected);
    } catch (cause) {
      console.error("[memory-editor] workspace picker failed", cause);
      setLocalError(String(cause));
    } finally {
      setPicking(false);
    }
  }
  return createPortal(
    <div className="react-memory-modal" onPointerDown={onBackdropPointerDown}>
      <form
        className="react-memory-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-editor-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!content.trim() || /[\r\n]/.test(content)) {
            setLocalError(t("manage.oneFact"));
            return;
          }
          const value = {
            scope,
            path: scope === "workspace" ? path.trim() : null,
            content: content.trim(),
          };
          onSave(
            entry
              ? { operation: "update", id: entry.id, ...value }
              : { operation: "create", ...value },
          );
        }}
      >
        <h2 id="memory-editor-title">{t(entry ? "manage.edit" : "manage.add")}</h2>
        <label>
          <span id="memory-content-label">{t("manage.content")}</span>
          <textarea
            aria-labelledby="memory-content-label"
            data-dialog-initial-focus
            value={content}
            maxLength={2000}
            rows={4}
            required
            disabled={busy}
            onChange={(event) => {
              setContent(event.target.value);
              setLocalError(null);
            }}
          />
        </label>
        <SettingsChoiceList
          label={t("manage.scope")}
          value={scope}
          disabled={busy}
          onChange={(value) => setScope(value as "user" | "workspace")}
          options={[
            { value: "user", label: t("manage.allWorkspaces") },
            { value: "workspace", label: t("manage.oneWorkspace") },
          ]}
        />
        {scope === "workspace" ? (
          <div className="react-memory-workspace-picker">
            <SettingsChoiceList
              label={t("manage.workspacePath")}
              value={path}
              options={options}
              disabled={busy}
              onChange={setPath}
            />
            <button type="button" disabled={busy} onClick={() => void chooseWorkspace()}>
              {t("manage.browse")}
            </button>
            <p className="react-memory-workspace-path">{path}</p>
          </div>
        ) : null}
        <p className="react-memory-dialog__hint">{t("manage.protectionNote")}</p>
        <p className="react-memory-dialog__hint">{t("snapshotNote")}</p>
        {localError || error ? (
          <p role="alert" className="react-memory-dialog__error">
            {localError || error}
          </p>
        ) : null}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {t("manage.cancel")}
          </button>
          <button className="react-memory-primary" type="submit" disabled={busy}>
            {t(pending ? "manage.saving" : "manage.save")}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

export function MemoryDeleteDialog({
  entries,
  pending,
  error,
  onClose,
  onDelete,
}: {
  entries: MemoryEntry[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("memory");
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({
    onClose,
    closeEnabled: !pending,
  });
  return createPortal(
    <div className="react-memory-modal" onPointerDown={onBackdropPointerDown}>
      <div
        className="react-memory-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-delete-title"
      >
        <h2 id="memory-delete-title">{t("manage.deleteTitle", { count: entries.length })}</h2>
        <p className="react-memory-dialog__hint">{t("manage.deleteNote")}</p>
        <ul className="react-memory-delete-preview">
          {entries.map((entry) => (
            <li key={entry.id}>{entry.content}</li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="react-memory-dialog__error">
            {error}
          </p>
        ) : null}
        <footer>
          <button data-dialog-initial-focus disabled={pending} onClick={onClose}>
            {t("manage.cancel")}
          </button>
          <button className="react-memory-danger" disabled={pending} onClick={onDelete}>
            {t(pending ? "manage.deleting" : "manage.delete")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
