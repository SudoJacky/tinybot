"""Swarm plan normalization and validation."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict
from typing import Any

from tinybot.cowork.blueprint import DEFAULT_ALLOWED_TOOLS, default_budget_usage, normalize_budget_limits
from tinybot.cowork.types import (
    CoworkAgent,
    CoworkSwarmOrchestrationAssessment,
    CoworkSwarmPlan,
    CoworkTask,
    CoworkWorkUnit,
    now_iso,
)


PLAN_STATUSES = {"draft", "active", "reducing", "reviewing", "completed", "blocked", "failed", "cancelled"}
WORK_UNIT_STATUSES = {"pending", "ready", "in_progress", "completed", "failed", "skipped", "needs_revision", "cancelled"}
PLAN_STRATEGIES = {"map_reduce", "research_matrix", "compare_options", "code_review", "document_synthesis", "exploration", "custom"}
DEFAULT_SWARM_POLICY = {
    "allowed_tools": sorted(DEFAULT_ALLOWED_TOOLS),
    "allow_file_reads": True,
    "allow_file_writes": False,
    "allow_exec": False,
    "allow_web": False,
    "require_user_approval_for_risky_actions": True,
    "stop_on_blocker": True,
}


def normalize_swarm_plan(
    raw: Any | None = None,
    *,
    goal: str,
    lead_agent_id: str,
    agents: dict[str, CoworkAgent],
    tasks: dict[str, CoworkTask],
    budgets: dict[str, Any] | None = None,
    policy: dict[str, Any] | None = None,
    source_blueprint_id: str = "",
) -> dict[str, Any]:
    """Return a JSON-safe first-class swarm plan.

    The first implementation deliberately mirrors existing Cowork tasks into
    work units so swarm mode can run through the current scheduler while the
    richer runtime grows around a stable contract.
    """

    data = raw if isinstance(raw, dict) else {}
    effective_policy = _normalize_policy({**DEFAULT_SWARM_POLICY, **(policy or data.get("policy") or {})})
    effective_budgets = normalize_budget_limits(budgets or data.get("budgets") or {})
    strategy = str(data.get("strategy") or _strategy_from_goal(goal)).strip().lower()
    if strategy not in PLAN_STRATEGIES:
        strategy = "custom"
    reducer_agent_id = _known_agent(data.get("reducer_agent_id"), agents) or lead_agent_id
    reviewer_agent_id = _known_agent(data.get("reviewer_agent_id"), agents)
    work_units = _normalize_work_units(
        data.get("work_units"),
        goal=goal,
        agents=agents,
        tasks=tasks,
        policy=effective_policy,
        source_blueprint_id=source_blueprint_id,
    )
    created_at = str(data.get("created_at") or now_iso())
    plan = CoworkSwarmPlan(
        id=str(data.get("id") or _plan_id(goal, work_units)),
        goal=str(data.get("goal") or goal).strip(),
        status="active" if work_units else "blocked",
        strategy=strategy,
        lead_agent_id=lead_agent_id,
        reducer_agent_id=reducer_agent_id,
        reviewer_agent_id=reviewer_agent_id,
        work_units=work_units,
        reducer=_normalize_reducer(data.get("reducer"), reducer_agent_id),
        review=_normalize_review(data.get("review"), reviewer_agent_id),
        budgets=effective_budgets,
        policy=effective_policy,
        created_at=created_at,
        updated_at=str(data.get("updated_at") or created_at),
    )
    normalized = asdict(plan)
    normalized["orchestration"] = assess_swarm_orchestration(
        goal=goal,
        agents=agents,
        tasks=tasks,
        work_units=normalized.get("work_units", []),
        budgets=effective_budgets,
        policy=effective_policy,
        existing=data.get("orchestration") if isinstance(data.get("orchestration"), dict) else None,
    )
    diagnostics = validate_swarm_plan(normalized, agents=agents, tasks=tasks)
    normalized["diagnostics"] = diagnostics
    if any(item["severity"] == "error" for item in diagnostics):
        normalized["status"] = "blocked"
    return normalized


def assess_swarm_orchestration(
    *,
    goal: str,
    agents: dict[str, CoworkAgent],
    tasks: dict[str, CoworkTask],
    work_units: list[dict[str, Any]],
    budgets: dict[str, Any] | None = None,
    policy: dict[str, Any] | None = None,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Score whether a goal deserves swarm fan-out and how it should be bounded."""

    if isinstance(existing, dict) and existing.get("id") and existing.get("recommended_mode"):
        return _normalize_orchestration_assessment(existing)

    limits = normalize_budget_limits(budgets or {})
    policy = _normalize_policy({**DEFAULT_SWARM_POLICY, **(policy or {})})
    units = [unit for unit in work_units if isinstance(unit, dict)]
    goal_text = str(goal or "").strip()
    lower_goal = goal_text.lower()
    task_values = list(tasks.values())

    root_units = [unit for unit in units if not unit.get("dependencies")]
    dependency_edges = sum(len(unit.get("dependencies") or []) for unit in units)
    workstream_hints = _orchestration_workstream_hints(goal_text, units, task_values)
    separability = min(
        1.0,
        (
            min(len(workstream_hints), 8) / 8
            + min(len(root_units), 8) / 8
            + (0.25 if _contains_any(lower_goal, _SEPARABLE_MARKERS) else 0.0)
        ),
    )
    depth = min(1.0, (len(agents) + len({unit.get("assigned_agent_id") for unit in units if unit.get("assigned_agent_id")})) / 8)
    merge_cost = min(1.0, (len(units) + dependency_edges) / 24)
    duplicate_risk = _duplicate_risk(units)
    tool_risk = _tool_risk(lower_goal, units, policy)
    budget_fit = _budget_fit(limits, unit_count=len(units), agent_count=len(agents))

    score = _clamp(
        0.10
        + separability * 0.38
        + depth * 0.18
        + budget_fit * 0.16
        - merge_cost * 0.08
        - duplicate_risk * 0.14
        - tool_risk * 0.10
    )
    risk_level = "high" if tool_risk >= 0.62 or _contains_any(lower_goal, _HIGH_RISK_MARKERS) else "medium" if tool_risk >= 0.28 or _contains_any(lower_goal, _REVIEW_MARKERS) else "low"
    requires_user_input = bool(
        (not policy.get("allow_exec") and _contains_any(lower_goal, {"exec", "command", "shell", "run command"}))
        or (not policy.get("allow_file_writes") and _contains_any(lower_goal, {"write", "edit", "modify", "implement", "file", "artifact"}))
        or _contains_any(lower_goal, {"credential", "secret", "token", "password", "login"})
    )
    requires_review = risk_level in {"medium", "high"} or _contains_any(lower_goal, _REVIEW_MARKERS)

    if requires_user_input and score < 0.35:
        recommended_mode = "blocked"
    elif score < 0.28:
        recommended_mode = "single"
    elif score < 0.48:
        recommended_mode = "team"
    elif len(units) >= 20 or score >= 0.76:
        recommended_mode = "large_swarm"
    else:
        recommended_mode = "small_swarm"

    max_spawned = int(limits.get("max_spawned_agents") or 0)
    if recommended_mode in {"single", "team", "blocked"}:
        spawn_strategy = "no_spawn"
    elif max_spawned <= 0:
        spawn_strategy = "reuse_existing"
    elif recommended_mode == "large_swarm" and max_spawned >= len(workstream_hints):
        spawn_strategy = "spawn_per_workstream"
    else:
        spawn_strategy = "spawn_per_workstream" if max_spawned else "reuse_existing"

    parallel_width = max(1, int(limits.get("parallel_width") or 1))
    parallel_width_recommendation = min(
        parallel_width,
        max(1, min(len(root_units) or len(units) or 1, 8 if recommended_mode == "large_swarm" else 4)),
    )
    rationale = _fanout_rationale(
        recommended_mode=recommended_mode,
        separability=separability,
        duplicate_risk=duplicate_risk,
        tool_risk=tool_risk,
        budget_fit=budget_fit,
        workstream_count=len(workstream_hints),
        unit_count=len(units),
    )
    assessment = CoworkSwarmOrchestrationAssessment(
        id=_assessment_id(goal_text, units),
        goal=goal_text,
        recommended_mode=recommended_mode,
        fanout_score=round(score, 3),
        fanout_rationale=rationale,
        workstream_hints=workstream_hints,
        spawn_strategy=spawn_strategy,
        parallel_width_recommendation=parallel_width_recommendation,
        risk_level=risk_level,
        requires_review=requires_review,
        requires_user_input=requires_user_input,
        budget_recommendation={
            "parallel_width": parallel_width_recommendation,
            "max_work_units": limits.get("max_work_units"),
            "max_spawned_agents": limits.get("max_spawned_agents"),
            "max_agent_calls_per_run": limits.get("max_agent_calls_per_run"),
        },
        signals={
            "separability": round(separability, 3),
            "depth": round(depth, 3),
            "merge_cost": round(merge_cost, 3),
            "duplicate_risk": round(duplicate_risk, 3),
            "tool_risk": round(tool_risk, 3),
            "budget_fit": round(budget_fit, 3),
            "root_work_units": len(root_units),
            "dependency_edges": dependency_edges,
            "agent_count": len(agents),
            "work_unit_count": len(units),
        },
    )
    return asdict(assessment)


