import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ToolCallRequest, ToolDefinition } from "../model/provider.ts";
import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { normalizeArchitectureName } from "./coworkArchitecture";
import { DEFAULT_COWORK_AGENT_TOOLS, type CoworkAgentInput, type CoworkTaskInput } from "./coworkService";

export type CoworkTeamPlan = {
  title: string;
  agents: CoworkAgentInput[];
  tasks: CoworkTaskInput[];
};

export type CoworkTeamPlannerOptions = {
  provider: ModelProvider;
  model?: string;
  workspace?: string;
};

const SUBMIT_COWORK_TEAM_TOOL: ToolDefinition = {
  name: "submit_cowork_team",
  description: "Create a dynamic cowork team and initial task assignments.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short session title" },
      agents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable lowercase identifier" },
            name: { type: "string" },
            role: { type: "string" },
            goal: { type: "string" },
            responsibilities: { type: "array", items: { type: "string" } },
            tools: { type: "array", items: { type: "string" } },
            subscriptions: { type: "array", items: { type: "string" } },
            communication_policy: { type: "string" },
            context_policy: { type: "string" },
          },
          required: ["id", "name", "role", "goal", "responsibilities"],
        },
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            assigned_agent_id: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          required: ["id", "title", "description"],
        },
      },
    },
    required: ["title", "agents", "tasks"],
  },
};

export class CoworkTeamPlanner {
  private readonly provider: ModelProvider;
  private readonly model?: string;
  private readonly workspace: string;

  constructor(options: CoworkTeamPlannerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace ?? "";
  }

  async plan(goal: string, workflowMode = "adaptive_starter"): Promise<CoworkTeamPlan> {
    const mode = normalizeArchitectureName(workflowMode);
    const messages: AgentMessage[] = [
      { role: "system", content: "You design compact multi-agent cowork teams." },
      { role: "user", content: plannerPrompt(goal, mode, this.workspace) },
    ];
    try {
      const response = await this.provider.complete(messages, {
        model: this.model,
        tools: [SUBMIT_COWORK_TEAM_TOOL],
        toolChoice: { type: "function", function: { name: "submit_cowork_team" } },
        maxTokens: 4096,
        temperature: 0.2,
      });
      const call = response.toolCalls.find((toolCall) => toolCall.name === "submit_cowork_team") ?? response.toolCalls[0];
      const parsed = call ? parseTeamToolCall(call) : null;
      if (parsed && parsed.agents.length > 0) {
        const agents = ensureReviewerIfNeeded(goal, parsed.agents);
        return {
          title: parsed.title || "Cowork Session",
          agents,
          tasks: parsed.tasks,
        };
      }
    } catch {
      // Fall through to deterministic fallback. The caller can still start a session.
    }
    const agents = ensureReviewerIfNeeded(goal, defaultTeam(goal));
    return {
      title: "Cowork Session",
      agents,
      tasks: leaderInitialTasks(goal, agents, []),
    };
  }
}

function parseTeamToolCall(call: ToolCallRequest): CoworkTeamPlan | null {
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson || "{}");
    if (!isJsonObject(parsed)) {
      return null;
    }
    return {
      title: stringValue(parsed.title) || "Cowork Session",
      agents: jsonObjectArray(parsed.agents).map(normalizeAgentInput),
      tasks: jsonObjectArray(parsed.tasks).map(normalizeTaskInput),
    };
  } catch {
    return null;
  }
}

function plannerPrompt(goal: string, mode: string, workspace: string): string {
  return [
    "Design a dynamic cowork team for this user goal.",
    "",
    "Goal:",
    goal,
    "",
    "Architecture:",
    mode,
    "",
    "Mode guidance:",
    modeGuidance(mode),
    "",
    "Create 1-6 agents. Do not hard-code software roles unless the goal is software work.",
    "Use fewer agents when the goal is simple, conversational, or directly answerable.",
    "Each agent should have a distinct responsibility, private perspective, and clear reason to communicate with others.",
    "Add 2-5 short subscriptions per agent for message-bus routing, such as domain names, request types, or event topics.",
    "Include a reviewer/evaluator only when the goal has meaningful risk, verification needs, code changes, research claims, or decision tradeoffs.",
    "Create exactly one initial task assigned to the lead/coordinator. The lead is responsible for deciding whether to message or assign tasks to other agents later.",
    `Workspace: ${workspace || "(native worker)"}`,
  ].join("\n");
}

