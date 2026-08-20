import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { GripVertical, Play, Plus, Save, Trash2, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  addAgentGraphNode,
  configureAgentGraphNode,
  connectAgentGraphNodes,
  createAgentGraphDraft,
  moveAgentGraphNode,
  removeAgentGraphEdge,
  removeAgentGraphNode,
  validateAgentGraphDefinition,
  type AgentGraphDefinition,
  type AgentGraphAgentNode,
  type AgentGraphEditError,
  type AgentGraphEditResult,
  type AgentGraphNode,
  type AgentGraphNodeKind,
  type AgentGraphNodePosition,
  type AgentGraphValidationIssue,
} from "../../app-core/agent-graph/agentGraphDefinition";
import type { StoredAgentGraph } from "../../app-core/agent-graph/agentGraphStore";
import type { AgentGraphRun } from "../../app-core/agent-graph/agentGraphRuntime";
import { normalizedWorkspacePathKey, sessionWorkspaceName } from "../chat/sessionWorkspaces";
import type { AppServices } from "../services";
import { SettingsChoiceList } from "../settings/SettingsChoiceList";
import {
  AGENT_GRAPH_NODE_DRAG_TYPE,
  AgentGraphCanvas,
  NodeIcon,
} from "./AgentGraphCanvas";
import { AgentGraphNodeDrawer } from "./AgentGraphNodeDrawer";
import "./AgentGraphsRoute.css";

const NODE_KINDS: AgentGraphNodeKind[] = ["input", "agent", "condition", "output"];

