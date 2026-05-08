"""Tools for dynamic multi-agent cowork sessions."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.agent.runner import AgentRunSpec, AgentRunner
from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from tinybot.agent.tools.registry import ToolRegistry
from tinybot.agent.tools.schema import ArraySchema, BooleanSchema, IntegerSchema, ObjectSchema, StringSchema, tool_parameters_schema
from tinybot.agent.tools.shell import ExecTool
from tinybot.cowork.service import CoworkService
from tinybot.cowork.types import CoworkAgent, CoworkSession
from tinybot.cowork.mailbox import CoworkEnvelope, CoworkMailbox
from tinybot.config.schema import ExecToolConfig
from tinybot.providers.base import LLMProvider


_AGENT_PROGRESS_STATUSES = {"idle", "waiting", "blocked", "done", "failed", "needs_review"}


_TEAM_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "submit_cowork_team",
            "description": "Create a dynamic cowork team and initial task assignments.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short session title"},
                    "agents": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Stable lowercase identifier"},
                                "name": {"type": "string"},
                                "role": {"type": "string"},
                                "goal": {"type": "string"},
                                "responsibilities": {"type": "array", "items": {"type": "string"}},
                                "tools": {"type": "array", "items": {"type": "string"}},
                                "communication_policy": {"type": "string"},
                                "context_policy": {"type": "string"},
                            },
                            "required": ["id", "name", "role", "goal", "responsibilities"],
                        },
                    },
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "assigned_agent_id": {"type": "string"},
                                "dependencies": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["id", "title", "description", "assigned_agent_id"],
                        },
                    },
                },
                "required": ["title", "agents", "tasks"],
            },
        },
    }
]


class CoworkTeamPlanner:
    """Ask the model for a task-specific team; fall back to a generic team."""

    def __init__(self, provider: LLMProvider, model: str, workspace: Path) -> None:
        self.provider = provider
        self.model = model
        self.workspace = workspace

    async def plan(self, goal: str) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
        prompt = f"""Design a dynamic cowork team for this user goal.

Goal:
{goal}

