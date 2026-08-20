import { useRef, useState } from "react";
import { ArrowRight, Bot, CircleDot, GitBranch, Plus, Workflow, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createAgentGraphDraft,
  validateAgentGraphDefinition,
  type AgentGraphDefinition,
  type AgentGraphNodeKind,
  type AgentGraphValidationIssue,
} from "../../app-core/agent-graph/agentGraphDefinition";
import "./AgentGraphsRoute.css";

const NODE_KINDS: AgentGraphNodeKind[] = ["input", "agent", "condition", "output"];

export default function AgentGraphsRoute() {
  const { t } = useTranslation("common");
  const draftSequence = useRef(0);
  const [draft, setDraft] = useState<AgentGraphDefinition | null>(null);
  const issues = draft ? validateAgentGraphDefinition(draft) : [];

  function createDraft() {
    draftSequence.current += 1;
    setDraft(createAgentGraphDraft({
      id: `draft-${draftSequence.current}`,
      name: t("graphs.untitled"),
    }));
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
                <button type="button" onClick={() => setDraft(null)}>
                  <X aria-hidden="true" size={15} />
                  {t("graphs.discard")}
                </button>
              </span>
            </header>

            <div
              aria-label={t("graphs.canvas")}
              className="react-agent-graph-canvas"
              role="region"
            >
              {draft.nodes.map((node, index) => (
                <span className="react-agent-graph-canvas__step" key={node.id}>
                  <article aria-label={t("graphs.nodeLabel", { kind: t(`graphs.nodes.${node.kind}`) })} data-kind={node.kind}>
                    <NodeIcon kind={node.kind} />
                    <span>
                      <small>{t("graphs.node")}</small>
                      <strong>{t(`graphs.nodes.${node.kind}`)}</strong>
                    </span>
                  </article>
                  {index < draft.nodes.length - 1 ? <ArrowRight aria-hidden="true" size={18} /> : null}
                </span>
              ))}
            </div>

            <GraphValidation issues={issues} />
          </section>

          <aside className="react-agent-graph-node-catalog" aria-labelledby="agent-graph-node-catalog-title">
            <h2 id="agent-graph-node-catalog-title">{t("graphs.availableNodes")}</h2>
            <p>{t("graphs.availableNodesDescription")}</p>
            <ul>
              {NODE_KINDS.map((kind) => (
                <li key={kind}>
                  <NodeIcon kind={kind} />
                  <span>
                    <strong>{t(`graphs.nodes.${kind}`)}</strong>
                    <small>{t(`graphs.nodeDescriptions.${kind}`)}</small>
                  </span>
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

function NodeIcon({ kind }: { kind: AgentGraphNodeKind }) {
  const Icon = kind === "agent"
    ? Bot
    : kind === "condition"
      ? GitBranch
      : CircleDot;
  return <Icon aria-hidden="true" size={17} />;
}