export default function AgentGraphsRoute({ services }: { services: AppServices }) {
  const { t } = useTranslation("common");
  const draftSequence = useRef(0);
  const nodeSequence = useRef(0);
  const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([]);
  const [definitionWorkspacePath, setDefinitionWorkspacePath] = useState("");
  const [workspaceCatalogError, setWorkspaceCatalogError] = useState<string | null>(null);
  const [workspaceCatalogReady, setWorkspaceCatalogReady] = useState(false);
  const [storedGraphs, setStoredGraphs] = useState<StoredAgentGraph[]>([]);
  const [graphListLoading, setGraphListLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<AgentGraphRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState<AgentGraphDefinition | null>(null);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [savedDefinition, setSavedDefinition] = useState<string | null>(null);
  const [selectedAgentNodeId, setSelectedAgentNodeId] = useState<string | null>(null);
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [editError, setEditError] = useState<AgentGraphEditError | null>(null);
  const issues = draft ? validateAgentGraphDefinition(draft) : [];
  const draftDirty = Boolean(draft && JSON.stringify(draft) !== savedDefinition);
  const selectedAgentNode = draft?.nodes.find((node): node is AgentGraphAgentNode => (
    node.id === selectedAgentNodeId && node.kind === "agent"
  ));
  const inspectedNode = draft?.nodes.find((node) => node.id === inspectedNodeId);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];

  useEffect(() => {
    let cancelled = false;
    setWorkspaceCatalogReady(false);
    setWorkspaceCatalogError(null);
    void Promise.all([services.sessionStore.list(), services.projectGroupStore.list()])
      .then(([sessions, groups]) => {
        if (cancelled) return;
        const paths = uniqueWorkspacePaths([
          ...sessions.flatMap((session) => (
            session.workingDirectory && !session.pluginMigration ? [session.workingDirectory] : []
          )),
          ...groups.flatMap((group) => group.workspaceIds),
        ]);
        setWorkspaceOptions(paths);
        setDefinitionWorkspacePath((current) => current || paths[0] || "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setWorkspaceCatalogError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setWorkspaceCatalogReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [services.projectGroupStore, services.sessionStore]);

  useEffect(() => {
    if (!workspaceCatalogReady || !definitionWorkspacePath) {
      setStoredGraphs([]);
      return;
    }
    let cancelled = false;
    setGraphListLoading(true);
    setStoredGraphs([]);
    setPersistenceError(null);
    void services.agentGraphStore.list(definitionWorkspacePath)
      .then((graphs) => {
        if (!cancelled) setStoredGraphs(graphs);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setPersistenceError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setGraphListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionWorkspacePath, services.agentGraphStore, workspaceCatalogReady]);

  useEffect(() => {
    if (!draft?.id || !draftRevision) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    setRunsLoading(true);
    setRunError(null);
    void services.agentGraphRuntime.list({
      graphId: draft.id,
      definitionWorkspacePath,
    })
      .then((items) => {
        if (!cancelled) setRuns((current) => mergePolledRuns(current, items));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setRunError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setRunsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionWorkspacePath, draft?.id, draftRevision, services.agentGraphRuntime]);

  useEffect(() => {
    setSelectedRunId((current) => {
      if (!runs.length) return null;
      if (running || !current || !runs.some((run) => run.id === current)) return runs[0].id;
      return current;
    });
  }, [running, runs]);

  useEffect(() => {
    if (!running || !draft?.id || !draftRevision) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const items = await services.agentGraphRuntime.list({
          graphId: draft.id,
          definitionWorkspacePath,
        });
        if (!cancelled) setRuns((current) => mergePolledRuns(current, items));
      } catch (cause: unknown) {
        if (!cancelled) setRunError(errorMessage(cause));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [definitionWorkspacePath, draft?.id, draftRevision, running, services.agentGraphRuntime]);

  function createDraft() {
    if (!definitionWorkspacePath) return;
    draftSequence.current += 1;
    nodeSequence.current = 0;
    setEditError(null);
    setSelectedAgentNodeId(null);
    setInspectedNodeId(null);
    setPersistenceError(null);
    setDraftRevision(null);
    setSavedDefinition(null);
    setDraft(createAgentGraphDraft({
      id: `graph-${Date.now()}-${draftSequence.current}`,
      name: t("graphs.untitled"),
      workspacePath: definitionWorkspacePath,
    }));
  }

  function applyEdit(result: AgentGraphEditResult): boolean {
    if (!result.ok) {
      setEditError(result.reason);
      return false;
    }
    setDraft(result.definition);
    setEditError(null);
    return true;
  }

  function addNode(kind: AgentGraphNodeKind, position: AgentGraphNodePosition): boolean {
    if (!draft) return false;
    let nodeId = "";
    do {
      nodeSequence.current += 1;
      nodeId = `${kind}-${nodeSequence.current}`;
    } while (draft.nodes.some((node) => node.id === nodeId));
    const node: AgentGraphNode = kind === "agent"
      ? {
          id: nodeId,
          kind,
          position,
          config: { workspacePath: definitionWorkspacePath, instructions: "" },
        }
      : { id: nodeId, kind, position };
    return applyEdit(addAgentGraphNode(draft, node));
  }

  function addNodeAtDefaultPosition(kind: AgentGraphNodeKind) {
    if (!draft) return;
    const addedNodeCount = Math.max(0, draft.nodes.length - 3);
    addNode(kind, {
      x: 92 + (addedNodeCount % 3) * 210,
      y: 230 + (Math.floor(addedNodeCount / 3) % 2) * 92,
    });
  }

  function beginPaletteDrag(event: ReactDragEvent<HTMLButtonElement>, kind: AgentGraphNodeKind) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(AGENT_GRAPH_NODE_DRAG_TYPE, kind);
  }

  function openStoredGraph(graph: StoredAgentGraph) {
    nodeSequence.current = 0;
    setEditError(null);
    setPersistenceError(null);
    setSelectedAgentNodeId(null);
    setInspectedNodeId(null);
    setSelectedRunId(null);
    setDraft(graph.definition);
    setDraftRevision(graph.revision);
    setSavedDefinition(JSON.stringify(graph.definition));
  }

  async function saveDraft() {
    if (!draft || issues.length || saving || running) return;
    setSaving(true);
    setPersistenceError(null);
    try {
      const stored = await services.agentGraphStore.save({
        workspacePath: definitionWorkspacePath,
        definition: draft,
        ...(draftRevision ? { expectedRevision: draftRevision } : {}),
      });
      setDraft(stored.definition);
      setDraftRevision(stored.revision);
      setSavedDefinition(JSON.stringify(stored.definition));
      setStoredGraphs((current) => sortedStoredGraphs([
        ...current.filter((graph) => graph.definition.id !== stored.definition.id),
        stored,
      ]));
    } catch (cause: unknown) {
      setPersistenceError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function deleteDraft() {
    if (!draft || !draftRevision || saving || running) return;
    if (!window.confirm(t("graphs.confirmDelete", { name: draft.name }))) return;
    setSaving(true);
    setPersistenceError(null);
    try {
      await services.agentGraphStore.delete({
        workspacePath: definitionWorkspacePath,
        graphId: draft.id,
        expectedRevision: draftRevision,
      });
      setStoredGraphs((current) => current.filter((graph) => graph.definition.id !== draft.id));
      closeDraft();
    } catch (cause: unknown) {
      setPersistenceError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function startRun() {
    if (!draft || !draftRevision || draftDirty || !runInput.trim() || running) return;
    setRunning(true);
    setRunError(null);
    try {
      const run = await services.agentGraphRuntime.start({
        graphId: draft.id,
        graphRevision: draftRevision,
        definitionWorkspacePath,
        input: runInput,
      });
      setSelectedRunId(run.id);
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
    } catch (cause: unknown) {
      setRunError(errorMessage(cause));
    } finally {
      setRunning(false);
    }
  }

  function closeDraft() {
    setDraft(null);
    setDraftRevision(null);
    setSavedDefinition(null);
    setEditError(null);
    setSelectedAgentNodeId(null);
    setInspectedNodeId(null);
    setSelectedRunId(null);
    setPersistenceError(null);
    setRuns([]);
    setRunInput("");
    setRunError(null);
    setRunning(false);
  }

  return (
    <main className="react-agent-graphs-page">
      <header className="react-agent-graphs-page__header">
        <span className="react-agent-graphs-page__heading">
          <span className="react-agent-graphs-page__eyebrow">{t("graphs.eyebrow")}</span>
          <h1>{t("graphs.title")}</h1>
          <p>{t("graphs.description")}</p>
        </span>
        {!draft ? (
          <button disabled={!definitionWorkspacePath} className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
            <Plus aria-hidden="true" size={16} />
            {t("graphs.new")}
          </button>
        ) : null}
      </header>

      <section className="react-agent-graph-workspace" aria-label={t("graphs.definitionWorkspace")}>
        <SettingsChoiceList
          ariaLabel={t("graphs.definitionWorkspace")}
          description={t("graphs.definitionWorkspaceDescription")}
          disabled={!workspaceCatalogReady || !workspaceOptions.length || draft !== null}
          label={t("graphs.definitionWorkspace")}
          onChange={setDefinitionWorkspacePath}
          options={workspaceOptions.map((path) => ({
            description: path,
            label: sessionWorkspaceName(path),
            value: path,
          }))}
          optionsAriaLabel={t("graphs.workspaceOptions")}
          value={definitionWorkspacePath}
        />
        {workspaceCatalogError ? (
          <p className="react-agent-graph-workspace__error" role="alert">
            {t("graphs.workspaceLoadFailed", { message: workspaceCatalogError })}
          </p>
        ) : null}
        {workspaceCatalogReady && !workspaceCatalogError && !workspaceOptions.length ? (
          <p className="react-agent-graph-workspace__empty" role="status">{t("graphs.workspaceEmpty")}</p>
        ) : null}
      </section>

      {!draft ? (
        graphListLoading ? (
          <p className="react-agent-graph-library__status" role="status">{t("graphs.loading")}</p>
        ) : storedGraphs.length ? (
          <section className="react-agent-graph-library" aria-labelledby="agent-graph-library-title">
            <header>
              <span>
                <h2 id="agent-graph-library-title">{t("graphs.savedGraphs")}</h2>
                <p>{t("graphs.savedGraphsDescription")}</p>
              </span>
            </header>
            <ul>
              {storedGraphs.map((graph) => (
                <li key={graph.definition.id}>
                  <button type="button" onClick={() => openStoredGraph(graph)}>
                    <strong>{graph.definition.name}</strong>
                    <small>{t("graphs.graphSummary", {
                      edges: graph.definition.edges.length,
                      nodes: graph.definition.nodes.length,
                    })}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="react-agent-graphs-empty" aria-labelledby="agent-graphs-empty-title">
            <span aria-hidden="true" className="react-agent-graphs-empty__icon"><Workflow size={25} /></span>
            <h2 id="agent-graphs-empty-title">{t("graphs.emptyTitle")}</h2>
            <p>{t("graphs.emptyDescription")}</p>
            <button disabled={!definitionWorkspacePath} className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
              <Plus aria-hidden="true" size={16} />
              {t("graphs.createFirst")}
            </button>
          </section>
        )
      ) : (
        <div className="react-agent-graph-draft">
          <section className="react-agent-graph-editor" aria-label={t("graphs.editor")}>
            <header className="react-agent-graph-editor__header">
              <label>
                <span>{t("graphs.name")}</span>
                <input
                  aria-invalid={issues.includes("name_required")}
                  disabled={running}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                />
              </label>
              <span className="react-agent-graph-draft__actions">
                <span className="react-agent-graph-draft__badge">
                  {t(draftDirty ? "graphs.unsaved" : "graphs.saved")}
                </span>
                <button disabled={!draftDirty || issues.length > 0 || saving || running} type="button" onClick={() => void saveDraft()}>
                  <Save aria-hidden="true" size={15} />
                  {t(saving ? "graphs.saving" : "graphs.save")}
                </button>
                {draftRevision ? (
                  <button disabled={saving || running} type="button" onClick={() => void deleteDraft()}>
                    <Trash2 aria-hidden="true" size={15} />
                    {t("graphs.delete")}
                  </button>
                ) : null}
                <button disabled={saving || running} type="button" onClick={closeDraft}>
                  <X aria-hidden="true" size={15} />
                  {t(draftRevision ? "graphs.close" : "graphs.discard")}
                </button>
              </span>
            </header>

            <AgentGraphCanvas
              definition={draft}
              onAddNode={addNode}
              onConnectNodes={(source, target) => applyEdit(connectAgentGraphNodes(draft, source, target))}
              onMoveNode={(nodeId, position) => applyEdit(moveAgentGraphNode(draft, nodeId, position))}
              onNodeActivate={setInspectedNodeId}
              onRemoveEdge={(edgeId) => applyEdit(removeAgentGraphEdge(draft, edgeId))}
              onRemoveNode={(nodeId) => {
                const removed = applyEdit(removeAgentGraphNode(draft, nodeId));
                if (removed && inspectedNodeId === nodeId) setInspectedNodeId(null);
                return removed;
              }}
              onSelectionChange={(nodeId) => {
                const node = draft.nodes.find((candidate) => candidate.id === nodeId);
                setSelectedAgentNodeId(node?.kind === "agent" ? node.id : null);
              }}
            />

            {editError ? <p className="react-agent-graph-edit-error" role="alert">{t(`graphs.editErrors.${editError}`)}</p> : null}
            {persistenceError ? <p className="react-agent-graph-persistence-error" role="alert">{persistenceError}</p> : null}
            <GraphValidation issues={issues} />
          </section>

          <aside className="react-agent-graph-node-catalog" aria-labelledby="agent-graph-node-catalog-title">
            <h2 id="agent-graph-node-catalog-title">{t("graphs.availableNodes")}</h2>
            <p>{t("graphs.availableNodesDescription")}</p>
            <ul>
              {NODE_KINDS.map((kind) => (
                <li key={kind}>
                  <button
                    aria-label={t("graphs.addNode", { kind: t(`graphs.nodes.${kind}`) })}
                    disabled={(kind === "input" || kind === "output") && draft.nodes.some((node) => node.kind === kind)}
                    draggable={!((kind === "input" || kind === "output") && draft.nodes.some((node) => node.kind === kind))}
                    onClick={() => addNodeAtDefaultPosition(kind)}
                    onDragStart={(event) => beginPaletteDrag(event, kind)}
                    title={(kind === "input" || kind === "output") && draft.nodes.some((node) => node.kind === kind)
                      ? t("graphs.nodeAlreadyExists", { kind: t(`graphs.nodes.${kind}`) })
                      : t("graphs.dragNode", { kind: t(`graphs.nodes.${kind}`) })}
                    type="button"
                  >
                    <GripVertical aria-hidden="true" className="react-agent-graph-node-catalog__grip" size={15} />
                    <NodeIcon kind={kind} />
                    <span>
                      <strong>{t(`graphs.nodes.${kind}`)}</strong>
                      <small>{t(`graphs.nodeDescriptions.${kind}`)}</small>
                    </span>
                    <Plus aria-hidden="true" className="react-agent-graph-node-catalog__add" size={15} />
                  </button>
                </li>
              ))}
            </ul>
            {selectedAgentNode ? (
              <section className="react-agent-graph-node-config" aria-labelledby="agent-graph-node-config-title">
                <h3 id="agent-graph-node-config-title">{t("graphs.agentSettings")}</h3>
                <p>{t("graphs.agentSettingsDescription")}</p>
                <SettingsChoiceList
                  ariaLabel={t("graphs.executionWorkspace")}
                  description={t("graphs.executionWorkspaceDescription")}
                  disabled={!workspaceOptions.length}
                  label={t("graphs.executionWorkspace")}
                  onChange={(workspacePath) => applyEdit(configureAgentGraphNode(
                    draft,
                    selectedAgentNode.id,
                    { ...selectedAgentNode.config, workspacePath },
                  ))}
                  options={workspaceOptions.map((path) => ({
                    description: path,
                    label: sessionWorkspaceName(path),
                    value: path,
                  }))}
                  optionsAriaLabel={t("graphs.workspaceOptions")}
                  value={selectedAgentNode.config.workspacePath}
                />
              </section>
            ) : null}
            <section
              aria-busy={running}
              aria-labelledby="agent-graph-run-title"
              className="react-agent-graph-run"
            >
              <h3 id="agent-graph-run-title">{t("graphs.runTitle")}</h3>
              <p>{t("graphs.runDescription")}</p>
              <label>
                <span>{t("graphs.runInput")}</span>
                <textarea
                  disabled={running}
                  onChange={(event) => setRunInput(event.currentTarget.value)}
                  placeholder={t("graphs.runInputPlaceholder")}
                  rows={4}
                  value={runInput}
                />
              </label>
              <button
                className="react-agent-graph-run__start"
                disabled={!draftRevision || draftDirty || !runInput.trim() || running}
                onClick={() => void startRun()}
                type="button"
              >
                <Play aria-hidden="true" size={14} />
                {t(running ? "graphs.running" : "graphs.run")}
              </button>
              {draftDirty ? <small>{t("graphs.saveBeforeRun")}</small> : null}
              {runError ? <p className="react-agent-graph-run__error" role="alert">{runError}</p> : null}
              <GraphRunHistory
                loading={runsLoading}
                onSelectRun={setSelectedRunId}
                runs={runs}
                selectedRunId={selectedRun?.id}
              />
            </section>
          </aside>
          {inspectedNode ? (
            <AgentGraphNodeDrawer
              chatStore={services.chatStore}
              node={inspectedNode}
              onClose={() => setInspectedNodeId(null)}
              run={selectedRun}
            />
          ) : null}
        </div>
      )}
      {!draft && persistenceError ? (
        <p className="react-agent-graph-persistence-error" role="alert">{persistenceError}</p>
      ) : null}
    </main>
  );
}

function uniqueWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    const normalized = workspaceDisplayPath(path);
    if (!normalized) return [];
    const key = normalizedWorkspacePathKey(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sortedStoredGraphs(graphs: StoredAgentGraph[]): StoredAgentGraph[] {
  return [...graphs].sort((left, right) => (
    left.definition.name.localeCompare(right.definition.name)
    || left.definition.id.localeCompare(right.definition.id)
  ));
}

function mergePolledRuns(current: AgentGraphRun[], incoming: AgentGraphRun[]): AgentGraphRun[] {
  const merged = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const existing = merged.get(run.id);
    const existingIsTerminal = existing && existing.status !== "running";
    if (!existingIsTerminal || run.status !== "running") {
      merged.set(run.id, run);
    }
  }
  return [...merged.values()].sort((left, right) => right.id.localeCompare(left.id));
}

function GraphRunHistory({
  loading,
  onSelectRun,
  runs,
  selectedRunId,
}: {
  loading: boolean;
  onSelectRun: (runId: string) => void;
  runs: AgentGraphRun[];
  selectedRunId?: string;
}) {
  const { t } = useTranslation("common");
  if (loading) {
    return <small role="status">{t("graphs.runsLoading")}</small>;
  }
  if (!runs.length) {
    return <small>{t("graphs.noRuns")}</small>;
  }
  return (
    <div aria-live="polite" className="react-agent-graph-run-history">
      <h4>{t("graphs.runHistory")}</h4>
      <ul>
        {runs.map((run, index) => (
          <li data-status={run.status} key={run.id}>
            <button
              aria-pressed={selectedRunId === run.id}
              onClick={() => onSelectRun(run.id)}
              type="button"
            >
              <span>
                <strong>{t(`graphs.runStatuses.${run.status}`)}</strong>
                <small>{t("graphs.runNodeSummary", {
                  completed: run.nodeRuns.filter((nodeRun) => nodeRun.status === "completed").length,
                  total: run.nodeRuns.length,
                })}</small>
              </span>
              <small>{t("graphs.runNumber", { number: index + 1 })}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GraphValidation({ issues }: { issues: AgentGraphValidationIssue[] }) {
  const { t } = useTranslation("common");
  if (!issues.length) {
    return <p className="react-agent-graph-validation" data-state="valid" role="status">{t("graphs.valid")}</p>;
  }
  return (
    <div className="react-agent-graph-validation" data-state="invalid" role="alert">
      <strong>{t("graphs.invalid")}</strong>
      <ul>{issues.map((issue) => <li key={issue}>{t(`graphs.issues.${issue}`)}</li>)}</ul>
    </div>
  );
}
