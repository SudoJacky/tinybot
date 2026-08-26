import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { ArrowUpRight, Circle, Eye, GripVertical, PencilLine, Play, Plus, Save, Trash2, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isReasoningEffort,
  REASONING_EFFORT_VALUES,
} from "../../app-core/chat/reasoningEffort";
import {
  addAgentGraphNode,
  configureAgentGraphNode,
  configureAgentGraphRouter,
  connectAgentGraphNodes,
  createAgentGraphDraft,
  createAgentGraphRouterConfig,
  moveAgentGraphNode,
  removeAgentGraphEdge,
  removeAgentGraphNode,
  validateAgentGraphDefinition,
  type AgentGraphDefinition,
  type AgentGraphAgentNode,
  type AgentGraphConditionNode,
  type AgentGraphEditError,
  type AgentGraphEditResult,
  type AgentGraphModelConfig,
  type AgentGraphNode,
  type AgentGraphNodeKind,
  type AgentGraphNodePosition,
  type AgentGraphValidationIssue,
  type AgentLoopNodeConfig,
} from "../../app-core/agent-graph/agentGraphDefinition";
import type { StoredAgentGraph } from "../../app-core/agent-graph/agentGraphStore";
import type { AgentGraphRun } from "../../app-core/agent-graph/agentGraphRuntime";
import { normalizedWorkspacePathKey, sessionWorkspaceName } from "../chat/sessionWorkspaces";
import type { AppServices, ChatModelOption } from "../services";
import { SettingsChoiceList, type SettingsChoiceOption } from "../settings/SettingsChoiceList";
import {
  AGENT_GRAPH_NODE_DRAG_TYPE,
  AgentGraphCanvas,
  NodeIcon,
} from "./AgentGraphCanvas";
import { AgentGraphNodeDrawer } from "./AgentGraphNodeDrawer";
import { AgentGraphPreview } from "./AgentGraphPreview";
import "./AgentGraphsRoute.css";

const NODE_KINDS: AgentGraphNodeKind[] = ["input", "agent", "condition", "output"];
const STARTER_GRAPH_PREVIEW = createAgentGraphDraft({
  id: "starter-graph-preview",
  name: "",
  workspacePath: "",
});
type AgentGraphInteractionMode = "edit" | "view";

