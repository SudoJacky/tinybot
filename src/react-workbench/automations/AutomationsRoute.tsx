import { FileSearch, History, ListTodo, NotebookPen, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationSnapshot, SaveAutomation, SavedAutomation } from "../../app-core/native/desktopNativeAutomations";
import type { AppServices, WorkspaceRegistryEntry } from "../services";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationReport } from "./AutomationReport";
import { AutomationTaskRow } from "./AutomationTaskRow";
import "./AutomationsRoute.css";

const emptyDraft: SaveAutomation = { name: "", instructions: "", workspacePath: "" };
const filters = ["all", "running", "completed", "attention"] as const;
type Filter = typeof filters[number];
const suggestions = [
  { id: "weekly", icon: NotebookPen, color: "violet" },
  { id: "files", icon: FileSearch, color: "green" },
  { id: "todos", icon: ListTodo, color: "blue" },
] as const;

export default function AutomationsRoute({ services, onOpenThread }: {
  services: AppServices;
  onOpenThread: (threadId: string) => Promise<void>;
}) {
  const { t } = useTranslation("common");
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>({ definitions: [], runs: [] });
  const [workspaces, setWorkspaces] = useState<WorkspaceRegistryEntry[]>([]);
  const [draft, setDraft] = useState<SaveAutomation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const value = await services.automationStore.list();
    setSnapshot(value);
    setLoaded(true);
  }, [services.automationStore]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await services.automationStore.list();
        if (!active) return;
        setSnapshot(value);
        setLoaded(true);
        timer = setTimeout(() => { void poll(); }, 3000);
      } catch (e) { if (active) setError(String(e)); }
    };
    void poll();
    void services.workspaceRegistryStore.list().then((value) => { if (active) setWorkspaces(value); })
      .catch((e: unknown) => { if (active) setError(String(e)); });
    return () => { active = false; clearTimeout(timer); };
  }, [services]);

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await work(); await reload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  function edit(definition: SavedAutomation) {
    setError(null);
    setDraft({ id: definition.id, name: definition.name, instructions: definition.instructions, workspacePath: definition.workspacePath, expectedRevision: definition.revision, execution: definition.execution, schedule: definition.schedule });
  }
  function create(suggestion?: typeof suggestions[number]["id"]) {
    setError(null);
    setDraft({ ...emptyDraft, workspacePath: workspaces.find((w) => w.exists)?.path ?? "",
      ...(suggestion ? { name: t(`automations.suggestions.${suggestion}.title`), instructions: t(`automations.suggestions.${suggestion}.prompt`) } : {}),
    });
  }
  function openHistory(id: string | null) {
    setSelected(id); setShowHistory(true); setDraft(null);
  }
  function run(id: string) {
    void action(async () => { await services.automationStore.run(id); openHistory(id); });
  }
  const search = query.trim().toLocaleLowerCase();
  const definitions = snapshot.definitions.filter((definition) => {
    const latest = snapshot.runs.find((r) => r.definition.id === definition.id);
    const statusMatch = filter === "all" || (filter === "running" && latest?.status === "running")
      || (filter === "completed" && latest?.status === "completed")
      || (filter === "attention" && latest && ["waiting", "failed", "interrupted"].includes(latest.status));
    return statusMatch && `${definition.name} ${definition.instructions} ${definition.workspacePath}`.toLocaleLowerCase().includes(search);
  });
  const runs = snapshot.runs.filter((r) => !selected || r.definition.id === selected);

  return <div className="automation-ui automation-page">
    <header className="automation-page-header">
      <div><h1>{t("automations.pageTitle")}</h1><p>{t("automations.intro")}</p></div>
      <div className="automation-actions">
        <button type="button" className="automation-icon-button" aria-label={showHistory ? t("automations.backToTasks") : t("automations.history")} title={showHistory ? t("automations.backToTasks") : t("automations.history")}
          onClick={() => { if (showHistory) setShowHistory(false); else openHistory(null); }}>{showHistory ? <ListTodo size={20} /> : <History size={20} />}</button>
        <button type="button" disabled={busy} onClick={() => create()}><Plus aria-hidden="true" size={17} />{t("automations.create")}</button>
      </div>
    </header>
    {error && !draft && <div role="alert" className="automation-error">{error}<button type="button" disabled={busy} onClick={() => { void action(reload); }}>{t("automations.refresh")}</button></div>}
    {!loaded && !error && <p role="status">{t("automations.loading")}</p>}

    {!showHistory ? <>
      <div className="automation-search">
        <Search aria-hidden="true" size={20} />
        <input type="search" aria-label={t("automations.search")} placeholder={t("automations.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button type="button" className="automation-icon-button" aria-label={t("automations.clearSearch")} onClick={() => setQuery("")}><X size={17} /></button>}
      </div>
      <div className="automation-filters" role="group" aria-label={t("automations.filterLabel")}>
        {filters.map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`automations.filters.${value}`)}</button>)}
      </div>
      <section aria-label={t("automations.saved")} className="automation-task-list">
        {definitions.map((definition) => <AutomationTaskRow key={definition.id} definition={definition}
          latestRun={snapshot.runs.find((r) => r.definition.id === definition.id)}
          workspaceName={workspaces.find((w) => w.path === definition.workspacePath)?.name ?? definition.workspacePath}
          busy={busy} onEdit={() => edit(definition)} onRun={() => run(definition.id)} onHistory={() => openHistory(definition.id)} />)}
        {loaded && definitions.length === 0 && <p className="automation-empty">{snapshot.definitions.length === 0 ? t("automations.empty") : t("automations.noMatches")}</p>}
      </section>
      <section className="automation-suggestions" aria-labelledby="automation-suggestions-title">
        <h2 id="automation-suggestions-title">{t("automations.suggestionsTitle")}</h2>
        {suggestions.map(({ id, icon: Icon, color }) => <button type="button" key={id} className="automation-suggestion" disabled={busy} onClick={() => create(id)}>
          <Icon aria-hidden="true" size={22} data-color={color} />
          <span><span className="automation-suggestion-title">{t(`automations.suggestions.${id}.title`)}</span><span className="automation-suggestion-description">{t(`automations.suggestions.${id}.description`)}</span></span>
        </button>)}
      </section>
    </> : <section className="automation-history" aria-label={t("automations.history")}>
      <div className="automation-heading"><h2>{t("automations.history")}</h2><button type="button" onClick={() => setSelected(null)}>{t("automations.allRuns")}</button></div>
      {loaded && runs.length === 0 && <p className="automation-empty">{t("automations.noRuns")}</p>}
      {runs.map((item) => <article key={item.id} className="automation-card">
        <div className="automation-heading"><h3>{item.definition.name}</h3><span className="automation-run-status" data-status={item.status} role="status">{t(`automations.status.${item.status}`)}</span></div>
        <p className="automation-history-meta"><time dateTime={new Date(item.startedAtMs).toISOString()}>{new Date(item.startedAtMs).toLocaleString()}</time>{item.effectiveModel && <> · {item.effectiveModel.provider} / {item.effectiveModel.model}</>}</p>
        {item.error && <p className="automation-error">{item.error}</p>}
        <details><summary>{t("automations.runDetails")}</summary><p className="automation-path">{item.definition.workspacePath}</p><pre>{item.definition.instructions}</pre><pre>{JSON.stringify(item.effectiveModel, null, 2)}</pre><small>{item.id} · {item.stopReason}</small></details>
        <div className="automation-actions">
          {item.threadId && <button type="button" disabled={busy} onClick={() => { void action(() => onOpenThread(item.threadId!)); }}>{t("automations.openThread")}</button>}
          {snapshot.definitions.some((d) => d.id === item.definition.id) && <button type="button" disabled={busy} onClick={() => edit(snapshot.definitions.find((d) => d.id === item.definition.id)!)}>{t("automations.edit")}</button>}
        </div>
        {item.threadId && item.status !== "running" && <AutomationReport run={item} services={services} />}
      </article>)}
    </section>}

    {draft && <AutomationEditor services={services} draft={draft} workspaces={workspaces} busy={busy} error={error} onChange={setDraft} onClose={() => setDraft(null)}
      onHistory={() => openHistory(draft.id ?? null)}
      onSave={(runAfterSave) => { void action(async () => {
        const saved = await services.automationStore.save(draft);
        setDraft({ id: saved.id, name: saved.name, instructions: saved.instructions, workspacePath: saved.workspacePath, expectedRevision: saved.revision, execution: saved.execution, schedule: saved.schedule });
        if (runAfterSave) { await services.automationStore.run(saved.id); openHistory(saved.id); }
        else { setDraft(null); setShowHistory(false); setQuery(""); setFilter("all"); }
      }); }}
      onDelete={() => { void action(async () => {
        await services.automationStore.delete(draft.id!, draft.expectedRevision!); setDraft(null); openHistory(null);
      }); }} />}
  </div>;
}
