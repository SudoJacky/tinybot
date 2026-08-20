import { useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { GripVertical, Plus, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  addAgentGraphNode,
  connectAgentGraphNodes,
  createAgentGraphDraft,
  moveAgentGraphNode,
  removeAgentGraphEdge,
  removeAgentGraphNode,
  validateAgentGraphDefinition,
  type AgentGraphDefinition,
  type AgentGraphEditError,
  type AgentGraphEditResult,
  type AgentGraphNodeKind,
  type AgentGraphNodePosition,
  type AgentGraphValidationIssue,
} from "../../app-core/agent-graph/agentGraphDefinition";
import {
  AGENT_GRAPH_NODE_DRAG_TYPE,
  AgentGraphCanvas,
  NodeIcon,
} from "./AgentGraphCanvas";
import "./AgentGraphsRoute.css";

const NODE_KINDS: AgentGraphNodeKind[] = ["input", "agent", "condition", "output"];

export default function AgentGraphsRoute() {
  const { t } = useTranslation("common");
  const draftSequence = useRef(0);
  const nodeSequence = useRef(0);
  const [draft, setDraft] = useState<AgentGraphDefinition | null>(null);
  const [editError, setEditError] = useState<AgentGraphEditError | null>(null);
  const issues = draft ? validateAgentGraphDefinition(draft) : [];

  function createDraft() {
    draftSequence.current += 1;
    nodeSequence.current = 0;
    setEditError(null);
    setDraft(createAgentGraphDraft({
      id: `draft-${draftSequence.current}`,
      name: t("graphs.untitled"),
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
    nodeSequence.current += 1;
    return applyEdit(addAgentGraphNode(draft, {
      id: `${kind}-${nodeSequence.current}`,
      kind,
      position,
    }));
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

  return (
    <main className="react-agent-graphs-page">
      <header className="react-agent-graphs-page__header">
        <span className="react-agent-graphs-page__heading">
          <span className="react-agent-graphs-page__eyebrow">{t("graphs.eyebrow")}</span>
          <h1>{t("graphs.title")}</h1>
          <p>{t("graphs.description")}</p>
        </span>
        {!draft ? (
          <button className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
            <Plus aria-hidden="true" size={16} />
            {t("graphs.new")}
          </button>
        ) : null}
      </header>

      {!draft ? (
        <section className="react-agent-graphs-empty" aria-labelledby="agent-graphs-empty-title">
          <span aria-hidden="true" className="react-agent-graphs-empty__icon"><Workflow size={25} /></span>
          <h2 id="agent-graphs-empty-title">{t("graphs.emptyTitle")}</h2>
          <p>{t("graphs.emptyDescription")}</p>
          <button className="react-agent-graphs-page__primary" type="button" onClick={createDraft}>
            <Plus aria-hidden="true" size={16} />
            {t("graphs.createFirst")}
          </button>
        </section>
      ) : (
        <div className="react-agent-graph-draft">
          <section className="react-agent-graph-editor" aria-label={t("graphs.editor")}>
            <header className="react-agent-graph-editor__header">
              <label>
                <span>{t("graphs.name")}</span>
                <input
                  aria-invalid={issues.includes("name_required")}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                />
              </label>
              <span className="react-agent-graph-draft__actions">
                <span className="react-agent-graph-draft__badge">{t("graphs.unsaved")}</span>
                <button type="button" onClick={() => {
                  setDraft(null);
                  setEditError(null);
                }}>
                  <X aria-hidden="true" size={15} />
                  {t("graphs.discard")}
                </button>
              </span>
            </header>

            <AgentGraphCanvas
              definition={draft}
              onAddNode={addNode}
              onConnectNodes={(source, target) => applyEdit(connectAgentGraphNodes(draft, source, target))}
              onMoveNode={(nodeId, position) => applyEdit(moveAgentGraphNode(draft, nodeId, position))}
              onRemoveEdge={(edgeId) => applyEdit(removeAgentGraphEdge(draft, edgeId))}
              onRemoveNode={(nodeId) => applyEdit(removeAgentGraphNode(draft, nodeId))}
            />

            {editError ? <p className="react-agent-graph-edit-error" role="alert">{t(`graphs.editErrors.${editError}`)}</p> : null}
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
          </aside>
        </div>
      )}
    </main>
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
