import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Bot, Check, CircleDot, GitBranch, LoaderCircle, Minus, Plus, Scan, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentGraphRun } from "../../app-core/agent-graph/agentGraphRuntime";
import type {
  AgentGraphDefinition,
  AgentGraphNode,
  AgentGraphNodeKind,
  AgentGraphNodePosition,
} from "../../app-core/agent-graph/agentGraphDefinition";

export const AGENT_GRAPH_NODE_DRAG_TYPE = "application/x-tinybot-agent-graph-node";

const INITIAL_WORLD_WIDTH = 760;
const INITIAL_WORLD_HEIGHT = 400;
const WORLD_ORIGIN_X = INITIAL_WORLD_WIDTH / 2;
const WORLD_ORIGIN_Y = INITIAL_WORLD_HEIGHT / 2;
const NODE_WIDTH = 154;
const NODE_HEIGHT = 76;
const KEYBOARD_MOVE_STEP = 8;
const KEYBOARD_PAN_STEP = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const CONFIG_PANEL_GAP = 12;
const CONFIG_PANEL_WIDTH = 340;
const CONFIG_PANEL_MIN_HEIGHT = 160;
const CONFIG_PANEL_MAX_HEIGHT = 500;
const CONFIG_PANEL_TOP_SAFE_AREA = 56;
const CONFIG_PANEL_BOTTOM_SAFE_AREA = 104;
const FIT_VIEW_HORIZONTAL_PADDING = 56;
const FIT_VIEW_TOP_PADDING = 72;
const FIT_VIEW_BOTTOM_PADDING = 112;

type GraphSelection =
  | { type: "node"; id: string }
  | { type: "edge"; id: string };

type NodePointerDrag = {
  pointerId: number;
  nodeId: string;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
};

type CanvasViewport = {
  panX: number;
  panY: number;
  zoom: number;
};

type CanvasPanDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
};

type CanvasSize = {
  width: number;
  height: number;
};

type PendingConnectionSource = {
  nodeId: string;
  routeId?: string;
};

const INITIAL_VIEWPORT: CanvasViewport = { panX: 0, panY: 0, zoom: 1 };
const INITIAL_CANVAS_SIZE: CanvasSize = { width: INITIAL_WORLD_WIDTH, height: INITIAL_WORLD_HEIGHT };

type AgentGraphCanvasProps = {
  definition: AgentGraphDefinition;
  configPanel?: ReactNode;
  configPanelNodeId?: string | null;
  run?: AgentGraphRun;
  readOnly?: boolean;
  onAddNode: (kind: AgentGraphNodeKind, position: AgentGraphNodePosition) => boolean;
  onMoveNode: (nodeId: string, position: AgentGraphNodePosition) => boolean;
  onConnectNodes: (source: string, target: string, sourceRouteId?: string) => boolean;
  onNodeActivate: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => boolean;
  onRemoveEdge: (edgeId: string) => boolean;
  onSelectionChange: (nodeId: string | null) => void;
};

