import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { ADAPTIVE_STARTER, normalizeArchitectureName } from "./coworkArchitecture";
import type { CoworkAgent, CoworkSession, CoworkTask } from "./coworkTypes";

export interface ArchitectureCapabilityResult {
  status: string;
  reason: string;
  payload: JsonObject;
}

export interface ArchitectureRuntimePolicy {
  architecture: string;
  displayName: string;
  runtimeProfile: string;
  supportedCapabilities: Set<string>;
  topology(session: CoworkSession, options?: { branchId?: string }): ArchitectureCapabilityResult;
  buildProjection(session: CoworkSession, options?: { branchId?: string }): ArchitectureCapabilityResult;
  evaluateCompletion(session: CoworkSession): ArchitectureCapabilityResult;
}

export class ArchitecturePolicyRegistry {
  private readonly policies = new Map<string, ArchitectureRuntimePolicy>();

  constructor(policies: ArchitectureRuntimePolicy[] = []) {
    policies.forEach((policy) => this.register(policy));
  }

  register(policy: ArchitectureRuntimePolicy): void {
    this.policies.set(normalizeArchitectureName(policy.architecture), policy);
  }

  resolve(architecture: string): ArchitectureRuntimePolicy {
    const canonical = normalizeArchitectureName(architecture);
    return this.policies.get(canonical) ?? mustGet(this.policies, ADAPTIVE_STARTER);
  }

  get architectures(): string[] {
    return [...this.policies.keys()].sort();
  }
}

export function defaultPolicyRegistry(): ArchitecturePolicyRegistry {
  return new ArchitecturePolicyRegistry([
    new AdaptiveStarterPolicy(),
    new GeneratorVerifierPolicy(),
    new MessageBusPolicy(),
    new SharedStatePolicy(),
    new SwarmPolicy(),
    new AgentTeamPolicy(),
  ]);
}

class BasePolicy implements ArchitectureRuntimePolicy {
  architecture = ADAPTIVE_STARTER;
  displayName = "Adaptive Starter";
  runtimeProfile = "hybrid";
  supportedCapabilities = new Set([
    "topology",
    "branch_initialization",
    "step_selection",
    "envelope_routing",
    "delegation",
    "completion",
    "projection",
  ]);

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const branchId = options.branchId ?? "default";
    const roles = Object.values(session.agents).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      responsibilities: [...agent.responsibilities],
      parent_agent_id: agent.parent_agent_id,
      lifetime: agent.lifetime,
      lifecycle_status: agent.lifecycle_status,
      delegated_task_id: agent.delegated_task_id,
      sub_agent_scope: agent.sub_agent_scope,
    }));
    const relationships: JsonObject[] = roles.map((agent) => ({
      from: "session",
      to: agent.id,
      kind: "member",
    }));
    roles.forEach((agent) => {
      if (agent.parent_agent_id) {
        relationships.push({
          from: agent.parent_agent_id,
          to: agent.id,
          kind: "parent_of",
          delegated_task_id: agent.delegated_task_id,
        });
      }
    });
    const delegatedTasks = Object.values(session.delegated_tasks)
      .filter((item) => !item.branch_id || item.branch_id === branchId)
      .map((item) => ({
        id: stringValue(item.id),
        parent_agent_id: stringValue(item.parent_agent_id),
        sub_agent_id: stringValue(item.sub_agent_id),
        brief_id: stringValue(item.brief_id),
        status: stringValue(item.status),
        scope: stringValue(item.scope),
        result_id: stringValue(item.result_id),
      }));
    return result("available", "Legacy Cowork session participants projected as architecture topology.", {
      schema_version: "cowork.architecture_topology.v1",
      architecture: this.architecture,
      branch_id: branchId,
      roles,
      relationships,
      routes: [],
      stores: [],
      loops: [],
      status: session.status,
      metadata: {
        policy: this.constructor.name,
        display_name: this.displayName,
        runtime_profile: this.runtimeProfile,
        delegated_tasks: delegatedTasks,
      },
    });
  }

  buildProjection(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const branchId = options.branchId ?? "default";
    const topology = this.topology(session, { branchId }).payload;
    const sections: JsonObject[] = [];
    const delegatedTasks = isJsonObject(topology.metadata) && Array.isArray(topology.metadata.delegated_tasks)
      ? topology.metadata.delegated_tasks
      : [];
    if (delegatedTasks.length > 0) {
      sections.push({ id: "delegation", title: "Agent Delegation", items: delegatedTasks });
    }
    return result("available", "Projection uses the policy topology plus legacy detail views during migration.", {
      schema_version: "cowork.organization_projection.v1",
      architecture: this.architecture,
      branch_id: branchId,
      display_name: this.displayName,
      topology,
      sections,
      metadata: {
        policy: this.constructor.name,
        runtime_profile: this.runtimeProfile,
      },
    });
  }

  evaluateCompletion(_session: CoworkSession): ArchitectureCapabilityResult {
    return result("delegated", "Completion is delegated to legacy Cowork assessment during migration.", {});
  }
}

