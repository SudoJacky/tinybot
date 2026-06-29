import type { JsonObject } from "../protocol/messages.ts";

export type CoworkSessionStatus = "active" | "paused" | "completed" | "blocked" | "failed" | string;
export type CoworkAgentStatus = "idle" | "working" | "waiting" | "blocked" | "done" | "failed" | "retired" | string;
export type CoworkTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped" | string;
export type CoworkBranchStatus = "active" | "paused" | "completed" | "failed" | string;

export interface CoworkAgent extends JsonObject {
  id: string;
  name: string;
  role: string;
  goal: string;
  responsibilities: string[];
  tools: string[];
  subscriptions: string[];
  communication_policy: string;
  context_policy: string;
  status: CoworkAgentStatus;
  private_summary: string;
  inbox: string[];
  current_task_id: string | null;
  current_task_title: string | null;
  last_active_at: string | null;
  rounds: number;
  parent_agent_id: string | null;
  team_id: string;
  lifetime: string;
  lifecycle_status: string;
  source_blueprint_id: string;
  source_event_id: string;
  spawn_reason: string;
  delegated_task_id: string;
  delegated_brief_id: string;
  isolated_context_id: string;
  sub_agent_scope: string;
}

export interface CoworkTask extends JsonObject {
  id: string;
  title: string;
  description: string;
  assigned_agent_id: string | null;
  dependencies: string[];
  status: CoworkTaskStatus;
  result: string | null;
  result_data: JsonObject;
  confidence: number | null;
  error: string | null;
  priority: number;
  expected_output: string;
  review_required: boolean;
  reviewer_agent_ids: string[];
  review_status: string;
  fanout_group_id: string;
  merge_task_id: string;
  source_blueprint_id: string;
  source_event_id: string;
  runtime_created: boolean;
  created_at: string;
  updated_at: string;
}

export interface CoworkBranch extends JsonObject {
  id: string;
  title: string;
  architecture: string;
  status: CoworkBranchStatus;
  topology_reference: JsonObject;
  source_branch_id: string | null;
  source_stage_record_id: string | null;
  derivation_event_id: string | null;
  derivation_reason: string;
  inherited_context_summary: string;
  runtime_state: JsonObject;
  completion_decision: JsonObject;
  branch_result: JsonObject | null;
  created_at: string;
  updated_at: string;
}

export interface CoworkEvent extends JsonObject {
  id: string;
  type: string;
  message: string;
  actor_id?: string | null;
  data?: JsonObject;
  created_at?: string;
}

export interface CoworkSession extends JsonObject {
  id: string;
  title: string;
  goal: string;
  status: CoworkSessionStatus;
  workflow_mode: string;
  current_branch_id: string;
  current_focus_task: string;
  workspace_dir: string;
  agents: Record<string, CoworkAgent>;
  tasks: Record<string, CoworkTask>;
  threads: Record<string, JsonObject>;
  messages: Record<string, JsonObject>;
  mailbox: Record<string, JsonObject>;
  events: CoworkEvent[];
  trace_spans: JsonObject[];
  agent_steps: JsonObject[];
  observation_details: Record<string, JsonObject>;
  sensitive_artifacts: Record<string, JsonObject>;
  delegation_guardrails: Record<string, JsonObject>;
  delegated_briefs: Record<string, JsonObject>;
  delegated_tasks: Record<string, JsonObject>;
  isolated_sub_agent_contexts: Record<string, JsonObject>;
  sub_agent_results: Record<string, JsonObject>;
  run_metrics: JsonObject[];
  scheduler_decisions: JsonObject[];
  branches: Record<string, CoworkBranch>;
  stage_records: JsonObject[];
  artifacts: string[];
  shared_memory: Record<string, JsonObject[]>;
  shared_summary: string;
  final_draft: string;
  completion_decision: JsonObject;
  session_final_result: JsonObject | null;
  swarm_plan: JsonObject;
  budget_limits: JsonObject;
  budget_usage: JsonObject;
  stop_reason: string;
  blueprint: JsonObject;
  blueprint_diagnostics: JsonObject[];
  runtime_state: JsonObject;
  created_at: string;
  updated_at: string;
  rounds: number;
  no_progress_rounds: number;
}

export interface CoworkStore {
  version: number;
  sessions: CoworkSession[];
}