export function AgentGraphCanvas({
  definition,
  configPanel,
  configPanelNodeId,
  run,
  readOnly = false,
  onAddNode,
  onMoveNode,
  onConnectNodes,
  onNodeActivate,
  onRemoveNode,
  onRemoveEdge,
  onSelectionChange,
}: AgentGraphCanvasProps) {
  const { t } = useTranslation("common");
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pointerMovedRef = useRef(false);
  const canvasPannedRef = useRef(false);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [pendingSource, setPendingSource] = useState<PendingConnectionSource | null>(null);
  const [pointerDrag, setPointerDrag] = useState<NodePointerDrag | null>(null);
  const [panDrag, setPanDrag] = useState<CanvasPanDrag | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(INITIAL_VIEWPORT);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(INITIAL_CANVAS_SIZE);
  const selectedNode = selection?.type === "node"
    ? definition.nodes.find((node) => node.id === selection.id)
    : undefined;
  const canDeleteSelection = selection?.type === "edge"
    || (selectedNode != null && selectedNode.kind !== "input" && selectedNode.kind !== "output");
  const pendingSourceNode = definition.nodes.find((node) => node.id === pendingSource?.nodeId);
  const pendingSourceRoute = pendingSourceNode?.kind === "condition"
    ? pendingSourceNode.config?.routes.find((route) => route.id === pendingSource?.routeId)
    : undefined;
  const configPanelNode = configPanelNodeId
    ? definition.nodes.find((node) => node.id === configPanelNodeId)
    : undefined;
  const configPanelPosition = configPanelNode
    ? positionConfigPanel(configPanelNode, viewport, canvasSize)
    : undefined;
  const viewportStyle = {
    "--graph-canvas-grid-size": `${18 * viewport.zoom}px`,
    "--graph-canvas-grid-offset-x": `${viewport.panX - WORLD_ORIGIN_X * viewport.zoom}px`,
    "--graph-canvas-grid-offset-y": `${viewport.panY - WORLD_ORIGIN_Y * viewport.zoom}px`,
    "--graph-canvas-pan-x": `${viewport.panX}px`,
    "--graph-canvas-pan-y": `${viewport.panY}px`,
    "--graph-canvas-zoom": viewport.zoom,
  } as CSSProperties;
  const stageStyle = {
    left: -WORLD_ORIGIN_X,
    top: -WORLD_ORIGIN_Y,
  } as CSSProperties;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateCanvasSize = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setCanvasSize({ width: bounds.width, height: bounds.height });
      }
    };
    updateCanvasSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateCanvasSize);
      return () => window.removeEventListener("resize", updateCanvasSize);
    }
    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  function selectNode(nodeId: string) {
    setSelection({ type: "node", id: nodeId });
    onSelectionChange(nodeId);
  }

  function removeSelection() {
    if (!selection || !canDeleteSelection) return;
    const removed = selection.type === "node"
      ? onRemoveNode(selection.id)
      : onRemoveEdge(selection.id);
    if (removed) {
      if (selection.type === "node" && pendingSource?.nodeId === selection.id) {
        setPendingSource(null);
      }
      setSelection(null);
      onSelectionChange(null);
    }
  }

  function setZoom(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    setViewport((current) => {
      const zoom = clampZoom(nextZoom);
      if (zoom === current.zoom) return current;
      if (!anchor || !bounds) return { ...current, zoom };
      const cursorX = anchor.clientX - bounds.left - bounds.width / 2;
      const cursorY = anchor.clientY - bounds.top - bounds.height / 2;
      const worldX = (cursorX - current.panX) / current.zoom;
      const worldY = (cursorY - current.panY) / current.zoom;
      return {
        panX: snapToDevicePixel(cursorX - worldX * zoom),
        panY: snapToDevicePixel(cursorY - worldY * zoom),
        zoom,
      };
    });
  }

  function moveViewport(deltaX: number, deltaY: number) {
    setViewport((current) => ({
      ...current,
      panX: snapToDevicePixel(current.panX + deltaX),
      panY: snapToDevicePixel(current.panY + deltaY),
    }));
  }

  function resetViewport() {
    setViewport(fitViewportToNodes(definition.nodes, canvasSize));
  }

  function startCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.button !== 0 && event.button !== 1)
      || (event.target as Element).closest(".react-agent-graph-node, .react-agent-graph-edge-hit, button")) return;
    event.preventDefault();
    canvasPannedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: viewport.panX,
      startPanY: viewport.panY,
    });
  }

  function moveCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - panDrag.startX;
    const deltaY = event.clientY - panDrag.startY;
    if (!canvasPannedRef.current && Math.hypot(deltaX, deltaY) < 4) return;
    canvasPannedRef.current = true;
    setViewport((current) => ({
      ...current,
      panX: snapToDevicePixel(panDrag.startPanX + deltaX),
      panY: snapToDevicePixel(panDrag.startPanY + deltaY),
    }));
  }

  function finishCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panDrag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPanDrag(null);
    if (canvasPannedRef.current) {
      window.setTimeout(() => {
        canvasPannedRef.current = false;
      }, 0);
    }
  }

  function handleCanvasWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const multiplier = wheelDeltaMultiplier(event.deltaMode, canvasRef.current?.clientHeight ?? INITIAL_WORLD_HEIGHT);
    if (event.ctrlKey || event.metaKey) {
      const zoomFactor = Math.exp(-event.deltaY * multiplier * WHEEL_ZOOM_SENSITIVITY);
      setZoom(viewport.zoom * zoomFactor, { clientX: event.clientX, clientY: event.clientY });
      return;
    }
    moveViewport(-event.deltaX * multiplier, -event.deltaY * multiplier);
  }

  function handleCanvasKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("input, textarea, select, [contenteditable='true']")) return;

    if (!readOnly && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      removeSelection();
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom(viewport.zoom + ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom(viewport.zoom - ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetViewport();
      }
      return;
    }

    if (event.target !== event.currentTarget) return;
    const delta = event.key === "ArrowLeft"
      ? { x: -KEYBOARD_PAN_STEP, y: 0 }
      : event.key === "ArrowRight"
        ? { x: KEYBOARD_PAN_STEP, y: 0 }
        : event.key === "ArrowUp"
          ? { x: 0, y: -KEYBOARD_PAN_STEP }
          : event.key === "ArrowDown"
            ? { x: 0, y: KEYBOARD_PAN_STEP }
            : null;
    if (delta) {
      event.preventDefault();
      moveViewport(delta.x, delta.y);
    }
  }

  function startNodeDrag(event: ReactPointerEvent<HTMLElement>, node: AgentGraphNode) {
    if (readOnly || event.button !== 0 || (event.target as Element).closest("button")) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const point = canvasPointFromClient(event.clientX, event.clientY, bounds, viewport);
    event.preventDefault();
    pointerMovedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selectNode(node.id);
    setPointerDrag({
      pointerId: event.pointerId,
      nodeId: node.id,
      offsetX: point.x - node.position.x,
      offsetY: point.y - node.position.y,
      startX: event.clientX,
      startY: event.clientY,
    });
  }

  function moveDraggedNode(event: ReactPointerEvent<HTMLElement>) {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - pointerDrag.startX) > 3 || Math.abs(event.clientY - pointerDrag.startY) > 3) {
      pointerMovedRef.current = true;
    }
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const point = canvasPointFromClient(event.clientX, event.clientY, bounds, viewport);
    onMoveNode(pointerDrag.nodeId, {
      x: point.x - pointerDrag.offsetX,
      y: point.y - pointerDrag.offsetY,
    });
  }

  function finishNodeDrag(event: ReactPointerEvent<HTMLElement>) {
    if (pointerDrag?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPointerDrag(null);
  }

  function moveNodeWithKeyboard(event: ReactKeyboardEvent<HTMLElement>, node: AgentGraphNode) {
    if (readOnly) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNodeActivate(node.id);
      }
      return;
    }
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
      onMoveNode(node.id, {
        x: node.position.x + delta.x,
        y: node.position.y + delta.y,
      });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNode(node.id);
      onNodeActivate(node.id);
      return;
    }
  }

  function dropNode(event: ReactDragEvent<HTMLDivElement>) {
    if (readOnly) return;
    event.preventDefault();
    const kind = event.dataTransfer.getData(AGENT_GRAPH_NODE_DRAG_TYPE) as AgentGraphNodeKind;
    if (!isNodeKind(kind)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = canvasPointFromClient(event.clientX, event.clientY, bounds, viewport);
    onAddNode(kind, {
      x: point.x - NODE_WIDTH / 2,
      y: point.y - NODE_HEIGHT / 2,
    });
  }

  function connectTo(target: AgentGraphNode) {
    if (!pendingSource) return;
    if (onConnectNodes(pendingSource.nodeId, target.id, pendingSource.routeId)) {
      setPendingSource(null);
    }
  }

  return (
    <div className="react-agent-graph-canvas-frame" style={viewportStyle}>
      <div className="react-agent-graph-canvas__toolbar">
        <p aria-live="polite">
          {pendingSourceNode
            ? t("graphs.connectingFrom", {
                kind: pendingSourceRoute?.label ?? t(`graphs.nodes.${pendingSourceNode.kind}`),
              })
            : t(readOnly ? "graphs.canvasViewHint" : "graphs.canvasHint")}
        </p>
        {!readOnly ? <span>
          {pendingSourceNode ? (
            <button type="button" onClick={() => setPendingSource(null)}>
              <X aria-hidden="true" size={14} />
              {t("graphs.cancelConnection")}
            </button>
          ) : null}
          <button
            aria-label={t("graphs.deleteSelected")}
            aria-keyshortcuts="Delete Backspace"
            disabled={!canDeleteSelection}
            onClick={removeSelection}
            title={selectedNode && !canDeleteSelection ? t("graphs.boundaryNodeProtected") : undefined}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />
            {t("graphs.deleteSelected")}
          </button>
        </span> : null}
      </div>

      <div
        aria-label={t("graphs.canvasControls")}
        className="react-agent-graph-canvas__viewport-controls"
        role="group"
      >
        <button
          aria-keyshortcuts="Control+- Meta+-"
          aria-label={t("graphs.zoomOut")}
          disabled={viewport.zoom <= MIN_ZOOM}
          onClick={() => setZoom(viewport.zoom - ZOOM_STEP)}
          title={t("graphs.zoomOutShortcut")}
          type="button"
        >
          <Minus aria-hidden="true" size={14} />
        </button>
        <button
          aria-keyshortcuts="Control+0 Meta+0"
          aria-label={t("graphs.resetCanvasView")}
          className="react-agent-graph-canvas__zoom-level"
          onClick={resetViewport}
          title={t("graphs.resetCanvasViewShortcut")}
          type="button"
        >
          <Scan aria-hidden="true" size={13} />
          <span>{Math.round(viewport.zoom * 100)}%</span>
        </button>
        <button
          aria-keyshortcuts="Control+= Meta+="
          aria-label={t("graphs.zoomIn")}
          disabled={viewport.zoom >= MAX_ZOOM}
          onClick={() => setZoom(viewport.zoom + ZOOM_STEP)}
          title={t("graphs.zoomInShortcut")}
          type="button"
        >
          <Plus aria-hidden="true" size={14} />
        </button>
      </div>

      <div className="react-agent-graph-canvas-scroll">
        <div
          aria-label={t("graphs.canvas")}
          className="react-agent-graph-canvas"
          data-panning={Boolean(panDrag)}
          onClick={(event) => {
            if (canvasPannedRef.current) {
              canvasPannedRef.current = false;
              return;
            }
            if (!(event.target as Element).closest(".react-agent-graph-node, .react-agent-graph-edge-hit")) {
              setSelection(null);
              onSelectionChange(null);
            }
          }}
          onDragOver={(event) => {
            if (!readOnly) event.preventDefault();
          }}
          onDrop={dropNode}
          onKeyDown={handleCanvasKeyDown}
          onPointerCancel={finishCanvasPan}
          onPointerDown={startCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={finishCanvasPan}
          onWheel={handleCanvasWheel}
          ref={canvasRef}
          role="region"
          tabIndex={0}
        >
        <div
          className="react-agent-graph-canvas__viewport"
          data-pan-x={viewport.panX}
          data-pan-y={viewport.panY}
          data-zoom={viewport.zoom}
        >
        <div className="react-agent-graph-canvas__stage" data-zoom={viewport.zoom} style={stageStyle}>
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
            const sourceRoute = source.kind === "condition"
              ? source.config?.routes.find((route) => route.id === edge.sourceRouteId)
              : undefined;
            const path = createEdgePath(source, target, edge.sourceRouteId);
            const isSelected = selection?.type === "edge" && selection.id === edge.id;
            const runtimeStatus = edgeRuntimeStatus(edge.id, source, target, run);
            return (
              <g key={edge.id}>
                <path
                  className="react-agent-graph-edge"
                  d={path}
                  data-runtime-status={runtimeStatus}
                  data-selected={isSelected}
                  markerEnd="url(#agent-graph-arrow)"
                />
                {!readOnly ? <path
                  aria-label={t("graphs.connectionLabel", {
                    source: sourceRoute?.label ?? t(`graphs.nodes.${source.kind}`),
                    target: t(`graphs.nodes.${target.kind}`),
                  })}
                  aria-pressed={isSelected}
                  className="react-agent-graph-edge-hit"
                  d={path}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelection({ type: "edge", id: edge.id });
                    onSelectionChange(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelection({ type: "edge", id: edge.id });
                      onSelectionChange(null);
                    }
                  }}
                  onFocus={() => {
                    setSelection({ type: "edge", id: edge.id });
                    onSelectionChange(null);
                  }}
                  role="button"
                  tabIndex={0}
                /> : null}
              </g>
            );
          })}
          </svg>

          {definition.nodes.map((node) => {
          const isSelected = selection?.type === "node" && selection.id === node.id;
          const isDragging = pointerDrag?.nodeId === node.id;
          const runtimeStatus = agentGraphNodeStatus(node, run);
          return (
            <article
              aria-label={t("graphs.nodeLabel", { kind: t(`graphs.nodes.${node.kind}`) })}
              className="react-agent-graph-node"
              data-dragging={isDragging}
              data-kind={node.kind}
              data-read-only={readOnly}
              data-runtime-status={runtimeStatus}
              data-selected={isSelected}
              data-x={node.position.x}
              data-y={node.position.y}
              key={node.id}
              onClick={(event) => {
                event.stopPropagation();
                if (readOnly) {
                  event.currentTarget.focus({ preventScroll: true });
                  onNodeActivate(node.id);
                  return;
                }
                selectNode(node.id);
                if (pointerMovedRef.current) {
                  pointerMovedRef.current = false;
                  return;
                }
                event.currentTarget.focus({ preventScroll: true });
                onNodeActivate(node.id);
              }}
              onKeyDown={(event) => moveNodeWithKeyboard(event, node)}
              onFocus={() => {
                if (!readOnly) selectNode(node.id);
              }}
              onPointerCancel={finishNodeDrag}
              onPointerDown={(event) => startNodeDrag(event, node)}
              onPointerMove={moveDraggedNode}
              onPointerUp={finishNodeDrag}
              style={{
                ...(node.kind === "condition" ? { height: nodeHeight(node) } : {}),
                left: node.position.x,
                top: node.position.y,
              }}
              tabIndex={0}
            >
              {!readOnly && node.kind !== "input" ? (
                <button
                  aria-label={pendingSource
                    ? t("graphs.connectNodes", {
                      source: pendingSourceRoute?.label
                        ?? t(`graphs.nodes.${pendingSourceNode?.kind ?? "input"}`),
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
                <small title={node.kind === "agent" ? node.config.workspacePath : undefined}>
                  {node.kind === "agent" ? workspaceName(node.config.workspacePath) : t("graphs.node")}
                </small>
                <strong>{t(`graphs.nodes.${node.kind}`)}</strong>
              </span>
              {runtimeStatus !== "not_run" ? (
                <span aria-hidden="true" className="react-agent-graph-node__runtime-status">
                  {runtimeStatus === "running"
                    ? <LoaderCircle size={13} />
                    : runtimeStatus === "completed"
                      ? <Check size={13} />
                      : null}
                  <small>{t(`graphs.nodeInspectionStatuses.${runtimeStatus}`)}</small>
                </span>
              ) : null}
              {!readOnly && node.kind !== "output" && node.kind !== "condition" ? (
                <button
                  aria-label={t("graphs.connectionSource", { kind: t(`graphs.nodes.${node.kind}`) })}
                  aria-pressed={pendingSource?.nodeId === node.id && !pendingSource.routeId}
                  className="react-agent-graph-node__handle react-agent-graph-node__handle--source"
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingSource(
                      pendingSource?.nodeId === node.id && !pendingSource.routeId
                        ? null
                        : { nodeId: node.id },
                    );
                    selectNode(node.id);
                  }}
                  type="button"
                />
              ) : null}
              {!readOnly && node.kind === "condition" ? node.config?.routes.map((route, index) => {
                const top = routeHandleTop(node, index);
                const active = pendingSource?.nodeId === node.id && pendingSource.routeId === route.id;
                return (
                  <span className="react-agent-graph-node__route-port" key={route.id} style={{ top }}>
                    <small title={route.label}>{route.label}</small>
                    <button
                      aria-label={t("graphs.routerConnectionSource", { label: route.label })}
                      aria-pressed={active}
                      className="react-agent-graph-node__handle react-agent-graph-node__handle--source"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingSource(active ? null : { nodeId: node.id, routeId: route.id });
                        selectNode(node.id);
                      }}
                      type="button"
                    />
                  </span>
                );
              }) : null}
            </article>
          );
          })}
        </div>
        </div>
        {configPanel && configPanelNode && configPanelPosition ? (
          <div
            className="react-agent-graph-canvas__node-config-popover"
            data-anchor-node-id={configPanelNode.id}
            data-placement={configPanelPosition.placement}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            style={configPanelPosition.style}
          >
            {configPanel}
          </div>
        ) : null}
        </div>
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

function createEdgePath(source: AgentGraphNode, target: AgentGraphNode, sourceRouteId?: string): string {
  const sourceX = source.position.x + NODE_WIDTH;
  const routeIndex = source.kind === "condition"
    ? source.config?.routes.findIndex((route) => route.id === sourceRouteId) ?? -1
    : -1;
  const sourceY = source.position.y + (routeIndex >= 0
    ? routeHandleTop(source, routeIndex)
    : nodeHeight(source) / 2);
  const targetX = target.position.x;
  const targetY = target.position.y + nodeHeight(target) / 2;
  const curve = Math.max(48, Math.abs(targetX - sourceX) / 2);
  return `M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`;
}

function nodeHeight(node: AgentGraphNode): number {
  return node.kind === "condition" && node.config
    ? Math.max(NODE_HEIGHT, 48 + node.config.routes.length * 24)
    : NODE_HEIGHT;
}

function routeHandleTop(node: AgentGraphNode, index: number): number {
  const height = nodeHeight(node);
  const routeCount = node.kind === "condition" ? node.config?.routes.length ?? 0 : 0;
  return routeCount > 0 ? 42 + index * ((height - 50) / routeCount) : height / 2;
}

function canvasPointFromClient(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: CanvasViewport,
): AgentGraphNodePosition {
  return {
    x: WORLD_ORIGIN_X + (clientX - bounds.left - bounds.width / 2 - viewport.panX) / viewport.zoom,
    y: WORLD_ORIGIN_Y + (clientY - bounds.top - bounds.height / 2 - viewport.panY) / viewport.zoom,
  };
}

function fitViewportToNodes(nodes: AgentGraphNode[], canvasSize: CanvasSize): CanvasViewport {
  if (nodes.length === 0) return INITIAL_VIEWPORT;

  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.position.y + nodeHeight(node)));
  const graphWidth = Math.max(NODE_WIDTH, maxX - minX);
  const graphHeight = Math.max(NODE_HEIGHT, maxY - minY);
  const availableWidth = Math.max(
    NODE_WIDTH,
    canvasSize.width - FIT_VIEW_HORIZONTAL_PADDING * 2,
  );
  const availableHeight = Math.max(
    NODE_HEIGHT,
    canvasSize.height - FIT_VIEW_TOP_PADDING - FIT_VIEW_BOTTOM_PADDING,
  );
  const zoom = clampZoom(Math.min(1, availableWidth / graphWidth, availableHeight / graphHeight));
  const graphCenterX = (minX + maxX) / 2;
  const graphCenterY = (minY + maxY) / 2;
  const availableCenterY = FIT_VIEW_TOP_PADDING + availableHeight / 2;

  return {
    panX: snapToDevicePixel((WORLD_ORIGIN_X - graphCenterX) * zoom),
    panY: snapToDevicePixel(
      availableCenterY
      - canvasSize.height / 2
      - (graphCenterY - WORLD_ORIGIN_Y) * zoom,
    ),
    zoom,
  };
}

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 100) / 100));
}