def validate_swarm_plan(plan: dict[str, Any], *, agents: dict[str, CoworkAgent], tasks: dict[str, CoworkTask]) -> list[dict[str, Any]]:
    """Validate dependency, owner, budget, and policy constraints."""

    diagnostics: list[dict[str, Any]] = []
    work_units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
    work_unit_ids = [str(item.get("id") or "") for item in work_units if isinstance(item, dict)]
    duplicates = sorted({item_id for item_id in work_unit_ids if work_unit_ids.count(item_id) > 1})
    for item_id in duplicates:
        diagnostics.append(_diagnostic("error", "duplicate_work_unit_id", f"Duplicate work-unit id '{item_id}'.", "work_units", item_id))
    known_units = set(work_unit_ids)
    known_tasks = set(tasks)
    known_agents = set(agents)

    if not str(plan.get("goal") or "").strip():
        diagnostics.append(_diagnostic("error", "missing_goal", "Swarm plan goal is required.", "goal"))
    if plan.get("status") not in PLAN_STATUSES:
        diagnostics.append(_diagnostic("error", "invalid_plan_status", "Swarm plan status is invalid.", "status", plan.get("status")))
    if not work_units:
        diagnostics.append(_diagnostic("error", "missing_work_units", "Swarm plan requires at least one work unit.", "work_units"))

    policy = plan.get("policy") if isinstance(plan.get("policy"), dict) else DEFAULT_SWARM_POLICY
    allowed_tools = {str(item) for item in policy.get("allowed_tools", []) if str(item).strip()} or DEFAULT_ALLOWED_TOOLS
    for index, unit in enumerate(work_units):
        if not isinstance(unit, dict):
            diagnostics.append(_diagnostic("error", "invalid_work_unit", "Work unit must be an object.", f"work_units[{index}]", unit))
            continue
        if unit.get("status") not in WORK_UNIT_STATUSES:
            diagnostics.append(_diagnostic("error", "invalid_work_unit_status", "Work-unit status is invalid.", f"work_units[{index}].status", unit.get("status")))
        owner = unit.get("assigned_agent_id")
        if owner and owner not in known_agents:
            diagnostics.append(_diagnostic("error", "missing_work_unit_owner", f"Work-unit owner '{owner}' does not exist.", f"work_units[{index}].assigned_agent_id", owner))
        for dependency in unit.get("dependencies") or []:
            if dependency not in known_units and dependency not in known_tasks:
                diagnostics.append(_diagnostic("error", "missing_work_unit_dependency", f"Work-unit dependency '{dependency}' does not exist.", f"work_units[{index}].dependencies", dependency))
        for tool in unit.get("tool_allowlist") or []:
            if tool not in allowed_tools:
                diagnostics.append(_diagnostic("error", "tool_disallowed", f"Tool '{tool}' is not allowed by swarm policy.", f"work_units[{index}].tool_allowlist", tool))
    cycle = _dependency_cycle(work_units)
    if cycle:
        diagnostics.append(_diagnostic("error", "work_unit_dependency_cycle", f"Work-unit dependencies contain a cycle: {' -> '.join(cycle)}.", "work_units", cycle))

    budgets = normalize_budget_limits(plan.get("budgets") or {})
    max_work_units = budgets.get("max_work_units")
    if max_work_units is not None and len(work_units) > int(max_work_units):
        diagnostics.append(_diagnostic("error", "work_unit_budget_exhausted", "Swarm plan exceeds max work units.", "budgets.max_work_units", max_work_units))
    for field, agent_id in (("lead_agent_id", plan.get("lead_agent_id")), ("reducer_agent_id", plan.get("reducer_agent_id")), ("reviewer_agent_id", plan.get("reviewer_agent_id"))):
        if agent_id and agent_id not in known_agents:
            diagnostics.append(_diagnostic("error", "missing_plan_agent", f"Plan agent '{agent_id}' does not exist.", field, agent_id))
    return diagnostics


