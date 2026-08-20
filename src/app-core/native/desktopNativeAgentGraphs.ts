import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AgentGraphStore, StoredAgentGraph } from "../agent-graph/agentGraphStore";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeAgentGraphsApi(
  options: { invoke?: TauriInvoke } = {},
): AgentGraphStore {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: (workspacePath) => invoke("worker_agent_graphs_list", {
      input: { workspacePath },
    }) as Promise<StoredAgentGraph[]>,
    save: (input) => invoke("worker_agent_graph_save", { input }) as Promise<StoredAgentGraph>,
    async delete(input) {
      await invoke("worker_agent_graph_delete", { input });
    },
  };
}
