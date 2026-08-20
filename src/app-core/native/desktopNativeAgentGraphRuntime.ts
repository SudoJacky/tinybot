import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AgentGraphRuntime, AgentGraphRun } from "../agent-graph/agentGraphRuntime";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeAgentGraphRuntime(
  options: { invoke?: TauriInvoke } = {},
): AgentGraphRuntime {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: (input) => invoke("worker_agent_graph_runs_list", { input }) as Promise<AgentGraphRun[]>,
    start: (input) => invoke("worker_agent_graph_run", { input }) as Promise<AgentGraphRun>,
  };
}