function snapToDevicePixel(value: number): number {
  const pixelRatio = window.devicePixelRatio || 1;
  return Math.round(value * pixelRatio) / pixelRatio;
}

function positionConfigPanel(
  node: AgentGraphNode,
  viewport: CanvasViewport,
  canvasSize: CanvasSize,
): { placement: "above" | "below"; style: CSSProperties } {
  const nodeTop = canvasSize.height / 2
    + viewport.panY
    + (node.position.y - WORLD_ORIGIN_Y) * viewport.zoom;
  const nodeBottom = nodeTop + nodeHeight(node) * viewport.zoom;
  const desiredCenterX = canvasSize.width / 2
    + viewport.panX
    + (node.position.x + NODE_WIDTH / 2 - WORLD_ORIGIN_X) * viewport.zoom;
  const panelHalfWidth = Math.min(CONFIG_PANEL_WIDTH, canvasSize.width - 24) / 2;
  const centerX = Math.max(
    panelHalfWidth + 12,
    Math.min(canvasSize.width - panelHalfWidth - 12, desiredCenterX),
  );
  const spaceBelow = canvasSize.height - CONFIG_PANEL_BOTTOM_SAFE_AREA - nodeBottom - CONFIG_PANEL_GAP;
  const spaceAbove = nodeTop - CONFIG_PANEL_TOP_SAFE_AREA - CONFIG_PANEL_GAP;
  const placement = spaceBelow >= CONFIG_PANEL_MIN_HEIGHT || spaceBelow >= spaceAbove ? "below" : "above";
  const availableHeight = placement === "below" ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(
    CONFIG_PANEL_MIN_HEIGHT,
    Math.min(CONFIG_PANEL_MAX_HEIGHT, Math.floor(availableHeight)),
  );

  const style = {
    "--graph-config-panel-max-height": `${maxHeight}px`,
    left: snapToDevicePixel(centerX),
    top: snapToDevicePixel(placement === "below"
      ? nodeBottom + CONFIG_PANEL_GAP
      : nodeTop - CONFIG_PANEL_GAP),
    maxHeight,
  } as CSSProperties;
  return { placement, style };
}