Create 3-6 agents. Do not hard-code software roles unless the goal is software work.
Each agent should have a distinct responsibility, private perspective, and clear reason to communicate with others.
Create initial tasks assigned to the agents. Keep tasks broad enough for one agent round and use dependencies only when necessary.
Workspace: {self.workspace}
"""
        try:
            response = await self.provider.chat(
                messages=[
                    {"role": "system", "content": "You design compact multi-agent cowork teams."},
                    {"role": "user", "content": prompt},
                ],
                tools=_TEAM_TOOL,
                model=self.model,
                max_tokens=4096,
                temperature=0.2,
                tool_choice={"type": "function", "function": {"name": "submit_cowork_team"}},
            )
            if response.tool_calls:
                args = response.tool_calls[0].arguments
                return (
                    str(args.get("title") or "Cowork Session"),
                    list(args.get("agents") or []),
                    list(args.get("tasks") or []),
                )
        except Exception as exc:
            logger.warning("Cowork team planning failed, using fallback team: {}", exc)
        agents = CoworkService.default_team(goal)
        tasks = [
            {
                "id": "1",
                "title": "Frame the goal",
                "description": "Clarify constraints, success criteria, and the best next workstreams.",
                "assigned_agent_id": agents[0]["id"],
                "dependencies": [],
            },
            {
                "id": "2",
                "title": "Gather useful context",
                "description": "Collect facts, options, files, or constraints that affect the goal.",
                "assigned_agent_id": agents[1]["id"],
                "dependencies": [],
            },
            {
                "id": "3",
                "title": "Check and synthesize",
                "description": "Evaluate the available information and prepare a concise recommendation.",
                "assigned_agent_id": agents[2]["id"],
                "dependencies": ["1", "2"],
            },
        ]
        return "Cowork Session", agents, tasks


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Internal cowork action",
            enum=["send_message", "create_thread", "complete_task", "add_task", "update_status"],
        ),
        recipient_ids=ArraySchema(StringSchema("Agent id"), description="Message recipients"),
        content=StringSchema("Message content or task result"),
        thread_id=StringSchema("Discussion thread id"),
        topic=StringSchema("Thread topic"),
        title=StringSchema("Task title"),
        assigned_agent_id=StringSchema("Agent id for new task"),
        dependencies=ArraySchema(StringSchema("Task id"), description="New task dependencies"),
        task_id=StringSchema("Task id to complete"),
        status=StringSchema("Status value"),
        extra_properties={"description": StringSchema("Task description")},
        requires_reply=BooleanSchema(description="Whether the recipient should reply", default=False),
        priority=IntegerSchema(description="Mailbox priority from 0 to 100", minimum=0, maximum=100),
        deadline_round=IntegerSchema(description="Round number or relative round budget when this envelope expires", minimum=1, maximum=100),
        correlation_id=StringSchema("Stable id that groups a question with replies"),
        reply_to_envelope_id=StringSchema("Envelope id this message replies to"),
        required=["action"],
    )
)
class CoworkInternalTool(Tool):
    """Agent-only tool for cowork messages, task updates, and status changes."""

    def __init__(self, service: CoworkService, session_id: str, sender_id: str, mailbox: CoworkMailbox | None = None):
        self.service = service
        self.session_id = session_id
        self.sender_id = sender_id
        self.mailbox = mailbox or CoworkMailbox(service)

    @property
    def name(self) -> str:
        return "cowork_internal"

    @property
    def description(self) -> str:
        return (
            "Coordinate with other cowork agents. Use it to send messages, create discussion threads, "
            "add follow-up tasks, update your status, or mark an assigned task complete."
        )

    async def execute(
        self,
        action: str,
        recipient_ids: list[str] | None = None,
        content: str = "",
        thread_id: str = "",
        topic: str = "",
        title: str = "",
        description: str = "",
        assigned_agent_id: str = "",
        dependencies: list[str] | None = None,
        task_id: str = "",
        status: str = "",
        requires_reply: bool = False,
        priority: int = 0,
        deadline_round: int | None = None,
        correlation_id: str = "",
        reply_to_envelope_id: str = "",
        **kwargs: Any,
    ) -> str:
        session = self.service.get_session(self.session_id)
        if not session:
            return f"Error: cowork session '{self.session_id}' not found"
        if self.sender_id not in session.agents:
            return f"Error: sender '{self.sender_id}' not found"

        if action == "create_thread":
            participants = [self.sender_id, *(recipient_ids or [])]
            thread = self.service.create_thread(session, topic or "Discussion", participants)
            return f"Created thread {thread.id}: {thread.topic}"

        if action == "send_message":
            if not content.strip():
                return "Error: content is required"
            message = self.mailbox.deliver(
                session,
                CoworkEnvelope(
                    sender_id=self.sender_id,
                    recipient_ids=recipient_ids or [],
                    content=content,
                    thread_id=thread_id or None,
                    visibility="direct" if recipient_ids else "group",
                    kind="question" if requires_reply else "message",
                    requires_reply=requires_reply,
                    priority=max(0, min(100, int(priority or 0))),
                    deadline_round=deadline_round,
                    correlation_id=correlation_id or None,
                    reply_to_envelope_id=reply_to_envelope_id or None,
                ),
            )
            return f"Sent message {message.id}"

        if action == "complete_task":
            if not task_id:
                agent = session.agents[self.sender_id]
                task_id = agent.current_task_id or ""
            if not task_id:
                return "Error: task_id is required"
            return self.service.complete_task(session, task_id, content or "Completed.", status=status or "completed")

        if action == "add_task":
            if not title.strip():
                return "Error: title is required"
            task = self.service.add_task(
                session,
                title=title,
                description=description or title,
                assigned_agent_id=assigned_agent_id or self.sender_id,
                dependencies=dependencies or [],
            )
            return f"Added task {task.id}: {task.title}"

        if action == "update_status":
            agent = session.agents[self.sender_id]
            if status in {"idle", "working", "waiting", "blocked", "done", "failed"}:
                agent.status = status  # type: ignore[assignment]
                self.service.add_event(session, "agent.status", f"{agent.name} set status to {status}", actor_id=agent.id)
                return f"Status updated to {status}"
            return "Error: invalid status"

        return f"Error: unknown action '{action}'"


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Cowork action",
            enum=["start", "status", "list", "send_message", "add_task", "run", "pause", "resume", "summary"],
        ),
        goal=StringSchema("Goal for a new cowork session"),
        session_id=StringSchema("Cowork session id"),
        recipient_ids=ArraySchema(StringSchema("Agent id"), description="Message recipients"),
        content=StringSchema("Message content"),
        thread_id=StringSchema("Discussion thread id"),
        title=StringSchema("Task title"),
        assigned_agent_id=StringSchema("Agent id"),
        dependencies=ArraySchema(StringSchema("Task id"), description="Task dependencies"),
        max_rounds=IntegerSchema(description="Maximum scheduling rounds", minimum=1, maximum=20),
        max_agents=IntegerSchema(description="Maximum agents to run per round", minimum=1, maximum=10),
        auto_run=BooleanSchema(description="Run one cowork round immediately after start", default=False),
        verbose=BooleanSchema(description="Show detailed status", default=False),
        extra_properties={"description": StringSchema("Task description")},
        required=["action"],
    )
)
class CoworkTool(Tool):
    """Manage dynamic cowork sessions with multiple stateful agents."""

    def __init__(
        self,
        service: CoworkService,
        provider: LLMProvider,
        workspace: Path,
        model: str,
        max_tool_result_chars: int,
        exec_config: ExecToolConfig | None = None,
        restrict_to_workspace: bool = False,
    ) -> None:
        self.service = service
        self.provider = provider
        self.workspace = workspace
        self.model = model
        self.max_tool_result_chars = max_tool_result_chars
        self.exec_config = exec_config or ExecToolConfig()
        self.restrict_to_workspace = restrict_to_workspace
        self.runner = AgentRunner(provider)
        self.planner = CoworkTeamPlanner(provider, model, workspace)
        self.mailbox = CoworkMailbox(service)

    @property
    def name(self) -> str:
        return "cowork"

    @property
    def description(self) -> str:
        return (
            "Create and run a dynamic multi-agent cowork session. Use this when a goal benefits from multiple "
            "specialized agents with private context, persistent state, inboxes, discussion threads, and task updates. "
            "Actions: start/status/list/send_message/add_task/run/pause/resume/summary."
        )

    async def execute(
        self,
        action: str,
        goal: str = "",
        session_id: str = "",
        recipient_ids: list[str] | None = None,
        content: str = "",
        thread_id: str = "",
        title: str = "",
        description: str = "",
        assigned_agent_id: str = "",
        dependencies: list[str] | None = None,
        max_rounds: int = 1,
        max_agents: int = 3,
        auto_run: bool = False,
        verbose: bool = False,
        **kwargs: Any,
    ) -> str:
        if action == "start":
            if not goal.strip():
                return "Error: goal is required for cowork start"
            planned_title, agents, tasks = await self.planner.plan(goal)
            session = self.service.create_session(goal=goal, title=planned_title, agents=agents, tasks=tasks)
            response = f"Cowork session started: {session.id}\n\n{self.service.format_status(session, verbose=True)}"
            if auto_run:
                run_result = await self._run_session(session, max_rounds=max_rounds, max_agents=max_agents)
                response += f"\n\n## Run Result\n{run_result}"
            return response

        if action == "list":
            sessions = self.service.list_sessions(include_completed=verbose)
            if not sessions:
                return "No cowork sessions."
            return "\n".join(f"- {s.id}: {s.title} [{s.status}] updated={s.updated_at}" for s in sessions)

        session = self._require_session(session_id)
        if isinstance(session, str):
            return session

        if action == "status":
            return self.service.format_status(session, verbose=verbose)

        if action == "summary":
            return self._format_summary(session)

        if action == "pause":
            if session.status == "completed":
                return f"Session {session.id} is already completed."
            session.status = "paused"
            self.service.add_event(session, "session.paused", "Cowork session paused")
            return f"Paused cowork session {session.id}."

        if action == "resume":
            if session.status == "completed":
                return f"Session {session.id} is already completed."
            session.status = "active"
            self.service.add_event(session, "session.resumed", "Cowork session resumed")
            return f"Resumed cowork session {session.id}."

        if action == "send_message":
            if not content.strip():
                return "Error: content is required"
            message = self.mailbox.deliver(
                session,
                CoworkEnvelope(
                    sender_id="user",
                    recipient_ids=recipient_ids or [],
                    content=content,
                    thread_id=thread_id or None,
                    visibility="direct" if recipient_ids else "group",
                ),
            )
            return f"Sent message {message.id}."

        if action == "add_task":
            if not title.strip():
                return "Error: title is required"
            task = self.service.add_task(
                session,
                title=title,
                description=description or title,
                assigned_agent_id=assigned_agent_id,
                dependencies=dependencies or [],
            )
            return f"Added task {task.id}: {task.title}"

        if action == "run":
            return await self._run_session(session, max_rounds=max_rounds, max_agents=max_agents)

        return f"Error: unknown action '{action}'"

    def _require_session(self, session_id: str) -> CoworkSession | str:
        if not session_id:
            return "Error: session_id is required"
        session = self.service.get_session(session_id)
        if not session:
            return f"Error: cowork session '{session_id}' not found"
        return session

    async def _run_session(self, session: CoworkSession, *, max_rounds: int, max_agents: int) -> str:
        if session.status == "paused":
            return f"Session {session.id} is paused."
        if session.status == "completed":
            return f"Session {session.id} is already completed."

        round_limit = min(max(1, int(max_rounds or 1)), 20)
        agent_limit = min(max(1, int(max_agents or 1)), 10)
        lines = []
        for round_index in range(round_limit):
            active = self.service.select_active_agents(session, limit=agent_limit)
            if not active:
                lines.append(f"Round {round_index + 1}: no ready agents.")
                self.service.add_event(session, "scheduler.idle", "Cowork scheduler stopped because no agents are ready")
                break
            names = ", ".join(agent.id for agent in active)
            lines.append(f"Round {round_index + 1}: running {names}")
            self.service.add_event(
                session,
                "scheduler.round",
                f"Cowork scheduler running round {round_index + 1} with {names}",
                data={"round": round_index + 1, "agent_ids": [agent.id for agent in active]},
            )
            await asyncio.gather(*(self._run_agent(session, agent) for agent in active))
            session = self.service.get_session(session.id) or session
            if session.status == "completed":
                lines.append("Session completed.")
                break
        else:
            self.service.add_event(session, "scheduler.budget_exhausted", "Cowork scheduler stopped at the run budget")
        lines.append("")
        lines.append(self.service.format_status(session, verbose=False))
        return "\n".join(lines)

    def _parse_agent_progress(self, content: str) -> dict[str, Any]:
        text = content.strip()
        parsed: Any = None
        for candidate in (text, self._extract_json_object(text)):
            if not candidate:
                continue
            try:
                parsed = json.loads(candidate)
                break
            except Exception:
                continue
        if not isinstance(parsed, dict):
            return {
                "status": "idle",
                "public_note": text or "Cowork round completed.",
                "private_note": text or "Cowork round completed.",
                "requests": [],
                "completed_task_ids": [],
                "new_task_suggestions": [],
            }
        status = str(parsed.get("status") or "idle").strip().lower()
        if status == "needs_review":
            status = "waiting"
        if status not in {"idle", "waiting", "blocked", "done", "failed"}:
            status = "idle"
        public_note = str(parsed.get("public_note") or parsed.get("note") or "").strip()
        private_note = str(parsed.get("private_note") or public_note or text).strip()
        return {
            "status": status,
            "public_note": public_note,
            "private_note": private_note,
            "requests": parsed.get("requests") if isinstance(parsed.get("requests"), list) else [],
            "completed_task_ids": parsed.get("completed_task_ids") if isinstance(parsed.get("completed_task_ids"), list) else [],
            "new_task_suggestions": parsed.get("new_task_suggestions") if isinstance(parsed.get("new_task_suggestions"), list) else [],
        }

    @staticmethod
    def _extract_json_object(text: str) -> str:
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            return fenced.group(1)
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return text[start : end + 1]
        return ""

    async def _run_agent(self, session: CoworkSession, agent: CoworkAgent) -> None:
        fresh = self.service.get_session(session.id)
        if fresh:
            session = fresh
            agent = session.agents[agent.id]

        unread = self.service.mark_messages_read(session, agent.id)
        ready_tasks = self.service.ready_tasks_for(session, agent.id)
        if ready_tasks:
            task = ready_tasks[0]
            task.status = "in_progress"
            agent.current_task_id = task.id
            agent.current_task_title = task.title
        else:
            task = None
            agent.current_task_id = None
            agent.current_task_title = None
        agent.status = "working"
        self.service.add_event(session, "agent.started", f"{agent.name} started a cowork round", actor_id=agent.id)

        tools = self._build_agent_tools(session.id, agent.id)
        messages = [
            {"role": "system", "content": self._build_agent_system_prompt(session, agent)},
            {"role": "user", "content": self._build_agent_work_prompt(session, agent, unread, task)},
        ]
        try:
            result = await self.runner.run(
                AgentRunSpec(
                    initial_messages=messages,
                    tools=tools,
                    model=self.model,
                    max_iterations=12,
                    max_tool_result_chars=self.max_tool_result_chars,
                    max_iterations_message="Cowork round ended because the tool iteration limit was reached.",
                    error_message=None,
                    fail_on_tool_error=False,
                )
            )
            content = result.final_content or result.error or "Cowork round completed without a final note."
            progress = self._parse_agent_progress(content)
            self._apply_agent_progress(session, agent, progress)
        except Exception as exc:
            logger.exception("Cowork agent '{}' failed", agent.id)
            self.service.fail_agent_run(session, agent.id, str(exc))

    def _apply_agent_progress(self, session: CoworkSession, agent: CoworkAgent, progress: dict[str, Any]) -> None:
        public_note = str(progress.get("public_note") or "").strip()
        private_note = str(progress.get("private_note") or public_note or "Cowork round completed.").strip()
        if public_note:
            self.mailbox.deliver(
                session,
                CoworkEnvelope(
                    sender_id=agent.id,
                    recipient_ids=["user"],
                    content=public_note,
                    visibility="user",
                    kind="result",
                    thread_id=next(iter(session.threads), None),
                ),
                save=False,
            )
        for request in progress.get("requests") or []:
            if not isinstance(request, dict):
                continue
            content = str(request.get("content") or "").strip()
            if not content:
                continue
            visibility = str(request.get("visibility") or "direct").strip()
            if visibility not in {"direct", "group", "user"}:
                visibility = "direct"
            self.mailbox.deliver(
                session,
                CoworkEnvelope(
                    sender_id=agent.id,
                    recipient_ids=[str(item) for item in request.get("recipient_ids") or []],
                    content=content,
                    visibility=visibility,  # type: ignore[arg-type]
                    kind="question" if request.get("requires_reply") else "message",
                    requires_reply=bool(request.get("requires_reply", False)),
                    priority=self._bounded_int(request.get("priority"), default=0, minimum=0, maximum=100),
                    deadline_round=self._deadline_round(session, request.get("deadline_round")),
                    correlation_id=str(request.get("correlation_id") or "") or None,
                    reply_to_envelope_id=str(request.get("reply_to_envelope_id") or "") or None,
                    thread_id=str(request.get("thread_id") or "") or None,
                ),
                save=False,
            )
        for task_id in progress.get("completed_task_ids") or []:
            task_id_text = str(task_id or "").strip()
            if task_id_text:
                self.service.complete_task(session, task_id_text, public_note or private_note, status="completed")
        for suggestion in progress.get("new_task_suggestions") or []:
            if not isinstance(suggestion, dict):
                continue
            title = str(suggestion.get("title") or "").strip()
            if title:
                self.service.add_task(
                    session,
                    title=title,
                    description=str(suggestion.get("description") or title),
                    assigned_agent_id=str(suggestion.get("assigned_agent_id") or agent.id),
                    dependencies=[str(item) for item in suggestion.get("dependencies") or []],
                    save=False,
                )
        self.service.update_agent_after_run(
            session,
            agent.id,
            private_note,
            status=str(progress.get("status") or "idle"),
            publish_note=False,
        )

    @staticmethod
    def _bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
        try:
            parsed = int(value)
        except Exception:
            parsed = default
        return min(max(parsed, minimum), maximum)

    @staticmethod
    def _deadline_round(session: CoworkSession, value: Any) -> int | None:
        try:
            parsed = int(value)
        except Exception:
            return None
        return parsed if parsed > session.rounds else session.rounds + parsed if parsed > 0 else None

    def _build_agent_tools(self, session_id: str, agent_id: str) -> ToolRegistry:
        registry = ToolRegistry()
        allowed_dir = self.workspace if self.restrict_to_workspace else None
        registry.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        registry.register(ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir))
        registry.register(WriteFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        registry.register(EditFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        if self.exec_config.enable:
            registry.register(
                ExecTool(
                    working_dir=str(self.workspace),
                    timeout=self.exec_config.timeout,
                    restrict_to_workspace=self.restrict_to_workspace,
                    path_append=self.exec_config.path_append,
                )
            )
        registry.register(CoworkInternalTool(self.service, session_id=session_id, sender_id=agent_id, mailbox=self.mailbox))
        return registry

    @staticmethod
    def _build_agent_system_prompt(session: CoworkSession, agent: CoworkAgent) -> str:
        responsibilities = "\n".join(f"- {item}" for item in agent.responsibilities) or "- Contribute to the shared goal."
        agents = "\n".join(f"- {a.id}: {a.name} / {a.role}" for a in session.agents.values())
        return f"""You are {agent.name}, a stateful cowork agent.

