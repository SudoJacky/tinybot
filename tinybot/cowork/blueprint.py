"""Cowork blueprint normalization, validation, preview, and export."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any


WORKFLOW_MODES = {
    "hybrid",
    "supervisor",
    "orchestrator",
    "team",
    "generator_verifier",
    "message_bus",
    "shared_state",
    "peer_handoff",
    "swarm",
}

DEFAULT_ALLOWED_TOOLS = {
    "cowork_internal",
    "read_file",
    "list_dir",
    "write_file",
    "edit_file",
    "exec",
}

DEFAULT_BUDGET_LIMITS: dict[str, int | float | None] = {
    "max_rounds_per_run": 20,
    "parallel_width": 3,
    "max_agent_calls_per_run": 30,
    "max_agent_calls_total": None,
    "max_spawned_agents": 0,
    "max_tool_calls": None,
    "max_tokens": None,
    "max_cost": None,
}

BUDGET_HARD_CAPS: dict[str, int | float] = {
    "max_rounds_per_run": 200,
    "parallel_width": 50,
    "max_agent_calls_per_run": 500,
    "max_agent_calls_total": 5000,
    "max_spawned_agents": 200,
    "max_tool_calls": 10000,
    "max_tokens": 20_000_000,
    "max_cost": 10_000.0,
}


@dataclass
class BlueprintDiagnostic:
    """A validation diagnostic tied to a blueprint field path."""

    severity: str
    code: str
    message: str
    path: str = ""
    value: Any = None


@dataclass
class BlueprintAgent:
    id: str
    name: str
    role: str
    goal: str
    responsibilities: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    subscriptions: list[str] = field(default_factory=list)
    communication_policy: str = ""
    context_policy: str = ""
    parent_agent_id: str | None = None
    team_id: str = ""
    layout: dict[str, Any] = field(default_factory=dict)


@dataclass
class BlueprintTask:
    id: str
    title: str
    description: str
    assigned_agent_id: str | None = None
    dependencies: list[str] = field(default_factory=list)
    priority: int = 0
    expected_output: str = ""
    review_required: bool = False
    reviewer_agent_ids: list[str] = field(default_factory=list)
    fanout_group_id: str = ""
    merge_task_id: str = ""
    layout: dict[str, Any] = field(default_factory=dict)


@dataclass
class BlueprintRoute:
    id: str
    source_id: str
    target_id: str
    kind: str = "direct"
    topic: str = ""
    event_type: str = ""
    request_type: str = ""
    required: bool = False


@dataclass
class BlueprintReview:
    required_reviewers: list[str] = field(default_factory=list)
    gates: list[dict[str, Any]] = field(default_factory=list)
    merge_required: bool = False
    synthesis_task_id: str = ""


@dataclass
class CoworkBlueprint:
    schema_version: str = "cowork.blueprint.v1"
    goal: str = ""
    title: str = "Cowork Session"
    workflow_mode: str = "hybrid"
    lead_agent_id: str = ""
    agents: list[BlueprintAgent] = field(default_factory=list)
    tasks: list[BlueprintTask] = field(default_factory=list)
    routes: list[BlueprintRoute] = field(default_factory=list)
    review: BlueprintReview = field(default_factory=BlueprintReview)
    budgets: dict[str, Any] = field(default_factory=dict)
    layout: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


def slug(value: Any, *, fallback: str = "item") -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9_\-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text[:48] or fallback


def normalize_workflow_mode(value: Any) -> str:
    mode = str(value or "hybrid").strip().lower().replace("-", "_")
    return mode if mode in WORKFLOW_MODES else "hybrid"


def normalize_budget_limits(value: Any | None) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    normalized: dict[str, Any] = dict(DEFAULT_BUDGET_LIMITS)
    aliases = {
        "max_rounds": "max_rounds_per_run",
        "rounds": "max_rounds_per_run",
        "max_agent_calls": "max_agent_calls_per_run",
        "agent_calls": "max_agent_calls_per_run",
        "max_agents": "parallel_width",
        "parallelism": "parallel_width",
    }
    for key, raw_value in raw.items():
        target = aliases.get(str(key), str(key))
        if target not in normalized:
            normalized[target] = _json_safe(raw_value)
            continue
        normalized[target] = _coerce_budget_value(target, raw_value)
    for key in list(DEFAULT_BUDGET_LIMITS):
        normalized[key] = _coerce_budget_value(key, normalized.get(key))
    return normalized


def default_budget_usage() -> dict[str, Any]:
    return {
        "rounds": 0,
        "agent_calls": 0,
        "spawned_agents": 0,
        "tool_calls": 0,
        "tokens_prompt": 0,
        "tokens_completion": 0,
        "tokens_total": 0,
        "cost": 0.0,
        "stop_reason": "",
    }


def budget_remaining(limits: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    remaining: dict[str, Any] = {}
    mapping = {
        "max_rounds_per_run": "rounds",
        "max_agent_calls_per_run": "agent_calls",
        "max_agent_calls_total": "agent_calls",
        "max_spawned_agents": "spawned_agents",
        "max_tool_calls": "tool_calls",
        "max_tokens": "tokens_total",
        "max_cost": "cost",
    }
    for limit_key, usage_key in mapping.items():
        limit = limits.get(limit_key)
        remaining[limit_key] = None if limit is None else max(0, limit - usage.get(usage_key, 0))
    remaining["parallel_width"] = limits.get("parallel_width")
    return remaining


def normalize_blueprint(raw: Any, *, default_goal: str = "") -> dict[str, Any]:
    data = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    goal = str(data.get("goal") or default_goal or "").strip()
    mode = normalize_workflow_mode(data.get("workflow_mode") or data.get("mode"))
    title = str(data.get("title") or _title_from_goal(goal) or "Cowork Session").strip()
    layout = data.get("layout") if isinstance(data.get("layout"), dict) else {}

    agents = _normalize_agents(data.get("agents"), goal, layout)
    lead_id = slug(data.get("lead_agent_id") or data.get("lead") or "")
    if lead_id not in {agent.id for agent in agents}:
        lead_id = _default_lead_id(agents)
    tasks = _normalize_tasks(data.get("tasks"), goal, agents, layout)
    routes = _normalize_routes(data.get("routes"), agents)
    review = _normalize_review(data.get("review"), tasks)

    blueprint = CoworkBlueprint(
        goal=goal,
        title=title,
        workflow_mode=mode,
        lead_agent_id=lead_id,
        agents=agents,
        tasks=tasks,
        routes=routes,
        review=review,
        budgets=normalize_budget_limits(data.get("budgets") or data.get("budget")),
        layout=_json_safe(layout) if isinstance(layout, dict) else {},
        metadata=_json_safe(data.get("metadata")) if isinstance(data.get("metadata"), dict) else {},
    )
    normalized = _json_safe(asdict(blueprint))
    normalized["id"] = _blueprint_fingerprint(normalized)
    return normalized


def validate_blueprint(raw: Any, *, policy: dict[str, Any] | None = None, default_goal: str = "") -> dict[str, Any]:
    normalized = normalize_blueprint(raw, default_goal=default_goal)
    diagnostics: list[BlueprintDiagnostic] = []
    raw_data = raw if isinstance(raw, dict) else {}

    _diagnose_duplicate_ids(raw_data.get("agents"), "agents", diagnostics)
    _diagnose_duplicate_ids(raw_data.get("tasks"), "tasks", diagnostics)

    agent_ids = {agent["id"] for agent in normalized["agents"]}
    task_ids = {task["id"] for task in normalized["tasks"]}
    if not normalized["goal"]:
        diagnostics.append(BlueprintDiagnostic("error", "missing_goal", "Blueprint goal is required.", "goal"))
    if not normalized["agents"]:
        diagnostics.append(BlueprintDiagnostic("error", "missing_agents", "At least one agent is required.", "agents"))
    for index, agent in enumerate(normalized["agents"]):
        if agent.get("parent_agent_id") and agent["parent_agent_id"] not in agent_ids:
            diagnostics.append(
                BlueprintDiagnostic(
                    "error",
                    "missing_parent_agent",
                    f"Parent agent '{agent['parent_agent_id']}' does not exist.",
                    f"agents[{index}].parent_agent_id",
                )
            )
        for tool in agent.get("tools") or []:
            if not _tool_allowed(tool, policy):
                diagnostics.append(
                    BlueprintDiagnostic(
                        "error",
                        "tool_disallowed",
                        f"Tool '{tool}' is not allowed by Cowork blueprint policy.",
                        f"agents[{index}].tools",
                        tool,
                    )
                )

    for index, task in enumerate(normalized["tasks"]):
        owner = task.get("assigned_agent_id")
        if owner and owner not in agent_ids:
            diagnostics.append(
                BlueprintDiagnostic(
                    "error",
                    "missing_task_owner",
                    f"Task owner '{owner}' does not exist.",
                    f"tasks[{index}].assigned_agent_id",
                )
            )
        for dependency in task.get("dependencies") or []:
            if dependency not in task_ids:
                diagnostics.append(
                    BlueprintDiagnostic(
                        "error",
                        "missing_task_dependency",
                        f"Task dependency '{dependency}' does not exist.",
                        f"tasks[{index}].dependencies",
                    )
                )
        for reviewer in task.get("reviewer_agent_ids") or []:
            if reviewer not in agent_ids:
                diagnostics.append(
                    BlueprintDiagnostic(
                        "error",
                        "missing_task_reviewer",
                        f"Reviewer '{reviewer}' does not exist.",
                        f"tasks[{index}].reviewer_agent_ids",
                    )
                )
        merge_task_id = task.get("merge_task_id")
        if merge_task_id and merge_task_id not in task_ids:
            diagnostics.append(
                BlueprintDiagnostic(
                    "error",
                    "missing_merge_task",
                    f"Merge task '{merge_task_id}' does not exist.",
                    f"tasks[{index}].merge_task_id",
                )
            )

    for index, route in enumerate(normalized["routes"]):
        source = route.get("source_id")
        target = route.get("target_id")
        if source and source not in agent_ids and source not in {"user", "session", "team"}:
            diagnostics.append(
                BlueprintDiagnostic("error", "missing_route_source", f"Route source '{source}' does not exist.", f"routes[{index}].source_id")
            )
        if target and target not in agent_ids and target not in {"user", "session", "team"}:
            diagnostics.append(
                BlueprintDiagnostic("error", "missing_route_target", f"Route target '{target}' does not exist.", f"routes[{index}].target_id")
            )

    for index, reviewer in enumerate(normalized.get("review", {}).get("required_reviewers") or []):
        if reviewer not in agent_ids:
            diagnostics.append(
                BlueprintDiagnostic("error", "missing_review_agent", f"Reviewer '{reviewer}' does not exist.", f"review.required_reviewers[{index}]")
            )

    cycle = _task_dependency_cycle(normalized["tasks"])
    if cycle:
        diagnostics.append(
            BlueprintDiagnostic("error", "task_dependency_cycle", f"Task dependencies contain a cycle: {' -> '.join(cycle)}", "tasks")
        )

    diagnostics.extend(_budget_diagnostics(raw_data.get("budgets") or raw_data.get("budget"), normalized["budgets"]))
    ok = not any(item.severity == "error" for item in diagnostics)
    return {
        "ok": ok,
        "blueprint": normalized,
        "diagnostics": [_diagnostic_dict(item) for item in diagnostics],
    }


def preview_blueprint(raw: Any, *, policy: dict[str, Any] | None = None, default_goal: str = "") -> dict[str, Any]:
    validation = validate_blueprint(raw, policy=policy, default_goal=default_goal)
    blueprint = validation["blueprint"]
    return {
        **validation,
        "graph_preview": build_blueprint_graph(blueprint),
        "budget_plan": {
            "limits": blueprint.get("budgets", {}),
            "usage": default_budget_usage(),
            "remaining": budget_remaining(blueprint.get("budgets", {}), default_budget_usage()),
        },
        "initial_ready_work": initial_ready_work(blueprint),
    }


def build_blueprint_graph(blueprint: dict[str, Any]) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = [
        {
            "id": "session",
            "kind": "session",
            "title": blueprint.get("title") or "Cowork Session",
            "label": blueprint.get("title") or "Cowork Session",
            "detail": blueprint.get("goal", ""),
            "status": "preview",
            "badge": blueprint.get("workflow_mode", "hybrid"),
            "source_blueprint_id": blueprint.get("id", ""),
        }
    ]
    edges: list[dict[str, Any]] = []
    layout_nodes = ((blueprint.get("layout") or {}).get("nodes") or {}) if isinstance(blueprint.get("layout"), dict) else {}

    for index, agent in enumerate(blueprint.get("agents") or []):
        position = layout_nodes.get(agent["id"], {}) if isinstance(layout_nodes, dict) else {}
        nodes.append(
            {
                "id": f"agent:{agent['id']}",
                "entity_id": agent["id"],
                "kind": "agent",
                "title": agent.get("name") or agent["id"],
                "label": agent.get("name") or agent["id"],
                "detail": agent.get("role") or "",
                "status": "planned",
                "badge": "lead" if agent["id"] == blueprint.get("lead_agent_id") else agent.get("team_id", ""),
                "x": position.get("x", 280 + (index % 5) * 170),
                "y": position.get("y", 160 + (index // 5) * 110),
                "source_blueprint_id": agent["id"],
            }
        )
        _add_edge(edges, "session", f"agent:{agent['id']}", "member", source_blueprint_id=agent["id"])
        if agent.get("parent_agent_id"):
            _add_edge(edges, f"agent:{agent['parent_agent_id']}", f"agent:{agent['id']}", "parent_of")

    for index, task in enumerate(blueprint.get("tasks") or []):
        position = layout_nodes.get(task["id"], {}) if isinstance(layout_nodes, dict) else {}
        nodes.append(
            {
                "id": f"task:{task['id']}",
                "entity_id": task["id"],
                "kind": "task",
                "title": task.get("title") or task["id"],
                "label": task.get("title") or task["id"],
                "detail": task.get("description") or "",
                "status": "planned",
                "badge": "review" if task.get("review_required") else "",
                "x": position.get("x", 240 + (index % 4) * 220),
                "y": position.get("y", 390 + (index // 4) * 100),
                "source_blueprint_id": task["id"],
            }
        )
        _add_edge(edges, "session", f"task:{task['id']}", "has_task")
        if task.get("assigned_agent_id"):
            _add_edge(edges, f"task:{task['id']}", f"agent:{task['assigned_agent_id']}", "assigned_to")
        for dependency in task.get("dependencies") or []:
            _add_edge(edges, f"task:{dependency}", f"task:{task['id']}", "depends_on")
        if task.get("merge_task_id"):
            _add_edge(edges, f"task:{task['id']}", f"task:{task['merge_task_id']}", "synthesizes")

    for route in blueprint.get("routes") or []:
        source = _route_node_id(route.get("source_id"))
        target = _route_node_id(route.get("target_id"))
        _add_edge(
            edges,
            source,
            target,
            route.get("kind") or "route",
            topic=route.get("topic", ""),
            event_type=route.get("event_type", ""),
            request_type=route.get("request_type", ""),
            source_blueprint_id=route.get("id", ""),
        )

    node_kinds = Counter(node["kind"] for node in nodes)
    edge_kinds = Counter(edge["kind"] for edge in edges)
    return {
        "schema_version": "cowork.graph.preview.v1",
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges),
            "node_kinds": dict(sorted(node_kinds.items())),
            "edge_kinds": dict(sorted(edge_kinds.items())),
        },
        "truncated": {"nodes": False, "edges": False, "hidden_nodes": 0, "hidden_edges": 0},
    }


def initial_ready_work(blueprint: dict[str, Any]) -> dict[str, Any]:
    tasks = blueprint.get("tasks") or []
    ready = [
        task
        for task in tasks
        if not task.get("dependencies")
    ]
    by_agent: dict[str, list[str]] = defaultdict(list)
    for task in ready:
        by_agent[str(task.get("assigned_agent_id") or "unassigned")].append(task["id"])
    return {
        "ready_task_ids": [task["id"] for task in ready],
        "ready_by_agent": dict(sorted(by_agent.items())),
        "lead_agent_id": blueprint.get("lead_agent_id", ""),
    }


def export_session_blueprint(session: Any) -> dict[str, Any]:
    base = copy.deepcopy(getattr(session, "blueprint", {}) or {})
    layout = base.get("layout") if isinstance(base.get("layout"), dict) else {}
    blueprint = {
        "schema_version": "cowork.blueprint.v1",
        "goal": getattr(session, "goal", ""),
        "title": getattr(session, "title", "") or "Cowork Session",
        "workflow_mode": getattr(session, "workflow_mode", "hybrid"),
        "lead_agent_id": base.get("lead_agent_id") or _session_lead_agent_id(session),
        "agents": [],
        "tasks": [],
        "routes": base.get("routes", []) if isinstance(base.get("routes"), list) else [],
        "review": base.get("review", {}) if isinstance(base.get("review"), dict) else {},
        "budgets": copy.deepcopy(getattr(session, "budget_limits", {}) or base.get("budgets") or {}),
        "layout": layout,
        "metadata": {
            **(base.get("metadata", {}) if isinstance(base.get("metadata"), dict) else {}),
            "exported_from_session_id": getattr(session, "id", ""),
            "runtime_fields_excluded": True,
        },
    }
    for agent in getattr(session, "agents", {}).values():
        blueprint["agents"].append(
            {
                "id": agent.id,
                "name": agent.name,
                "role": agent.role,
                "goal": agent.goal,
                "responsibilities": list(getattr(agent, "responsibilities", []) or []),
                "tools": list(getattr(agent, "tools", []) or []),
                "subscriptions": list(getattr(agent, "subscriptions", []) or []),
                "communication_policy": getattr(agent, "communication_policy", ""),
                "context_policy": getattr(agent, "context_policy", ""),
                "parent_agent_id": getattr(agent, "parent_agent_id", None),
                "team_id": getattr(agent, "team_id", ""),
            }
        )
    for task in getattr(session, "tasks", {}).values():
        blueprint["tasks"].append(
            {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "assigned_agent_id": task.assigned_agent_id,
                "dependencies": list(getattr(task, "dependencies", []) or []),
                "priority": int(getattr(task, "priority", 0) or 0),
                "review_required": bool(getattr(task, "review_required", False)),
                "reviewer_agent_ids": list(getattr(task, "reviewer_agent_ids", []) or []),
                "fanout_group_id": getattr(task, "fanout_group_id", ""),
                "merge_task_id": getattr(task, "merge_task_id", ""),
            }
        )
    return normalize_blueprint(blueprint)


def session_inputs_from_blueprint(blueprint: dict[str, Any]) -> dict[str, Any]:
    return {
        "goal": blueprint.get("goal", ""),
        "title": blueprint.get("title", "") or "Cowork Session",
        "workflow_mode": blueprint.get("workflow_mode", "hybrid"),
        "agents": copy.deepcopy(blueprint.get("agents") or []),
        "tasks": copy.deepcopy(blueprint.get("tasks") or []),
        "budgets": copy.deepcopy(blueprint.get("budgets") or {}),
    }


def _normalize_agents(value: Any, goal: str, layout: dict[str, Any]) -> list[BlueprintAgent]:
    raw_agents = value if isinstance(value, list) else []
    if not raw_agents:
        raw_agents = _default_agents(goal)
    agents: list[BlueprintAgent] = []
    used: set[str] = set()
    layout_nodes = layout.get("nodes", {}) if isinstance(layout.get("nodes", {}), dict) else {}
    for index, raw in enumerate(raw_agents):
        raw = raw if isinstance(raw, dict) else {}
        agent_id = _dedupe_id(slug(raw.get("id") or raw.get("name") or raw.get("role") or f"agent_{index + 1}", fallback="agent"), used)
        tools = _string_list(raw.get("tools")) or ["cowork_internal"]
        agents.append(
            BlueprintAgent(
                id=agent_id,
                name=str(raw.get("name") or agent_id).strip(),
                role=str(raw.get("role") or "Collaborator").strip(),
                goal=str(raw.get("goal") or goal or "Contribute to the shared goal.").strip(),
                responsibilities=_string_list(raw.get("responsibilities")),
                tools=tools,
                subscriptions=_string_list(raw.get("subscriptions")) or _default_subscriptions(raw, agent_id),
                communication_policy=str(raw.get("communication_policy") or "").strip(),
                context_policy=str(raw.get("context_policy") or "").strip(),
                parent_agent_id=slug(raw.get("parent_agent_id")) if raw.get("parent_agent_id") else None,
                team_id=str(raw.get("team_id") or "").strip(),
                layout=_json_safe(layout_nodes.get(agent_id, {})) if isinstance(layout_nodes, dict) else {},
            )
        )
    return agents


def _normalize_tasks(value: Any, goal: str, agents: list[BlueprintAgent], layout: dict[str, Any]) -> list[BlueprintTask]:
    raw_tasks = value if isinstance(value, list) else []
    lead_id = _default_lead_id(agents)
    if not raw_tasks:
        raw_tasks = [
            {
                "id": "lead_start",
                "title": "Decide team plan and delegation",
                "description": f"Analyze the goal and decide the first concrete work split: {goal}",
                "assigned_agent_id": lead_id,
            }
        ]
    agent_ids = {agent.id for agent in agents}
    tasks: list[BlueprintTask] = []
    used: set[str] = set()
    layout_nodes = layout.get("nodes", {}) if isinstance(layout.get("nodes", {}), dict) else {}
    for index, raw in enumerate(raw_tasks):
        raw = raw if isinstance(raw, dict) else {}
        task_id = _dedupe_id(slug(raw.get("id") or raw.get("title") or f"task_{index + 1}", fallback="task"), used)
        owner = slug(raw.get("assigned_agent_id") or raw.get("owner") or "")
        owner = owner if owner in agent_ids else (None if not owner else owner)
        review_raw = raw.get("review") if isinstance(raw.get("review"), dict) else {}
        tasks.append(
            BlueprintTask(
                id=task_id,
                title=str(raw.get("title") or task_id).strip(),
                description=str(raw.get("description") or raw.get("title") or goal or task_id).strip(),
                assigned_agent_id=owner,
                dependencies=[slug(item) for item in _string_list(raw.get("dependencies") or raw.get("depends_on"))],
                priority=_int(raw.get("priority"), 0),
                expected_output=str(raw.get("expected_output") or raw.get("expected_outputs") or "").strip(),
                review_required=bool(raw.get("review_required") or review_raw.get("required")),
                reviewer_agent_ids=[slug(item) for item in _string_list(raw.get("reviewer_agent_ids") or review_raw.get("reviewer_agent_ids") or review_raw.get("reviewers"))],
                fanout_group_id=str(raw.get("fanout_group_id") or "").strip(),
                merge_task_id=slug(raw.get("merge_task_id") or "") if raw.get("merge_task_id") else "",
                layout=_json_safe(layout_nodes.get(task_id, {})) if isinstance(layout_nodes, dict) else {},
            )
        )
    return tasks


def _normalize_routes(value: Any, agents: list[BlueprintAgent]) -> list[BlueprintRoute]:
    raw_routes = value if isinstance(value, list) else []
    if not raw_routes:
        lead_id = _default_lead_id(agents)
        raw_routes = [{"id": "user_to_lead", "from": "user", "to": lead_id, "kind": "direct", "topic": "goal"}] if lead_id else []
    routes: list[BlueprintRoute] = []
    used: set[str] = set()
    for index, raw in enumerate(raw_routes):
        raw = raw if isinstance(raw, dict) else {}
        route_id = _dedupe_id(slug(raw.get("id") or f"route_{index + 1}", fallback="route"), used)
        routes.append(
            BlueprintRoute(
                id=route_id,
                source_id=slug(raw.get("source_id") or raw.get("from") or raw.get("source") or "user", fallback="user"),
                target_id=slug(raw.get("target_id") or raw.get("to") or raw.get("target") or "team", fallback="team"),
                kind=str(raw.get("kind") or raw.get("type") or "direct").strip().lower(),
                topic=str(raw.get("topic") or "").strip(),
                event_type=str(raw.get("event_type") or "").strip(),
                request_type=str(raw.get("request_type") or "").strip(),
                required=bool(raw.get("required", False)),
            )
        )
    return routes


def _normalize_review(value: Any, tasks: list[BlueprintTask]) -> BlueprintReview:
    raw = value if isinstance(value, dict) else {}
    merge = raw.get("merge") if isinstance(raw.get("merge"), dict) else {}
    synthesis_task_id = slug(raw.get("synthesis_task_id") or merge.get("task_id") or "")
    if not synthesis_task_id:
        synthesis_task_id = next((task.id for task in tasks if task.merge_task_id or "synth" in task.id), "")
    return BlueprintReview(
        required_reviewers=[slug(item) for item in _string_list(raw.get("required_reviewers") or raw.get("reviewers"))],
        gates=[_json_safe(item) for item in raw.get("gates", []) if isinstance(item, dict)],
        merge_required=bool(raw.get("merge_required") or merge.get("required")),
        synthesis_task_id=synthesis_task_id,
    )


def _default_agents(goal: str) -> list[dict[str, Any]]:
    return [
        {
            "id": "coordinator",
            "name": "Coordinator",
            "role": "Team coordinator",
            "goal": f"Keep the collaboration focused on: {goal}",
            "responsibilities": ["Break down work", "Route questions", "Synthesize final progress"],
            "tools": ["cowork_internal"],
            "subscriptions": ["coordination", "handoff", "unblock", "decision", "summary"],
        },
        {
            "id": "researcher",
            "name": "Researcher",
            "role": "Information gatherer",
            "goal": f"Gather useful facts and constraints for: {goal}",
            "responsibilities": ["Investigate relevant sources", "Summarize findings", "Flag uncertainty"],
            "tools": ["read_file", "list_dir", "cowork_internal"],
            "subscriptions": ["research", "produce", "finding", "source", "context"],
        },
        {
            "id": "analyst",
            "name": "Analyst",
            "role": "Reasoning and verification partner",
            "goal": f"Check assumptions and turn findings into decisions for: {goal}",
            "responsibilities": ["Compare options", "Verify claims", "Identify risks"],
            "tools": ["read_file", "list_dir", "cowork_internal"],
            "subscriptions": ["analysis", "review", "verify", "risk", "decision"],
        },
    ]


def _default_lead_id(agents: list[BlueprintAgent]) -> str:
    ids = {agent.id for agent in agents}
    for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
        if candidate in ids:
            return candidate
    return agents[0].id if agents else ""


def _session_lead_agent_id(session: Any) -> str:
    agents = getattr(session, "agents", {}) or {}
    for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
        if candidate in agents:
            return candidate
    return next(iter(agents), "")


def _default_subscriptions(raw: dict[str, Any], agent_id: str) -> list[str]:
    values = [agent_id, raw.get("role", ""), *(_string_list(raw.get("responsibilities")))]
    seen: list[str] = []
    for value in values:
        text = slug(value)
        if text and text not in seen:
            seen.append(text)
    return seen[:12]


def _diagnose_duplicate_ids(value: Any, field: str, diagnostics: list[BlueprintDiagnostic]) -> None:
    items = value if isinstance(value, list) else []
    ids = [slug(item.get("id") if isinstance(item, dict) else "") for item in items]
    counts = Counter(item for item in ids if item)
    for item_id, count in counts.items():
        if count > 1:
            diagnostics.append(
                BlueprintDiagnostic("error", "duplicate_id", f"Duplicate {field[:-1]} id '{item_id}'.", field, item_id)
            )


def _task_dependency_cycle(tasks: list[dict[str, Any]]) -> list[str]:
    graph = {task["id"]: [dep for dep in task.get("dependencies", []) if dep] for task in tasks}
    visiting: set[str] = set()
    visited: set[str] = set()
    path: list[str] = []

    def visit(node: str) -> list[str]:
        if node in visiting:
            if node in path:
                return path[path.index(node) :] + [node]
            return [node, node]
        if node in visited:
            return []
        visiting.add(node)
        path.append(node)
        for dependency in graph.get(node, []):
            cycle = visit(dependency)
            if cycle:
                return cycle
        visiting.remove(node)
        visited.add(node)
        path.pop()
        return []

    for task_id in graph:
        cycle = visit(task_id)
        if cycle:
            return cycle
    return []


def _budget_diagnostics(raw: Any, normalized: dict[str, Any]) -> list[BlueprintDiagnostic]:
    diagnostics: list[BlueprintDiagnostic] = []
    raw_dict = raw if isinstance(raw, dict) else {}
    aliases = {
        "max_rounds": "max_rounds_per_run",
        "rounds": "max_rounds_per_run",
        "max_agent_calls": "max_agent_calls_per_run",
        "agent_calls": "max_agent_calls_per_run",
        "max_agents": "parallel_width",
        "parallelism": "parallel_width",
    }
    for key, raw_value in raw_dict.items():
        target = aliases.get(str(key), str(key))
        if target in BUDGET_HARD_CAPS and normalized.get(target) != _coerce_number(raw_value):
            diagnostics.append(
                BlueprintDiagnostic(
                    "warning",
                    "budget_clamped",
                    f"Budget '{key}' was clamped to policy bounds.",
                    f"budgets.{key}",
                    normalized.get(target),
                )
            )
    return diagnostics


def _tool_allowed(tool: Any, policy: dict[str, Any] | None) -> bool:
    allowed = policy.get("allowed_tools") if isinstance(policy, dict) else None
    allowed_set = {str(item).strip() for item in allowed} if isinstance(allowed, list) else DEFAULT_ALLOWED_TOOLS
    return str(tool or "").strip() in allowed_set


def _coerce_budget_value(key: str, value: Any) -> int | float | None:
    if value is None or value == "":
        return None if DEFAULT_BUDGET_LIMITS.get(key) is None else DEFAULT_BUDGET_LIMITS[key]
    parsed = _coerce_number(value)
    if parsed is None:
        return None if DEFAULT_BUDGET_LIMITS.get(key) is None else DEFAULT_BUDGET_LIMITS[key]
    minimum: int | float = 0 if key != "parallel_width" else 1
    maximum = BUDGET_HARD_CAPS.get(key)
    if maximum is not None:
        parsed = min(parsed, maximum)
    parsed = max(parsed, minimum)
    return parsed if key == "max_cost" else int(parsed)


def _coerce_number(value: Any) -> int | float | None:
    try:
        if isinstance(value, float):
            return value
        return int(value)
    except Exception:
        try:
            return float(value)
        except Exception:
            return None


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text:
            result.append(text)
    return result


def _dedupe_id(value: str, used: set[str]) -> str:
    base = value or "item"
    candidate = base
    counter = 2
    while candidate in used:
        candidate = f"{base}_{counter}"
        counter += 1
    used.add(candidate)
    return candidate


def _add_edge(edges: list[dict[str, Any]], source: str, target: str, kind: str, **extra: Any) -> None:
    if not source or not target or source == target:
        return
    key = (source, target, kind)
    if any((edge.get("from"), edge.get("to"), edge.get("kind")) == key for edge in edges):
        return
    payload = {"from": source, "to": target, "source": source, "target": target, "kind": kind}
    payload.update({key: value for key, value in extra.items() if value is not None and value != ""})
    edges.append(payload)


def _route_node_id(value: Any) -> str:
    item_id = str(value or "").strip()
    if item_id in {"", "session", "team"}:
        return "session"
    if item_id == "user":
        return "user"
    return f"agent:{item_id}"


def _title_from_goal(goal: str) -> str:
    text = " ".join(goal.split())
    if not text:
        return ""
    return text[:52].rstrip() + ("..." if len(text) > 52 else "")


def _blueprint_fingerprint(blueprint: dict[str, Any]) -> str:
    material = json.dumps({key: value for key, value in blueprint.items() if key != "id"}, sort_keys=True, ensure_ascii=False)
    return f"bp_{hashlib.sha1(material.encode('utf-8')).hexdigest()[:12]}"


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _diagnostic_dict(item: BlueprintDiagnostic) -> dict[str, Any]:
    payload = asdict(item)
    return {key: value for key, value in payload.items() if value is not None and value != ""}
