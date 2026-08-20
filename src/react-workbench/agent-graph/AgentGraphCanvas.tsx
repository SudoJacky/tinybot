import {
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Bot, CircleDot, GitBranch, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentGraphDefinition,
  AgentGraphNode,
  AgentGraphNodeKind,
  AgentGraphNodePosition,
} from "../../app-core/agent-graph/agentGraphDefinition";

export const AGENT_GRAPH_NODE_DRAG_TYPE = "application/x-tinybot-agent-graph-node";

const CANVAS_WIDTH = 760;
const CANVAS_HEIGHT = 400;
const NODE_WIDTH = 154;
const NODE_HEIGHT = 66;
const KEYBOARD_MOVE_STEP = 8;

type GraphSelection =
  | { type: "node"; id: string }
  | { type: "edge"; id: string };

type NodePointerDrag = {
  pointerId: number;
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

type AgentGraphCanvasProps = {
  definition: AgentGraphDefinition;
  onAddNode: (kind: AgentGraphNodeKind, position: AgentGraphNodePosition) => boolean;
  onMoveNode: (nodeId: string, position: AgentGraphNodePosition) => boolean;
  onConnectNodes: (source: string, target: string) => boolean;
  onRemoveNode: (nodeId: string) => boolean;
  onRemoveEdge: (edgeId: string) => boolean;
};

export function AgentGraphCanvas({
  definition,
  onAddNode,
  onMoveNode,
  onConnectNodes,
  onRemoveNode,
  onRemoveEdge,
}: AgentGraphCanvasProps) {
  const { t } = useTranslation("common");
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [pointerDrag, setPointerDrag] = useState<NodePointerDrag | null>(null);
  const selectedNode = selection?.type === "node"
    ? definition.nodes.find((node) => node.id === selection.id)
    : undefined;
  const canDeleteSelection = selection?.type === "edge"
    || (selectedNode != null && selectedNode.kind !== "input" && selectedNode.kind !== "output");
  const pendingSourceNode = definition.nodes.find((node) => node.id === pendingSource);

  function selectNode(nodeId: string) {
    setSelection({ type: "node", id: nodeId });
  }

  function removeSelection() {
    if (!selection || !canDeleteSelection) return;
    const removed = selection.type === "node"
      ? onRemoveNode(selection.id)
      : onRemoveEdge(selection.id);
    if (removed) {
      if (selection.type === "node" && pendingSource === selection.id) {
        setPendingSource(null);
      }
      setSelection(null);
    }
  }

  function startNodeDrag(event: ReactPointerEvent<HTMLElement>, node: AgentGraphNode) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selectNode(node.id);
    setPointerDrag({
      pointerId: event.pointerId,
      nodeId: node.id,
      offsetX: event.clientX - bounds.left - node.position.x,
      offsetY: event.clientY - bounds.top - node.position.y,
    });
  }

  function moveDraggedNode(event: ReactPointerEvent<HTMLElement>) {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    onMoveNode(pointerDrag.nodeId, clampPosition({
      x: event.clientX - bounds.left - pointerDrag.offsetX,
      y: event.clientY - bounds.top - pointerDrag.offsetY,
    }));
  }

  function finishNodeDrag(event: ReactPointerEvent<HTMLElement>) {
    if (pointerDrag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPointerDrag(null);
  }

  function moveNodeWithKeyboard(event: ReactKeyboardEvent<HTMLElement>, node: AgentGraphNode) {
    const multiplier = event.shiftKey ? 3 : 1;
    const distance = KEYBOARD_MOVE_STEP * multiplier;
    const delta = event.key === "ArrowLeft"
      ? { x: -distance, y: 0 }
      : event.key === "ArrowRight"
        ? { x: distance, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -distance }
          : event.key === "ArrowDown"
            ? { x: 0, y: distance }
            : null;

    if (delta) {
      event.preventDefault();
      selectNode(node.id);
      onMoveNode(node.id, clampPosition({
        x: node.position.x + delta.x,
        y: node.position.y + delta.y,
      }));
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && node.kind !== "input" && node.kind !== "output") {
      event.preventDefault();
      if (onRemoveNode(node.id)) {
        setSelection(null);
        if (pendingSource === node.id) setPendingSource(null);
      }
    }
  }

  function dropNode(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    const kind = event.dataTransfer.getData(AGENT_GRAPH_NODE_DRAG_TYPE) as AgentGraphNodeKind;
    if (!isNodeKind(kind)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onAddNode(kind, clampPosition({
      x: event.clientX - bounds.left - NODE_WIDTH / 2,
      y: event.clientY - bounds.top - NODE_HEIGHT / 2,
    }));
  }

  function connectTo(target: AgentGraphNode) {
    if (!pendingSource) return;
    if (onConnectNodes(pendingSource, target.id)) {
      setPendingSource(null);
    }
  }

  return (
    <div className="react-agent-graph-canvas-scroll">
      <div
        aria-label={t("graphs.canvas")}
        className="react-agent-graph-canvas"
        onClick={(event) => {
          if (event.currentTarget === event.target) setSelection(null);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropNode}
        ref={canvasRef}
        role="region"
      >
        <div className="react-agent-graph-canvas__toolbar">
          <p aria-live="polite">
            {pendingSourceNode
              ? t("graphs.connectingFrom", { kind: t(`graphs.nodes.${pendingSourceNode.kind}`) })
              : t("graphs.canvasHint")}
          </p>
          <span>
            {pendingSourceNode ? (
              <button type="button" onClick={() => setPendingSource(null)}>
                <X aria-hidden="true" size={14} />
                {t("graphs.cancelConnection")}
              </button>
            ) : null}
            <button
              aria-label={t("graphs.deleteSelected")}
              disabled={!canDeleteSelection}
              onClick={removeSelection}
              title={selectedNode && !canDeleteSelection ? t("graphs.boundaryNodeProtected") : undefined}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              {t("graphs.deleteSelected")}
            </button>
          </span>
        </div>

        <svg aria-label={t("graphs.connections")} className="react-agent-graph-canvas__edges" role="group">
          <defs>
            <marker id="agent-graph-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
              <path d="M 0 0 L 7 3.5 L 0 7 z" />
            </marker>
          </defs>
          {definition.edges.map((edge) => {
            const source = definition.nodes.find((node) => node.id === edge.source);
            const target = definition.nodes.find((node) => node.id === edge.target);
            if (!source || !target) return null;
            const path = createEdgePath(source, target);
            const isSelected = selection?.type === "edge" && selection.id === edge.id;
            return (
              <g key={edge.id}>
                <path className="react-agent-graph-edge" d={path} data-selected={isSelected} markerEnd="url(#agent-graph-arrow)" />
                <path
                  aria-label={t("graphs.connectionLabel", {
                    source: t(`graphs.nodes.${source.kind}`),
                    target: t(`graphs.nodes.${target.kind}`),
                  })}
                  aria-pressed={isSelected}
                  className="react-agent-graph-edge-hit"
                  d={path}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelection({ type: "edge", id: edge.id });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelection({ type: "edge", id: edge.id });
                    }
                  }}
                  role="button"
                  tabIndex={0}
                />
              </g>
            );
          })}
        </svg>

        {definition.nodes.map((node) => {
          const isSelected = selection?.type === "node" && selection.id === node.id;
          const isDragging = pointerDrag?.nodeId === node.id;
          return (
            <article
              aria-label={t("graphs.nodeLabel", { kind: t(`graphs.nodes.${node.kind}`) })}
              className="react-agent-graph-node"
              data-dragging={isDragging}
              data-kind={node.kind}
              data-selected={isSelected}
              data-x={node.position.x}
              data-y={node.position.y}
              key={node.id}
              onClick={(event) => {
                event.stopPropagation();
                selectNode(node.id);
              }}
              onKeyDown={(event) => moveNodeWithKeyboard(event, node)}
              onPointerCancel={finishNodeDrag}
              onPointerDown={(event) => startNodeDrag(event, node)}
              onPointerMove={moveDraggedNode}
              onPointerUp={finishNodeDrag}
              style={{ left: node.position.x, top: node.position.y }}
              tabIndex={0}
            >
              {node.kind !== "input" ? (
                <button
                  aria-label={pendingSource
                    ? t("graphs.connectNodes", {
                      source: t(`graphs.nodes.${pendingSourceNode?.kind ?? "input"}`),
                      target: t(`graphs.nodes.${node.kind}`),
                    })
                    : t("graphs.connectionTarget", { kind: t(`graphs.nodes.${node.kind}`) })}
                  className="react-agent-graph-node__handle react-agent-graph-node__handle--target"
                  disabled={!pendingSource}
                  onClick={(event) => {
                    event.stopPropagation();
                    connectTo(node);
                  }}
                  type="button"
                />
              ) : null}
              <NodeIcon kind={node.kind} />
              <span>
                <small>{t("graphs.node")}</small>
                <strong>{t(`graphs.nodes.${node.kind}`)}</strong>
              </span>
              {node.kind !== "output" ? (
                <button
                  aria-label={t("graphs.connectionSource", { kind: t(`graphs.nodes.${node.kind}`) })}
                  aria-pressed={pendingSource === node.id}
                  className="react-agent-graph-node__handle react-agent-graph-node__handle--source"
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingSource(pendingSource === node.id ? null : node.id);
                    selectNode(node.id);
                  }}
                  type="button"
                />
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function NodeIcon({ kind }: { kind: AgentGraphNodeKind }) {
  const Icon = kind === "agent"
    ? Bot
    : kind === "condition"
      ? GitBranch
      : CircleDot;
  return <Icon aria-hidden="true" size={17} />;
}

function clampPosition(position: AgentGraphNodePosition): AgentGraphNodePosition {
  return {
    x: Math.max(0, Math.min(CANVAS_WIDTH - NODE_WIDTH, position.x)),
    y: Math.max(64, Math.min(CANVAS_HEIGHT - NODE_HEIGHT, position.y)),
  };
}

function createEdgePath(source: AgentGraphNode, target: AgentGraphNode): string {
  const sourceX = source.position.x + NODE_WIDTH;
  const sourceY = source.position.y + NODE_HEIGHT / 2;
  const targetX = target.position.x;
  const targetY = target.position.y + NODE_HEIGHT / 2;
  const curve = Math.max(48, Math.abs(targetX - sourceX) / 2);
  return `M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`;
}

function isNodeKind(value: string): value is AgentGraphNodeKind {
  return value === "input" || value === "agent" || value === "condition" || value === "output";
}
