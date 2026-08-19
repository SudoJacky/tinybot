import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  NativeCommandHookSnapshot,
  NativeCommandHookSummary,
  NativeManagedHookLanguage,
  NativeManagedHookTestResult,
} from "../../app-core/native/desktopNativeHooks";
import type { HooksStore, ProjectGroupStore, SessionStore } from "../services";

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

export function HooksSettingsPage({
  hooksStore,
  projectGroupStore,
  sessionStore,
}: {
  hooksStore: HooksStore;
  projectGroupStore: ProjectGroupStore;
  sessionStore: SessionStore;
}) {
  const { t } = useTranslation("settings");
  const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    setWorkspaceCatalogReady(false);
    void Promise.all([sessionStore.list(), projectGroupStore.list()])
      .then(([sessions, groups]) => {
        if (cancelled) return;
        const paths = uniqueWorkspacePaths([
          ...sessions.flatMap((session) => (
            session.workingDirectory && !session.pluginMigration ? [session.workingDirectory] : []
          )),
          ...groups.flatMap((group) => group.workspaceIds),
        ]);
        setWorkspaceOptions(paths);
        setWorkspacePath((current) => current || paths[0]);
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
  }, [projectGroupStore, sessionStore]);

  useEffect(() => {
    if (!workspaceCatalogReady) return;
    let cancelled = false;
    setError(null);
    void hooksStore.load(workspacePath)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setWorkspaceOptions((current) => uniqueWorkspacePaths([...current, next.workspaceRoot]));
        setWorkspacePath((current) => current || next.workspaceRoot);
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

  function selectWorkspace(path: string) {
    setManagedEditor(null);
    setManagedTestResult(null);
    setSnapshot(null);
    setWorkspacePath(path);
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
        <label>
          <span>{t("hooks.workspace")}</span>
          <select
            aria-label={t("hooks.workspace")}
            disabled={!workspaceCatalogReady || !workspaceOptions.length}
            onChange={(event) => selectWorkspace(event.target.value)}
            value={selectedWorkspace || ""}
          >
            {workspaceOptions.map((path) => (
              <option key={workspacePathKey(path)} value={path}>
                {workspaceName(path)} — {path}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setLoadRevision((value) => value + 1)} type="button">
          {t("hooks.reload")}
        </button>
      </div>

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
            <label>
              <span>{t("hooks.managed.event")}</span>
              <select
                onChange={(event) => {
                  const nextEvent = event.target.value as HookEvent;
                  setManagedEditor({
                    ...managedEditor,
                    event: nextEvent,
                    matcher: defaultMatcher(nextEvent),
                    customMatcher: false,
                  });
                }}
                value={managedEditor.event}
              >
                {HOOK_EVENTS.map((event) => <option key={event} value={event}>{event}</option>)}
              </select>
            </label>
            {managedEditor.event !== "UserPromptSubmit" ? (
              <label>
                <span>{t("hooks.managed.appliesTo")}</span>
                <select
                  onChange={(event) => {
                    const value = event.target.value;
                    setManagedEditor({
                      ...managedEditor,
                      customMatcher: value === CUSTOM_MATCHER,
                      matcher: value === CUSTOM_MATCHER ? "" : value,
                    });
                  }}
                  value={managedEditor.customMatcher ? CUSTOM_MATCHER : managedEditor.matcher}
                >
                  {matcherOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.label)}</option>
                  ))}
                  <option value={CUSTOM_MATCHER}>{t("hooks.managed.matchers.custom")}</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>{t("hooks.managed.language")}</span>
              <select
                onChange={(event) => setManagedEditor({
                  ...managedEditor,
                  language: event.target.value as NativeManagedHookLanguage,
                })}
                value={managedEditor.language}
              >
                <option value="powershell">PowerShell</option>
                <option value="shell">POSIX shell</option>
              </select>
            </label>
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
          <div className="react-hooks-settings__paths">
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
                      <span>{hook.event} · {t(`hooks.source.${hook.source}`)} · {hook.matcher || "*"} · {t("hooks.timeout", { seconds: hook.timeout })}</span>
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
                  <small>{hook.managed?.manifestPath || hook.sourcePath}</small>
                  <footer>
                    <code>{hook.hash}</code>
                    <div className="react-hooks-settings__actions">
                      {hook.managed ? (
                        <>
                          <button onClick={() => void revealScript(hook)} type="button">{t("hooks.managed.reveal")}</button>
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

function uniqueWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    const normalized = path.trim().replace(/[\\/]+$/, "");
    if (!normalized) return [];
    const key = workspacePathKey(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function workspacePathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function workspaceName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
