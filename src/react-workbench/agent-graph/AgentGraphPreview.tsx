import type { AgentGraphDefinition, AgentGraphNode } from "../../app-core/agent-graph/agentGraphDefinition";
import { NodeIcon } from "./AgentGraphCanvas";

const PREVIEW_NODE_WIDTH = 56;
const PREVIEW_NODE_HEIGHT = 44;
const PREVIEW_MARGIN = 44;

export function AgentGraphPreview({
  definition,
  label,
}: {
  definition: AgentGraphDefinition;
  label: string;
}) {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const viewBox = previewViewBox(definition.nodes);

  return (
    <div aria-label={label} className="react-agent-graph-preview" role="img">
      <svg aria-hidden="true" preserveAspectRatio="xMidYMid meet" viewBox={viewBox}>
        <g className="react-agent-graph-preview__edges">
          {definition.edges.map((edge) => {
            const source = nodesById.get(edge.source);
            const target = nodesById.get(edge.target);
            if (!source || !target) return null;
            return <path d={previewEdgePath(source, target)} key={edge.id} />;
          })}
        </g>
        {definition.nodes.map((node) => (
          <foreignObject
            height={PREVIEW_NODE_HEIGHT}
            key={node.id}
            width={PREVIEW_NODE_WIDTH}
            x={node.position.x}
            y={node.position.y}
          >
            <div className="react-agent-graph-preview__node" data-kind={node.kind}>
              <NodeIcon kind={node.kind} />
            </div>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}

function previewViewBox(nodes: AgentGraphNode[]): string {
  if (!nodes.length) return "0 0 760 400";
  const minX = Math.min(...nodes.map((node) => node.position.x)) - PREVIEW_MARGIN;
  const minY = Math.min(...nodes.map((node) => node.position.y)) - PREVIEW_MARGIN;
  const maxX = Math.max(...nodes.map((node) => node.position.x + PREVIEW_NODE_WIDTH)) + PREVIEW_MARGIN;
  const maxY = Math.max(...nodes.map((node) => node.position.y + PREVIEW_NODE_HEIGHT)) + PREVIEW_MARGIN;
  return `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`;
}

function previewEdgePath(source: AgentGraphNode, target: AgentGraphNode): string {
  const sourceX = source.position.x + PREVIEW_NODE_WIDTH;
  const sourceY = source.position.y + PREVIEW_NODE_HEIGHT / 2;
  const targetX = target.position.x;
  const targetY = target.position.y + PREVIEW_NODE_HEIGHT / 2;
  const curve = Math.max(24, Math.abs(targetX - sourceX) / 2);
  return `M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`;
}
