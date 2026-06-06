import type {
  DesktopKnowledgePaneModel,
  DesktopKnowledgeQueryResultRow,
} from "./desktopKnowledgeTraceability";
import type { DesktopTaskCenterItem } from "./desktopTaskCenter";

export type DesktopKnowledgeWorkbenchMode = "graph-2d" | "table" | "graph-3d";

export interface DesktopKnowledgeWorkbenchProjectionInput {
  pane: DesktopKnowledgePaneModel;
  mode: DesktopKnowledgeWorkbenchMode;
  selectedLayerIds?: Set<string>;
  selectedGraphId?: string;
  jobs?: DesktopTaskCenterItem[];
}

export interface DesktopKnowledgeWorkbenchProjection {
  commandBar: {
    readiness: string;
    stats: string;
    mode: DesktopKnowledgeWorkbenchMode;
    actions: string[];
  };
  leftPanel: {
    filters: string[];
    layers: Array<{ id: string; label: string; active: boolean }>;
    documents: Array<{ id: string; title: string; status: string; meta: string; selected: boolean }>;
  };
  mainView: {
    mode: DesktopKnowledgeWorkbenchMode;
    graph: {
      nodeCount: number;
      edgeCount: number;
      renderer: "sigma";
      lazy3dAvailable: boolean;
    };
    table: {
      rows: number;
    };
  };
  queryDrawer: {
    open: boolean;
    summary: DesktopKnowledgePaneModel["query"]["results"]["summary"];
    results: Array<{
      id: string;
      title: string;
      scoreLabel: string;
      evidencePaths: string[];
      actions: string[];
    }>;
  };
  detailDrawer: {
    open: boolean;
    id: string;
    title: string;
    kind: string;
    evidence: string[];
    conflicts: string[];
    communities: string[];
    actions: string[];
  };
  indexJobs: Array<{
    id: string;
    title: string;
    state: string;
    progress: DesktopTaskCenterItem["progress"];
    failure: string;
    documentLinks: string[];
    actions: string[];
  }>;
}

const LAYERS = [
  ["documents", "Documents"],
  ["claims", "Claims"],
  ["relations", "Relations"],
  ["communities", "Communities"],
  ["conflicts", "Conflicts"],
  ["evidence", "Evidence"],
] as const;

export function buildDesktopKnowledgeWorkbenchProjection(
  input: DesktopKnowledgeWorkbenchProjectionInput,
): DesktopKnowledgeWorkbenchProjection {
  const pane = input.pane;
  return {
    commandBar: {
      readiness: `${pane.readiness.score}%`,
      stats: pane.status,
      mode: input.mode,
      actions: commandActions(pane),
    },
    leftPanel: {
      filters: pane.configHints,
      layers: LAYERS.map(([id, label]) => ({
        id,
        label,
        active: Boolean(input.selectedLayerIds?.has(id)),
      })),
      documents: pane.documentRows.map((document) => ({
        id: document.id,
        title: document.title,
        status: document.status,
        meta: document.meta,
        selected: pane.selectedDocument?.id === document.id,
      })),
    },
    mainView: {
      mode: input.mode,
      graph: {
        nodeCount: pane.graph.view.nodes.length,
        edgeCount: pane.graph.view.edges.length,
        renderer: "sigma",
        lazy3dAvailable: true,
      },
      table: {
        rows: pane.documentRows.length,
      },
    },
    queryDrawer: {
      open: pane.query.results.rows.length > 0,
      summary: pane.query.results.summary,
      results: pane.query.results.rows.map(queryResult),
    },
    detailDrawer: graphDetailDrawer(pane, input.selectedGraphId),
    indexJobs: (input.jobs ?? []).map(indexJob),
  };
}

function commandActions(pane: DesktopKnowledgePaneModel): string[] {
  return [
    pane.actions.upload ? "upload" : "",
    pane.actions.query ? "query" : "",
    pane.actions.refreshGraph ? "refresh-graph" : "",
    pane.actions.rebuild ? "rebuild" : "",
    "show-stats",
    "mode-switch",
  ].filter(Boolean);
}