def update_work_unit_readiness(plan: dict[str, Any], tasks: dict[str, CoworkTask]) -> dict[str, Any]:
    """Move pending work units with satisfied dependencies to ready."""

    if not isinstance(plan, dict):
        return {}
    units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
    completed_units = {unit.get("id") for unit in units if unit.get("status") in {"completed", "skipped"}}
    completed_tasks = {task_id for task_id, task in tasks.items() if task.status in {"completed", "skipped"}}
    changed = False
    for unit in units:
        if unit.get("status") != "pending":
            continue
        dependencies = set(unit.get("dependencies") or [])
        if dependencies <= (completed_units | completed_tasks):
            unit["status"] = "ready"
            unit["updated_at"] = now_iso()
            unit["readiness_reason"] = {"completed_dependencies": sorted(dependencies), "priority": unit.get("priority", 0)}
            changed = True
    if changed:
        plan["updated_at"] = now_iso()
    return plan


def build_swarm_scheduler_queues(session: Any) -> dict[str, Any]:
    """Project a swarm plan into durable scheduler queues."""

    plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
    units = [unit for unit in plan.get("work_units", []) if isinstance(unit, dict)]
    tasks = getattr(session, "tasks", {}) or {}
    completed_units = {unit.get("id") for unit in units if unit.get("status") in {"completed", "skipped"}}
    completed_tasks = {task_id for task_id, task in tasks.items() if getattr(task, "status", "") in {"completed", "skipped"}}
    running_agents = {
        str(unit.get("assigned_agent_id"))
        for unit in units
        if unit.get("status") == "in_progress" and unit.get("assigned_agent_id")
    }
    queues: dict[str, list[dict[str, Any]]] = {
        "ready": [],
        "blocked": [],
        "running": [],
        "completed": [],
        "failed_retry": [],
        "cancelled": [],
    }

    for unit in units:
        item = _queue_item(unit, completed_units | completed_tasks, running_agents)
        status = str(unit.get("status") or "pending")
        if status == "in_progress":
            queues["running"].append(item)
        elif status in {"completed", "skipped"}:
            queues["completed"].append(item)
        elif status in {"failed", "needs_revision"}:
            attempts = int(unit.get("attempts", 0) or 0)
            max_attempts = int(unit.get("max_attempts", 1) or 1)
            if attempts < max_attempts:
                queues["failed_retry"].append(item)
            else:
                item["block_reason"] = "max_attempts_reached"
                queues["blocked"].append(item)
        elif status == "cancelled":
            queues["cancelled"].append(item)
        elif item["blocked_by"]:
            queues["blocked"].append(item)
        else:
            queues["ready"].append(item)

    for key in queues:
        queues[key].sort(key=lambda item: (-int(item.get("priority", 0) or 0), item.get("created_at", ""), item.get("id", "")))
    queues["ready"] = _fair_order_by_workstream(queues["ready"])
    queues["failed_retry"] = _fair_order_by_workstream(queues["failed_retry"])
    limits = getattr(session, "budget_limits", {}) or {}
    usage = getattr(session, "budget_usage", {}) or {}
    parallel_width = max(1, int(limits.get("parallel_width", 1) or 1))
    metrics = build_swarm_parallel_metrics(session)
    return {
        "schema_version": "cowork.swarm_queues.v1",
        "plan_id": plan.get("id", ""),
        "plan_status": plan.get("status", ""),
        "generated_at": now_iso(),
        "parallel_width": parallel_width,
        "available_slots": max(0, parallel_width - len(queues["running"])),
        "queues": queues,
        "counts": {key: len(value) for key, value in queues.items()},
        "budget": {"limits": limits, "usage": usage},
        "metrics": metrics,
    }


