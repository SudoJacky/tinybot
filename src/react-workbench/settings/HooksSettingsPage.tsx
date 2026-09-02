import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  NativeCommandHookSnapshot,
  NativeCommandHookSummary,
  NativeManagedHookLanguage,
  NativeManagedHookScript,
  NativeManagedHookTestResult,
} from "../../app-core/native/desktopNativeHooks";
import type { HooksStore, WorkspaceRegistryEntry, WorkspaceRegistryStore } from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";
import {
  indentScriptLines,
  outdentScriptLines,
  toggleScriptLineComments,
  type ScriptTextEdit,
} from "./hookScriptEditing";

type HookEvent = NativeCommandHookSummary["event"];
type MatcherTranslationKey =
  | "hooks.managed.matchers.allTools"
  | "hooks.managed.matchers.workspaceTools"
  | "hooks.managed.matchers.shellCommand"
  | "hooks.managed.matchers.allCompaction"
  | "hooks.managed.matchers.manualCompaction"
  | "hooks.managed.matchers.autoCompaction";

type ManagedHookEditor = {
  id?: string;
  name: string;
  event: HookEvent;
  matcher: string;
  customMatcher: boolean;
  language: NativeManagedHookLanguage;
  enabled: boolean;
  timeout: number;
};

type ManagedScriptEditor = NativeManagedHookScript & {
  savedContents: string;
};

