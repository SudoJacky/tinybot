"""Task management service for automatic task decomposition and execution."""

from __future__ import annotations

import asyncio
import json
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from collections.abc import Callable, Coroutine

from loguru import logger

from tinybot.task.types import SubTask, TaskPlan, TaskStore
from tinybot.utils.prompt_templates import render_template

if TYPE_CHECKING:
    from tinybot.agent.experience import ExperienceStore
    from tinybot.providers.base import LLMProvider


_DECOMPOSE_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "submit_plan",
            "description": "Submit the decomposed task plan with subtasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Overall task title",
                    },
                    "subtasks": {
                        "type": "array",
                        "description": "List of subtasks",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Short unique ID (e.g., '1', '2', 'a', 'b')",
                                },
                                "title": {
                                    "type": "string",
                                    "description": "Short title (< 30 chars)",
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Detailed execution instructions",
                                },
                                "dependencies": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "IDs of subtasks this depends on",
                                },
                                "parallel_safe": {
                                    "type": "boolean",
                                    "description": "Whether this can run concurrently with other subtasks",
                                },
                            },
                            "required": ["id", "title", "description", "dependencies"],
                        },
                    },
                },
                "required": ["title", "subtasks"],
            },
        },
    }
]

# Maximum context length for each subtask result (in chars)
_MAX_CONTEXT_PER_SUBTASK = 1500
# Maximum total context length passed to subsequent subtasks
_MAX_TOTAL_CONTEXT = 8000