def build_swarm_parallel_metrics(session: Any) -> dict[str, Any]:
    """Measure whether swarm fanout is producing useful parallelism."""

    plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
    units = [unit for unit in plan.get("work_units", []) if isinstance(unit, dict)]
    limits = getattr(session, "budget_limits", {}) or {}
    parallel_width = max(1, int(limits.get("parallel_width", 1) or 1))
    main_units = [unit for unit in units if unit.get("kind") not in {"reducer", "reviewer"}]
    required_units = [unit for unit in main_units if unit.get("status") != "cancelled"]
    completed_units = [unit for unit in required_units if unit.get("status") == "completed"]
    running_units = [unit for unit in required_units if unit.get("status") == "in_progress"]
    blocked_units = [
        unit
        for unit in required_units
        if unit.get("status") in {"failed", "blocked", "needs_revision"}
        or _metric_blocked_by(unit, units, getattr(session, "tasks", {}) or {})
    ]
    runnable_units = [
        unit
        for unit in required_units
        if unit.get("status") in {"ready", "pending"}
        and not _metric_blocked_by(unit, units, getattr(session, "tasks", {}) or {})
    ]
    depth = _critical_path_depth(units)
    reducer_units = [unit for unit in units if unit.get("kind") == "reducer"]
    reviewer_units = [unit for unit in units if unit.get("kind") == "reviewer"]
    gate_depth = (1 if reducer_units else 0) + (1 if reviewer_units else 0)
    critical_path_depth = depth + gate_depth
    rounds = max(1, int(getattr(session, "rounds", 0) or 0) or critical_path_depth or 1)
    observed_width = max(
        len(running_units),
        _observed_width_from_trace(getattr(session, "trace_spans", []) or []),
        min(parallel_width, len(runnable_units)) if len(runnable_units) > 1 else 0,
    )
    duplicate_rejections = sum(1 for event in getattr(session, "events", []) if getattr(event, "type", "") == "swarm.duplicate_activation_skipped")
    blocked_slot_count = max(0, min(parallel_width, len(blocked_units)) - len(running_units))
    reducer_coverage = _reducer_coverage(session, completed_units)
    parallel_efficiency = _clamp(len(completed_units) / max(1, critical_path_depth or rounds))
    fanout_utilization = _clamp(observed_width / parallel_width)
    return {
        "schema_version": "cowork.swarm_metrics.v1",
        "plan_id": plan.get("id", ""),
        "critical_path_depth": critical_path_depth,
        "critical_rounds": rounds,
        "fanout_width_observed": observed_width,
        "parallel_efficiency": round(parallel_efficiency, 3),
        "fanout_utilization": round(fanout_utilization, 3),
        "duplicate_rejection_count": duplicate_rejections,
        "blocked_slot_count": blocked_slot_count,
        "reducer_coverage": round(reducer_coverage, 3),
        "counts": {
            "work_units": len(required_units),
            "completed": len(completed_units),
            "running": len(running_units),
            "blocked": len(blocked_units),
            "reducer_units": len(reducer_units),
            "reviewer_units": len(reviewer_units),
        },
        "generated_at": now_iso(),
    }


_SEPARABLE_MARKERS = {
    "compare",
    "research",
    "matrix",
    "review",
    "audit",
    "panel",
    "experts",
    "perspectives",
    "files",
    "documents",
    "urls",
    "pages",
    "sources",
    "options",
    "batch",
    "parallel",
}
_REVIEW_MARKERS = {
    "review",
    "verify",
    "validate",
    "test",
    "security",
    "compliance",
    "risk",
    "critical",
    "artifact",
    "code",
    "final",
    "evidence",
}
_HIGH_RISK_MARKERS = {"credential", "secret", "token", "password", "delete", "deploy", "payment", "private", "production"}