export default function AgentGraphsRoute({ services }: { services: AppServices }) {
  const { t } = useTranslation("common");
  const draftSequence = useRef(0);
  const nodeSequence = useRef(0);
  const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([]);
  const [definitionWorkspacePath, setDefinitionWorkspacePath] = useState("");
  const [workspaceCatalogError, setWorkspaceCatalogError] = useState<string | null>(null);
  const [workspaceCatalogReady, setWorkspaceCatalogReady] = useState(false);
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [storedGraphs, setStoredGraphs] = useState<StoredAgentGraph[]>([]);
  const [graphListLoading, setGraphListLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<AgentGraphRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [draft, setDraft] = useState<AgentGraphDefinition | null>(null);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [savedDefinition, setSavedDefinition] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<AgentGraphInteractionMode>("edit");
  const [selectedConfigNodeId, setSelectedConfigNodeId] = useState<string | null>(null);
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [editError, setEditError] = useState<AgentGraphEditError | null>(null);
  const issues = draft ? validateAgentGraphDefinition(draft) : [];
  const draftDirty = Boolean(draft && JSON.stringify(draft) !== savedDefinition);
  const selectedInputNode = draft?.nodes.find((node) => (
    node.id === selectedConfigNodeId && node.kind === "input"
  ));
  const selectedAgentNode = draft?.nodes.find((node): node is AgentGraphAgentNode => (
    node.id === selectedConfigNodeId && node.kind === "agent"
  ));
  const selectedRouterNode = draft?.nodes.find((node): node is AgentGraphConditionNode => (
    node.id === selectedConfigNodeId && node.kind === "condition"
  ));
  const inspectedNode = draft?.nodes.find((node) => node.id === inspectedNodeId);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];
  const selectedModelConfig = selectedAgentNode?.config.model ?? selectedRouterNode?.config?.model;
  const selectedProviderValue = selectedModelConfig?.providerId ?? "";
  const providerChoices = agentGraphProviderChoices(chatModels, selectedModelConfig, {
    inheritDescription: t("graphs.inheritProviderDescription"),
    inheritLabel: t("graphs.inheritProvider"),
    unavailableDescription: t("graphs.providerUnavailableDescription"),
  });
  const selectedProviderModels = chatModels.filter((model) => model.providerId === selectedProviderValue);
  const modelChoices = agentGraphModelChoices(selectedProviderModels, selectedModelConfig, {
    unavailableDescription: t("graphs.modelUnavailableDescription"),
  });

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
    if (!services.settingsStore.loadChatModels) return;
    let cancelled = false;
    setModelCatalogError(null);
    void services.settingsStore.loadChatModels()
      .then((models) => {
        if (!cancelled) setChatModels(models);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setChatModels([]);
          setModelCatalogError(errorMessage(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [services.settingsStore]);

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
    setInteractionMode("edit");
    setSelectedConfigNodeId(null);
    setInspectedNodeId(null);
    setPersistenceError(null);
    setDraftRevision(null);
    setSavedDefinition(null);
    setRunInput("");
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

  function updateSelectedAgentConfig(config: AgentLoopNodeConfig) {
    if (!draft || !selectedAgentNode) return;
    applyEdit(configureAgentGraphNode(draft, selectedAgentNode.id, config));
  }

  function updateSelectedRouterConfig(config: NonNullable<AgentGraphConditionNode["config"]>) {
    if (!draft || !selectedRouterNode) return;
    applyEdit(configureAgentGraphRouter(draft, selectedRouterNode.id, config));
  }

  function updateSelectedModelConfig(model?: AgentGraphModelConfig) {
    if (selectedAgentNode) {
      updateSelectedAgentConfig({ ...selectedAgentNode.config, ...(model ? { model } : { model: undefined }) });
    } else if (selectedRouterNode?.config) {
      updateSelectedRouterConfig({ ...selectedRouterNode.config, ...(model ? { model } : { model: undefined }) });
    }
  }

  function selectNodeProvider(value: string) {
    if (!selectedAgentNode && !selectedRouterNode?.config) return;
    if (selectedModelConfig?.providerId === value) return;
    if (!value) {
      updateSelectedModelConfig();
      return;
    }
    const providerModels = chatModels.filter((model) => model.providerId === value);
    const selectedModel = providerModels.find((model) => model.default) ?? providerModels[0];
    if (!selectedModel) return;
    updateSelectedModelConfig({
      modelId: selectedModel.id,
      ...(selectedModel.providerId ? { providerId: selectedModel.providerId } : {}),
    });
  }

  function selectNodeModel(value: string) {
    const providerId = selectedModelConfig?.providerId;
    if ((!selectedAgentNode && !selectedRouterNode?.config) || !providerId) return;
    if (selectedModelConfig?.modelId === value) return;
    const selectedModel = chatModels.find((model) => model.providerId === providerId && model.id === value);
    if (!selectedModel) return;
    updateSelectedModelConfig({
      modelId: selectedModel.id,
      providerId,
    });
  }

  function selectNodeReasoningEffort(value: string) {
    if (!selectedModelConfig) return;
    updateSelectedModelConfig({
      modelId: selectedModelConfig.modelId,
      ...(selectedModelConfig.providerId ? { providerId: selectedModelConfig.providerId } : {}),
      ...(isReasoningEffort(value) ? { reasoningEffort: value } : {}),
    });
  }

  function addNode(kind: AgentGraphNodeKind, position: AgentGraphNodePosition): boolean {
    if (!draft) return false;
    let nodeId = "";
    do {
      nodeSequence.current += 1;
      nodeId = `${kind}-${nodeSequence.current}`;
    } while (draft.nodes.some((node) => node.id === nodeId));
    const node: AgentGraphNode = kind === "input"
      ? { id: nodeId, kind, position }
      : kind === "agent"
        ? {
          id: nodeId,
          kind,
          position,
          config: { workspacePath: definitionWorkspacePath, instructions: "" },
        }
        : kind === "condition"
          ? {
              id: nodeId,
              kind,
              position,
              config: {
                ...createAgentGraphRouterConfig(nodeId),
                routes: createAgentGraphRouterConfig(nodeId).routes.map((route, index) => ({
                  ...route,
                  label: t("graphs.defaultRouterRouteLabel", { suffix: routeTokenSuffix(index) }),
                })),
              },
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
    setInteractionMode("edit");
    setPersistenceError(null);
    setSelectedConfigNodeId(null);
    setInspectedNodeId(null);
    setSelectedRunId(null);
    setRunInput("");
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
    if (!draft || !draftRevision || draftDirty || running || !runInput.trim()) return;
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
    setInteractionMode("edit");
    setSelectedConfigNodeId(null);
    setInspectedNodeId(null);
    setSelectedRunId(null);
    setRunInput("");
    setPersistenceError(null);
    setRuns([]);
    setRunError(null);
    setRunning(false);
  }

  function changeInteractionMode(mode: AgentGraphInteractionMode) {
    setInteractionMode(mode);
    setSelectedConfigNodeId(null);
    setInspectedNodeId(null);
  }

  return (
    <main className="react-agent-graphs-page" data-editor-open={Boolean(draft)}>
      {!draft ? (
        <header className="react-agent-graphs-page__header">
          <span className="react-agent-graphs-page__heading">
            <span className="react-agent-graphs-page__eyebrow">{t("graphs.eyebrow")}</span>
            <h1>{t("graphs.title")}</h1>
            <p>{t("graphs.description")}</p>
          </span>
          <section className="react-agent-graph-workspace" aria-label={t("graphs.definitionWorkspace")}>
            <SettingsChoiceList
              ariaLabel={t("graphs.definitionWorkspace")}
              description={t("graphs.definitionWorkspaceDescription")}
              disabled={!workspaceCatalogReady || !workspaceOptions.length}
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
          <button disabled={!definitionWorkspacePath} className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
            <Plus aria-hidden="true" size={16} />
            {t("graphs.new")}
          </button>
        </header>
      ) : null}

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
              <small>{t("graphs.libraryCount", { count: storedGraphs.length })}</small>
            </header>
            <ul>
              {storedGraphs.map((graph) => (
                <li key={graph.definition.id}>
                  <button type="button" onClick={() => openStoredGraph(graph)}>
                    <AgentGraphPreview
                      definition={graph.definition}
                      label={t("graphs.graphPreview", { name: graph.definition.name })}
                    />
                    <span className="react-agent-graph-library__card-body">
                      <span>
                        <strong>{graph.definition.name}</strong>
                        <small>{t("graphs.graphSummary", {
                          edges: graph.definition.edges.length,
                          nodes: graph.definition.nodes.length,
                        })}</small>
                      </span>
                      <span className="react-agent-graph-library__saved">{t("graphs.saved")}</span>
                      <ArrowUpRight aria-hidden="true" size={16} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="react-agent-graphs-empty" aria-labelledby="agent-graphs-empty-title">
            <AgentGraphPreview definition={STARTER_GRAPH_PREVIEW} label={t("graphs.starterPreview")} />
            <span className="react-agent-graphs-empty__content">
              <span aria-hidden="true" className="react-agent-graphs-empty__icon"><Workflow size={22} /></span>
              <h2 id="agent-graphs-empty-title">{t("graphs.emptyTitle")}</h2>
              <p>{t("graphs.emptyDescription")}</p>
              <button disabled={!definitionWorkspacePath} className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
                <Plus aria-hidden="true" size={16} />
                {t("graphs.createFirst")}
              </button>
            </span>
          </section>
        )
      ) : (
        <div className="react-agent-graph-draft">
          <section className="react-agent-graph-editor" aria-label={t("graphs.editor")}>
            <header className="react-agent-graph-editor__header">
              <label className="react-agent-graph-editor__name">
                <span>{t("graphs.name")}</span>
                <input
                  aria-label={t("graphs.name")}
                  aria-invalid={issues.includes("name_required")}
                  disabled={running || interactionMode === "view"}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                />
                <small>{t("graphs.description")}</small>
              </label>
              <span className="react-agent-graph-editor__workspace">
                <small>{t("graphs.definitionWorkspace")}</small>
                <strong>{sessionWorkspaceName(definitionWorkspacePath)}</strong>
              </span>
              <span className="react-agent-graph-draft__actions">
                <span
                  aria-label={t("graphs.mode")}
                  className="react-agent-graph-mode-switch"
                  data-mode={interactionMode}
                  role="group"
                >
                  <span aria-hidden="true" className="react-agent-graph-mode-switch__indicator" />
                  <button
                    aria-pressed={interactionMode === "edit"}
                    onClick={() => changeInteractionMode("edit")}
                    type="button"
                  >
                    <PencilLine aria-hidden="true" size={13} />
                    {t("graphs.editMode")}
                  </button>
                  <button
                    aria-pressed={interactionMode === "view"}
                    onClick={() => changeInteractionMode("view")}
                    type="button"
                  >
                    <Eye aria-hidden="true" size={13} />
                    {t("graphs.viewMode")}
                  </button>
                </span>
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
                <button
                  className="react-agent-graph-run__start"
                  disabled={!draftRevision || draftDirty || running || !runInput.trim()}
                  onClick={() => void startRun()}
                  type="button"
                >
                  <Play aria-hidden="true" size={15} />
                  {t(running ? "graphs.running" : "graphs.run")}
                </button>
              </span>
            </header>

            <AgentGraphCanvas
              configPanel={interactionMode === "view" && inspectedNode ? (
                <AgentGraphNodeDrawer
                  chatStore={services.chatStore}
                  node={inspectedNode}
                  onClose={() => setInspectedNodeId(null)}
                  run={selectedRun}
                />
              ) : selectedInputNode ? (
                <section className="react-agent-graph-node-config" aria-labelledby="agent-graph-input-config-title">
                  <header className="react-agent-graph-node-config__header">
                    <span>
                      <small>{t("graphs.nodes.input")}</small>
                      <h3 id="agent-graph-input-config-title">{t("graphs.inputSettings")}</h3>
                    </span>
                    <button aria-label={t("graphs.closeNodeDetails")} type="button" onClick={() => setSelectedConfigNodeId(null)}>
                      <X aria-hidden="true" size={15} />
                    </button>
                  </header>
                  <div className="react-agent-graph-node-config__body">
                    <p>{t("graphs.inputSettingsDescription")}</p>
                  </div>
                </section>
              ) : selectedAgentNode ? (
                <section className="react-agent-graph-node-config" aria-labelledby="agent-graph-node-config-title">
                  <header className="react-agent-graph-node-config__header">
                    <span>
                      <small>{t("graphs.nodes.agent")}</small>
                      <h3 id="agent-graph-node-config-title">{t("graphs.agentSettings")}</h3>
                    </span>
                    <button aria-label={t("graphs.closeNodeDetails")} type="button" onClick={() => setSelectedConfigNodeId(null)}>
                      <X aria-hidden="true" size={15} />
                    </button>
                  </header>
                  <div className="react-agent-graph-node-config__body">
                    <p>{t("graphs.agentSettingsDescription")}</p>
                    <SettingsChoiceList
                      ariaLabel={t("graphs.executionWorkspace")}
                      description={t("graphs.executionWorkspaceDescription")}
                      disabled={!workspaceOptions.length}
                      label={t("graphs.executionWorkspace")}
                      onChange={(workspacePath) => updateSelectedAgentConfig({
                        ...selectedAgentNode.config,
                        workspacePath,
                      })}
                      options={workspaceOptions.map((path) => ({
                        description: path,
                        label: sessionWorkspaceName(path),
                        value: path,
                      }))}
                      optionsAriaLabel={t("graphs.workspaceOptions")}
                      value={selectedAgentNode.config.workspacePath}
                    />
                    <label className="react-agent-graph-node-config__textarea-field">
                      <span>
                        <strong>{t("graphs.nodeInstructions")}</strong>
                        <small id={`agent-graph-instructions-help-${selectedAgentNode.id}`}>
                          {t("graphs.nodeInstructionsDescription")}
                        </small>
                      </span>
                      <textarea
                        aria-describedby={`agent-graph-instructions-help-${selectedAgentNode.id}`}
                        onChange={(event) => updateSelectedAgentConfig({
                          ...selectedAgentNode.config,
                          instructions: event.currentTarget.value,
                        })}
                        placeholder={t("graphs.nodeInstructionsPlaceholder")}
                        rows={5}
                        value={selectedAgentNode.config.instructions ?? ""}
                      />
                    </label>
                    <AgentGraphModelSettings
                      model={selectedAgentNode.config.model}
                      modelCatalogError={modelCatalogError}
                      modelChoices={modelChoices}
                      onModelChange={selectNodeModel}
                      onProviderChange={selectNodeProvider}
                      onReasoningEffortChange={selectNodeReasoningEffort}
                      providerChoices={providerChoices}
                      selectedProviderModels={selectedProviderModels}
                      selectedProviderValue={selectedProviderValue}
                    />
                  </div>
                </section>
              ) : selectedRouterNode?.config ? (
                <section className="react-agent-graph-node-config" aria-labelledby="agent-graph-router-config-title">
                  <header className="react-agent-graph-node-config__header">
                    <span>
                      <small>{t("graphs.nodes.condition")}</small>
                      <h3 id="agent-graph-router-config-title">{t("graphs.routerSettings")}</h3>
                    </span>
                    <button aria-label={t("graphs.closeNodeDetails")} type="button" onClick={() => setSelectedConfigNodeId(null)}>
                      <X aria-hidden="true" size={15} />
                    </button>
                  </header>
                  <div className="react-agent-graph-node-config__body">
                    <p>{t("graphs.routerSettingsDescription")}</p>
                    <label className="react-agent-graph-node-config__textarea-field">
                      <span>
                        <strong>{t("graphs.routerTask")}</strong>
                        <small id={`agent-graph-router-task-help-${selectedRouterNode.id}`}>
                          {t("graphs.routerTaskDescription")}
                        </small>
                      </span>
                      <textarea
                        aria-describedby={`agent-graph-router-task-help-${selectedRouterNode.id}`}
                        onChange={(event) => updateSelectedRouterConfig({
                          ...selectedRouterNode.config!,
                          task: event.currentTarget.value,
                        })}
                        placeholder={t("graphs.routerTaskPlaceholder")}
                        rows={3}
                        value={selectedRouterNode.config.task ?? ""}
                      />
                    </label>
                    <fieldset className="react-agent-graph-router-routes">
                      <legend>{t("graphs.routerRoutes")}</legend>
                      <p>{t("graphs.routerRoutesDescription")}</p>
                      {selectedRouterNode.config.routes.map((route, index) => (
                        <section className="react-agent-graph-router-route" key={route.id}>
                          <header>
                            <strong>{t("graphs.routerRoute", { index: index + 1 })}</strong>
                            <small>{`ROUTE_${routeTokenSuffix(index)}`}</small>
                            <button
                              aria-label={t("graphs.removeRouterRoute", { label: route.label || index + 1 })}
                              disabled={selectedRouterNode.config!.routes.length <= 2}
                              onClick={() => updateSelectedRouterConfig({
                                ...selectedRouterNode.config!,
                                routes: selectedRouterNode.config!.routes.filter((candidate) => candidate.id !== route.id),
                              })}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" size={14} />
                            </button>
                          </header>
                          <label>
                            <span>{t("graphs.routerRouteLabel")}</span>
                            <input
                              aria-invalid={!route.label.trim()}
                              onChange={(event) => updateSelectedRouterConfig({
                                ...selectedRouterNode.config!,
                                routes: selectedRouterNode.config!.routes.map((candidate) => (
                                  candidate.id === route.id
                                    ? { ...candidate, label: event.currentTarget.value }
                                    : candidate
                                )),
                              })}
                              placeholder={t("graphs.routerRouteLabelPlaceholder")}
                              value={route.label}
                            />
                          </label>
                          <label>
                            <span>{t("graphs.routerRouteDescription")}</span>
                            <textarea
                              aria-invalid={!route.description.trim()}
                              onChange={(event) => updateSelectedRouterConfig({
                                ...selectedRouterNode.config!,
                                routes: selectedRouterNode.config!.routes.map((candidate) => (
                                  candidate.id === route.id
                                    ? { ...candidate, description: event.currentTarget.value }
                                    : candidate
                                )),
                              })}
                              placeholder={t("graphs.routerRouteDescriptionPlaceholder")}
                              rows={2}
                              value={route.description}
                            />
                          </label>
                        </section>
                      ))}
                      <button
                        className="react-agent-graph-router-routes__add"
                        onClick={() => {
                          const index = selectedRouterNode.config!.routes.length;
                          updateSelectedRouterConfig({
                            ...selectedRouterNode.config!,
                            routes: [
                              ...selectedRouterNode.config!.routes,
                              {
                                id: nextRouterRouteId(selectedRouterNode),
                                label: t("graphs.defaultRouterRouteLabel", { suffix: routeTokenSuffix(index) }),
                                description: "",
                              },
                            ],
                          });
                        }}
                        type="button"
                      >
                        <Plus aria-hidden="true" size={14} />
                        {t("graphs.addRouterRoute")}
                      </button>
                    </fieldset>
                    <AgentGraphModelSettings
                      model={selectedRouterNode.config.model}
                      modelCatalogError={modelCatalogError}
                      modelChoices={modelChoices}
                      onModelChange={selectNodeModel}
                      onProviderChange={selectNodeProvider}
                      onReasoningEffortChange={selectNodeReasoningEffort}
                      providerChoices={providerChoices}
                      selectedProviderModels={selectedProviderModels}
                      selectedProviderValue={selectedProviderValue}
                    />
                  </div>
                </section>
              ) : selectedRouterNode ? (
                <section className="react-agent-graph-node-config" aria-labelledby="agent-graph-router-config-title">
                  <header className="react-agent-graph-node-config__header">
                    <span>
                      <small>{t("graphs.nodes.condition")}</small>
                      <h3 id="agent-graph-router-config-title">{t("graphs.routerSettings")}</h3>
                    </span>
                    <button aria-label={t("graphs.closeNodeDetails")} type="button" onClick={() => setSelectedConfigNodeId(null)}>
                      <X aria-hidden="true" size={15} />
                    </button>
                  </header>
                  <div className="react-agent-graph-node-config__body">
                    <p>{t("graphs.routerSetupLegacyDescription")}</p>
                    <button
                      className="react-agent-graph-router-routes__add"
                      onClick={() => {
                        const config = createAgentGraphRouterConfig(selectedRouterNode.id);
                        updateSelectedRouterConfig({
                          ...config,
                          routes: config.routes.map((route, index) => ({
                            ...route,
                            label: t("graphs.defaultRouterRouteLabel", { suffix: routeTokenSuffix(index) }),
                          })),
                        });
                      }}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={14} />
                      {t("graphs.routerSetupLegacy")}
                    </button>
                  </div>
                </section>
              ) : null}
              configPanelNodeId={interactionMode === "view" ? inspectedNode?.id : selectedConfigNodeId}
              definition={draft}
              key={interactionMode}
              onAddNode={addNode}
              onConnectNodes={(source, target, sourceRouteId) => (
                applyEdit(connectAgentGraphNodes(draft, source, target, sourceRouteId))
              )}
              onMoveNode={(nodeId, position) => applyEdit(moveAgentGraphNode(draft, nodeId, position))}
              onNodeActivate={(nodeId) => {
                if (interactionMode === "view") setInspectedNodeId(nodeId);
              }}
              onRemoveEdge={(edgeId) => applyEdit(removeAgentGraphEdge(draft, edgeId))}
              onRemoveNode={(nodeId) => {
                const removed = applyEdit(removeAgentGraphNode(draft, nodeId));
                if (removed && inspectedNodeId === nodeId) setInspectedNodeId(null);
                return removed;
              }}
              onSelectionChange={(nodeId) => {
                if (interactionMode === "view") {
                  if (nodeId === null) setInspectedNodeId(null);
                  return;
                }
                const node = draft.nodes.find((candidate) => candidate.id === nodeId);
                setSelectedConfigNodeId(
                  node?.kind === "input" || node?.kind === "agent" || node?.kind === "condition"
                    ? node.id
                    : null,
                );
              }}
              readOnly={interactionMode === "view"}
              run={selectedRun}
            />

            {editError ? <p className="react-agent-graph-edit-error" role="alert">{t(`graphs.editErrors.${editError}`)}</p> : null}
            {persistenceError ? <p className="react-agent-graph-persistence-error" role="alert">{persistenceError}</p> : null}
            <GraphValidation issues={issues} />
          </section>

          <aside className="react-agent-graph-node-catalog" aria-labelledby="agent-graph-node-catalog-title">
            {interactionMode === "edit" ? (
              <>
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
              </>
            ) : (
              <>
                <h2 id="agent-graph-node-catalog-title">{t("graphs.viewModeTitle")}</h2>
                <p>{t("graphs.viewModeDescription")}</p>
              </>
            )}
            <section
              aria-busy={running}
              aria-labelledby="agent-graph-run-title"
              className="react-agent-graph-run"
              data-status={selectedRun?.status ?? "idle"}
            >
              <span className="react-agent-graph-run__summary">
                <Circle aria-hidden="true" className="react-agent-graph-run__status-dot" size={10} />
                <span>
                  <h3 id="agent-graph-run-title">
                    {selectedRun ? t(`graphs.runStatuses.${selectedRun.status}`) : t("graphs.runTitle")}
                  </h3>
                  <small>{draftDirty ? t("graphs.saveBeforeRun") : t("graphs.runDescription")}</small>
                </span>
              </span>
              <label className="react-agent-graph-run__input">
                <span className="sr-only">{t("graphs.runInput")}</span>
                <input
                  aria-label={t("graphs.runInput")}
                  disabled={running}
                  onChange={(event) => setRunInput(event.currentTarget.value)}
                  placeholder={t("graphs.runInputPlaceholder")}
                  value={runInput}
                />
              </label>
              {runError ? <p className="react-agent-graph-run__error" role="alert">{runError}</p> : null}
              <GraphRunHistory
                loading={runsLoading}
                onSelectRun={setSelectedRunId}
                runs={runs}
                selectedRunId={selectedRun?.id}
              />
            </section>
          </aside>
        </div>
      )}
      {!draft && persistenceError ? (
        <p className="react-agent-graph-persistence-error" role="alert">{persistenceError}</p>
      ) : null}
    </main>
  );
}

function AgentGraphModelSettings({
  model,
  modelCatalogError,
  modelChoices,
  onModelChange,
  onProviderChange,
  onReasoningEffortChange,
  providerChoices,
  selectedProviderModels,
  selectedProviderValue,
}: {
  model?: AgentGraphModelConfig;
  modelCatalogError: string | null;
  modelChoices: SettingsChoiceOption[];
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  providerChoices: SettingsChoiceOption[];
  selectedProviderModels: ChatModelOption[];
  selectedProviderValue: string;
}) {
  const { t } = useTranslation("common");
  return (
    <>
      <SettingsChoiceList
        ariaLabel={t("graphs.nodeProvider")}
        description={t("graphs.nodeProviderDescription")}
        error={modelCatalogError ? t("graphs.modelLoadFailed", { message: modelCatalogError }) : undefined}
        label={t("graphs.nodeProvider")}
        onChange={onProviderChange}
        options={providerChoices}
        optionsAriaLabel={t("graphs.providerOptions")}
        value={selectedProviderValue}
      />
      <SettingsChoiceList
        ariaLabel={t("graphs.nodeModel")}
        description={t("graphs.nodeModelDescription")}
        disabled={!selectedProviderValue || !selectedProviderModels.length}
        label={t("graphs.nodeModel")}
        onChange={onModelChange}
        options={selectedProviderValue
          ? modelChoices
          : [{
              description: t("graphs.inheritModelDescription"),
              label: t("graphs.inheritModel"),
              value: "",
            }]}
        optionsAriaLabel={t("graphs.modelOptions")}
        value={model?.modelId ?? ""}
      />
      <SettingsChoiceList
        ariaLabel={t("graphs.reasoningEffort")}
        description={t("graphs.reasoningEffortDescription")}
        disabled={!model}
        label={t("graphs.reasoningEffort")}
        onChange={onReasoningEffortChange}
        options={[
          {
            description: t("graphs.reasoningDefaultDescription"),
            label: t("graphs.reasoningDefault"),
            value: "",
          },
          ...REASONING_EFFORT_VALUES.map((effort) => ({
            description: t(`graphs.reasoningOptions.${effort}.description`),
            label: t(`graphs.reasoningOptions.${effort}.label`),
            value: effort,
          })),
        ]}
        optionsAriaLabel={t("graphs.reasoningOptionsLabel")}
        value={model?.reasoningEffort ?? ""}
      />
    </>
  );
}

function nextRouterRouteId(node: AgentGraphConditionNode): string {
  const usedIds = new Set(node.config?.routes.map((route) => route.id));
  for (let sequence = 1; ; sequence += 1) {
    const candidate = `${node.id}-route-${sequence}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

function routeTokenSuffix(index: number): string {
  let suffix = "";
  do {
    suffix = String.fromCharCode(65 + (index % 26)) + suffix;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return suffix;
}

function agentGraphProviderChoices(
  models: ChatModelOption[],
  current: AgentGraphModelConfig | undefined,
  labels: {
    inheritDescription: string;
    inheritLabel: string;
    unavailableDescription: string;
  },
): SettingsChoiceOption[] {
  const choices: SettingsChoiceOption[] = [
    {
      description: labels.inheritDescription,
      label: labels.inheritLabel,
      value: "",
    },
  ];
  const providerIds = new Set<string>();
  for (const model of models) {
    if (!model.providerId || providerIds.has(model.providerId)) continue;
    providerIds.add(model.providerId);
    choices.push({
      description: model.providerId,
      label: model.providerLabel ?? model.providerId,
      value: model.providerId,
    });
  }
  if (current?.providerId && !providerIds.has(current.providerId)) {
    choices.splice(1, 0, {
      description: labels.unavailableDescription,
      disabled: true,
      label: current.providerId,
      value: current.providerId,
    });
  }
  return choices;
}

function agentGraphModelChoices(
  models: ChatModelOption[],
  current: AgentLoopNodeConfig["model"] | undefined,
  labels: { unavailableDescription: string },
): SettingsChoiceOption[] {
  const choices: SettingsChoiceOption[] = models.map((model) => ({
    description: model.description,
    label: model.label,
    value: model.id,
  }));
  if (current && !models.some((model) => model.id === current.modelId)) {
    choices.unshift({
      description: labels.unavailableDescription,
      disabled: true,
      label: current.modelId,
      value: current.modelId,
    });
  }
  return choices;
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