export function HooksSettingsPage({
  hooksStore,
  workspaceRegistryStore,
}: {
  hooksStore: HooksStore;
  workspaceRegistryStore: WorkspaceRegistryStore;
}) {
  const { t } = useTranslation("settings");
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceRegistryEntry[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [workspaceCatalogReady, setWorkspaceCatalogReady] = useState(false);
  const [snapshot, setSnapshot] = useState<NativeCommandHookSnapshot | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [updatingHash, setUpdatingHash] = useState<string | null>(null);
  const [managedEditor, setManagedEditor] = useState<ManagedHookEditor | null>(null);
  const [savingManaged, setSavingManaged] = useState(false);
  const [testingManagedId, setTestingManagedId] = useState<string | null>(null);
  const [archivingManagedId, setArchivingManagedId] = useState<string | null>(null);
  const [managedTestResult, setManagedTestResult] = useState<NativeManagedHookTestResult | null>(null);
  const [scriptEditor, setScriptEditor] = useState<ManagedScriptEditor | null>(null);
  const [loadingScriptId, setLoadingScriptId] = useState<string | null>(null);
  const [savingScript, setSavingScript] = useState(false);
  const [scriptSaved, setScriptSaved] = useState(false);
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceCatalogReady(false);
    void workspaceRegistryStore.list()
      .then((workspaces) => {
        if (cancelled) return;
        setWorkspaceOptions(workspaces);
        setWorkspacePath((current) => (
          current || workspaces.find((workspace) => workspace.exists)?.path
        ));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setWorkspaceCatalogReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRegistryStore]);

  useEffect(() => {
    if (!workspaceCatalogReady) return;
    let cancelled = false;
    setError(null);
    void hooksStore.load(workspacePath)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setWorkspacePath((current) => current || workspaceDisplayPath(next.workspaceRoot));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hooksStore, loadRevision, workspaceCatalogReady, workspacePath]);

  const selectedWorkspace = workspacePath || snapshot?.workspaceRoot;
  const matcherOptions = useMemo(
    () => managedEditor ? hookMatcherOptions(managedEditor.event) : [],
    [managedEditor],
  );
  const managedHooks = useMemo(
    () => snapshot?.hooks.filter((hook) => hook.managed) ?? [],
    [snapshot],
  );
  const scriptDirty = Boolean(scriptEditor && scriptEditor.contents !== scriptEditor.savedContents);

  function selectWorkspace(path: string): boolean {
    if (!confirmDiscardScript()) return false;
    setManagedEditor(null);
    setManagedTestResult(null);
    setScriptEditor(null);
    setScriptSaved(false);
    setSnapshot(null);
    setWorkspacePath(path);
    return true;
  }

  function reloadHooks() {
    if (!confirmDiscardScript()) return;
    setScriptEditor(null);
    setScriptSaved(false);
    setLoadRevision((value) => value + 1);
  }

  async function setTrusted(hook: NativeCommandHookSummary, trusted: boolean) {
    if (trusted && !window.confirm(t("hooks.confirmTrust", {
      command: hook.command,
      event: hook.event,
    }))) {
      return;
    }
    setUpdatingHash(hook.hash);
    setError(null);
    try {
      const next = await hooksStore.setTrusted({
        ...(selectedWorkspace ? { workspacePath: selectedWorkspace } : {}),
        hash: hook.hash,
        trusted,
      });
      setSnapshot(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUpdatingHash(null);
    }
  }

  function startCreateManaged() {
    setManagedEditor({
      name: "",
      event: "PreToolUse",
      matcher: "*",
      customMatcher: false,
      language: defaultManagedHookLanguage(),
      enabled: true,
      timeout: 30,
    });
  }

  function startEditManaged(hook: NativeCommandHookSummary) {
    if (!hook.managed) return;
    if (!confirmDiscardScript()) return;
    setScriptEditor(null);
    setScriptSaved(false);
    const matcher = hook.matcher || defaultMatcher(hook.event);
    setManagedEditor({
      id: hook.managed.id,
      name: hook.managed.name,
      event: hook.event,
      matcher,
      customMatcher: !hookMatcherOptions(hook.event).some((option) => option.value === matcher),
      language: hook.managed.language,
      enabled: hook.enabled,
      timeout: hook.timeout,
    });
  }

  async function saveManaged(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!managedEditor || !selectedWorkspace) return;
    setSavingManaged(true);
    setError(null);
    try {
      const matcher = managedEditor.event === "UserPromptSubmit"
        ? undefined
        : managedEditor.matcher.trim() || "*";
      const next = await hooksStore.saveManaged({
        workspacePath: selectedWorkspace,
        ...(managedEditor.id ? { id: managedEditor.id } : {}),
        name: managedEditor.name,
        event: managedEditor.event,
        ...(matcher ? { matcher } : {}),
        language: managedEditor.language,
        enabled: managedEditor.enabled,
        timeout: managedEditor.timeout,
      });
      setSnapshot(next);
      setManagedEditor(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingManaged(false);
    }
  }

  async function setManagedEnabled(hook: NativeCommandHookSummary, enabled: boolean) {
    if (!hook.managed || !selectedWorkspace) return;
    setSavingManaged(true);
    setError(null);
    try {
      const next = await hooksStore.saveManaged({
        workspacePath: selectedWorkspace,
        id: hook.managed.id,
        name: hook.managed.name,
        event: hook.event,
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        language: hook.managed.language,
        enabled,
        timeout: hook.timeout,
      });
      setSnapshot(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingManaged(false);
    }
  }

  async function revealScript(hook: NativeCommandHookSummary) {
    if (!hook.managed) return;
    setError(null);
    try {
      await revealItemInDir(hook.managed.scriptPath);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function openScript(hook: NativeCommandHookSummary, discardConfirmed = false) {
    if (!hook.managed || !selectedWorkspace) return;
    if (!discardConfirmed && !confirmDiscardScript()) return;
    setLoadingScriptId(hook.managed.id);
    setScriptSaved(false);
    setError(null);
    try {
      const script = await hooksStore.readManagedScript({
        workspacePath: selectedWorkspace,
        id: hook.managed.id,
      });
      setScriptEditor({ ...script, savedContents: script.contents });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingScriptId(null);
    }
  }

  async function saveScript(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scriptEditor || !selectedWorkspace) return;
    setSavingScript(true);
    setScriptSaved(false);
    setError(null);
    try {
      const saved = await hooksStore.saveManagedScript({
        workspacePath: selectedWorkspace,
        id: scriptEditor.id,
        contents: scriptEditor.contents,
        expectedRevision: scriptEditor.revision,
      });
      setScriptEditor({ ...saved, savedContents: saved.contents });
      setScriptSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingScript(false);
    }
  }

  function closeScriptEditor() {
    if (!confirmDiscardScript()) return;
    setScriptEditor(null);
    setScriptSaved(false);
  }

  function confirmDiscardScript(): boolean {
    return !scriptDirty || window.confirm(t("hooks.managed.confirmDiscardScript"));
  }

  function hookAppliesTo(hook: NativeCommandHookSummary): string {
    if (hook.event === "UserPromptSubmit") return t("hooks.managed.matchers.everyPrompt");
    const option = hookMatcherOptions(hook.event)
      .find((candidate) => candidate.value === (hook.matcher || "*"));
    return option ? t(option.label) : hook.matcher || "*";
  }

  function applyScriptTextEdit(edit: ScriptTextEdit) {
    if (!scriptEditor) return;
    setScriptSaved(false);
    setScriptEditor({ ...scriptEditor, contents: edit.contents });
    window.requestAnimationFrame(() => {
      scriptTextareaRef.current?.focus();
      scriptTextareaRef.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  function editScriptSelection(
    edit: (contents: string, selectionStart: number, selectionEnd: number) => ScriptTextEdit,
  ) {
    if (!scriptEditor) return;
    const selectionStart = scriptTextareaRef.current?.selectionStart ?? 0;
    const selectionEnd = scriptTextareaRef.current?.selectionEnd ?? selectionStart;
    applyScriptTextEdit(edit(
      scriptEditor.contents,
      selectionStart,
      selectionEnd,
    ));
  }

  function onScriptEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && (event.key === "/" || event.code === "Slash")) {
      event.preventDefault();
      editScriptSelection(toggleScriptLineComments);
      return;
    }
    if (commandKey && event.key.toLocaleLowerCase("en-US") === "s") {
      event.preventDefault();
      if (scriptDirty && !savingScript) event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      editScriptSelection(event.shiftKey ? outdentScriptLines : indentScriptLines);
    }
  }

  async function testManaged(hook: NativeCommandHookSummary) {
    if (!hook.managed || !selectedWorkspace) return;
    setTestingManagedId(hook.managed.id);
    setManagedTestResult(null);
    setError(null);
    try {
      setManagedTestResult(await hooksStore.testManaged({
        workspacePath: selectedWorkspace,
        id: hook.managed.id,
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTestingManagedId(null);
    }
  }

  async function archiveManaged(hook: NativeCommandHookSummary) {
    if (!hook.managed || !selectedWorkspace) return;
    if (!window.confirm(t("hooks.managed.confirmArchive", { name: hook.managed.name }))) return;
    setArchivingManagedId(hook.managed.id);
    setManagedTestResult(null);
    setError(null);
    try {
      setSnapshot(await hooksStore.archiveManaged({
        workspacePath: selectedWorkspace,
        id: hook.managed.id,
      }));
      if (scriptEditor?.id === hook.managed.id) {
        setScriptEditor(null);
        setScriptSaved(false);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setArchivingManagedId(null);
    }
  }

  return (
    <section className="react-hooks-settings" aria-labelledby="hooks-settings-title">
      <div className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("hooks.eyebrow")}</span>
          <h2 id="hooks-settings-title">{t("hooks.title")}</h2>
          <p>{t("hooks.description")}</p>
        </div>
        <button
          className="react-hooks-settings__create"
          disabled={!selectedWorkspace || savingManaged}
          onClick={startCreateManaged}
          type="button"
        >
          {t("hooks.managed.create")}
        </button>
      </div>

      <div className="react-hooks-settings__workspace">
        <SettingsChoiceList
          ariaLabel={t("hooks.workspace")}
          description={t("hooks.workspaceDescription")}
          disabled={!workspaceCatalogReady || !workspaceOptions.some((workspace) => workspace.exists)}
          label={t("hooks.workspace")}
          onChange={selectWorkspace}
          options={workspaceOptions.map((workspace) => ({
            description: workspace.path,
            disabled: !workspace.exists,
            label: workspace.name,
            value: workspace.path,
          }))}
          optionsAriaLabel={t("hooks.workspaceOptions")}
          value={selectedWorkspace || ""}
        />
        <button onClick={reloadHooks} type="button">
          {t("hooks.reload")}
        </button>
      </div>

      {snapshot ? (
        <div className="react-hooks-settings__script-picker">
          <SettingsChoiceList
            ariaLabel={t("hooks.managed.scripts")}
            badge={managedHooks.length ? String(managedHooks.length) : undefined}
            description={t(managedHooks.length ? "hooks.managed.chooseScript" : "hooks.managed.noScripts")}
            disabled={!managedHooks.length || loadingScriptId !== null}
            label={t("hooks.managed.scripts")}
            onChange={(id) => {
              const hook = managedHooks.find((candidate) => candidate.managed?.id === id);
              if (!hook || (scriptDirty && !confirmDiscardScript())) return;
              void openScript(hook, true);
            }}
            options={[
              {
                disabled: true,
                label: t(managedHooks.length ? "hooks.managed.chooseScript" : "hooks.managed.noScripts"),
                value: "",
              },
              ...managedHooks.map((hook) => ({
                description: `${fileName(hook.managed!.scriptPath)} · ${managedLanguageLabel(hook.managed!.language)}`,
                label: hook.managed!.name,
                value: hook.managed!.id,
              })),
            ]}
            optionsAriaLabel={t("hooks.managed.scriptOptions")}
            value={scriptEditor?.id || ""}
          />
          {loadingScriptId ? <span role="status">{t("hooks.managed.loadingScript")}</span> : null}
        </div>
      ) : null}

      {scriptEditor ? (
        <form className="react-hooks-settings__script-editor" onSubmit={saveScript}>
          <header>
            <div>
              <h3>{t("hooks.managed.scriptEditorTitle", { name: scriptEditor.name })}</h3>
              <code>{scriptEditor.path}</code>
            </div>
            <span data-dirty={scriptDirty} role="status">
              {scriptSaved
                ? t("hooks.managed.scriptSaved")
                : scriptDirty ? t("hooks.managed.unsavedScript") : t("hooks.managed.scriptCurrent")}
            </span>
          </header>
          <div className="react-hooks-settings__script-field">
            <div className="react-hooks-settings__script-toolbar">
              <label htmlFor="managed-hook-script-contents">{t("hooks.managed.scriptContents")}</label>
              <div>
                <button
                  onClick={() => editScriptSelection(toggleScriptLineComments)}
                  title={t("hooks.managed.toggleCommentShortcut", { modifier: shortcutModifier() })}
                  type="button"
                >
                  {t("hooks.managed.toggleComment")}
                  <kbd>{shortcutModifier()}+/</kbd>
                </button>
                <button onClick={() => editScriptSelection(outdentScriptLines)} type="button">
                  {t("hooks.managed.outdent")}
                </button>
                <button onClick={() => editScriptSelection(indentScriptLines)} type="button">
                  {t("hooks.managed.indent")}
                </button>
              </div>
            </div>
            <textarea
              aria-label={t("hooks.managed.scriptContents")}
              autoCapitalize="off"
              autoCorrect="off"
              id="managed-hook-script-contents"
              onKeyDown={onScriptEditorKeyDown}
              onChange={(event) => {
                setScriptSaved(false);
                setScriptEditor({ ...scriptEditor, contents: event.target.value });
              }}
              ref={scriptTextareaRef}
              spellCheck={false}
              value={scriptEditor.contents}
            />
          </div>
          <footer>
            <small>{t("hooks.managed.scriptEditorHint", { modifier: shortcutModifier() })}</small>
            <div>
              <button disabled={savingScript} onClick={closeScriptEditor} type="button">
                {t("hooks.managed.closeScript")}
              </button>
              <button disabled={savingScript || !scriptDirty} type="submit">
                {savingScript ? t("hooks.managed.savingScript") : t("hooks.managed.saveScript")}
              </button>
            </div>
          </footer>
        </form>
      ) : null}

      {managedEditor ? (
        <form className="react-hooks-settings__editor" onSubmit={saveManaged}>
          <header>
            <div>
              <h3>{t(managedEditor.id ? "hooks.managed.editTitle" : "hooks.managed.createTitle")}</h3>
              <p>{t("hooks.managed.description")}</p>
            </div>
          </header>
          <div className="react-hooks-settings__editor-grid">
            <label>
              <span>{t("hooks.managed.name")}</span>
              <input
                autoFocus
                maxLength={80}
                onChange={(event) => setManagedEditor({ ...managedEditor, name: event.target.value })}
                placeholder={t("hooks.managed.namePlaceholder")}
                required
                value={managedEditor.name}
              />
            </label>
            <SettingsChoiceList
              label={t("hooks.managed.event")}
              onChange={(value) => {
                const nextEvent = value as HookEvent;
                setManagedEditor({
                  ...managedEditor,
                  event: nextEvent,
                  matcher: defaultMatcher(nextEvent),
                  customMatcher: false,
                });
              }}
              options={HOOK_EVENTS.map((event) => ({ label: event, value: event }))}
              value={managedEditor.event}
            />
            {managedEditor.event !== "UserPromptSubmit" ? (
              <SettingsChoiceList
                label={t("hooks.managed.appliesTo")}
                onChange={(value) => setManagedEditor({
                  ...managedEditor,
                  customMatcher: value === CUSTOM_MATCHER,
                  matcher: value === CUSTOM_MATCHER ? "" : value,
                })}
                options={[
                  ...matcherOptions.map((option) => ({
                    label: t(option.label),
                    value: option.value,
                  })),
                  { label: t("hooks.managed.matchers.custom"), value: CUSTOM_MATCHER },
                ]}
                value={managedEditor.customMatcher ? CUSTOM_MATCHER : managedEditor.matcher}
              />
            ) : null}
            <SettingsChoiceList
              label={t("hooks.managed.language")}
              onChange={(value) => setManagedEditor({
                  ...managedEditor,
                  language: value as NativeManagedHookLanguage,
              })}
              options={[
                { label: "PowerShell", value: "powershell" },
                { label: "POSIX shell", value: "shell" },
              ]}
              value={managedEditor.language}
            />
            {managedEditor.customMatcher ? (
              <label className="react-hooks-settings__editor-wide">
                <span>{t("hooks.managed.matcher")}</span>
                <input
                  onChange={(event) => setManagedEditor({ ...managedEditor, matcher: event.target.value })}
                  placeholder="^(workspace\\.|shell_command$)"
                  required
                  value={managedEditor.matcher}
                />
              </label>
            ) : null}
            <label>
              <span>{t("hooks.managed.timeout")}</span>
              <input
                max={600}
                min={1}
                onChange={(event) => setManagedEditor({ ...managedEditor, timeout: Number(event.target.value) })}
                required
                type="number"
                value={managedEditor.timeout}
              />
            </label>
          </div>
          <footer>
            <small>{t("hooks.managed.scriptHint")}</small>
            <div>
              <button disabled={savingManaged} onClick={() => setManagedEditor(null)} type="button">
                {t("hooks.managed.cancel")}
              </button>
              <button disabled={savingManaged} type="submit">
                {savingManaged ? t("hooks.managed.saving") : t("hooks.managed.save")}
              </button>
            </div>
          </footer>
        </form>
      ) : null}

      {error ? <p className="react-settings-alert" role="alert">{error}</p> : null}
      {managedTestResult ? (
        <div className="react-hooks-settings__test-result" role="status">
          <strong>{t("hooks.managed.testResult", { decision: managedTestResult.decision })}</strong>
          <span>{t("hooks.managed.testDuration", { duration: managedTestResult.durationMs })}</span>
          {managedTestResult.failure ? <code>{managedTestResult.failure}</code> : null}
          {managedTestResult.deniedReason || managedTestResult.toolFeedback || managedTestResult.additionalContext ? (
            <p>{managedTestResult.deniedReason || managedTestResult.toolFeedback || managedTestResult.additionalContext}</p>
          ) : null}
        </div>
      ) : null}
      {!snapshot ? (
        <p className="react-empty-state">{t("hooks.loading")}</p>
      ) : (
        <>
          {snapshot.diagnostics.length ? (
            <div className="react-hooks-settings__diagnostics" role="status">
              {snapshot.diagnostics.map((diagnostic, index) => (
                <p key={`${diagnostic.path}:${diagnostic.code}:${index}`}>
                  <strong>{diagnostic.code}</strong> {diagnostic.message} <code>{diagnostic.path}</code>
                </p>
              ))}
            </div>
          ) : null}

          {!snapshot.hooks.length ? (
            <p className="react-empty-state">{t("hooks.empty")}</p>
          ) : (
            <div className="react-hooks-settings__list">
              {snapshot.hooks.map((hook) => (
                <article className="react-hooks-settings__hook" data-enabled={hook.enabled} key={hook.hash}>
                  <header>
                    <div>
                      <strong>{hook.managed?.name || hook.statusMessage || hook.event}</strong>
                      <span>{hook.event} · {t(`hooks.source.${hook.source}`)} · {hookAppliesTo(hook)} · {t("hooks.timeout", { seconds: hook.timeout })}</span>
                    </div>
                    <div className="react-hooks-settings__badges">
                      <span className="react-hooks-settings__enabled" data-enabled={hook.enabled}>
                        {t(hook.enabled ? "hooks.managed.enabled" : "hooks.managed.disabled")}
                      </span>
                      <span className="react-hooks-settings__trust" data-trusted={hook.trusted}>
                        {hook.trusted ? t("hooks.trusted") : t("hooks.untrusted")}
                      </span>
                    </div>
                  </header>
                  {hook.managed ? <code className="react-hooks-settings__command">{hook.managed.scriptPath}</code> : <code className="react-hooks-settings__command">{hook.command}</code>}
                  {!hook.managed ? <small>{hook.sourcePath}</small> : null}
                  <footer>
                    <div className="react-hooks-settings__actions">
                      {hook.managed ? (
                        <>
                          <button onClick={() => void revealScript(hook)} type="button">{t("hooks.managed.reveal")}</button>
                          <button
                            disabled={loadingScriptId !== null}
                            onClick={() => void openScript(hook)}
                            type="button"
                          >
                            {loadingScriptId === hook.managed.id
                              ? t("hooks.managed.loadingScript")
                              : t("hooks.managed.editScript")}
                          </button>
                          <button onClick={() => startEditManaged(hook)} type="button">{t("hooks.managed.edit")}</button>
                          <button
                            disabled={!hook.enabled || !hook.trusted || testingManagedId === hook.managed.id}
                            onClick={() => void testManaged(hook)}
                            type="button"
                          >
                            {testingManagedId === hook.managed.id ? t("hooks.managed.testing") : t("hooks.managed.test")}
                          </button>
                          <button
                            disabled={savingManaged}
                            onClick={() => void setManagedEnabled(hook, !hook.enabled)}
                            type="button"
                          >
                            {t(hook.enabled ? "hooks.managed.disable" : "hooks.managed.enable")}
                          </button>
                          <button
                            disabled={archivingManagedId === hook.managed.id}
                            onClick={() => void archiveManaged(hook)}
                            type="button"
                          >
                            {archivingManagedId === hook.managed.id ? t("hooks.managed.archiving") : t("hooks.managed.archive")}
                          </button>
                        </>
                      ) : null}
                      <button
                        disabled={updatingHash === hook.hash || (!hook.enabled && !hook.trusted)}
                        onClick={() => void setTrusted(hook, !hook.trusted)}
                        type="button"
                      >
                        {updatingHash === hook.hash
                          ? t("hooks.updating")
                          : hook.trusted ? t("hooks.revoke") : t("hooks.trust")}
                      </button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          )}
          <details className="react-hooks-settings__paths">
            <summary>{t("hooks.advancedFiles")}</summary>
            <div className="react-hooks-settings__paths-content">
              <p>{t("hooks.configHint")}</p>
              <dl>
                <div><dt>{t("hooks.globalConfig")}</dt><dd><code>{snapshot.globalConfigPath}</code></dd></div>
                <div><dt>{t("hooks.workspaceConfig")}</dt><dd><code>{snapshot.workspaceConfigPath}</code></dd></div>
                <div><dt>{t("hooks.trustStore")}</dt><dd><code>{snapshot.trustStorePath}</code></dd></div>
                <div><dt>{t("hooks.templateConfig")}</dt><dd><code>{snapshot.templateConfigPath}</code></dd></div>
                <div><dt>{t("hooks.templateScripts")}</dt><dd><code>{snapshot.templateScriptsPath}</code></dd></div>
              </dl>
              <p>{t("hooks.templateHint")}</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

const HOOK_EVENTS: HookEvent[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostCompact"];
const CUSTOM_MATCHER = "__custom__";

function hookMatcherOptions(event: HookEvent): Array<{ value: string; label: MatcherTranslationKey }> {
  if (event === "PostCompact") {
    return [
      { value: "^(manual|auto)$", label: "hooks.managed.matchers.allCompaction" },
      { value: "^manual$", label: "hooks.managed.matchers.manualCompaction" },
      { value: "^auto$", label: "hooks.managed.matchers.autoCompaction" },
    ];
  }
  if (event === "PreToolUse" || event === "PostToolUse") {
    return [
      { value: "*", label: "hooks.managed.matchers.allTools" },
      { value: "^workspace\\.", label: "hooks.managed.matchers.workspaceTools" },
      { value: "^shell_command$", label: "hooks.managed.matchers.shellCommand" },
    ];
  }
  return [];
}

function defaultMatcher(event: HookEvent): string {
  return event === "PostCompact" ? "^(manual|auto)$" : event === "UserPromptSubmit" ? "" : "*";
}

function defaultManagedHookLanguage(): NativeManagedHookLanguage {
  return navigator.userAgent.includes("Windows") ? "powershell" : "shell";
}

function workspaceDisplayPath(path: string): string {
  const trimmed = path.trim();
  const verbatimUnc = trimmed.match(/^[\\/]{2}\?[\\/]UNC[\\/](.*)$/i);
  const withoutVerbatimPrefix = verbatimUnc
    ? `\\\\${verbatimUnc[1]}`
    : trimmed.replace(/^[\\/]{2}\?[\\/]/, "");
  if (/^[a-zA-Z]:[\\/]$/.test(withoutVerbatimPrefix)) {
    return withoutVerbatimPrefix;
  }
  return withoutVerbatimPrefix.replace(/[\\/]+$/, "") || withoutVerbatimPrefix;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function managedLanguageLabel(language: NativeManagedHookLanguage): string {
  return language === "powershell" ? "PowerShell" : "POSIX shell";
}

function shortcutModifier(): string {
  return navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