class AdaptiveStarterPolicy extends BasePolicy {
  architecture = ADAPTIVE_STARTER;
  displayName = "Adaptive Starter";
  runtimeProfile = "hybrid";

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    return result(base.status, base.reason, {
      ...base.payload,
      loops: [{
        id: "clarify_recommend_launch",
        kind: "starter_loop",
        label: "Clarify, recommend, or launch smallest useful structure",
        status: session.status,
      }],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        canonical_replaces: "hybrid",
      },
    });
  }

  buildProjection(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.buildProjection(session, options);
    const recommendation = recommendArchitecture(session);
    return result("available", "Adaptive Starter projection exposes recommendation state.", {
      ...base.payload,
      sections: [{
        id: "starter",
        title: "Adaptive Starter",
        items: [{
          kind: "recommendation_state",
          status: session.status,
          focus: session.current_focus_task || session.goal,
          recommendation,
        }],
      }],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        recommendation,
        derivation_supported: true,
      },
    });
  }
}

class AgentTeamPolicy extends BasePolicy {
  architecture = "team";
  displayName = "Agent Team";
  runtimeProfile = "team";

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    const coordinatorId = coordinatorIdFor(session);
    const workerRelationships = Object.values(session.agents)
      .filter((agent) => agent.id !== coordinatorId && agent.lifetime !== "temporary")
      .map((agent) => ({
        from: coordinatorId,
        to: agent.id,
        kind: "coordinates_worker_domain",
        worker_domain: workerDomain(agent),
      }));
    return result("available", "Agent Team topology exposes coordinator and worker-domain lanes.", {
      ...base.payload,
      relationships: [...arrayValue(base.payload.relationships), ...workerRelationships],
      loops: [{
        id: "coordinate_work_synthesize",
        kind: "agent_team_loop",
        label: "Coordinator divides work, long-running workers progress domains, coordinator synthesizes",
        status: session.status,
      }],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        coordinator_id: coordinatorId,
        worker_count: workersFor(session).length,
      },
    });
  }

  buildProjection(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.buildProjection(session, options);
    const coordinatorId = coordinatorIdFor(session);
    const coordinator = session.agents[coordinatorId];
    return result("available", "Agent Team projection exposes coordinator, workers, domains, and synthesis state.", {
      ...base.payload,
      sections: [
        {
          id: "coordinator",
          title: "Coordinator",
          items: [{
            agent_id: coordinatorId,
            name: coordinator?.name ?? coordinatorId,
            status: coordinator?.status ?? "",
            active_task_id: coordinator?.current_task_id ?? null,
          }],
        },
        { id: "worker_domains", title: "Worker Domains", items: workersFor(session) },
        {
          id: "team_synthesis",
          title: "Team Synthesis",
          items: [{
            summary: session.final_draft || session.shared_summary,
            completion: this.evaluateCompletion(session).payload,
          }],
        },
      ],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        branch_local_persistence: true,
        completion: this.evaluateCompletion(session).payload,
      },
    });
  }

  evaluateCompletion(session: CoworkSession): ArchitectureCapabilityResult {
    const blockers = teamBlockers(session);
    const pending = Object.values(session.tasks)
      .filter((task) => ["pending", "in_progress"].includes(task.status))
      .map((task) => task.id);
    const coordinatorId = coordinatorIdFor(session);
    if (blockers.length > 0) {
      return result("blocked", `${blockers.length} worker/domain blocker(s) require coordinator action.`, {
        next_action: "resolve_team_blockers",
        ready_to_finish: false,
        blocked: blockers,
        coordinator_id: coordinatorId,
        worker_domains: workersFor(session),
      });
    }
    if (pending.length > 0) {
      return result("continue", `${pending.length} team task(s) still need progress.`, {
        next_action: "run_next_round",
        ready_to_finish: false,
        blocked: [],
        coordinator_id: coordinatorId,
        worker_domains: workersFor(session),
      });
    }
    const complete = Boolean(session.final_draft || session.shared_summary);
    return result(complete ? "complete" : "continue", complete
      ? "Coordinator has enough branch-local worker output to synthesize a result."
      : "No pending work remains, but coordinator synthesis has not been recorded.", {
      next_action: complete ? "complete" : "coordinate_synthesis",
      ready_to_finish: complete,
      blocked: [],
      coordinator_id: coordinatorId,
      worker_domains: workersFor(session),
    });
  }
}