function modeGuidance(mode: string): string {
  const guidance: Record<string, string> = {
    orchestrator: "Prefer one lead/coordinator plus only the specialists that are clearly needed. Simple goals may use a single coordinator.",
    supervisor: "Prefer one supervisor plus only the specialists that are clearly needed. Simple goals may use a single supervisor.",
    team: "Create a small long-lived team with domain owners; avoid generic researcher/analyst roles unless they fit the goal.",
    generator_verifier: "Use producer and verifier roles. Add more agents only when separate domains are required.",
    message_bus: "Create topic-oriented subscribers/publishers whose subscriptions match the goal.",
    shared_state: "Create contributors who maintain distinct shared-state buckets such as findings, risks, decisions, or artifacts.",
    peer_handoff: "Create agents that own sequential handoff steps. Keep the chain short.",
    swarm: "Create a bounded swarm plan with focused specialists and clear merge/synthesis ownership.",
    adaptive_starter: "Choose the smallest useful team. For simple goals, one coordinator is enough; add specialists only for distinct workstreams.",
  };
  return guidance[mode] ?? "Choose the smallest useful team.";
}

function ensureReviewerIfNeeded(goal: string, agents: CoworkAgentInput[]): CoworkAgentInput[] {
  const text = goal.toLowerCase();
  const needsReview = [
    "code",
    "test",
    "bug",
    "review",
    "verify",
    "验证",
    "评审",
    "测试",
    "代码",
    "风险",
    "research",
    "compare",
    "decision",
    "事实",
    "对比",
    "决策",
  ].some((marker) => text.includes(marker.toLowerCase()));
  if (!needsReview || agents.some((agent) => `${agent.id ?? ""} ${agent.role ?? ""}`.toLowerCase().match(/review|evaluator/))) {
    return agents;
  }
  return [
    ...agents,
    {
      id: "reviewer",
      name: "Reviewer",
      role: "Quality and risk reviewer",
      goal: `Review assumptions, risks, and completeness for: ${goal}`,
      responsibilities: ["Check claims and assumptions", "Find gaps or risks", "Recommend whether to finish or continue"],
      tools: [...DEFAULT_COWORK_AGENT_TOOLS],
      subscriptions: ["review", "verify", "risk", "quality", "verification_requested"],
      communication_policy: "Review completed work when asked by the lead or when a task needs validation.",
      context_policy: "Use shared summaries, task results, and targeted file reads instead of replaying the full conversation.",
    },
  ];
}

function defaultTeam(goal: string): CoworkAgentInput[] {
  return [{
    id: "coordinator",
    name: "Coordinator",
    role: "Team coordinator",
    goal: `Keep the collaboration focused on: ${goal}`,
    responsibilities: ["Break down work", "Route questions", "Synthesize final progress"],
    tools: [...DEFAULT_COWORK_AGENT_TOOLS],
    subscriptions: ["coordination", "handoff", "unblock", "decision", "summary"],
  }];
}

export function leaderInitialTasks(goal: string, agents: CoworkAgentInput[], plannedTasks: CoworkTaskInput[]): CoworkTaskInput[] {
  const lead = agents.find((agent) => ["coordinator", "lead", "team_lead", "team-lead"].includes(stringValue(agent.id)))
    ?? agents[0];
  const leadId = stringValue(lead?.id) || "coordinator";
  const taskLines = plannedTasks
    .filter((task) => stringValue(task.title))
    .map((task) => `- ${task.title}: ${task.description || task.title}`);
  const delegatedHint = taskLines.length > 0
    ? `\nPotential workstreams from planning:\n${taskLines.join("\n")}`
    : "";
  return [{
    id: "lead_start",
    title: "Decide team plan and delegation",
    description: [
      "Understand the user's goal, decide whether teammates are needed, and assign or message them only when their contribution is necessary.",
      "",
      `Goal: ${goal}${delegatedHint}`,
    ].join("\n"),
    assigned_agent_id: leadId,
    dependencies: [],
  }];
}

function normalizeAgentInput(value: JsonObject): CoworkAgentInput {
  return {
    ...value,
    id: stringValue(value.id),
    name: stringValue(value.name),
    role: stringValue(value.role),
    goal: stringValue(value.goal),
    responsibilities: stringList(value.responsibilities),
    tools: stringList(value.tools),
    subscriptions: stringList(value.subscriptions),
    communication_policy: stringValue(value.communication_policy),
    context_policy: stringValue(value.context_policy),
  };
}

function normalizeTaskInput(value: JsonObject): CoworkTaskInput {
  return {
    ...value,
    id: stringValue(value.id),
    title: stringValue(value.title),
    description: stringValue(value.description),
    assigned_agent_id: stringValue(value.assigned_agent_id) || null,
    dependencies: stringList(value.dependencies),
  };
}

function jsonObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