def _normalize_orchestration_assessment(value: dict[str, Any]) -> dict[str, Any]:
    mode = str(value.get("recommended_mode") or "team")
    if mode not in {"single", "team", "small_swarm", "large_swarm", "blocked"}:
        mode = "team"
    spawn_strategy = str(value.get("spawn_strategy") or "reuse_existing")
    if spawn_strategy not in {"reuse_existing", "spawn_per_workstream", "spawn_per_unit", "no_spawn"}:
        spawn_strategy = "reuse_existing"
    risk_level = str(value.get("risk_level") or "low")
    if risk_level not in {"low", "medium", "high"}:
        risk_level = "low"
    return {
        "id": str(value.get("id") or _assessment_id(value.get("goal", ""), [])),
        "goal": str(value.get("goal") or ""),
        "recommended_mode": mode,
        "fanout_score": round(_clamp(_float(value.get("fanout_score"), 0.0)), 3),
        "fanout_rationale": [str(item) for item in value.get("fanout_rationale", []) if str(item).strip()]
        if isinstance(value.get("fanout_rationale"), list)
        else [],
        "workstream_hints": [dict(item) for item in value.get("workstream_hints", []) if isinstance(item, dict)]
        if isinstance(value.get("workstream_hints"), list)
        else [],
        "spawn_strategy": spawn_strategy,
        "parallel_width_recommendation": max(1, int(value.get("parallel_width_recommendation") or 1)),
        "risk_level": risk_level,
        "requires_review": bool(value.get("requires_review", False)),
        "requires_user_input": bool(value.get("requires_user_input", False)),
        "budget_recommendation": dict(value.get("budget_recommendation") or {}) if isinstance(value.get("budget_recommendation"), dict) else {},
        "signals": dict(value.get("signals") or {}) if isinstance(value.get("signals"), dict) else {},
        "created_at": str(value.get("created_at") or now_iso()),
    }


def _orchestration_workstream_hints(goal: str, units: list[dict[str, Any]], tasks: list[CoworkTask]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}

    def add_hint(key: str, title: str, source: str, unit_id: str = "") -> None:
        key = _slug(key, fallback="default")
        item = groups.setdefault(key, {"id": key, "title": title or key.replace("_", " "), "source": source, "unit_ids": []})
        if unit_id and len(item["unit_ids"]) < 12:
            item["unit_ids"].append(unit_id)

    for unit in units:
        key = str(unit.get("team_id") or unit.get("fanout_group_id") or unit.get("kind") or unit.get("assigned_agent_id") or "").strip()
        if key:
            add_hint(key, key.replace("_", " "), "work_unit", str(unit.get("id") or ""))
    for task in tasks:
        if task.fanout_group_id:
            add_hint(task.fanout_group_id, task.fanout_group_id.replace("_", " "), "task", task.id)
    for index, marker in enumerate(_goal_workstream_markers(goal), start=1):
        add_hint(f"goal_{index}_{marker}", marker.title(), "goal")
    if not groups and units:
        add_hint("default", "Default", "fallback")
    return sorted(groups.values(), key=lambda item: (item["source"] != "goal", item["id"]))[:12]


def _goal_workstream_markers(goal: str) -> list[str]:
    lower = goal.lower()
    markers = []
    for value in ("vc", "pm", "security", "compliance", "customer", "gtm", "ethics", "finance", "engineering", "research", "qa"):
        if value in lower:
            markers.append(value)
    if "http://" in lower or "https://" in lower:
        markers.append("web sources")
    if any(part in lower for part in (".py", ".ts", ".js", ".md", "file", "files")):
        markers.append("files")
    if "compare" in lower or "option" in lower:
        markers.append("options")
    return list(dict.fromkeys(markers))


def _duplicate_risk(units: list[dict[str, Any]]) -> float:
    if len(units) < 2:
        return 0.0
    signatures = [_unit_signature(unit, "") for unit in units]
    duplicates = len(signatures) - len(set(signatures))
    return _clamp(duplicates / max(1, len(units) - 1))


def _tool_risk(goal: str, units: list[dict[str, Any]], policy: dict[str, Any]) -> float:
    risk = 0.0
    if _contains_any(goal, {"write", "edit", "modify", "implement", "delete", "deploy", "artifact"}):
        risk += 0.28
    if _contains_any(goal, {"exec", "command", "shell", "terminal", "run"}):
        risk += 0.32
    if _contains_any(goal, {"web", "url", "http", "browser", "download"}):
        risk += 0.18
    tools = {tool for unit in units for tool in (unit.get("tool_allowlist") or [])}
    if tools & {"write_file", "edit_file"} or policy.get("allow_file_writes"):
        risk += 0.22
    if "exec" in tools or policy.get("allow_exec"):
        risk += 0.26
    if policy.get("allow_web"):
        risk += 0.18
    return _clamp(risk)


def _budget_fit(limits: dict[str, Any], *, unit_count: int, agent_count: int) -> float:
    max_units = limits.get("max_work_units")
    unit_fit = 1.0 if max_units is None else _clamp(float(max_units) / max(1, unit_count))
    parallel_width = max(1, int(limits.get("parallel_width") or 1))
    parallel_fit = _clamp(parallel_width / max(1, min(unit_count or 1, 8)))
    max_calls = limits.get("max_agent_calls_per_run")
    call_fit = 1.0 if max_calls is None else _clamp(float(max_calls) / max(1, unit_count + agent_count))
    return round((unit_fit + parallel_fit + call_fit) / 3, 3)


def _critical_path_depth(units: list[dict[str, Any]]) -> int:
    by_id = {str(unit.get("id")): unit for unit in units if unit.get("id")}
    memo: dict[str, int] = {}

    def depth(unit_id: str, visiting: set[str]) -> int:
        if unit_id in memo:
            return memo[unit_id]
        if unit_id in visiting:
            return 1
        visiting.add(unit_id)
        unit = by_id.get(unit_id, {})
        dependencies = [str(dep) for dep in unit.get("dependencies") or [] if str(dep) in by_id]
        value = 1 + max((depth(dep, visiting) for dep in dependencies), default=0)
        visiting.remove(unit_id)
        memo[unit_id] = value
        return value

    return max((depth(unit_id, set()) for unit_id in by_id), default=0)


