import type { AgentGraphDefinition } from "./agentGraphDefinition";

export type StoredAgentGraph = {
  definition: AgentGraphDefinition;
  revision: string;
};

export type AgentGraphStore = {
  list(workspacePath: string): Promise<StoredAgentGraph[]>;
  save(input: {
    workspacePath: string;
    definition: AgentGraphDefinition;
    expectedRevision?: string;
  }): Promise<StoredAgentGraph>;
  delete(input: {
    workspacePath: string;
    graphId: string;
    expectedRevision: string;
  }): Promise<void>;
};