class TaskManager:
    """Manages task plans: creation, execution, and persistence."""

    def __init__(
        self,
        workspace: Path,
        provider: LLMProvider,
        model: str,
        on_execute: Callable[[SubTask, TaskPlan], Coroutine[Any, Any, str]] | None = None,
        on_progress: Callable[[dict[str, Any]], Coroutine[Any, Any, None]] | None = None,
        experience_store: ExperienceStore | None = None,
    ):
        self.workspace = workspace
        self.plans_dir = workspace / "plans"
        self.provider = provider
        self.model = model
        self.on_execute = on_execute
        self.on_progress = on_progress
        self.experience_store = experience_store
        self._store: TaskStore | None = None
        self._execution_tasks: dict[str, asyncio.Task] = {}  # plan_id -> execution task
        self._cancel_events: dict[str, asyncio.Event] = {}  # plan_id -> cancel signal

    @property
    def store_path(self) -> Path:
        return self.plans_dir / "store.json"

    def _ensure_plans_dir(self) -> None:
        self.plans_dir.mkdir(parents=True, exist_ok=True)

    def _load_store(self) -> TaskStore:
        """Load the task store from disk."""
        if self._store is not None:
            return self._store

        if self.store_path.exists():
            try:
                data = json.loads(self.store_path.read_text(encoding="utf-8"))
                plans = []
                for p in data.get("plans", []):
                    subtasks = [
                        SubTask(
                            id=s["id"],
                            title=s["title"],
                            description=s["description"],
                            status=s.get("status", "pending"),
                            dependencies=s.get("dependencies", []),
                            parallel_safe=s.get("parallel_safe", True),
                            result=s.get("result"),
                            error=s.get("error"),
                            started_at=datetime.fromisoformat(s["started_at"]) if s.get("started_at") else None,
                            completed_at=datetime.fromisoformat(s["completed_at"]) if s.get("completed_at") else None,
                            retry_count=s.get("retry_count", 0),
                            max_retries=s.get("max_retries", 2),
                        )
                        for s in p.get("subtasks", [])
                    ]
                    plans.append(TaskPlan(
                        id=p["id"],
                        title=p["title"],
                        original_request=p["original_request"],
                        subtasks=subtasks,
                        created_at=datetime.fromisoformat(p["created_at"]),
                        updated_at=datetime.fromisoformat(p["updated_at"]),
                        status=p.get("status", "planning"),
                        current_subtask_ids=p.get("current_subtask_ids", []),
                        context=p.get("context", {}),
                    ))
                self._store = TaskStore(version=data.get("version", 1), plans=plans)
            except Exception as e:
                logger.warning("Failed to load task store: {}", e)
                self._store = TaskStore()
        else:
            self._store = TaskStore()

        return self._store

    def _save_store(self) -> None:
        """Save the task store to disk with atomic write."""
        if self._store is None:
            return

        self._ensure_plans_dir()

        data = {
            "version": self._store.version,
            "plans": [
                {
                    "id": p.id,
                    "title": p.title,
                    "original_request": p.original_request,
                    "subtasks": [
                        {
                            "id": s.id,
                            "title": s.title,
                            "description": s.description,
                            "status": s.status,
                            "dependencies": s.dependencies,
                            "parallel_safe": s.parallel_safe,
                            "result": s.result,
                            "error": s.error,
                            "started_at": s.started_at.isoformat() if s.started_at else None,
                            "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                            "retry_count": s.retry_count,
                            "max_retries": s.max_retries,
                        }
                        for s in p.subtasks
                    ],
                    "created_at": p.created_at.isoformat(),
                    "updated_at": p.updated_at.isoformat(),
                    "status": p.status,
                    "current_subtask_ids": p.current_subtask_ids,
                    "context": p.context,
                }
                for p in self._store.plans
            ],
        }

        # Atomic write: write to temp file, then rename
        fd, temp_path = tempfile.mkstemp(dir=self.plans_dir, suffix=".json")
        try:
            with open(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            Path(temp_path).replace(self.store_path)
        except Exception:
            Path(temp_path).unlink(missing_ok=True)
            raise

    def _save_plan(self, plan: TaskPlan) -> None:
        """Save a single plan to disk."""
        plan.updated_at = datetime.now()
        self._save_store()

    # ========== DAG Validation ==========

    def _validate_dag(self, plan: TaskPlan) -> list[str]:
        """Validate DAG: check for cycles and missing dependencies.

        Returns list of error messages (empty if valid).
        """
        errors = []

        # Build adjacency list
        graph: dict[str, list[str]] = defaultdict(list)
        all_ids = {s.id for s in plan.subtasks}

        for subtask in plan.subtasks:
            for dep_id in subtask.dependencies:
                if dep_id not in all_ids:
                    errors.append(f"Subtask '{subtask.id}' depends on non-existent '{dep_id}'")
                else:
                    graph[dep_id].append(subtask.id)

        # Cycle detection using DFS
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {s.id: WHITE for s in plan.subtasks}

        def dfs(node: str, path: list[str]) -> bool:
            color[node] = GRAY
            path.append(node)
            for neighbor in graph.get(node, []):
                if color[neighbor] == GRAY:
                    cycle_start = path.index(neighbor)
                    cycle = path[cycle_start:] + [neighbor]
                    errors.append(f"Cycle detected: {' -> '.join(cycle)}")
                    return True
                if color[neighbor] == WHITE:
                    if dfs(neighbor, path):
                        return True
            path.pop()
            color[node] = BLACK
            return False

        for subtask in plan.subtasks:
            if color[subtask.id] == WHITE:
                dfs(subtask.id, [])

        return errors

    # ========== Core Methods ==========

    async def create_plan(
        self,
        request: str,
        channel: str,
        chat_id: str,
    ) -> TaskPlan:
        """Create a task plan by decomposing the user request via LLM."""
        plan_id = str(uuid.uuid4())[:8]

        # Build context for decomposition
        context_info = f"Workspace: {self.workspace}\nRequest: {request}"
        planning_strategy = self._build_planning_strategy(request)
        if planning_strategy:
            context_info = planning_strategy + "\n\n" + context_info

        # Call LLM to decompose the task
        response = await self.provider.chat_with_retry(
            messages=[
                {"role": "system", "content": render_template("task/decompose.md")},
                {"role": "user", "content": context_info},
            ],
            tools=_DECOMPOSE_TOOL,
            model=self.model,
        )

        # Extract the plan from the tool call
        subtasks: list[SubTask] = []
        title = request[:50]

        if response.has_tool_calls:
            args = response.tool_calls[0].arguments
            title = args.get("title", title)
            for st in args.get("subtasks", []):
                subtasks.append(SubTask(
                    id=st.get("id", str(uuid.uuid4())[:4]),
                    title=st.get("title", "Untitled"),
                    description=st.get("description", ""),
                    dependencies=st.get("dependencies", []),
                    parallel_safe=st.get("parallel_safe", True),
                ))

        # If no subtasks were created, create a single one from the request
        if not subtasks:
            subtasks.append(SubTask(
                id="1",
                title=request[:30],
                description=request,
                dependencies=[],
            ))

        # Create the plan
        plan = TaskPlan(
            id=plan_id,
            title=title,
            original_request=request,
            subtasks=subtasks,
            status="planning",
            context={
                "channel": channel,
                "chat_id": chat_id,
                "session_key": f"{channel}:{chat_id}",
            },
        )

        # Validate DAG
        dag_errors = self._validate_dag(plan)
        if dag_errors:
            plan.context["dag_errors"] = dag_errors
            logger.warning("DAG validation errors for plan {}: {}", plan.id, dag_errors)

        # Save to store
        store = self._load_store()
        store.add_plan(plan)
        self._save_plan(plan)

        logger.info("Created task plan '{}' ({})", plan.title, plan.id)
        return plan

    def _build_planning_strategy(self, request: str, limit: int = 2) -> str:
        """Select explicit before-plan workflow strategies for task decomposition."""
        if self.experience_store is None:
            return ""

        workflows = self.experience_store.search_workflows(
            query=request,
            limit=limit,
            min_confidence=0.55,
        )
        if not workflows:
            return ""

        lines = [
            "[PLANNING STRATEGY]",
            "Prefer the following reusable workflows when decomposing the request.",
            "",
        ]
        for exp in workflows:
            conf = int(exp.confidence * 100)
            lines.append(
                f"- [{exp.id}] {exp.context_summary or exp.tool_name or 'workflow'} ({conf}% confidence)"
            )
            if exp.action_hint:
                lines.append(f"  Primary action: {exp.action_hint}")
            if exp.applicability:
                lines.append(f"  Applies when: {exp.applicability}")
            if exp.resolution:
                lines.append(f"  Reference: {exp.resolution}")
            lines.append("")
            try:
                self.experience_store.mark_used(exp.id)
            except Exception:
                logger.warning("TaskManager: failed to mark planning strategy as used")

        return "\n".join(lines).strip()

    async def execute_plan(
        self,
        plan_id: str,
        parallel: bool = True,
    ) -> str:
        """Execute a task plan.

        Args:
            plan_id: The plan ID to execute
            parallel: Whether to execute parallel-safe subtasks concurrently

        Returns:
            Final result string
        """
        plan = self.get_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        if plan.status == "completed":
            return "Plan already completed."

        if plan.status == "executing":
            return "Plan is already executing."

        # Check for DAG errors
        dag_errors = plan.context.get("dag_errors", [])
        if dag_errors:
            return f"Cannot execute plan due to DAG errors: {dag_errors}"

        plan.status = "executing"
        plan.current_subtask_ids = []
        self._save_plan(plan)

        # Create cancel event for this execution
        cancel_event = asyncio.Event()
        self._cancel_events[plan_id] = cancel_event

        results: list[str] = []

        try:
            while plan.status == "executing":
                # Check for cancellation
                if cancel_event.is_set():
                    plan.status = "paused"
                    self._save_plan(plan)
                    return "Execution paused by user."

                # Find all executable subtasks
                executable = [s for s in plan.subtasks if self._can_execute(s, plan)]

                if not executable:
                    # Check if all subtasks are done
                    if all(s.status in ("completed", "skipped") for s in plan.subtasks):
                        plan.status = "completed"
                        self._save_plan(plan)
                        break

                    # Check for blocked state
                    pending = [s for s in plan.subtasks if s.status == "pending"]
                    if pending:
                        plan.status = "failed"
                        plan.context["error"] = "Tasks blocked by unresolvable dependencies"
                        self._save_plan(plan)
                        return f"Error: Tasks blocked by dependencies. Pending: {[s.id for s in pending]}"

                    plan.status = "completed"
                    self._save_plan(plan)
                    break

                # Separate parallel-safe and non-safe subtasks
                parallel_safe = [s for s in executable if s.parallel_safe]
                sequential_only = [s for s in executable if not s.parallel_safe]

                # Execute: prioritize sequential (they might have side effects)
                # Then execute parallel-safe ones together
                if sequential_only:
                    # Execute sequentially with retry logic
                    for subtask in sequential_only:
                        if cancel_event.is_set():
                            break

                        result = await self._execute_subtask_with_retry(subtask, plan, cancel_event)
                        if result is None:
                            # Retry exhausted or cancelled
                            if cancel_event.is_set():
                                break
                            plan.status = "paused"
                            self._save_plan(plan)
                            return f"Subtask '{subtask.title}' failed after {subtask.max_retries} retries.\nPlan paused."
                        results.append(f"[{subtask.title}] {result}")
                        self._save_plan(plan)

                elif parallel_safe and parallel and len(parallel_safe) > 1:
                    # Execute parallel-safe subtasks concurrently with retry
                    result_map = await self._execute_parallel_with_retry(parallel_safe, plan, cancel_event)
                    for subtask in parallel_safe:
                        if subtask.id in result_map:
                            results.append(f"[{subtask.title}] {result_map[subtask.id]}")
                    self._save_plan(plan)

                elif executable:
                    # Single subtask or parallel disabled
                    subtask = executable[0]
                    result = await self._execute_subtask_with_retry(subtask, plan, cancel_event)
                    if result is None:
                        if cancel_event.is_set():
                            break
                        plan.status = "paused"
                        self._save_plan(plan)
                        return f"Subtask '{subtask.title}' failed after {subtask.max_retries} retries.\nPlan paused."
                    results.append(f"[{subtask.title}] {result}")
                    self._save_plan(plan)

        except asyncio.CancelledError:
            plan.status = "paused"
            self._save_plan(plan)
            return "Execution cancelled."

        finally:
            self._cancel_events.pop(plan_id, None)

        # Build final result
        final_result = f"Task '{plan.title}' completed.\n\n"
        final_result += "\n".join(results)
        return final_result

    async def _execute_subtask_with_retry(
        self,
        subtask: SubTask,
        plan: TaskPlan,
        cancel_event: asyncio.Event,
    ) -> str | None:
        """Execute a subtask with retry logic. Returns None if all retries exhausted."""
        while subtask.retry_count <= subtask.max_retries:
            if cancel_event.is_set():
                return None

            try:
                result = await self._execute_subtask(subtask, plan)
                return result
            except Exception as e:
                subtask.retry_count += 1
                subtask.error = str(e)
                logger.error("Subtask {} failed (attempt {}): {}", subtask.id, subtask.retry_count, e)

                if subtask.retry_count <= subtask.max_retries:
                    subtask.status = "pending"
                    await asyncio.sleep(1)  # Brief delay before retry
                else:
                    subtask.status = "failed"
                    return None

        return None

    async def _execute_parallel_with_retry(
        self,
        subtasks: list[SubTask],
        plan: TaskPlan,
        cancel_event: asyncio.Event,
    ) -> dict[str, str]:
        """Execute multiple subtasks in parallel with individual retry logic."""
        results: dict[str, str] = {}

        # Track which subtasks need retry
        pending = list(subtasks)

        while pending and not cancel_event.is_set():
            # Update current subtask IDs
            plan.current_subtask_ids = [s.id for s in pending if s.status == "in_progress"]
            self._save_plan(plan)

            # Execute all pending subtasks
            tasks = {
                s.id: asyncio.create_task(self._execute_subtask(s, plan))
                for s in pending if s.status == "pending" or s.status == "in_progress"
            }

            if not tasks:
                break

            # Wait for all to complete
            done_results = await asyncio.gather(*tasks.values(), return_exceptions=True)

            # Process results
            still_pending = []
            for subtask, result in zip([s for s in pending if s.id in tasks], done_results, strict=False):
                if cancel_event.is_set():
                    break

                if isinstance(result, Exception):
                    subtask.error = str(result)
                    subtask.retry_count += 1
                    logger.error("Subtask {} failed (attempt {}): {}", subtask.id, subtask.retry_count, result)

                    if subtask.retry_count <= subtask.max_retries:
                        subtask.status = "pending"
                        still_pending.append(subtask)
                    else:
                        subtask.status = "failed"
                        results[subtask.id] = f"Failed after {subtask.max_retries} retries"
                else:
                    results[subtask.id] = result or "Completed"

            pending = still_pending
            if pending:
                await asyncio.sleep(1)  # Brief delay before retry batch

        return results

    async def _execute_subtask(
        self,
        subtask: SubTask,
        plan: TaskPlan,
    ) -> str:
        """Execute a single subtask."""
        subtask.status = "in_progress"
        subtask.started_at = datetime.now()
        self._write_progress_file(plan)
        await self._report_progress(plan, subtask, "started")

        logger.info("Executing subtask '{}' ({})", subtask.title, subtask.id)

        try:
            if self.on_execute:
                result = await self.on_execute(subtask, plan)
            else:
                result = f"Executed: {subtask.description}"

            subtask.status = "completed"
            subtask.completed_at = datetime.now()
            subtask.result = self._truncate_result(result)
            self._write_progress_file(plan)
            await self._report_progress(plan, subtask, "completed")
            return result

        except Exception as e:
            subtask.status = "failed"
            subtask.error = str(e)
            self._write_progress_file(plan)
            await self._report_progress(plan, subtask, "failed")
            raise

    def _truncate_result(self, result: str | None) -> str | None:
        """Truncate result to prevent context explosion."""
        if not result:
            return None
        if len(result) <= _MAX_CONTEXT_PER_SUBTASK:
            return result
        return result[:_MAX_CONTEXT_PER_SUBTASK] + "\n...[truncated]"

    def _build_context_for_subtask(self, plan: TaskPlan, subtask: SubTask) -> str:
        """Build condensed context from completed subtasks."""
        parts = []

        # Get dependencies' results first
        dep_results = []
        for dep_id in subtask.dependencies:
            dep = plan.get_subtask(dep_id)
            if dep and dep.result:
                dep_results.append(f"**{dep.title}:** {dep.result}")

        if dep_results:
            parts.append("## Dependencies' Results")
            parts.extend(dep_results)

        # Add other completed results (truncated)
        other_results = []
        total_len = sum(len(r) for r in dep_results)

        for s in plan.subtasks:
            if s.status == "completed" and s.id not in subtask.dependencies and s.result:
                snippet = s.result[:500]
                if total_len + len(snippet) < _MAX_TOTAL_CONTEXT:
                    other_results.append(f"- {s.title}: {snippet}")
                    total_len += len(snippet)

        if other_results:
            parts.append("\n## Other Completed Steps")
            parts.extend(other_results[:5])  # Limit to 5 other results

        return "\n".join(parts) if parts else ""

    async def _report_progress(
        self,
        plan: TaskPlan,
        subtask: SubTask,
        event: str,
    ) -> None:
        """Report progress to callback if configured."""
        if self.on_progress is None:
            return

        progress = self.get_progress(plan.id)
        if progress is None:
            return

        await self.on_progress({
            "event": event,
            "plan_id": plan.id,
            "plan_title": plan.title,
            "plan_status": plan.status,
            "subtask_id": subtask.id,
            "subtask_title": subtask.title,
            "subtask_status": subtask.status,
            "progress": progress,
            "result": subtask.result,
            "error": subtask.error,
            "subtasks": [
                {
                    "id": s.id,
                    "title": s.title,
                    "status": s.status,
                    "dependencies": s.dependencies,
                    "parallel_safe": s.parallel_safe,
                    "result": s.result,
                    "error": s.error,
                }
                for s in plan.subtasks
            ],
        })

    def _write_progress_file(self, plan: TaskPlan) -> None:
        """Write progress to a file for external monitoring."""
        self._ensure_plans_dir()
        progress_file = self.plans_dir / "progress.md"

        progress = self.get_progress(plan.id)
        if progress is None:
            return

        lines = [
            f"# Task Progress: {plan.title}",
            "",
            f"**Status:** {plan.status}",
            f"**Plan ID:** {plan.id}",
            f"**Progress:** {progress['completed']}/{progress['total']} completed",
            "",
            "## Subtasks",
            "",
        ]

        status_icons = {
            "pending": "⏳",
            "in_progress": "▶️",
            "completed": "✅",
            "failed": "❌",
            "skipped": "⏭️",
        }

        for subtask in plan.subtasks:
            icon = status_icons.get(subtask.status, "❓")
            lines.append(f"- {icon} **{subtask.id}:** {subtask.title}")
            if subtask.status == "in_progress":
                lines.append("  - *Currently executing...*")
            if subtask.result:
                lines.append(f"  - Result: {subtask.result[:200]}...")
            if subtask.error:
                lines.append(f"  - Error: {subtask.error}")
            if subtask.dependencies:
                lines.append(f"  - Dependencies: {', '.join(subtask.dependencies)}")

        lines.append("")
        lines.append("---")
        lines.append(f"Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        progress_file.write_text("\n".join(lines), encoding="utf-8")

    def _can_execute(self, subtask: SubTask, plan: TaskPlan) -> bool:
        """Check if a subtask can be executed (dependencies satisfied)."""
        if subtask.status not in ("pending",):
            return False

        for dep_id in subtask.dependencies:
            dep = plan.get_subtask(dep_id)
            if dep is None or dep.status != "completed":
                return False

        return True

    def update_subtask_status(
        self,
        plan_id: str,
        subtask_id: str,
        status: str,
        result: str | None = None,
        error: str | None = None,
    ) -> SubTask | None:
        """Update a subtask's status."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None

        subtask = plan.get_subtask(subtask_id)
        if subtask is None:
            return None

        subtask.status = status  # type: ignore
        if result is not None:
            subtask.result = self._truncate_result(result)
        if error is not None:
            subtask.error = error
        if status == "in_progress":
            subtask.started_at = datetime.now()
        elif status in ("completed", "failed", "skipped"):
            subtask.completed_at = datetime.now()

        self._save_plan(plan)
        return subtask

    # ========== Dynamic Re-planning ==========

    def add_subtask(
        self,
        plan_id: str,
        title: str,
        description: str,
        dependencies: list[str] | None = None,
        parallel_safe: bool = True,
        after: str | None = None,  # Insert after this subtask ID
    ) -> SubTask | None:
        """Add a new subtask to an existing plan."""
        plan = self.get_plan(plan_id)
        if plan is None or plan.status == "completed":
            return None

        new_id = str(uuid.uuid4())[:4]
        new_subtask = SubTask(
            id=new_id,
            title=title,
            description=description,
            dependencies=dependencies or [],
            parallel_safe=parallel_safe,
        )

        if after:
            # Insert after specified subtask
            for i, s in enumerate(plan.subtasks):
                if s.id == after:
                    plan.subtasks.insert(i + 1, new_subtask)
                    break
            else:
                plan.subtasks.append(new_subtask)
        else:
            plan.subtasks.append(new_subtask)

        # Re-validate DAG
        plan.context["dag_errors"] = self._validate_dag(plan)
        self._save_plan(plan)
        return new_subtask

    def remove_subtask(self, plan_id: str, subtask_id: str) -> bool:
        """Remove a subtask (only if pending)."""
        plan = self.get_plan(plan_id)
        if plan is None or plan.status == "completed":
            return False

        subtask = plan.get_subtask(subtask_id)
        if subtask is None or subtask.status != "pending":
            return False

        # Remove and update dependencies
        plan.subtasks = [s for s in plan.subtasks if s.id != subtask_id]
        for s in plan.subtasks:
            s.dependencies = [d for d in s.dependencies if d != subtask_id]

        plan.context["dag_errors"] = self._validate_dag(plan)
        self._save_plan(plan)
        return True

    # ========== Query Methods ==========

    def get_plan(self, plan_id: str) -> TaskPlan | None:
        """Get a plan by ID."""
        store = self._load_store()
        return store.get_plan(plan_id)

    def list_plans(self, include_completed: bool = False) -> list[TaskPlan]:
        """List all plans, optionally including completed ones."""
        store = self._load_store()
        if include_completed:
            return list(store.plans)
        return [p for p in store.plans if p.status != "completed"]

    def get_progress(self, plan_id: str) -> dict[str, Any] | None:
        """Get progress summary for a plan."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None

        in_progress = [s for s in plan.subtasks if s.status == "in_progress"]
        current_titles = [s.title for s in in_progress]

        # Find next executable subtask
        next_executable = None
        for s in plan.subtasks:
            if s.status == "pending" and self._can_execute(s, plan):
                next_executable = s
                break

        return {
            "plan_id": plan.id,
            "title": plan.title,
            "status": plan.status,
            "total": len(plan.subtasks),
            "completed": plan.count_by_status("completed"),
            "in_progress": plan.count_by_status("in_progress"),
            "pending": plan.count_by_status("pending"),
            "failed": plan.count_by_status("failed"),
            "skipped": plan.count_by_status("skipped"),
            "current": current_titles[0] if current_titles else None,
            "current_all": current_titles,
            "next": next_executable.title if next_executable else None,
        }

    def get_executable_subtasks(self, plan: TaskPlan) -> list[SubTask]:
        """Get all subtasks that can be executed now."""
        return [s for s in plan.subtasks if self._can_execute(s, plan)]

    def get_ready_subtasks(self, plan_id: str) -> list[SubTask]:
        """Get all ready (dependency-satisfied, pending) subtasks for a plan.

        This is used for non-blocking execution: spawn SubAgents for these tasks.
        """
        plan = self.get_plan(plan_id)
        if plan is None:
            return []
        return [s for s in plan.subtasks if self._can_execute(s, plan)]

    def can_execute(self, subtask: SubTask, plan: TaskPlan) -> bool:
        """Public method to check if a subtask can be executed."""
        return self._can_execute(subtask, plan)

    def is_plan_completed(self, plan_id: str) -> bool:
        """Check if all subtasks in a plan are completed or skipped."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return False
        return all(s.status in ("completed", "skipped") for s in plan.subtasks)

    def is_plan_blocked(self, plan_id: str) -> bool:
        """Check if plan has pending tasks that cannot execute (blocked by dependencies)."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return False
        pending = [s for s in plan.subtasks if s.status == "pending"]
        if not pending:
            return False
        # All pending tasks have unmet dependencies and no in-progress tasks
        return all(not self._can_execute(s, plan) for s in pending) and \
               not any(s.status == "in_progress" for s in plan.subtasks)

    def mark_subtask_started(self, plan_id: str, subtask_id: str) -> SubTask | None:
        """Mark a subtask as in_progress (called when SubAgent starts)."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None
        subtask = plan.get_subtask(subtask_id)
        if subtask is None:
            return None
        subtask.status = "in_progress"
        subtask.started_at = datetime.now()
        # Note: retry_count is incremented on failure, not on start
        plan.current_subtask_ids.append(subtask_id)
        self._save_plan(plan)
        logger.info("Subtask '{}' marked as in_progress", subtask.title)
        # Trigger progress update for CLI display
        asyncio.get_event_loop().create_task(
            self._report_progress(plan, subtask, "started")
        )
        return subtask

    def update_subtask_result(
        self,
        plan_id: str,
        subtask_id: str,
        result: str | None,
        status: str = "completed",
        error: str | None = None,
    ) -> SubTask | None:
        """Update subtask result after SubAgent completes.

        This is called by SubagentManager when a SubAgent finishes.
        """
        plan = self.get_plan(plan_id)
        if plan is None:
            logger.warning("Plan {} not found when updating subtask {}", plan_id, subtask_id)
            return None

        subtask = plan.get_subtask(subtask_id)
        if subtask is None:
            logger.warning("Subtask {} not found in plan {}", subtask_id, plan_id)
            return None

        # Update status
        subtask.status = status  # type: ignore
        if result is not None:
            subtask.result = self._truncate_result(result)
        if error is not None:
            subtask.error = error

        if status == "completed":
            subtask.completed_at = datetime.now()
            plan.current_subtask_ids = [sid for sid in plan.current_subtask_ids if sid != subtask_id]
            logger.info("Subtask '{}' completed", subtask.title)
        elif status == "failed":
            subtask.completed_at = datetime.now()
            plan.current_subtask_ids = [sid for sid in plan.current_subtask_ids if sid != subtask_id]
            logger.warning("Subtask '{}' failed: {}", subtask.title, error or "unknown")
            # Check if all retries exhausted
            if subtask.retry_count >= subtask.max_retries:
                # Mark plan as paused for intervention
                plan.status = "paused"
                plan.context["error"] = f"Subtask '{subtask.title}' failed after {subtask.max_retries} retries"
                logger.warning("Plan '{}' paused due to subtask failure", plan.title)

        self._save_plan(plan)

        # Check if plan should transition to completed
        if self.is_plan_completed(plan_id):
            plan.status = "completed"
            self._save_plan(plan)
            logger.info("Plan '{}' completed", plan.title)

        # Trigger progress update for CLI display
        asyncio.get_event_loop().create_task(
            self._report_progress(plan, subtask, status)
        )

        return subtask

    def get_plan_summary(self, plan_id: str) -> str | None:
        """Get a summary of all completed subtask results for final report."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None

        results = []
        for subtask in plan.subtasks:
            if subtask.status == "completed" and subtask.result:
                results.append(f"[{subtask.title}] {subtask.result}")

        if not results:
            return "No completed subtasks."

        return "\n\n".join(results)

    # ========== Plan Control ==========

    def pause_plan(self, plan_id: str) -> TaskPlan | None:
        """Pause a running plan (signals cancellation to execution loop)."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None

        if plan.status == "executing":
            # Signal cancellation
            if plan_id in self._cancel_events:
                self._cancel_events[plan_id].set()

            # Mark in-progress tasks
            for subtask in plan.subtasks:
                if subtask.status == "in_progress":
                    subtask.status = "pending"
                    subtask.error = "Interrupted by pause"

            plan.status = "paused"
            self._save_plan(plan)
            logger.info("Paused plan '{}' ({})", plan.title, plan.id)

        return plan

    def cancel_plan(self, plan_id: str) -> TaskPlan | None:
        """Cancel a plan, marking all pending subtasks as skipped."""
        plan = self.get_plan(plan_id)
        if plan is None:
            return None

        # Signal cancellation
        if plan_id in self._cancel_events:
            self._cancel_events[plan_id].set()

        for subtask in plan.subtasks:
            if subtask.status == "pending":
                subtask.status = "skipped"
            elif subtask.status == "in_progress":
                subtask.status = "skipped"
                subtask.error = "Cancelled by user"

        plan.status = "failed"
        plan.context["cancelled"] = True
        self._save_plan(plan)
        logger.info("Cancelled plan '{}' ({})", plan.title, plan.id)

        return plan

    def delete_plan(self, plan_id: str) -> bool:
        """Delete a plan from the store."""
        store = self._load_store()
        removed = store.remove_plan(plan_id)
        if removed:
            self._save_store()
            logger.info("Deleted plan {}", plan_id)
        return removed