function wheelDeltaMultiplier(deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return 16;
  if (deltaMode === 2) return pageHeight;
  return 1;
}

type AgentGraphNodeRuntimeStatus =
  | "not_run"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

function agentGraphNodeStatus(
  node: AgentGraphNode,
  run?: AgentGraphRun,
): AgentGraphNodeRuntimeStatus {
  if (!run) return "not_run";
  if (node.kind === "input") return "completed";
  if (node.kind === "output") {
    return run.status === "completed"
      ? "completed"
      : run.status === "failed" || run.status === "cancelled"
        ? run.status
        : "pending";
  }
  const nodeRun = [...run.nodeRuns].reverse().find((candidate) => candidate.nodeId === node.id);
  return nodeRun?.status ?? (run.status === "running" ? "pending" : "not_run");
}

function edgeRuntimeStatus(
  edgeId: string,
  source: AgentGraphNode,
  target: AgentGraphNode,
  run?: AgentGraphRun,
): "idle" | "active" | "completed" {
  if (!run) return "idle";
  if (source.kind === "condition") {
    const routerRun = [...run.nodeRuns]
      .reverse()
      .find((candidate) => candidate.nodeId === source.id)?.router;
    if (!routerRun || routerRun.selectedEdgeId !== edgeId) return "idle";
  }
  const sourceStatus = agentGraphNodeStatus(source, run);
  const targetStatus = agentGraphNodeStatus(target, run);
  if (sourceStatus === "completed" && targetStatus === "completed") return "completed";
  if (sourceStatus === "completed" && (targetStatus === "pending" || targetStatus === "running")) return "active";
  return "idle";
}

function isNodeKind(value: string): value is AgentGraphNodeKind {
  return value === "input" || value === "agent" || value === "condition" || value === "output";
}

function workspaceName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