def _metric_blocked_by(unit: dict[str, Any], units: list[dict[str, Any]], tasks: dict[str, Any]) -> list[str]:
    completed_units = {item.get("id") for item in units if item.get("status") in {"completed", "skipped"}}
    completed_tasks = {task_id for task_id, task in tasks.items() if getattr(task, "status", "") in {"completed", "skipped"}}
    return [str(dep) for dep in unit.get("dependencies") or [] if dep not in completed_units and dep not in completed_tasks]


def _observed_width_from_trace(spans: list[Any]) -> int:
    active_units = {
        str((getattr(span, "data", {}) or {}).get("work_unit_id"))
        for span in spans
        if getattr(span, "name", "") == "Work unit started" and (getattr(span, "data", {}) or {}).get("work_unit_id")
    }
    return len(active_units)


def _reducer_coverage(session: Any, completed_units: list[dict[str, Any]]) -> float:
    completed_ids = {str(unit.get("id")) for unit in completed_units if unit.get("id")}
    if not completed_ids:
        return 0.0
    cited: set[str] = set()
    for task in (getattr(session, "tasks", {}) or {}).values():
        if not str(getattr(task, "source_event_id", "") or "").startswith("swarm_reducer:"):
            continue
        data = getattr(task, "result_data", {}) if isinstance(getattr(task, "result_data", {}), dict) else {}
        for value in data.get("source_work_unit_ids") or []:
            if str(value) in completed_ids:
                cited.add(str(value))
    return len(cited) / max(1, len(completed_ids))


def _fanout_rationale(
    *,
    recommended_mode: str,
    separability: float,
    duplicate_risk: float,
    tool_risk: float,
    budget_fit: float,
    workstream_count: int,
    unit_count: int,
) -> list[str]:
    reasons = [f"recommended {recommended_mode} for {unit_count} work unit(s) across {workstream_count} workstream hint(s)"]
    if separability >= 0.5:
        reasons.append("goal appears separable enough for bounded fanout")
    else:
        reasons.append("limited separability; avoid broad fanout")
    if duplicate_risk >= 0.25:
        reasons.append("duplicate-risk signals suggest keeping fanout narrow")
    if tool_risk >= 0.35:
        reasons.append("tool or artifact risk requires review or user input")
    if budget_fit < 0.5:
        reasons.append("budget pressure limits useful parallelism")
    return reasons


def _contains_any(text: str, markers: set[str]) -> bool:
    return any(marker in text for marker in markers)


def _float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _assessment_id(goal: Any, units: list[dict[str, Any]]) -> str:
    material = json.dumps(
        {"goal": str(goal or ""), "units": [unit.get("id") for unit in units if isinstance(unit, dict)]},
        sort_keys=True,
        ensure_ascii=False,
    )
    return f"orch_{hashlib.sha1(material.encode('utf-8')).hexdigest()[:12]}"


def _queue_item(unit: dict[str, Any], completed: set[str], running_agents: set[str]) -> dict[str, Any]:
    dependencies = [str(item) for item in unit.get("dependencies", []) if str(item).strip()]
    blocked_by = [item for item in dependencies if item not in completed]
    return {
        "id": unit.get("id", ""),
        "title": unit.get("title", ""),
        "status": unit.get("status", "pending"),
        "priority": int(unit.get("priority", 0) or 0),
        "assigned_agent_id": unit.get("assigned_agent_id"),
        "dependencies": dependencies,
        "blocked_by": blocked_by,
        "attempts": int(unit.get("attempts", 0) or 0),
        "max_attempts": int(unit.get("max_attempts", 1) or 1),
        "workstream": unit.get("team_id") or unit.get("fanout_group_id") or unit.get("kind") or "default",
        "created_at": unit.get("created_at", ""),
        "updated_at": unit.get("updated_at", ""),
        "reason": _queue_reason(unit, blocked_by, running_agents),
    }


def _queue_reason(unit: dict[str, Any], blocked_by: list[str], running_agents: set[str]) -> str:
    if blocked_by:
        return f"Waiting on dependencies: {', '.join(blocked_by)}"
    status = str(unit.get("status") or "pending")
    if status == "in_progress":
        return f"Running on {unit.get('assigned_agent_id') or 'an agent'}"
    if status in {"failed", "needs_revision"}:
        return "Eligible for retry" if int(unit.get("attempts", 0) or 0) < int(unit.get("max_attempts", 1) or 1) else "Retry budget exhausted"
    if unit.get("assigned_agent_id") in running_agents:
        return "Owner is already running another work unit"
    return "Dependencies satisfied and scheduling budget permitting"