function queryResult(row: DesktopKnowledgeQueryResultRow) {
  return {
    id: row.id,
    title: row.docName,
    scoreLabel: row.scoreLabel,
    evidencePaths: row.traceabilitySections
      .flatMap((section) => section.rows)
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => item.title || item.id)
      .filter(Boolean),
    actions: ["use-in-chat", "open-graph-detail"],
  };
}

function graphDetailDrawer(
  pane: DesktopKnowledgePaneModel,
  selectedGraphId: string | undefined,
): DesktopKnowledgeWorkbenchProjection["detailDrawer"] {
  const node = selectedGraphId
    ? pane.graph.view.nodes.find((candidate) => candidate.id === selectedGraphId)
    : null;
  if (!node) {
    return {
      open: false,
      id: "",
      title: "",
      kind: "",
      evidence: [],
      conflicts: [],
      communities: [],
      actions: [],
    };
  }
  return {
    open: true,
    id: node.id,
    title: node.label,
    kind: node.type,
    evidence: evidenceIdsForNode(pane, node.id),
    conflicts: conflictsForNode(pane, node.id),
    communities: communitiesForNode(pane, node.id),
    actions: ["use-in-chat", "inspect-evidence", "open-source"],
  };
}

function evidenceIdsForNode(pane: DesktopKnowledgePaneModel, nodeId: string): string[] {
  const node = pane.graph.view.nodes.find((candidate) => candidate.id === nodeId);
  const rawEvidence = node?.raw.evidence_ids;
  if (Array.isArray(rawEvidence)) {
    return rawEvidence.map(String).filter(Boolean);
  }
  return pane.graph.view.evidenceRows
    .filter((row) => row.sourceNodeId === nodeId || row.targetNodeId === nodeId)
    .map((row) => row.id);
}

function conflictsForNode(pane: DesktopKnowledgePaneModel, nodeId: string): string[] {
  const direct = pane.graph.conflicts
    .filter((conflict) => {
      const rawNodeIds = optionalRecord(conflict).raw?.node_ids;
      return Array.isArray(rawNodeIds)
        ? rawNodeIds.map(String).includes(nodeId)
        : conflict.text.toLowerCase().includes(nodeId.toLowerCase()) || conflict.id.toLowerCase().includes(nodeId.toLowerCase());
    })
    .map((conflict) => conflict.id);
  return direct.length ? direct : pane.graph.conflicts.map((conflict) => conflict.id);
}

function communitiesForNode(pane: DesktopKnowledgePaneModel, nodeId: string): string[] {
  const node = pane.graph.view.nodes.find((candidate) => candidate.id === nodeId);
  const connectedNode = pane.graph.view.edges
    .filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId)
    .flatMap((edge) => [edge.sourceId, edge.targetId])
    .filter((id) => id !== nodeId)
    .map((id) => pane.graph.view.nodes.find((candidate) => candidate.id === id))
    .find((candidate) => typeof candidate?.raw.community_id === "string");
  const communityId = typeof node?.raw.community_id === "string"
    ? node.raw.community_id
    : typeof connectedNode?.raw.community_id === "string"
      ? connectedNode.raw.community_id
      : "";
  if (!communityId) {
    return [];
  }
  return pane.graph.communities
    .filter((community) => community.id === communityId || community.text.includes(communityId))
    .map((community) => community.title);
}

function indexJob(item: DesktopTaskCenterItem): DesktopKnowledgeWorkbenchProjection["indexJobs"][number] {
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    progress: item.progress,
    failure: item.diagnostics,
    documentLinks: item.relatedResources.map((resource) => resource.id.replace("knowledge-source:", "")),
    actions: item.state === "failed" ? ["retry", "cancel", "open-document"] : ["cancel", "open-document"],
  };
}

function optionalRecord(value: unknown): { raw?: Record<string, unknown> } {
  return typeof value === "object" && value !== null ? value as { raw?: Record<string, unknown> } : {};
}
