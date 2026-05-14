"""Swarm plan normalization and validation."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict
from typing import Any

from tinybot.cowork.blueprint import DEFAULT_ALLOWED_TOOLS, default_budget_usage, normalize_budget_limits
from tinybot.cowork.types import CoworkAgent, CoworkSwarmPlan, CoworkTask, CoworkWorkUnit, now_iso


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
    diagnostics = validate_swarm_plan(normalized, agents=agents, tasks=tasks)
    normalized["diagnostics"] = diagnostics
    if any(item["severity"] == "error" for item in diagnostics):
        normalized["status"] = "blocked"
    return normalized


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
        },
        "merge_policy": str(data.get("merge_policy") or "include_failed_and_skipped_summaries"),
    }


def _normalize_review(raw: Any, reviewer_agent_id: str | None) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    return {
        "required": bool(data.get("required") or reviewer_agent_id),
        "agent_id": reviewer_agent_id,
        "rubric": data.get("rubric") if isinstance(data.get("rubric"), list) else ["correctness", "completeness", "evidence", "safety"],
        "verdict_schema": data.get("verdict_schema") if isinstance(data.get("verdict_schema"), dict) else {"verdict": "pass|needs_revision|blocked", "issues": "array", "confidence": "number"},
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