Role: {agent.role}
Goal: {agent.goal}

Responsibilities:
{responsibilities}

Communication policy:
{agent.communication_policy}

Context policy:
{agent.context_policy}

Shared cowork goal:
{session.goal}

Other agents:
{agents}

Use cowork_internal when you need to message another agent during the turn, create a discussion, add follow-up work, update status, or complete a task.
End your turn with a compact JSON object, not prose. The JSON should use:
status: idle | waiting | blocked | done | failed | needs_review
public_note: visible team-chat update for the user
private_note: concise private memory update
requests: optional list of mailbox messages, each with recipient_ids, content, visibility, requires_reply, priority, deadline_round, correlation_id
completed_task_ids: optional list of task ids you completed
new_task_suggestions: optional list of task objects with title, description, assigned_agent_id, dependencies
"""

    @staticmethod
    def _build_agent_work_prompt(session: CoworkSession, agent: CoworkAgent, unread: list[Any], task: Any) -> str:
        inbox_lines = []
        for message in unread:
            thread = session.threads.get(message.thread_id)
            topic = thread.topic if thread else message.thread_id
            inbox_lines.append(f"- [{message.id} / {topic}] from {message.sender_id}: {message.content}")
        pending_requests = [
            record
            for record in session.mailbox.values()
            if agent.id in record.recipient_ids
            and record.requires_reply
            and record.status in {"delivered", "read"}
        ]
        request_lines = [
            f"- [{record.id} / correlation {record.correlation_id or '-'} / priority {record.priority}] "
            f"from {record.sender_id}: {record.content}"
            for record in pending_requests[:8]
        ]
        task_text = "No ready assigned task."
        if task:
            task_text = f"{task.id}: {task.title}\n{task.description}"
        threads = session.open_threads_for(agent.id)
        thread_lines = [f"- {thread.id}: {thread.topic} ({len(thread.message_ids)} messages)" for thread in threads[:8]]
        completed = [
            f"- {t.id}: {t.title}: {t.result}"
            for t in session.tasks.values()
            if t.status == "completed" and t.result
        ][-5:]
        return f"""Run one cowork round.

