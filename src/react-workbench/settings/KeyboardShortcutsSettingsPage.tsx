import { Keyboard, Pencil, RotateCcw, Search, Trash2 } from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_SHORTCUT_PREFERENCES,
  SHORTCUT_COMMAND_IDS,
  findShortcutConflict,
  shortcutFromKeyboardEvent,
  type ShortcutCommandId,
} from "../../app-core/settings/appShortcuts";
import { useAppShortcuts } from "./AppShortcutContext";

export function KeyboardShortcutsSettingsPage() {
  const { preferences, resetAll, resetBinding, setBinding } = useAppShortcuts();
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [recordingCommandId, setRecordingCommandId] = useState<ShortcutCommandId | null>(null);
  const [error, setError] = useState<{ commandId: ShortcutCommandId; message: string } | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCommandIds = useMemo(() => SHORTCUT_COMMAND_IDS.filter((commandId) => {
    if (!normalizedQuery) return true;
    return [
      t(`shortcuts.commands.${commandId}.label`),
      t(`shortcuts.commands.${commandId}.description`),
      preferences[commandId] ?? t("shortcuts.unassigned"),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  }), [normalizedQuery, preferences, t]);

  function startRecording(commandId: ShortcutCommandId) {
    setError(null);
    setRecordingCommandId(commandId);
  }

  function captureShortcut(commandId: ShortcutCommandId, event: ReactKeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setError(null);
      setRecordingCommandId(null);
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      if (!["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) {
        setError({ commandId, message: t("shortcuts.modifierRequired") });
      }
      return;
    }
    const conflictId = findShortcutConflict(preferences, commandId, shortcut);
    if (conflictId) {
      setError({
        commandId,
        message: t("shortcuts.conflict", {
          command: t(`shortcuts.commands.${conflictId}.label`),
          shortcut,
        }),
      });
      return;
    }
    setBinding(commandId, shortcut);
    setError(null);
    setRecordingCommandId(null);
  }

  return (
    <section className="react-shortcuts-settings" aria-labelledby="keyboard-shortcuts-title">
      <header className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("shortcuts.eyebrow")}</span>
          <h2 id="keyboard-shortcuts-title">{t("shortcuts.title")}</h2>
          <p>{t("shortcuts.description")}</p>
        </div>
      </header>

      <div className="react-shortcuts-toolbar">
        <label className="react-shortcuts-search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-label={t("shortcuts.searchLabel")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("shortcuts.searchPlaceholder")}
            type="search"
            value={query}
          />
        </label>
        <button className="react-shortcuts-reset-all" onClick={resetAll} type="button">
          <RotateCcw aria-hidden="true" size={14} />
          {t("shortcuts.resetAll")}
        </button>
      </div>

      {visibleCommandIds.length > 0 ? (
        <div className="react-shortcuts-list">
          {visibleCommandIds.map((commandId) => {
            const label = t(`shortcuts.commands.${commandId}.label`);
            const binding = preferences[commandId];
            const isRecording = recordingCommandId === commandId;
            const isDefault = binding === DEFAULT_SHORTCUT_PREFERENCES[commandId];
            const errorMessage = error?.commandId === commandId ? error.message : null;
            return (
              <div className="react-shortcut-row" data-recording={isRecording ? "true" : "false"} key={commandId}>
                <span className="react-shortcut-row__copy">
                  <strong>{label}</strong>
                  <small>{t(`shortcuts.commands.${commandId}.description`)}</small>
                  {errorMessage ? <span className="react-shortcut-row__error" role="alert">{errorMessage}</span> : null}
                </span>
                <span className="react-shortcut-row__binding">
                  {isRecording ? (
                    <button
                      aria-label={t("shortcuts.recordingAria", { command: label })}
                      autoFocus
                      className="react-shortcut-recorder"
                      data-shortcut-recorder
                      onKeyDown={(event) => captureShortcut(commandId, event)}
                      type="button"
                    >
                      <Keyboard aria-hidden="true" size={14} />
                      {t("shortcuts.recording")}
                    </button>
                  ) : binding ? <kbd>{binding}</kbd> : <span>{t("shortcuts.unassigned")}</span>}
                </span>
                <span className="react-shortcut-row__actions">
                  <button
                    aria-label={t("shortcuts.editAria", { command: label })}
                    onClick={() => startRecording(commandId)}
                    title={t("shortcuts.edit")}
                    type="button"
                  >
                    <Pencil aria-hidden="true" size={14} />
                  </button>
                  <button
                    aria-label={t("shortcuts.clearAria", { command: label })}
                    disabled={binding === null}
                    onClick={() => {
                      setBinding(commandId, null);
                      setError(null);
                      setRecordingCommandId(null);
                    }}
                    title={t("shortcuts.clear")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                  <button
                    aria-label={t("shortcuts.resetAria", { command: label })}
                    disabled={isDefault}
                    onClick={() => {
                      resetBinding(commandId);
                      setError(null);
                      setRecordingCommandId(null);
                    }}
                    title={t("shortcuts.reset")}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="react-shortcuts-empty">
          <Search aria-hidden="true" size={18} />
          <strong>{t("shortcuts.noResults")}</strong>
          <span>{t("shortcuts.noResultsDescription")}</span>
        </div>
      )}

      <small className="react-app-settings__persistence">{t("shortcuts.persistence")}</small>
    </section>
  );
}
