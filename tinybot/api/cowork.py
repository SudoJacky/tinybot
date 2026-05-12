"""Dedicated HTTP API routes for Cowork sessions."""

from __future__ import annotations

from typing import Any

from aiohttp import web

from tinybot.cowork.snapshot import build_cowork_graph, build_cowork_trace


def cowork_session_snapshot(session: Any, *, verbose: bool = True) -> dict[str, Any]:
    """Return a JSON-safe snapshot for a cowork session."""
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
                "status": agent.status,
                "private_summary": agent.private_summary if verbose else "",
                "inbox_count": len(agent.inbox),
                "current_task_id": agent.current_task_id,
                "current_task_title": current_task_title,
                "last_active_at": agent.last_active_at,
                "rounds": agent.rounds,
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
            "result": task.result,
            "result_data": task.result_data,
            "confidence": task.confidence,
            "error": task.error,
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
            "request_type": record.request_type,
            "status": record.status,
            "thread_id": record.thread_id,
            "message_id": record.message_id,
            "requires_reply": record.requires_reply,
            "priority": record.priority,
            "deadline_round": record.deadline_round,
            "correlation_id": record.correlation_id,
            "reply_to_envelope_id": record.reply_to_envelope_id,
            "expected_output_schema": record.expected_output_schema,
            "blocking_task_id": record.blocking_task_id,
            "escalate_after_rounds": record.escalate_after_rounds,
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
    snapshot = {
        "id": session.id,
        "title": session.title,
        "goal": session.goal,
        "status": session.status,
        "workflow_mode": getattr(session, "workflow_mode", "hybrid"),
        "current_focus_task": getattr(session, "current_focus_task", ""),
        "workspace_dir": getattr(session, "workspace_dir", ""),
        "artifacts": getattr(session, "artifacts", []),
        "shared_summary": session.shared_summary,
        "final_draft": session.final_draft,
        "completion_decision": session.completion_decision,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "rounds": session.rounds,
        "agents": agents,
        "tasks": tasks,
        "threads": threads,
        "messages": messages,
        "mailbox": mailbox,
        "events": events,
    }
    if verbose:
        snapshot["graph"] = build_cowork_graph(session)
        snapshot["trace"] = build_cowork_trace(session)
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


async def handle_create_session(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    service = _cowork_service(request.app)
    if tool is None or service is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    goal = str(payload.get("goal") or "").strip()
    if not goal:
        return web.json_response({"error": "goal is required"}, status=400)
    existing_ids = {session.id for session in service.list_sessions(include_completed=True)}
    result = await tool.execute(
        action="start",
        goal=goal,
        workflow_mode=str(payload.get("workflow_mode") or "hybrid"),
        auto_run=bool(payload.get("auto_run", False)),
        max_rounds=int(payload.get("max_rounds", 1) or 1),
        max_agents=int(payload.get("max_agents", 3) or 3),
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
    return web.json_response({"graph": build_cowork_graph(session), "trace": build_cowork_trace(session)})


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
        max_agents=int(payload.get("max_agents", 3) or 3),
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
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    payload = await _json_body(request)
    if isinstance(payload, web.Response):
        return payload
    content = str(payload.get("content") or "").strip()
    if not content:
        return web.json_response({"error": "content is required"}, status=400)
    session_id = request.match_info["session_id"]
    result = await tool.execute(
        action="send_message",
        session_id=session_id,
        recipient_ids=payload.get("recipient_ids") or [],
        content=content,
        thread_id=str(payload.get("thread_id") or ""),
    )
    service = _cowork_service(request.app)
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


async def handle_summary(request: web.Request) -> web.Response:
    tool = _cowork_tool(request.app)
    if tool is None:
        return web.json_response({"error": "cowork is not available"}, status=503)
    session_id = request.match_info["session_id"]
    result = await tool.execute(action="summary", session_id=session_id)
    return web.json_response({"summary": result})


def register_cowork_routes(app: web.Application) -> None:
    app.router.add_get("/api/cowork/sessions", handle_list_sessions)
    app.router.add_post("/api/cowork/sessions", handle_create_session)
    app.router.add_get("/api/cowork/sessions/{session_id}", handle_get_session)
    app.router.add_get("/api/cowork/sessions/{session_id}/graph", handle_get_session_graph)
    app.router.add_delete("/api/cowork/sessions/{session_id}", handle_delete_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/run", handle_run_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/pause", handle_pause_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/resume", handle_resume_session)
    app.router.add_post("/api/cowork/sessions/{session_id}/messages", handle_send_message)
    app.router.add_post("/api/cowork/sessions/{session_id}/tasks", handle_add_task)
    app.router.add_get("/api/cowork/sessions/{session_id}/summary", handle_summary)