Private context summary:
{agent.private_summary or "(none yet)"}

Current assigned task:
{task_text}

Unread inbox:
{chr(10).join(inbox_lines) if inbox_lines else "(none)"}

Pending reply requests:
{chr(10).join(request_lines) if request_lines else "(none)"}

Open discussions:
{chr(10).join(thread_lines) if thread_lines else "(none)"}

Recent completed task results:
{chr(10).join(completed) if completed else "(none)"}

Expected behavior:
1. Make concrete progress on your current task or inbox.
2. If another agent should help, call cowork_internal send_message or add_task.
3. If you answer a pending reply request, include the original correlation_id or reply_to_envelope_id in your request/message.
4. If you complete the current task, call cowork_internal complete_task with a concise result.
5. End with the structured JSON progress object described in your system instructions.
"""

    @staticmethod
    def _format_summary(session: CoworkSession) -> str:
        completed = [task for task in session.tasks.values() if task.status == "completed"]
        lines = [f"## {session.title} ({session.id})", f"Status: {session.status}", "", "### Completed Work"]
        if completed:
            for task in completed:
                lines.append(f"- {task.title}: {task.result or 'Completed'}")
        else:
            lines.append("- No completed tasks yet.")
        lines.append("")
        lines.append("### Agent Notes")
        for agent in session.agents.values():
            note = agent.private_summary[-500:] if agent.private_summary else "(no note yet)"
            lines.append(f"- {agent.name}: {note}")
        return "\n".join(lines)
