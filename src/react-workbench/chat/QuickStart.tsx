import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, FileText, FolderOpen, MessageSquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import { buildProviderConfigurePatch, buildProviderModelsPatch, type ProviderModelsSettingsData } from "../../app-core/settings/providerModelsSettings";
import type { SettingsStore } from "../services";
import "./QuickStart.css";

export function QuickStart({ ready, settingsStore, onConfigured, onDismiss, onExample, onAddWorkspace, workspaceEnabled, pending }: {
  ready: boolean;
  settingsStore: SettingsStore;
  onConfigured: () => void;
  onDismiss: () => void;
  onExample: (text: string) => void;
  onAddWorkspace: () => Promise<string | undefined>;
  workspaceEnabled: boolean;
  pending: boolean;
}) {
  const { t } = useTranslation("chat");
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const titleId = useId();
  async function chooseProject() {
    setChoosing(true);
    setError("");
    try {
      if (await onAddWorkspace()) onExample(t("quickStart.projectPrompt"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setChoosing(false); }
  }
  return (
    <section className="react-quick-start" aria-labelledby={titleId}>
      <header>
        <span className="react-quick-start__eyebrow">{t("quickStart.label")}</span>
        <button aria-label={t("quickStart.dismiss")} title={t("quickStart.dismiss")} type="button" onClick={onDismiss}><X size={16} /></button>
      </header>
      <h2 id={titleId}>{t(ready ? "quickStart.taskTitle" : "quickStart.title")}</h2>
      <p>{t(ready ? "quickStart.taskDescription" : "quickStart.description")}</p>
      <ol className="react-quick-start__steps" aria-label={t("quickStart.progress")}>
        <li data-complete={ready}>{ready ? <Check size={14} /> : <span>1</span>}{t("quickStart.connect")}</li>
        <li><span>2</span>{t("quickStart.firstTask")}</li>
      </ol>
      {ready ? (
        <div className="react-quick-start__examples">
          {workspaceEnabled ? <button disabled={pending || choosing} type="button" onClick={() => void chooseProject()}><FolderOpen size={18} /><span>{t("quickStart.project")}</span><ArrowRight size={15} /></button> : null}
          <button type="button" onClick={() => onExample(t("quickStart.filePrompt"))}><FileText size={18} /><span>{t("quickStart.file")}</span><ArrowRight size={15} /></button>
          <button type="button" onClick={() => onExample(t("quickStart.questionPrompt"))}><MessageSquare size={18} /><span>{t("quickStart.question")}</span><ArrowRight size={15} /></button>
        </div>
      ) : <div className="react-quick-start__actions"><button className="react-quick-start__primary" type="button" onClick={() => setSetup(true)}>{t("quickStart.connect")}<ArrowRight size={16} /></button><button type="button" onClick={onDismiss}>{t("quickStart.explore")}</button></div>}
      <small>{t(ready ? "quickStart.composerTip" : "quickStart.resumeTip")}</small>
      {error ? <p role="alert">{error}</p> : null}
      {setup ? <QuickStartModelDialog settingsStore={settingsStore} onClose={() => setSetup(false)} onConfigured={() => { onConfigured(); setSetup(false); }} /> : null}
    </section>
  );
}

export function QuickStartModelDialog({ settingsStore, onClose, onConfigured }: {
  settingsStore: SettingsStore; onClose: () => void; onConfigured: () => void;
}) {
  const { t } = useTranslation("chat");
  const [data, setData] = useState<ProviderModelsSettingsData | null>(null);
  const [profileId, setProfileId] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const titleId = useId();
  const listId = useId();
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({ onClose, closeEnabled: !busy });
  const provider = data?.providers.find((item) => item.profileId === profileId);

  useEffect(() => {
    let cancelled = false;
    setError("");
    void settingsStore.loadProviderSettings!().then((next) => {
      if (cancelled) return;
      setData(next);
      const initial = next.providers.find((item) => item.status === "available") ?? next.providers[0];
      if (!initial) throw new Error("No provider presets available");
      setProfileId(initial.profileId);
      setApiBase(initial.baseUrl);
      setModel(initial.defaultModel ?? initial.models[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [settingsStore, reload]);

  async function saveConnection() {
    if (!data || !provider) throw new Error("Provider settings are not loaded");
    const next = await settingsStore.saveProviderSettings!(data.currentConfig, buildProviderConfigurePatch({
      providerId: provider.id, profileId, apiBase, apiKey,
      useResponsesApi: provider.useResponsesApi, enabled: true,
    }));
    setData(next);
    setApiKey("");
    return next;
  }

  async function run(action: "discover" | "finish") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!provider) throw new Error("Select a provider");
      const next = await saveConnection();
      if (action === "discover") {
        if (!settingsStore.fetchProviderModels) throw new Error(t("quickStart.discoveryUnavailable"));
        const result = await settingsStore.fetchProviderModels({ providerId: provider.id, profileId, apiBase: apiBase.trim(), modelDiscovery: provider.modelDiscovery });
        if (!result.ok) throw new Error(result.error || t("quickStart.discoveryFailed"));
        setDiscovered(result.models);
        if (result.models.length && !result.models.includes(model)) setModel(result.models[0]);
        setNotice(result.warning || t(result.models.length ? "quickStart.discovered" : "quickStart.noModels"));
      } else {
        const ids = [...new Set([...provider.models.map((item) => item.id), model.trim()])];
        await settingsStore.saveProviderSettings!(next.currentConfig, buildProviderModelsPatch({
          providerId: provider.id, profileId, models: ids,
          enabledModels: [...new Set([...provider.models.filter((item) => item.enabled).map((item) => item.id), model.trim()])],
          defaultModel: model, setAgentDefault: true,
        }));
        if (!settingsStore.saveDefaultChatModel) throw new Error(t("quickStart.saveUnavailable"));
        await settingsStore.saveDefaultChatModel({ modelId: model.trim(), providerId: provider.id });
        onConfigured();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return createPortal(
    <div className="react-quick-start-backdrop" onPointerDown={onBackdropPointerDown}>
      <div aria-modal="true" aria-labelledby={titleId} role="dialog" ref={dialogRef} tabIndex={-1} className="react-quick-start-dialog">
        <header><h2 id={titleId}>{t("quickStart.connect")}</h2><button type="button" disabled={busy} aria-label={t("quickStart.close")} onClick={onClose}><X size={16} /></button></header>
        <p>{t("quickStart.setupDescription")}</p>
        {!data && !error ? <p role="status">{t("quickStart.loading")}</p> : null}
        {data ? <form onSubmit={(event) => { event.preventDefault(); void run("finish"); }}>
          <fieldset disabled={busy}>
            <label>{t("quickStart.provider")}<select value={profileId} onChange={(event) => {
              const next = data.providers.find((item) => item.profileId === event.target.value)!;
              setProfileId(next.profileId); setApiBase(next.baseUrl); setApiKey("");
              setModel(next.defaultModel ?? next.models[0]?.id ?? ""); setDiscovered([]); setNotice(""); setError("");
            }}>{data.providers.map((item) => <option key={item.profileId} value={item.profileId}>{item.label}</option>)}</select></label>
            <label>{t("quickStart.apiBase")}<input required type="url" value={apiBase} onChange={(event) => { setApiBase(event.target.value); setDiscovered([]); setNotice(""); }} /></label>
            <label>{t("quickStart.apiKey")}<input autoComplete="off" type="password" required={provider?.apiKeyRequired && !provider.apiKeyConfigured} placeholder={provider?.apiKeyConfigured ? t("quickStart.keySaved") : ""} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setNotice(""); }} /></label>
            <label>{t("quickStart.model")}<input required pattern=".*\S.*" list={listId} value={model} onChange={(event) => setModel(event.target.value)} /><datalist id={listId}>{[...new Set([...discovered, ...(provider?.models.map((item) => item.id) ?? [])])].map((id) => <option key={id} value={id} />)}</datalist></label>
            <p className="react-quick-start-dialog__hint">{t("quickStart.validationHint")}</p>
            <div className="react-quick-start__actions">
              {provider?.modelDiscovery.status === "openai-compatible" ? <button type="button" onClick={(event) => {
                const inputs = event.currentTarget.form!.querySelectorAll<HTMLInputElement>("input:not([list])");
                if (Array.from(inputs).every((input) => input.reportValidity())) void run("discover");
              }}>{t("quickStart.discover")}</button> : null}
              <button className="react-quick-start__primary" type="submit">{t("quickStart.saveContinue")}</button>
            </div>
          </fieldset>
        </form> : error ? <button type="button" onClick={() => setReload((current) => current + 1)}>{t("quickStart.retry")}</button> : null}
        {busy ? <p role="status">{t("quickStart.saving")}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </div>, document.body,
  );
}
