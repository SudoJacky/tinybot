export type AgentGraphRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentGraphNodeRunStatus = "pending" | "running" | "completed" | "failed";

export type AgentGraphNodeRun = {
  id: string;
  nodeId: string;
  threadId?: string;
  status: AgentGraphNodeRunStatus;
  router?: {
    rawResponse: string;
    selectedRouteId: string;
    selectedEdgeId: string;
    usage?: unknown;
  };
  error?: string;
};

export type AgentGraphRun = {
  schemaVersion: "tinybot.agent_graph_run.v1";
  id: string;
  graphId: string;
  graphRevision: string;
  definitionWorkspacePath: string;
  status: AgentGraphRunStatus;
  input: string;
  nodeRuns: AgentGraphNodeRun[];
  output?: string;
  error?: string;
};

export type AgentGraphRuntime = {
  list(input: {
    graphId: string;
    definitionWorkspacePath: string;
  }): Promise<AgentGraphRun[]>;
  start(input: {
    graphId: string;
    graphRevision: string;
    definitionWorkspacePath: string;
  }): Promise<AgentGraphRun>;
};