def _fair_order_by_workstream(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault(str(item.get("workstream") or "default"), []).append(item)
    ordered: list[dict[str, Any]] = []
    while any(groups.values()):
        for key in sorted(groups):
            if groups[key]:
                ordered.append(groups[key].pop(0))
    return ordered


def work_unit_result_from_task(task: CoworkTask) -> dict[str, Any]:
    data = task.result_data if isinstance(task.result_data, dict) else {}
    artifacts = []
    for value in _artifact_values(data):
        if isinstance(value, dict):
            path_or_url = str(value.get("path_or_url") or value.get("path") or value.get("url") or "").strip()
            if path_or_url:
                artifacts.append(
                    {
                        "kind": value.get("kind") or _artifact_kind(path_or_url),
                        "path_or_url": path_or_url,
                        "summary": value.get("summary") or path_or_url,
                    }
                )
        else:
            artifacts.append({"kind": _artifact_kind(value), "path_or_url": value, "summary": value})
    return {
        "answer": data.get("answer") or task.result or "",
        "findings": data.get("findings") if isinstance(data.get("findings"), list) else [],
        "evidence": data.get("evidence") if isinstance(data.get("evidence"), list) else [],
        "risks": data.get("risks") if isinstance(data.get("risks"), list) else [],
        "open_questions": data.get("open_questions") if isinstance(data.get("open_questions"), list) else [],
        "artifacts": artifacts,
        "confidence": task.confidence,
    }


def _normalize_work_units(
    raw_units: Any,
    *,
    goal: str,
    agents: dict[str, CoworkAgent],
    tasks: dict[str, CoworkTask],
    policy: dict[str, Any],
    source_blueprint_id: str,
) -> list[CoworkWorkUnit]:
    raw = raw_units if isinstance(raw_units, list) and raw_units else []
    units: list[CoworkWorkUnit] = []
    used: set[str] = set()
    signatures: set[str] = set()
    if not raw:
        raw = [
            {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "assigned_agent_id": task.assigned_agent_id,
                "dependencies": task.dependencies,
                "priority": task.priority,
                "expected_output_schema": _schema_from_expected(task.expected_output),
                "source_task_id": task.id,
                "source_blueprint_id": task.source_blueprint_id,
                "fanout_group_id": task.fanout_group_id,
            }
            for task in tasks.values()
        ]
    if not raw:
        raw = [{"id": "initial_analysis", "title": "Initial analysis", "description": f"Analyze the goal: {goal}"}]
    allowed_tools = set(policy.get("allowed_tools") or DEFAULT_ALLOWED_TOOLS)
    for index, item in enumerate(raw):
        item = item if isinstance(item, dict) else {}
        unit_id = _dedupe_id(_slug(item.get("id") or item.get("title") or f"unit_{index + 1}"), used)
        owner = _known_agent(item.get("assigned_agent_id"), agents)
        source_task_id = str(item.get("source_task_id") or item.get("task_id") or "")
        task = tasks.get(source_task_id) or tasks.get(unit_id)
        if task is not None:
            owner = owner or task.assigned_agent_id
        tools = item.get("tool_allowlist") or item.get("tools")
        tool_allowlist = [str(tool).strip() for tool in (tools if isinstance(tools, list) else []) if str(tool).strip()]
        if not tool_allowlist and owner and owner in agents:
            tool_allowlist = list(agents[owner].tools or ["cowork_internal"])
        if not tool_allowlist:
            tool_allowlist = ["cowork_internal"]
        tool_allowlist = [tool for tool in dict.fromkeys(tool_allowlist) if tool in allowed_tools]
        signature = _unit_signature(item, goal)
        if signature in signatures:
            continue
        signatures.add(signature)
        dependencies = [_slug(dep) for dep in item.get("dependencies", []) if str(dep).strip()] if isinstance(item.get("dependencies", []), list) else []
        units.append(
            CoworkWorkUnit(
                id=unit_id,
                title=str(item.get("title") or unit_id).strip(),
                description=str(item.get("description") or item.get("title") or goal).strip(),
                input=item.get("input") if isinstance(item.get("input"), dict) else {"goal": goal, "source_task_id": source_task_id or unit_id},
                expected_output_schema=item.get("expected_output_schema") if isinstance(item.get("expected_output_schema"), dict) else _schema_from_expected(item.get("expected_output")),
                completion_criteria=[str(value).strip() for value in item.get("completion_criteria", []) if str(value).strip()] if isinstance(item.get("completion_criteria"), list) else ["Return a structured result for the unit."],
                assigned_agent_id=owner,
                dependencies=dependencies,
                workstream_id=str(item.get("workstream_id") or item.get("workstream") or "").strip(),
                fanout_group_id=str(item.get("fanout_group_id") or "").strip(),
                team_id=str(item.get("team_id") or "").strip(),
                status=_work_unit_status(item.get("status"), dependencies),
                priority=int(item.get("priority", 0) or 0),
                attempts=int(item.get("attempts", 0) or 0),
                max_attempts=max(1, int(item.get("max_attempts", 2) or 2)),
                tool_allowlist=tool_allowlist,
                source_task_id=source_task_id or (task.id if task else None),
                source_blueprint_id=str(item.get("source_blueprint_id") or source_blueprint_id or ""),
            )
        )
    return units


def _normalize_policy(policy: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(DEFAULT_SWARM_POLICY)
    normalized.update(policy)
    allowed = normalized.get("allowed_tools")
    if not isinstance(allowed, list):
        allowed = sorted(DEFAULT_ALLOWED_TOOLS)
    normalized["allowed_tools"] = [str(item).strip() for item in allowed if str(item).strip()]
    if not normalized.get("allow_file_writes"):
        normalized["allowed_tools"] = [tool for tool in normalized["allowed_tools"] if tool not in {"write_file", "edit_file"}]
    if not normalized.get("allow_exec"):
        normalized["allowed_tools"] = [tool for tool in normalized["allowed_tools"] if tool != "exec"]
    return normalized


def _normalize_reducer(raw: Any, reducer_agent_id: str) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    return {
        "strategy": str(data.get("strategy") or "summarize_required_work"),
        "agent_id": reducer_agent_id,
        "required_inputs": data.get("required_inputs") if isinstance(data.get("required_inputs"), list) else ["completed_work_units"],
        "expected_output_schema": data.get("expected_output_schema")
        if isinstance(data.get("expected_output_schema"), dict)
        else {
            "answer": "string",
            "findings": "array",
            "risks": "array",
            "open_questions": "array",
            "confidence": "number",
            "source_work_unit_ids": "array",
            "source_artifact_refs": "array",
            "coverage_by_workstream": "object",
            "confidence_by_section": "object",
        },
        "merge_policy": str(data.get("merge_policy") or "include_failed_and_skipped_summaries"),
    }


def _normalize_review(raw: Any, reviewer_agent_id: str | None) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    return {
        "required": bool(data.get("required") or reviewer_agent_id),
        "agent_id": reviewer_agent_id,
        "rubric": data.get("rubric") if isinstance(data.get("rubric"), list) else ["correctness", "completeness", "evidence", "safety"],
        "verdict_schema": data.get("verdict_schema")
        if isinstance(data.get("verdict_schema"), dict)
        else {
            "verdict": "pass|needs_revision|blocked",
            "issues": "array",
            "coverage_issues": "array",
            "uncited_claims": "array",
            "artifact_issues": "array",
            "required_follow_up_units": "array",
            "confidence": "number",
        },
        "revision_policy": str(data.get("revision_policy") or "create_revision_work_units"),
    }


def _known_agent(value: Any, agents: dict[str, CoworkAgent]) -> str | None:
    item = _slug(value)
    return item if item in agents else None


def _work_unit_status(value: Any, dependencies: list[str]) -> str:
    status = str(value or "").strip().lower()
    if status in WORK_UNIT_STATUSES:
        return status
    return "pending" if dependencies else "ready"


def _schema_from_expected(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not text:
        return {"answer": "string", "evidence": "array", "risks": "array", "artifacts": "array", "confidence": "number"}
    return {"answer": "string", "expected": text, "confidence": "number"}


def _dependency_cycle(units: list[dict[str, Any]]) -> list[str]:
    graph = {str(unit.get("id")): [str(dep) for dep in unit.get("dependencies") or [] if dep] for unit in units if isinstance(unit, dict)}
    visiting: set[str] = set()
    visited: set[str] = set()
    path: list[str] = []

    def visit(node: str) -> list[str]:
        if node in visiting:
            return path[path.index(node) :] + [node] if node in path else [node, node]
        if node in visited:
            return []
        visiting.add(node)
        path.append(node)
        for dep in graph.get(node, []):
            if dep in graph:
                cycle = visit(dep)
                if cycle:
                    return cycle
        visiting.remove(node)
        visited.add(node)
        path.pop()
        return []

    for item_id in graph:
        cycle = visit(item_id)
        if cycle:
            return cycle
    return []


def _artifact_values(data: dict[str, Any]) -> list[Any]:
    values: list[Any] = []
    for key in ("artifacts", "artifact_paths", "generated_files", "files", "paths"):
        raw = data.get(key)
        if isinstance(raw, list):
            values.extend(raw)
        elif isinstance(raw, str):
            values.append(raw)
    result: list[Any] = []
    for value in values:
        if isinstance(value, dict):
            if str(value.get("path_or_url") or value.get("path") or value.get("url") or "").strip():
                result.append(value)
            continue
        text = str(value or "").strip()
        if text:
            result.append(text)
    return result


def _artifact_kind(value: str) -> str:
    text = value.lower()
    if text.startswith(("http://", "https://")):
        return "url"
    if text.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")):
        return "image"
    if text.endswith((".csv", ".tsv", ".xlsx", ".xls")):
        return "table"
    if text.endswith((".patch", ".diff")):
        return "diff"
    return "file"


def _strategy_from_goal(goal: str) -> str:
    text = goal.lower()
    if any(marker in text for marker in ("compare", "对比", "选择")):
        return "compare_options"
    if any(marker in text for marker in ("code", "test", "review", "代码", "测试")):
        return "code_review"
    if any(marker in text for marker in ("research", "调查", "资料")):
        return "research_matrix"
    return "map_reduce"


def _unit_signature(item: dict[str, Any], goal: str) -> str:
    material = {
        "title": " ".join(str(item.get("title") or "").lower().split()),
        "description": " ".join(str(item.get("description") or item.get("title") or goal).lower().split()),
        "input": item.get("input") if isinstance(item.get("input"), dict) else {},
        "expected_output_schema": item.get("expected_output_schema") if isinstance(item.get("expected_output_schema"), dict) else _schema_from_expected(item.get("expected_output")),
        "source": item.get("source_task_id") or item.get("task_id") or item.get("source_blueprint_id") or "",
    }
    return hashlib.sha1(json.dumps(material, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _plan_id(goal: str, work_units: list[CoworkWorkUnit]) -> str:
    material = json.dumps({"goal": goal, "work_units": [unit.id for unit in work_units]}, sort_keys=True, ensure_ascii=False)
    return f"swarm_{hashlib.sha1(material.encode('utf-8')).hexdigest()[:12]}"


def _dedupe_id(value: str, used: set[str]) -> str:
    base = value or "unit"
    candidate = base
    counter = 2
    while candidate in used:
        candidate = f"{base}_{counter}"
        counter += 1
    used.add(candidate)
    return candidate


def _slug(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9_\-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text[:48] or fallback


def _diagnostic(severity: str, code: str, message: str, path: str = "", value: Any = None) -> dict[str, Any]:
    return {"severity": severity, "code": code, "message": message, "path": path, "value": value}