class GeneratorVerifierPolicy extends BasePolicy {
  architecture = "generator_verifier";
  displayName = "Generator-Verifier";
  runtimeProfile = "generator_verifier";

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    const candidates = candidateResults(session);
    const verdicts = verificationVerdicts(session);
    return result("available", "Generator-Verifier topology exposes candidate/verdict revision loop.", {
      ...base.payload,
      loops: [{
        id: "generate_verify_revise",
        kind: "generator_verifier_loop",
        label: "Generator produces candidates; verifier returns verdicts against a visible rubric",
        status: session.status,
        max_iterations: maxIterations(session),
      }],
      relationships: [
        ...arrayValue(base.payload.relationships),
        ...candidates.slice(0, verdicts.length).map((candidate, index) => ({
          from: stringValue(candidate.agent_id) || "generator",
          to: stringValue(verdicts[index]?.agent_id) || "verifier",
          kind: "verified_by",
          candidate_result_id: candidate.id,
          verdict_id: verdicts[index]?.id,
        })),
      ],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        rubric: rubricFor(session),
        candidate_count: candidates.length,
        verdict_count: verdicts.length,
      },
    });
  }

  buildProjection(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.buildProjection(session, options);
    return result("available", "Generator-Verifier projection exposes rubric, candidates, and verifier verdicts.", {
      ...base.payload,
      sections: [
        { id: "rubric", title: "Rubric", items: rubricFor(session).map((criterion) => ({ criterion })) },
        { id: "candidate_results", title: "Candidate Results", items: candidateResults(session) },
        { id: "verification_verdicts", title: "Verification Verdicts", items: verificationVerdicts(session) },
      ],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        iteration: verificationVerdicts(session).length,
        max_iterations: maxIterations(session),
        completion: this.evaluateCompletion(session).payload,
      },
    });
  }
}

class MessageBusPolicy extends BasePolicy {
  architecture = "message_bus";
  displayName = "Message Bus";
  runtimeProfile = "message_bus";

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    const routes = Object.values(session.mailbox).map((record) => ({
      id: stringValue(record.id),
      kind: routeType(record),
      from: stringValue(record.sender_id),
      to: arrayValue(record.recipient_ids).map(stringValue),
      topic: stringValue(record.topic),
      event_type: stringValue(record.event_type),
      request_type: stringValue(record.request_type),
      correlation_id: record.correlation_id ?? null,
      lineage_id: record.lineage_id ?? null,
      reply_to_envelope_id: record.reply_to_envelope_id ?? null,
      delivery_reason: deliveryReason(record),
      status: stringValue(record.status),
    }));
    return result("available", "Message Bus topology projects envelopes, routes, and subscribers.", {
      ...base.payload,
      routes,
      stores: [{ id: "message_bus", kind: "bus_envelope_store", envelope_count: Object.keys(session.mailbox).length }],
      loops: [{
        id: "publish_route_correlate",
        kind: "message_bus_loop",
        label: "Publish envelopes, route by topic or direct recipient, correlate replies",
        status: session.status,
      }],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        router_is_runtime_layer: true,
        subscriber_count: Object.keys(session.agents).length,
      },
    });
  }
}

class SharedStatePolicy extends BasePolicy {
  architecture = "shared_state";
  displayName = "Shared State";
  runtimeProfile = "shared_state";

  buildProjection(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.buildProjection(session, options);
    const contributions = sharedContributions(session);
    return result("available", "Shared State projection exposes contributions, claims, risks, and decisions.", {
      ...base.payload,
      sections: [
        { id: "shared_knowledge_space", title: "Shared Knowledge Space", items: contributions.slice(-80) },
        { id: "competing_claims", title: "Competing Claims", items: competingClaims(contributions) },
      ],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        completion: this.evaluateCompletion(session).payload,
      },
    });
  }

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    const contributions = sharedContributions(session);
    return result("available", "Shared State topology projects an append-only knowledge space.", {
      ...base.payload,
      stores: [{
        id: "shared_knowledge_space",
        kind: "shared_knowledge_space",
        contribution_count: contributions.length,
        competing_claim_count: competingClaims(contributions).length,
      }],
      loops: [{
        id: "append_review_resolve",
        kind: "shared_state_loop",
        label: "Append contributions, preserve competing claims, resolve by synthesis or decision",
        status: session.status,
      }],
    });
  }
}

class SwarmPolicy extends BasePolicy {
  architecture = "swarm";
  displayName = "Swarm";
  runtimeProfile = "swarm";

