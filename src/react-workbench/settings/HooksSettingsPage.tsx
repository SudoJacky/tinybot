import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { NativeCommandHookSnapshot, NativeCommandHookSummary } from "../../app-core/native/desktopNativeHooks";
import type { HooksStore } from "../services";

export function HooksSettingsPage({ hooksStore }: { hooksStore: HooksStore }) {
  const { t } = useTranslation("settings");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string | undefined>();
  const [snapshot, setSnapshot] = useState<NativeCommandHookSnapshot | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [updatingHash, setUpdatingHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void hooksStore.load(workspacePath)
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
          if (!workspacePath) setWorkspaceDraft(next.workspaceRoot);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hooksStore, loadRevision, workspacePath]);

  function loadWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSnapshot(null);
    setWorkspacePath(workspaceDraft.trim() || undefined);
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
        ...(workspacePath ? { workspacePath } : {}),
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

  return (
    <section className="react-hooks-settings" aria-labelledby="hooks-settings-title">
      <div className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("hooks.eyebrow")}</span>
          <h2 id="hooks-settings-title">{t("hooks.title")}</h2>
          <p>{t("hooks.description")}</p>
        </div>
      </div>

      <form className="react-hooks-settings__workspace" onSubmit={loadWorkspace}>
        <label>
          <span>{t("hooks.workspace")}</span>
          <input
            aria-label={t("hooks.workspace")}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            placeholder={t("hooks.workspacePlaceholder")}
            value={workspaceDraft}
          />
        </label>
        <button type="submit">{t("hooks.reload")}</button>
      </form>

      {error ? <p className="react-settings-alert" role="alert">{error}</p> : null}
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
                <article className="react-hooks-settings__hook" key={hook.hash}>
                  <header>
                    <div>
                      <strong>{hook.statusMessage || hook.event}</strong>
                      <span>{t(`hooks.source.${hook.source}`)} · {hook.matcher || "*"} · {t("hooks.timeout", { seconds: hook.timeout })}</span>
                    </div>
                    <span className="react-hooks-settings__trust" data-trusted={hook.trusted}>
                      {hook.trusted ? t("hooks.trusted") : t("hooks.untrusted")}
                    </span>
                  </header>
                  <code className="react-hooks-settings__command">{hook.command}</code>
                  <small>{hook.sourcePath}</small>
                  <footer>
                    <code>{hook.hash}</code>
                    <button
                      disabled={updatingHash === hook.hash}
                      onClick={() => void setTrusted(hook, !hook.trusted)}
                      type="button"
                    >
                      {updatingHash === hook.hash
                        ? t("hooks.updating")
                        : hook.trusted ? t("hooks.revoke") : t("hooks.trust")}
                    </button>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
