"""Dedicated HTTP API routes for Cowork sessions."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from aiohttp import web

from tinybot.cowork.blueprint import budget_remaining, default_budget_usage, export_session_blueprint, normalize_budget_limits
from tinybot.cowork.policies import default_policy_registry
from tinybot.cowork.snapshot import (
    build_cowork_artifact_index,
    build_cowork_graph,
    build_cowork_large_swarm_summary,
    build_cowork_task_dag,
    build_cowork_trace,
)
from tinybot.cowork.swarm import build_swarm_scheduler_queues


def _budget_snapshot(session: Any) -> dict[str, Any]:
    limits = normalize_budget_limits(getattr(session, "budget_limits", {}) or {})
    usage = default_budget_usage()
    usage.update(getattr(session, "budget_usage", {}) or {})
    usage["stop_reason"] = getattr(session, "stop_reason", "") or usage.get("stop_reason", "")
    return {
        "limits": limits,
        "usage": usage,
        "remaining": budget_remaining(limits, usage),
        "stop_reason": usage.get("stop_reason", ""),
    }


def _blueprint_metadata(blueprint: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(blueprint, dict) or not blueprint:
        return {}
    return {
        "id": blueprint.get("id", ""),
        "schema_version": blueprint.get("schema_version", ""),
        "lead_agent_id": blueprint.get("lead_agent_id", ""),
        "agent_count": len(blueprint.get("agents", []) if isinstance(blueprint.get("agents"), list) else []),
        "task_count": len(blueprint.get("tasks", []) if isinstance(blueprint.get("tasks"), list) else []),
    }


def _branch_snapshot(branch: Any, *, current: bool = False) -> dict[str, Any]:
    return {
        "id": branch.id,
        "title": branch.title,
        "architecture": branch.architecture,
        "status": branch.status,
        "topology_reference": getattr(branch, "topology_reference", {}) or {},
        "source_branch_id": getattr(branch, "source_branch_id", None),
        "source_stage_record_id": getattr(branch, "source_stage_record_id", None),
        "derivation_event_id": getattr(branch, "derivation_event_id", None),
        "derivation_reason": getattr(branch, "derivation_reason", ""),
        "inherited_context_summary": getattr(branch, "inherited_context_summary", ""),
        "completion_decision": getattr(branch, "completion_decision", {}) or {},
        "runtime_state": getattr(branch, "runtime_state", {}) or {},
        "branch_result": _dataclass_snapshot(getattr(branch, "branch_result", None)),
        "created_at": branch.created_at,
        "updated_at": branch.updated_at,
        "current": current,
        "derived": bool(getattr(branch, "source_branch_id", None)),
    }


def _dataclass_snapshot(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return dict(value)
    return {}


def cowork_session_snapshot(session: Any, *, verbose: bool = True) -> dict[str, Any]:
    """Return a JSON-safe snapshot for a cowork session."""
    branches = getattr(session, "branches", {}) if isinstance(getattr(session, "branches", {}), dict) else {}
    current_branch_id = getattr(session, "current_branch_id", "default") or "default"
    current_branch = branches.get(current_branch_id) if branches else None
    active_architecture = getattr(current_branch, "architecture", getattr(session, "workflow_mode", "adaptive_starter"))
    policy = default_policy_registry().resolve(active_architecture)
    agents = []
    for agent in session.agents.values():
        current_task_title = agent.current_task_title
        if not current_task_title and agent.current_task_id and agent.current_task_id in session.tasks:
            current_task_title = session.tasks[agent.current_task_id].title
        agents.append(
            {
                "id": agent.id,
                "name": agent.name,
                "role": agent.role,
                "goal": agent.goal,
                "responsibilities": agent.responsibilities,
                "subscriptions": getattr(agent, "subscriptions", []),
                "status": agent.status,
                "private_summary": agent.private_summary if verbose else "",
                "inbox_count": len(agent.inbox),
                "current_task_id": agent.current_task_id,
                "current_task_title": current_task_title,
                "last_active_at": agent.last_active_at,
            "rounds": agent.rounds,
            "parent_agent_id": getattr(agent, "parent_agent_id", None),
            "team_id": getattr(agent, "team_id", ""),
            "lifetime": getattr(agent, "lifetime", "persistent"),
            "lifecycle_status": getattr(agent, "lifecycle_status", "active"),
            "source_blueprint_id": getattr(agent, "source_blueprint_id", ""),
        }
        )
    tasks = [
        {
            "id": task.id,
            "title": task.title,
            "description": task.description if verbose else "",
            "assigned_agent_id": task.assigned_agent_id,
            "dependencies": task.dependencies,
            "status": task.status,
            "result": task.result if verbose else "",
            "result_data": task.result_data if verbose else {},
            "confidence": task.confidence,
            "error": task.error,
            "priority": getattr(task, "priority", 0),
            "expected_output": getattr(task, "expected_output", ""),
            "review_required": getattr(task, "review_required", False),
            "reviewer_agent_ids": getattr(task, "reviewer_agent_ids", []),
            "review_status": getattr(task, "review_status", ""),
            "fanout_group_id": getattr(task, "fanout_group_id", ""),
            "merge_task_id": getattr(task, "merge_task_id", ""),
            "source_blueprint_id": getattr(task, "source_blueprint_id", ""),
            "runtime_created": getattr(task, "runtime_created", False),
            "created_at": task.created_at,
            "updated_at": task.updated_at,
        }
        for task in session.tasks.values()
    ]
    threads = [
        {
            "id": thread.id,
            "topic": thread.topic,
            "participant_ids": thread.participant_ids,
            "status": thread.status,
            "summary": thread.summary,
            "message_count": len(thread.message_ids),
            "created_at": thread.created_at,
            "updated_at": thread.updated_at,
            "last_message_at": thread.last_message_at,
        }
        for thread in session.threads.values()
    ]
    messages = [
        {
            "id": message.id,
            "thread_id": message.thread_id,
            "sender_id": message.sender_id,
            "recipient_ids": message.recipient_ids,
            "content": message.content,
            "created_at": message.created_at,
            "read_by": message.read_by,
        }
        for message in session.messages.values()
    ] if verbose else []
    mailbox = [
        {
            "id": record.id,
            "sender_id": record.sender_id,
            "recipient_ids": record.recipient_ids,
            "content": record.content if verbose else "",
            "visibility": record.visibility,
            "kind": record.kind,
            "topic": getattr(record, "topic", ""),
            "event_type": getattr(record, "event_type", ""),
            "request_type": record.request_type,
            "status": record.status,
            "thread_id": record.thread_id,
            "message_id": record.message_id,
            "requires_reply": record.requires_reply,
            "priority": record.priority,
            "deadline_round": record.deadline_round,
            "correlation_id": record.correlation_id,
            "lineage_id": getattr(record, "lineage_id", None),
            "reply_to_envelope_id": record.reply_to_envelope_id,
            "caused_by_envelope_id": getattr(record, "caused_by_envelope_id", None),
            "expected_output_schema": record.expected_output_schema,
            "blocking_task_id": record.blocking_task_id,
            "escalate_after_rounds": record.escalate_after_rounds,
            "escalated_at": getattr(record, "escalated_at", None),
            "read_by": record.read_by,
            "replied_by": record.replied_by,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "delivered_at": record.delivered_at,
        }
        for record in session.mailbox.values()
    ] if verbose else []
    events = [
        {
            "id": event.id,
            "type": event.type,
            "message": event.message,
            "actor_id": event.actor_id,
            "data": event.data,
            "created_at": event.created_at,
        }
        for event in session.events[-80:]
    ]
    trace_spans = [
        {
            "id": span.id,
            "session_id": span.session_id,
            "run_id": span.run_id,
            "round_id": span.round_id,
            "parent_id": span.parent_id,
            "kind": span.kind,
            "name": span.name,
            "actor_id": span.actor_id,
            "status": span.status,
            "started_at": span.started_at,
            "ended_at": span.ended_at,
            "duration_ms": span.duration_ms,
            "input_ref": span.input_ref if verbose else "",
            "output_ref": span.output_ref if verbose else "",
            "summary": span.summary,
            "data": span.data if verbose else {},
            "error": span.error,
        }
        for span in getattr(session, "trace_spans", [])[-160:]
    ] if verbose else []
    run_metrics = [
        {
            "run_id": metric.run_id,
            "status": metric.status,
            "rounds": metric.rounds,
            "agent_calls": metric.agent_calls,
            "tool_calls": metric.tool_calls,
            "messages": metric.messages,
            "tasks_created": metric.tasks_created,
            "tasks_completed": metric.tasks_completed,
            "artifacts_created": metric.artifacts_created,
            "tokens_prompt": metric.tokens_prompt,
            "tokens_completion": metric.tokens_completion,
            "tokens_total": metric.tokens_total,
            "stop_reason": getattr(metric, "stop_reason", ""),
            "started_at": metric.started_at,
            "ended_at": metric.ended_at,
        }
        for metric in getattr(session, "run_metrics", [])[-20:]
    ]
    snapshot = {
        "id": session.id,
        "title": session.title,
        "goal": session.goal,
        "status": session.status,
        "workflow_mode": getattr(session, "workflow_mode", "adaptive_starter"),
        "architecture": active_architecture,
        "current_branch_id": current_branch_id,
        "current_branch": _branch_snapshot(current_branch, current=True) if current_branch is not None else {},
        "branches": [
            _branch_snapshot(branch, current=branch.id == current_branch_id)
            for branch in branches.values()
        ],
        "branch_results": [
            _dataclass_snapshot(getattr(branch, "branch_result", None))
            for branch in branches.values()
            if getattr(branch, "branch_result", None) is not None
        ],
        "session_final_result": _dataclass_snapshot(getattr(session, "session_final_result", None)),
        "stage_records": [
            {
                "id": record.id,
                "source_branch_id": record.source_branch_id,
                "target_branch_id": record.target_branch_id,
                "source_architecture": record.source_architecture,
                "target_architecture": record.target_architecture,
                "derivation_reason": record.derivation_reason,
                "source_summary": record.source_summary,
                "inherited_context_summary": record.inherited_context_summary,
                "artifact_refs": record.artifact_refs,
                "message_refs": record.message_refs if verbose else [],
                "decisions": record.decisions if verbose else [],
                "created_at": record.created_at,
            }
            for record in getattr(session, "stage_records", [])
        ],
        "current_focus_task": getattr(session, "current_focus_task", ""),
        "workspace_dir": getattr(session, "workspace_dir", ""),
        "artifacts": getattr(session, "artifacts", []),
        "shared_memory": getattr(session, "shared_memory", {}),
        "shared_summary": session.shared_summary,
        "final_draft": session.final_draft,
        "completion_decision": session.completion_decision,
        "budget": _budget_snapshot(session),
        "budget_state": _budget_snapshot(session),
        "stop_reason": getattr(session, "stop_reason", ""),
        "blueprint": getattr(session, "blueprint", {}) if verbose else {},
        "blueprint_metadata": _blueprint_metadata(getattr(session, "blueprint", {}) or {}),
        "blueprint_diagnostics": getattr(session, "blueprint_diagnostics", []),
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "rounds": session.rounds,
        "no_progress_rounds": getattr(session, "no_progress_rounds", 0),
        "agents": agents,
        "tasks": tasks,
        "threads": threads,
        "messages": messages,
        "mailbox": mailbox,
        "events": events,
        "trace_spans": trace_spans,
        "run_metrics": run_metrics,
        "scheduler_decisions": getattr(session, "scheduler_decisions", [])[-40:] if verbose else [],
        "swarm_plan": getattr(session, "swarm_plan", {}),
        "evaluation_results": (getattr(session, "runtime_state", {}) or {}).get("swarm_evaluations", []),
        "swarm_queues": build_swarm_scheduler_queues(session) if getattr(session, "workflow_mode", "") == "swarm" else {},
        "large_swarm_summary": build_cowork_large_swarm_summary(session) if getattr(session, "workflow_mode", "") == "swarm" else {},
    }
    if verbose:
        snapshot["architecture_topology"] = policy.topology(session, branch_id=current_branch_id).payload
        snapshot["organization_projection"] = policy.build_projection(session, branch_id=current_branch_id).payload
        snapshot["graph"] = build_cowork_graph(session)
        snapshot["trace"] = build_cowork_trace(session)
        snapshot["task_dag"] = build_cowork_task_dag(session)
        snapshot["artifact_index"] = build_cowork_artifact_index(session)
    return snapshot


def _cowork_service(app: web.Application):
    service = app.get("cowork_service")
    if service is not None:
        return service
    runtime = app.get("cowork_runtime")
    if runtime is not None:
        return getattr(runtime, "service", None)
    agent_loop = app.get("agent_loop")
    return getattr(agent_loop, "cowork_service", None) if agent_loop is not None else None


def _cowork_tool(app: web.Application):
    runtime = app.get("cowork_runtime")
    if runtime is not None:
        return getattr(runtime, "tool", runtime)
    tool = app.get("cowork_tool")
    if tool is not None:
        return tool
    agent_loop = app.get("agent_loop")
    tools = getattr(agent_loop, "tools", None) if agent_loop is not None else None
    return tools.get("cowork") if tools is not None else None


async def _json_body(request: web.Request) -> dict[str, Any] | web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json body"}, status=400)
    return payload if isinstance(payload, dict) else web.json_response({"error": "invalid json body"}, status=400)


async def handle_list_sessions(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    include_completed = request.query.get("include_completed", "false").lower() in {"1", "true", "yes"}
    sessions = service.list_sessions(include_completed=include_completed)
    return web.json_response({"items": [cowork_session_snapshot(session, verbose=False) for session in sessions]})


async def handle_validate_blueprint(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    blueprint = payload.get("blueprint", payload)
    result = service.validate_blueprint(blueprint if isinstance(blueprint, dict) else {})
    return web.json_response(result, status=200 if result.get("ok") else 400)


async def handle_preview_blueprint(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    blueprint = payload.get("blueprint", payload)
    result = service.preview_blueprint(blueprint if isinstance(blueprint, dict) else {})
    return web.json_response(result, status=200 if result.get("ok") else 400)


async def handle_create_session(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    if isinstance(payload.get("blueprint"), dict):
        session, diagnostics = service.create_session_from_blueprint(payload["blueprint"])
        if session is None:
            return web.json_response({"error": "blueprint validation failed", "diagnostics": diagnostics}, status=400)
        if payload.get("auto_run"):
            tool = _cowork_tool(request.app)
            if tool is not None:
                await tool.execute(
                    action="run",
                    session_id=session.id,
                    max_rounds=int(payload.get("max_rounds", payload.get("rounds", 1)) or 1),
                    max_agents=int(payload.get("max_agents", payload.get("parallel_width", 3)) or 3),
                    max_agent_calls=int(payload.get("max_agent_calls", 0) or 0) or None,
                    run_until_idle=bool(payload.get("run_until_idle", False)),
                    stop_on_blocker=bool(payload.get("stop_on_blocker", False)),
                )
                session = service.get_session(session.id) or session
        return web.json_response({"result": f"started {session.id}", "session": cowork_session_snapshot(session), "diagnostics": diagnostics})
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    goal = str(payload.get("goal") or "").strip()
    if not goal:
        return web.json_response({"error": "goal is required"}, status=400)
    existing_ids = {session.id for session in service.list_sessions(include_completed=True)}
    result = await tool.execute(
        action="start",
        goal=goal,
        workflow_mode=str(payload.get("architecture") or payload.get("workflow_mode") or payload.get("mode") or "adaptive_starter"),
        auto_run=bool(payload.get("auto_run", False)),
        max_rounds=int(payload.get("max_rounds", 1) or 1),
        max_agents=int(payload.get("max_agents", 3) or 3),
        max_agent_calls=int(payload.get("max_agent_calls", 0) or 0) or None,
        run_until_idle=bool(payload.get("run_until_idle", False)),
        stop_on_blocker=bool(payload.get("stop_on_blocker", False)),
    )
    sessions = service.list_sessions(include_completed=True)
    session = next((item for item in sessions if item.id not in existing_ids), None)
    if session is None and sessions:
        session = sessions[0]
    return web.json_response({"result": result, "session": cowork_session_snapshot(session) if session else None})


async def handle_get_session(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response({"session": cowork_session_snapshot(session)})


async def handle_get_session_graph(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    branch_id = getattr(session, "current_branch_id", "default")
    branch = getattr(session, "branches", {}).get(branch_id) if isinstance(getattr(session, "branches", {}), dict) else None
    policy = default_policy_registry().resolve(getattr(branch, "architecture", getattr(session, "workflow_mode", "adaptive_starter")))
    return web.json_response(
        {
            "graph": build_cowork_graph(session),
            "trace": build_cowork_trace(session),
            "architecture_topology": policy.topology(session, branch_id=branch_id).payload,
            "organization_projection": policy.build_projection(session, branch_id=branch_id).payload,
        }
    )


async def handle_list_branches(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    branches = service.list_branches(session)
    return web.json_response(
        {
            "current_branch_id": session.current_branch_id,
            "branches": [_branch_snapshot(branch, current=branch.id == session.current_branch_id) for branch in branches],
        }
    )


async def handle_select_branch(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.select_branch(session, request.match_info["branch_id"])
    if isinstance(result, str):
        return web.json_response({"error": result}, status=404)
    return web.json_response({"branch": _branch_snapshot(result, current=True), "session": cowork_session_snapshot(session)})


async def handle_derive_branch(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    branch = service.derive_branch(
        session,
        source_branch_id=str(payload.get("source_branch_id") or request.match_info.get("branch_id") or ""),
        target_architecture=str(payload.get("target_architecture") or payload.get("architecture") or "adaptive_starter"),
        reason=str(payload.get("reason") or payload.get("derivation_reason") or ""),
        title=str(payload.get("title") or ""),
        inherited_context_summary=str(payload.get("inherited_context_summary") or ""),
    )
    if isinstance(branch, str):
        return web.json_response({"error": branch}, status=400)
    return web.json_response({"branch": _branch_snapshot(branch, current=True), "session": cowork_session_snapshot(session)})


async def handle_select_final_result(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    branch_id = str(payload.get("branch_id") or request.match_info.get("branch_id") or "")
    result = service.select_session_final_result(
        session,
        branch_id,
        result_id=str(payload.get("result_id") or "") or None,
    )
    if isinstance(result, str):
        return web.json_response({"error": result}, status=400)
    return web.json_response({"session_final_result": _dataclass_snapshot(result), "session": cowork_session_snapshot(session)})


async def handle_merge_branch_results(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    branch_ids = payload.get("branch_ids")
    if not isinstance(branch_ids, list):
        return web.json_response({"error": "branch_ids must be a list"}, status=400)
    result = service.merge_branch_results(
        session,
        [str(branch_id) for branch_id in branch_ids],
        summary=str(payload.get("summary") or ""),
    )
    if isinstance(result, str):
        return web.json_response({"error": result}, status=400)
    return web.json_response({"session_final_result": _dataclass_snapshot(result), "session": cowork_session_snapshot(session)})


async def handle_get_session_trace(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response(
        {
            "trace": build_cowork_trace(session),
            "trace_spans": cowork_session_snapshot(session).get("trace_spans", []),
            "scheduler_decisions": getattr(session, "scheduler_decisions", [])[-80:],
            "run_metrics": cowork_session_snapshot(session).get("run_metrics", []),
        }
    )


async def handle_export_session_blueprint(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response({"blueprint": export_session_blueprint(session)})


async def handle_get_session_dag(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response({"task_dag": build_cowork_task_dag(session), "artifact_index": build_cowork_artifact_index(session)})


async def handle_get_session_artifacts(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    artifacts = build_cowork_artifact_index(session)
    return web.json_response({"artifact_index": artifacts, "large_swarm_summary": build_cowork_large_swarm_summary(session)})


async def handle_get_session_queues(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response({"swarm_queues": build_swarm_scheduler_queues(session)})


async def handle_delete_session(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    deleted = service.delete_session(request.match_info["session_id"])
    if not deleted:
        return web.json_response({"error": "cowork session not found"}, status=404)
    return web.json_response({"deleted": True})


async def handle_run_session(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    session_id = request.match_info["session_id"]
    result = await tool.execute(
        action="run",
        session_id=session_id,
        max_rounds=int(payload.get("max_rounds", 1) or 1),
        max_agents=int(payload.get("max_agents", payload.get("parallel_width", 3)) or 3),
        max_agent_calls=int(payload.get("max_agent_calls", 0) or 0) or None,
        run_until_idle=bool(payload.get("run_until_idle", False)),
        stop_on_blocker=bool(payload.get("stop_on_blocker", False)),
    )
    service = _cowork_service(request.app)
    session = service.get_session(session_id) if service else None
    return web.json_response({"result": result, "session": cowork_session_snapshot(session) if session else None})


async def handle_pause_session(request: web.Request) -> web.Response:
    return await _simple_tool_action(request, "pause")


async def handle_resume_session(request: web.Request) -> web.Response:
    return await _simple_tool_action(request, "resume")


async def _simple_tool_action(request: web.Request, action: str) -> web.Response:
    tool = _cowork_tool(request.app)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session_id = request.match_info["session_id"]
    result = await tool.execute(action=action, session_id=session_id)
    service = _cowork_service(request.app)
    session = service.get_session(session_id) if service else None
    return web.json_response({"result": result, "session": cowork_session_snapshot(session) if session else None})


async def handle_send_message(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    service = _cowork_service(request.app)
    if tool is None and service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    content = str(payload.get("content") or "").strip()
    if not content:
        return web.json_response({"error": "content is required"}, status=400)
    session_id = request.match_info["session_id"]
    session = service.get_session(session_id) if service else None
    if session is not None and getattr(session, "workflow_mode", "") == "swarm" and not payload.get("recipient_ids"):
        result = service.steer_swarm(session, content)
        status = 400 if result.startswith("Error:") else 200
        return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    result = await tool.execute(
        action="send_message",
        session_id=session_id,
        recipient_ids=payload.get("recipient_ids") or [],
        content=content,
        thread_id=str(payload.get("thread_id") or ""),
        topic=str(payload.get("topic") or ""),
        event_type=str(payload.get("event_type") or ""),
    )
    session = service.get_session(session_id) if service else None
    return web.json_response({"result": result, "session": cowork_session_snapshot(session) if session else None})


async def handle_add_task(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    title = str(payload.get("title") or "").strip()
    if not title:
        return web.json_response({"error": "title is required"}, status=400)
    session_id = request.match_info["session_id"]
    result = await tool.execute(
        action="add_task",
        session_id=session_id,
        title=title,
        description=str(payload.get("description") or ""),
        assigned_agent_id=str(payload.get("assigned_agent_id") or ""),
        dependencies=payload.get("dependencies") or [],
    )
    service = _cowork_service(request.app)
    session = service.get_session(session_id) if service else None
    return web.json_response({"result": result, "session": cowork_session_snapshot(session) if session else None})


async def handle_retry_task(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.retry_task(session, request.match_info["task_id"])
    status = 400 if result.startswith("Error:") else 200
    return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)


async def handle_assign_task(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.assign_task(session, request.match_info["task_id"], str(payload.get("assigned_agent_id") or ""))
    status = 400 if result.startswith("Error:") else 200
    return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)


async def handle_request_task_review(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.request_task_review(
        session,
        request.match_info["task_id"],
        reviewer_agent_id=str(payload.get("reviewer_agent_id") or "") if isinstance(payload, dict) else None,
    )
    if isinstance(result, str):
        return web.json_response({"error": result}, status=400)
    return web.json_response({"review_task_id": result.id, "session": cowork_session_snapshot(session)})


async def handle_retry_work_unit(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.retry_work_unit(session, request.match_info["work_unit_id"], reason=str(payload.get("reason") or ""))
    status = 400 if result.startswith("Error:") else 200
    return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)


async def handle_skip_work_unit(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.skip_work_unit(session, request.match_info["work_unit_id"], reason=str(payload.get("reason") or ""))
    status = 400 if result.startswith("Error:") else 200
    return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)


async def handle_cancel_work_unit(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    result = service.cancel_work_unit(session, request.match_info["work_unit_id"], reason=str(payload.get("reason") or ""))
    status = 400 if result.startswith("Error:") else 200
    return web.json_response({"result": result, "session": cowork_session_snapshot(session)}, status=status)


async def handle_update_session_budget(request: web.Request) -> web.Response:
    service = _cowork_service(request.app)
    if service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    session = service.get_session(request.match_info["session_id"])
    if session is None:
        return web.json_response({"error": "cowork session not found"}, status=404)
    budgets = payload.get("budgets", payload)
    if not isinstance(budgets, dict):
        return web.json_response({"error": "budgets must be an object"}, status=400)
    budget_state = service.set_session_budgets(session, budgets)
    return web.json_response({"budget": budget_state, "session": cowork_session_snapshot(session)})


async def handle_summary(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session_id = request.match_info["session_id"]
    result = await tool.execute(action="summary", session_id=session_id)
    return web.json_response({"summary": result})


def register_cowork_routes(app: web.Application) -> None:
    app.router.add_post("/api/cowork/blueprints/validate", handle_validate_blueprint)
    app.router.add_post("/api/cowork/blueprints/preview", handle_preview_blueprint)
    app.router.add_get("/api/cowork/sessions", handle_list_sessions)
    app.router.add_post("/api/cowork/sessions", handle_create_session)
    app.router.add_get("/api/cowork/sessions/{session_id}", handle_get_session)
    app.router.add_get("/api/cowork/sessions/{session_id}/graph", handle_get_session_graph)
    app.router.add_get("/api/cowork/sessions/{session_id}/branches", handle_list_branches)
    app.router.add_post("/api/cowork/sessions/{session_id}/branches/derive", handle_derive_branch)
    app.router.add_post("/api/cowork/sessions/{session_id}/branch-results/merge", handle_merge_branch_results)
    app.router.add_post("/api/cowork/sessions/{session_id}/branches/{branch_id}/select", handle_select_branch)
    app.router.add_post("/api/cowork/sessions/{session_id}/branches/{branch_id}/derive", handle_derive_branch)
    app.router.add_post("/api/cowork/sessions/{session_id}/branches/{branch_id}/result/select-final", handle_select_final_result)
    app.router.add_get("/api/cowork/sessions/{session_id}/trace", handle_get_session_trace)
    app.router.add_get("/api/cowork/sessions/{session_id}/blueprint", handle_export_session_blueprint)
    app.router.add_get("/api/cowork/sessions/{session_id}/dag", handle_get_session_dag)
    app.router.add_get("/api/cowork/sessions/{session_id}/artifacts", handle_get_session_artifacts)
    app.router.add_get("/api/cowork/sessions/{session_id}/queues", handle_get_session_queues)
    app.router.add_delete("/api/cowork/sessions/{session_id}", handle_delete_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/run", handle_run_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/pause", handle_pause_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/resume", handle_resume_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/messages", handle_send_message)
    app.router.add_post("/api/cowork/sessions/{session_id}/tasks", handle_add_task)
    app.router.add_post("/api/cowork/sessions/{session_id}/tasks/{task_id}/retry", handle_retry_task)
    app.router.add_post("/api/cowork/sessions/{session_id}/tasks/{task_id}/assign", handle_assign_task)
    app.router.add_post("/api/cowork/sessions/{session_id}/tasks/{task_id}/review", handle_request_task_review)
    app.router.add_post("/api/cowork/sessions/{session_id}/work-units/{work_unit_id}/retry", handle_retry_work_unit)
    app.router.add_post("/api/cowork/sessions/{session_id}/work-units/{work_unit_id}/skip", handle_skip_work_unit)
    app.router.add_post("/api/cowork/sessions/{session_id}/work-units/{work_unit_id}/cancel", handle_cancel_work_unit)
    app.router.add_post("/api/cowork/sessions/{session_id}/budget", handle_update_session_budget)
    app.router.add_get("/api/cowork/sessions/{session_id}/summary", handle_summary)