  topology(session: CoworkSession, options: { branchId?: string } = {}): ArchitectureCapabilityResult {
    const base = super.topology(session, options);
    const units = workUnits(session);
    return result(base.status, base.reason, {
      ...base.payload,
      relationships: [
        ...arrayValue(base.payload.relationships),
        ...units.map((unit) => ({
          from: stringValue(unit.assigned_agent_id) || stringValue(session.swarm_plan.lead_agent_id) || "session",
          to: stringValue(unit.id),
          kind: "owns_work_unit",
        })),
      ],
      loops: [{
        id: "fanout_reduce_review",
        kind: "swarm_loop",
        label: "Fan out work units, reduce outputs, review synthesis",
        status: stringValue(session.swarm_plan.status) || session.status,
      }],
      metadata: {
        ...(base.payload.metadata as JsonObject),
        plan_id: stringValue(session.swarm_plan.id),
        strategy: stringValue(session.swarm_plan.strategy),
        work_unit_count: units.length,
      },
    });
  }
}

function result(status: string, reason: string, payload: JsonObject): ArchitectureCapabilityResult {
  return { status, reason, payload };
}

function coordinatorIdFor(session: CoworkSession): string {
  for (const candidate of ["coordinator", "lead", "team_lead", "team-lead"]) {
    if (session.agents[candidate]) {
      return candidate;
    }
  }
  return Object.keys(session.agents)[0] ?? "";
}

function workersFor(session: CoworkSession): JsonObject[] {
  const coordinatorId = coordinatorIdFor(session);
  return Object.values(session.agents)
    .filter((agent) => agent.id !== coordinatorId && agent.lifetime !== "temporary")
    .map((agent) => ({
      agent_id: agent.id,
      name: agent.name,
      worker_domain: workerDomain(agent),
      status: agent.status,
      active_task_ids: Object.values(session.tasks)
        .filter((task) => task.assigned_agent_id === agent.id && ["pending", "in_progress"].includes(task.status))
        .map((task) => task.id),
      branch_local: true,
      lifetime: agent.lifetime,
    }));
}

function workerDomain(agent: CoworkAgent): string {
  return agent.team_id || agent.responsibilities[0] || agent.role || agent.name || agent.id;
}

function teamBlockers(session: CoworkSession): JsonObject[] {
  const blockedAgents = Object.values(session.agents)
    .filter((agent) => agent.status === "blocked")
    .map((agent) => ({ kind: "blocked_worker", agent_id: agent.id, worker_domain: workerDomain(agent) }));
  const failedTasks = Object.values(session.tasks)
    .filter((task) => task.status === "failed")
    .map((task) => ({
      kind: "failed_task",
      task_id: task.id,
      assigned_agent_id: task.assigned_agent_id,
      error: task.error,
    }));
  return [...blockedAgents, ...failedTasks];
}

function recommendArchitecture(session: CoworkSession): JsonObject {
  const goal = session.goal.toLowerCase();
  const architecture = goal.includes("swarm") || goal.includes("parallel") || goal.includes("并行")
    ? "swarm"
    : goal.includes("review") || goal.includes("verify") || goal.includes("验证")
      ? "generator_verifier"
      : goal.includes("route") || goal.includes("event") || goal.includes("消息")
        ? "message_bus"
        : goal.includes("knowledge") || goal.includes("shared") || goal.includes("共享")
          ? "shared_state"
          : Object.keys(session.tasks).length > 1 || goal.includes("team") || goal.includes("团队")
            ? "team"
            : ADAPTIVE_STARTER;
  return {
    architecture,
    reason: architecture === ADAPTIVE_STARTER
      ? "The goal is still broad; continue clarifying in Adaptive Starter."
      : `Adaptive Starter recommends ${architecture}.`,
    confidence: architecture === ADAPTIVE_STARTER ? 0.55 : 0.7,
    required_choices: architecture === ADAPTIVE_STARTER ? ["target_architecture_or_more_context"] : [],
    derivation: {
      supported: architecture !== ADAPTIVE_STARTER,
      source_branch_id: session.current_branch_id,
      target_architecture: architecture,
    },
  };
}

function rubricFor(session: CoworkSession): string[] {
  const raw = Array.isArray(session.runtime_state.rubric)
    ? session.runtime_state.rubric
    : Array.isArray(session.blueprint.rubric)
      ? session.blueprint.rubric
      : ["correctness", "completeness", "evidence", "risk"];
  return raw.map(stringValue).map((item) => item.trim()).filter(Boolean);
}

function maxIterations(session: CoworkSession): number {
  const raw = Number(session.runtime_state.max_iterations ?? session.blueprint.max_iterations ?? 3);
  return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 3;
}

