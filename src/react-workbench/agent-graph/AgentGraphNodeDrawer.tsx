import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentGraphNode } from "../../app-core/agent-graph/agentGraphDefinition";
import type {
  AgentGraphNodeRun,
  AgentGraphNodeRunStatus,
  AgentGraphRun,
} from "../../app-core/agent-graph/agentGraphRuntime";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatStore } from "../services";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { ChatTimeline } from "../chat/ChatTimeline";
import "../chat/ChatPage.css";
import { NodeIcon } from "./AgentGraphCanvas";

const EMPTY_INTERACTIVE_FORM_IDS = new Set<string>();
const TIMELINE_POLL_INTERVAL_MS = 1_000;

export function AgentGraphNodeDrawer({
  chatStore,
  node,
  onClose,
  run,
}: {
  chatStore: ChatStore;
  node: AgentGraphNode;
  onClose: () => void;
  run?: AgentGraphRun;
}) {
  const { t } = useTranslation("common");
  const nodeRun = node.kind === "agent"
    ? run?.nodeRuns.find((candidate) => candidate.nodeId === node.id)
    : undefined;
  const [timeline, setTimeline] = useState<ChatTimelineSnapshot | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const status = nodeInspectionStatus(node, run, nodeRun);
  const titleId = useId();
  const description = node.kind === "agent" ? node.config.workspacePath : t(`graphs.nodeDescriptions.${node.kind}`);

  const requestClose = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    onClose();
    returnFocus?.focus({ preventScroll: true });
  }, [onClose]);

  useEffect(() => {
    if (document.activeElement instanceof HTMLElement && !drawerRef.current?.contains(document.activeElement)) {
      returnFocusRef.current = document.activeElement;
    }
  }, [node.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  useEffect(() => {
    const threadId = nodeRun?.threadId;
    if (!threadId) {
      setTimeline(null);
      setTimelineError(null);
      setTimelineLoading(false);
      return;
    }
    let cancelled = false;
    let loading = false;
    let timer: number | undefined;
    const loadTimeline = async () => {
      if (loading) return;
      loading = true;
      setTimelineLoading(true);
      try {
        const snapshot = await chatStore.load(threadId);
        if (!cancelled) {
          setTimeline(snapshot);
          setTimelineError(null);
        }
      } catch (cause: unknown) {
        if (!cancelled) setTimelineError(errorMessage(cause));
      } finally {
        loading = false;
        if (!cancelled) setTimelineLoading(false);
      }
    };
    setTimeline(null);
    setTimelineError(null);
    void loadTimeline();
    if (nodeRun.status === "running") {
      timer = window.setInterval(() => void loadTimeline(), TIMELINE_POLL_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [chatStore, nodeRun?.status, nodeRun?.threadId]);

  const timelineContent = useMemo(() => {
    if (!timeline) return null;
    return (
      <ChatTimeline
        actions={{}}
        error={timelineError ?? undefined}
        hookResults={timeline.hookResults ?? []}
        interactiveFormIds={EMPTY_INTERACTIVE_FORM_IDS}
        latestFailedTurnId=""
        optimisticMessages={[]}
        recoveringTurnId=""
        sessionRunning={nodeRun?.status === "running"}
        turns={timeline.turns}
      />
    );
  }, [nodeRun?.status, timeline, timelineError]);

  return (
    <aside
      aria-labelledby={titleId}
      className="react-agent-graph-node-drawer"
      data-presentation="floating"
      ref={drawerRef}
      role="complementary"
    >
      <header className="react-agent-graph-node-drawer__header">
        <span aria-hidden="true" className="react-agent-graph-node-drawer__icon"><NodeIcon kind={node.kind} /></span>
        <span>
          <small>{t("graphs.nodeDetails")}</small>
          <h2 id={titleId}>{t(`graphs.nodes.${node.kind}`)}</h2>
          <p>{description}</p>
        </span>
        <button aria-label={t("graphs.closeNodeDetails")} type="button" onClick={requestClose}>
          <X aria-hidden="true" size={17} />
        </button>
      </header>

      <div aria-live="polite" className="react-agent-graph-node-drawer__status" data-status={status}>
        <span>{t("graphs.nodeStatus")}</span>
        <strong>{t(`graphs.nodeInspectionStatuses.${status}`)}</strong>
      </div>

      <div
        aria-busy={timelineLoading}
        aria-label={t("graphs.nodeMessages")}
        className="react-agent-graph-node-drawer__messages react-conversation-view"
      >
        {!run ? <NodeEmptyState text={t("graphs.selectRunForNode")} /> : null}
        {run && node.kind === "input" ? (
          <NodeMessage role="user" text={run.input} />
        ) : null}
        {run && node.kind === "output" ? (
          run.output ? <NodeMessage role="assistant" text={run.output} /> : (
            <NodeEmptyState text={run.error || t("graphs.nodeOutputUnavailable")} />
          )
        ) : null}
        {run && node.kind === "condition" ? <NodeEmptyState text={t("graphs.conditionNotRunnable")} /> : null}
        {run && node.kind === "agent" ? (
          <>
            {nodeRun?.error ? <p className="react-agent-graph-node-drawer__error" role="alert">{nodeRun.error}</p> : null}
            {!nodeRun?.threadId ? <NodeEmptyState text={t("graphs.nodeThreadUnavailable")} />
              : timelineLoading && !timeline ? (
                  <p className="react-agent-graph-node-drawer__loading" role="status">
                    <Loader2 aria-hidden="true" className="react-spin" size={16} />
                    {t("graphs.nodeMessagesLoading")}
                  </p>
                ) : timelineError && !timeline ? <p className="react-agent-graph-node-drawer__error" role="alert">{timelineError}</p>
                  : timeline?.turns.length ? timelineContent : <NodeEmptyState text={t("graphs.nodeNoMessages")} />}
          </>
        ) : null}
      </div>
    </aside>
  );
}

type NodeInspectionStatus = AgentGraphNodeRunStatus | "cancelled" | "not_run";

function nodeInspectionStatus(
  node: AgentGraphNode,
  run: AgentGraphRun | undefined,
  nodeRun: AgentGraphNodeRun | undefined,
): NodeInspectionStatus {
  if (!run) return "not_run";
  if (node.kind === "input") return "completed";
  if (node.kind === "agent") return nodeRun?.status ?? "not_run";
  if (node.kind === "condition") return "not_run";
  if (run.status === "completed") return "completed";
  if (run.status === "running") return "pending";
  return run.status;
}

function NodeMessage({ role, text }: { role: "assistant" | "user"; text: string }) {
  return (
    <article className="react-message" data-role={role}>
      <div className="react-message__body">
        {role === "assistant" ? <AssistantMarkdown streaming={false} text={text} /> : (
          <div className="react-message-plain-text"><p>{text}</p></div>
        )}
      </div>
    </article>
  );
}

function NodeEmptyState({ text }: { text: string }) {
  return <p className="react-agent-graph-node-drawer__empty">{text}</p>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