function candidateResults(session: CoworkSession): JsonObject[] {
  return Object.values(session.tasks)
    .filter((task) => task.status === "completed")
    .filter((task) => {
      const agent = task.assigned_agent_id ? session.agents[task.assigned_agent_id] : null;
      return !(agent && isVerifier(agent) && !task.result_data.candidate_result);
    })
    .map((task) => ({
      id: `candidate_${task.id}`,
      task_id: task.id,
      agent_id: task.assigned_agent_id,
      summary: stringValue(task.result_data.candidate_result || task.result_data.answer || task.result).slice(0, 700),
      artifacts: Array.isArray(task.result_data.artifacts) ? task.result_data.artifacts : [],
      confidence: task.confidence,
      created_at: task.updated_at,
    }))
    .filter((item) => stringValue(item.summary).trim());
}

function verificationVerdicts(session: CoworkSession): JsonObject[] {
  return Object.values(session.tasks)
    .filter((task) => {
      const agent = task.assigned_agent_id ? session.agents[task.assigned_agent_id] : null;
      return Boolean(agent && isVerifier(agent)) || "verdict" in task.result_data || "verification_verdict" in task.result_data;
    })
    .map((task) => ({
      id: `verdict_${task.id}`,
      task_id: task.id,
      agent_id: task.assigned_agent_id,
      verdict: stringValue(task.result_data.verification_verdict || task.result_data.verdict || task.result_data.review_status || "unresolved"),
      issues: Array.isArray(task.result_data.issues) ? task.result_data.issues : [],
      required_fixes: Array.isArray(task.result_data.required_fixes) ? task.result_data.required_fixes : [],
      confidence: task.confidence,
      created_at: task.updated_at,
    }));
}

function isVerifier(agent: CoworkAgent): boolean {
  return [agent.id, agent.name, agent.role, ...agent.responsibilities].join(" ").toLowerCase()
    .split(/\s+/)
    .some((item) => ["verify", "verifier", "review", "quality", "risk"].includes(item));
}

function routeType(record: JsonObject): string {
  if (record.reply_to_envelope_id) return "reply_route";
  if (record.topic || record.event_type) return "topic_route";
  return "direct_route";
}

function deliveryReason(record: JsonObject): string {
  const type = routeType(record);
  if (type === "reply_route") return `Reply correlated to ${stringValue(record.reply_to_envelope_id)}.`;
  if (type === "topic_route") {
    return `Topic labels matched subscribers: ${[record.topic, record.event_type, record.request_type, record.kind].map(stringValue).filter(Boolean).join(", ")}.`;
  }
  return "Direct recipient envelope.";
}

function sharedContributions(session: CoworkSession): JsonObject[] {
  const contributions: JsonObject[] = [];
  Object.entries(session.shared_memory).forEach(([bucket, entries]) => {
    entries.forEach((entry, index) => {
      const text = stringValue(entry.text).trim();
      if (text) {
        contributions.push({
          id: entry.id ?? `${bucket}_${index + 1}`,
          kind: bucket,
          text,
          author: entry.author ?? "",
          source_task_id: entry.source_task_id ?? "",
          evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
          confidence: entry.confidence,
          updated_at: entry.updated_at ?? "",
        });
      }
    });
  });
  Object.values(session.tasks).forEach((task) => {
    ["findings", "claims", "risks", "open_questions", "decisions"].forEach((key) => {
      const values = task.result_data[key];
      if (!Array.isArray(values)) return;
      values.map(stringValue).filter(Boolean).forEach((text, index) => {
        contributions.push({
          id: `task_${task.id}_${key}_${index + 1}`,
          kind: key,
          text,
          author: task.assigned_agent_id ?? "",
          source_task_id: task.id,
          confidence: task.confidence,
          updated_at: task.updated_at,
        });
      });
    });
  });
  return contributions;
}

function competingClaims(contributions: JsonObject[]): JsonObject[] {
  return contributions
    .filter((item) => ["claims", "findings"].includes(stringValue(item.kind)))
    .filter((item) => ["conflict", "contradict", "competes with"].some((marker) => stringValue(item.text).toLowerCase().includes(marker)))
    .slice(0, 20)
    .map((item) => ({ id: item.id, claim_key: item.text, claims: [item] }));
}

function workUnits(session: CoworkSession): JsonObject[] {
  return Array.isArray(session.swarm_plan.work_units)
    ? session.swarm_plan.work_units.filter(isJsonObject)
    : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (!value) {
    throw new Error(`Missing required policy: ${String(key)}`);
  }
  return value;
}
