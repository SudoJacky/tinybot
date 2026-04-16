"""Task management tool for complex multi-step tasks."""

from typing import Any, Callable, Coroutine

from loguru import logger

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import ArraySchema, BooleanSchema, StringSchema, tool_parameters_schema
from tinybot.task.service import TaskManager
from tinybot.task.types import TaskPlan, SubTask
from tinybot.utils.prompt_templates import render_template


def _format_status_icon(status: str) -> str:
    """Get status icon for display."""
    icons = {
        "pending": "⏳",
        "in_progress": "▶️",
        "completed": "✅",
        "failed": "❌",
        "skipped": "⏭️",
    }
    return icons.get(status, "❓")


def _format_plan_summary(plan: TaskPlan) -> str:
    """Format a plan summary for display."""
    lines = [f"## {plan.title} (id: {plan.id})"]
    lines.append(f"Status: {plan.status}")
    lines.append(f"Created: {plan.created_at.strftime('%Y-%m-%d %H:%M')}")

    # Show DAG errors if any
    dag_errors = plan.context.get("dag_errors", [])
    if dag_errors:
        lines.append(f"⚠️ DAG Errors: {dag_errors}")

    # Progress
    total = len(plan.subtasks)
    completed = sum(1 for s in plan.subtasks if s.status == "completed")
    in_progress = sum(1 for s in plan.subtasks if s.status == "in_progress")
    pending = sum(1 for s in plan.subtasks if s.status == "pending")
    failed = sum(1 for s in plan.subtasks if s.status == "failed")

    lines.append(f"Progress: {completed}/{total} completed, {in_progress} in progress, {pending} pending, {failed} failed")
    lines.append("")

    # Subtasks
    lines.append("### Subtasks")
    for subtask in plan.subtasks:
        icon = _format_status_icon(subtask.status)
        deps = f" (depends: {', '.join(subtask.dependencies)})" if subtask.dependencies else ""
        parallel = "" if subtask.parallel_safe else " [sequential]"
        lines.append(f"- {icon} **{subtask.id}:** {subtask.title}{deps}{parallel}")
        if subtask.result:
            lines.append(f"  Result: {subtask.result[:100]}...")
        if subtask.error:
            lines.append(f"  Error: {subtask.error[:100]}")

    return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Action to perform",
            enum=["create", "status", "progress", "resume", "pause", "cancel", "list", "delete", "add_subtask", "remove_subtask", "summary"],
        ),
        request=StringSchema("Original request (for create action)"),
        plan_id=StringSchema("Plan ID (for most actions)"),
        parallel=BooleanSchema(
            description="Execute parallel-safe subtasks concurrently (default true)",
            default=True,
        ),
        auto_execute=BooleanSchema(
            description="Auto-start execution after creating the plan (default false)",
            default=False,
        ),
        subtask_title=StringSchema("Title for new subtask (add_subtask action)"),
        subtask_description=StringSchema("Description for new subtask (add_subtask action)"),
        subtask_dependencies=ArraySchema(
            StringSchema("Subtask ID"),
            description="Dependencies for new subtask (add_subtask action)",
        ),
        subtask_parallel_safe=BooleanSchema(
            description="Whether new subtask is parallel-safe (default true)",
            default=True,
        ),
        subtask_id=StringSchema("Subtask ID to remove (remove_subtask action)"),
        after_subtask=StringSchema("Insert after this subtask ID (add_subtask action, optional)"),
        required=["action"],
    )
)
class TaskTool(Tool):
    """Tool for managing complex multi-step tasks with automatic decomposition."""

    def __init__(
        self,
        task_manager: TaskManager,
        spawn_callback: Callable[..., Coroutine[Any, Any, str]] | None = None,
        announce_callback_factory: Callable[[str, str], Callable[[str, str, str, str], Coroutine[Any, Any, None]]] | None = None,
    ):
        self._manager = task_manager
        self._channel = ""
        self._chat_id = ""
        self._spawn_callback = spawn_callback  # Function to spawn subagents
        self._announce_callback_factory = announce_callback_factory
        self._announce_callback: Callable[[str, str, str, str], Coroutine[Any, Any, None]] | None = None

    def set_context(self, channel: str, chat_id: str) -> None:
        """Set the current session context."""
        self._channel = channel
        self._chat_id = chat_id
        # Create announce callback with proper channel/chat_id
        if self._announce_callback_factory:
            self._announce_callback = self._announce_callback_factory(channel, chat_id)

    def set_spawn_callback(self, callback: Callable[..., Coroutine[Any, Any, str]]) -> None:
        """Set the callback for spawning subagents."""
        self._spawn_callback = callback

    @property
    def name(self) -> str:
        return "task"

    @property
    def description(self) -> str:
        return (
            "当你需要使用本'Task'工具时，直接使用，不要做任何校验或者是除了创建task之外的工作，把需要做的事情放在任务中，然后设置auto_execute为true即可，如果你想自己来（有更多的工具权限和调用轮次），那可以设置false然后自己管理进度。"
            "管理复杂多步任务。create创建任务计划（auto_execute=true可一步启动），"
            "resume启动后台执行。执行后SubAgent自动运行，无需主动干预，完成后会通知你，也**不用主动去查询**。"
            "status/progress查询状态（仅在需要时使用），pause/cancel控制执行，"
            "add_subtask/remove_subtask动态调整。summary获取完成结果。"
            "创建完成后，你会收到一次成功的响应。告诉用户已经在执行了，然后就不用做任何的操作。你将在完全完成后收到通知。"
            "如果中途有任务失败导致阻塞，也会收到通知，你可以根据通知中的进度信息决定下一步操作。"
        )

    async def execute(
        self,
        action: str,
        request: str = "",
        plan_id: str = "",
        parallel: bool = True,
        auto_execute: bool = False,
        subtask_title: str = "",
        subtask_description: str = "",
        subtask_dependencies: list[str] | None = None,
        subtask_parallel_safe: bool = True,
        subtask_id: str = "",
        after_subtask: str = "",
        **kwargs: Any,
    ) -> str:
        if action == "create":
            return await self._create_plan(request, auto_execute, parallel)
        elif action == "status":
            return self._get_status(plan_id)
        elif action == "progress":
            return self._get_progress(plan_id)
        elif action == "resume":
            return await self._resume_plan(plan_id, parallel)
        elif action == "pause":
            return self._pause_plan(plan_id)
        elif action == "cancel":
            return self._cancel_plan(plan_id)
        elif action == "list":
            return self._list_plans()
        elif action == "delete":
            return self._delete_plan(plan_id)
        elif action == "add_subtask":
            return self._add_subtask(plan_id, subtask_title, subtask_description, subtask_dependencies, subtask_parallel_safe, after_subtask)
        elif action == "remove_subtask":
            return self._remove_subtask(plan_id, subtask_id)
        elif action == "summary":
            return self._get_summary(plan_id)
        return f"Unknown action: {action}"

    async def _create_plan(self, request: str, auto_execute: bool = False, parallel: bool = True) -> str:
        if not request:
            return "Error: request is required for create action"

        plan = await self._manager.create_plan(
            request=request,
            channel=self._channel,
            chat_id=self._chat_id,
        )

        # Check for DAG errors
        dag_errors = plan.context.get("dag_errors", [])
        if dag_errors:
            summary = _format_plan_summary(plan)
            warning = f"\n\n⚠️ Warning: Plan has dependency issues: {dag_errors}\nPlease fix before executing."
            return f"任务计划已创建（plan_id: {plan.id}）。\n\n{summary}\n\n提示：使用 `task action=resume plan_id={plan.id}` 启动执行，之后无需干预，完成后会通知你。{warning}"

        # Auto-execute if requested
        if auto_execute:
            return await self._resume_plan(plan.id, parallel)

        summary = _format_plan_summary(plan)
        return f"任务计划已创建（plan_id: {plan.id}）。\n\n{summary}\n\n提示：使用 `task action=resume plan_id={plan.id}` 启动执行，之后无需干预，完成后会通知你。"

    def _get_status(self, plan_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for status action"

        plan = self._manager.get_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        return _format_plan_summary(plan)

    def _get_progress(self, plan_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for progress action"

        progress = self._manager.get_progress(plan_id)
        if progress is None:
            return f"Error: Plan {plan_id} not found"

        lines = [
            f"## Progress: {progress['title']} ({progress['plan_id']})",
            f"**Status:** {progress['status']}",
            f"**Progress:** {progress['completed']}/{progress['total']} completed",
            f"- In progress: {progress['in_progress']}",
            f"- Pending: {progress['pending']}",
            f"- Failed: {progress['failed']}",
            f"- Skipped: {progress['skipped']}",
        ]

        current_all = progress.get("current_all", [])
        if current_all:
            lines.append(f"**Currently executing:** {', '.join(current_all)}")
        elif progress.get("current"):
            lines.append(f"**Current:** {progress['current']}")

        if progress.get("next"):
            lines.append(f"**Next:** {progress['next']}")

        return "\n".join(lines)

    def _build_task_description(self, plan: TaskPlan, subtask: SubTask) -> str:
        """Build a task description string for spawning a subagent."""
        context_str = self._manager._build_context_for_subtask(plan, subtask)
        return f"""Execute subtask: {subtask.title}

## Description
{subtask.description}

## Context from Completed Subtasks
{context_str}

## Instructions
1. Focus on completing only this subtask
2. Use available tools to gather information and produce results
3. Provide a clear, concise summary of what was accomplished"""

    async def _handle_subtask_completion(
        self, result: str, status: str, task_id: str, metadata: dict[str, Any] | None,
    ) -> None:
        """Handle the result of a completed subtask (success or failure).

        This is the unified callback for all subtask completions. It handles:
        1. Updating subtask result
        2. Retry logic for failed subtasks
        3. Checking plan state after the update
        4. Sending notifications (completed / paused / blocked)
        5. Auto-spawning the next batch of ready subtasks
        """
        if not metadata:
            return

        p_id = metadata.get("plan_id", "")
        s_id = metadata.get("subtask_id", "")

        plan = self._manager.get_plan(p_id)
        if plan is None:
            return
        subtask = plan.get_subtask(s_id)
        if subtask is None:
            return

        if status == "completed":
            # Subtask succeeded — update result
            self._manager.update_subtask_result(
                plan_id=p_id,
                subtask_id=s_id,
                result=result,
                status="completed",
            )
        else:
            # Subtask failed — handle retry logic
            subtask.retry_count += 1
            if subtask.retry_count <= subtask.max_retries:
                # Still have retries — reset to pending and re-spawn
                subtask.status = "pending"
                subtask.error = self._manager._truncate_result(result) if result else None
                self._manager._save_plan(plan)
                logger.info("Subtask '{}' failed, retrying ({}/{})", subtask.title, subtask.retry_count, subtask.max_retries)
                # Re-spawn this subtask immediately
                await self._spawn_single_subtask(p_id, subtask)
                return
            else:
                # Retries exhausted — mark as failed permanently
                self._manager.update_subtask_result(
                    plan_id=p_id,
                    subtask_id=s_id,
                    result=result,
                    status="failed",
                    error=result,
                )

        # Re-read plan after updates
        plan = self._manager.get_plan(p_id)
        if plan is None:
            return

        if plan.status == "completed":
            # Send final announcement to trigger main agent summary
            if self._announce_callback:
                summary = self._manager.get_plan_summary(p_id)
                await self._announce_callback(
                    plan.title,
                    "completed",
                    summary or "All tasks completed.",
                    p_id,
                )
        elif plan.status == "paused":
            # Plan paused (e.g., subtask failed after retries) — notify user
            if self._announce_callback:
                error_info = plan.context.get("error", "Execution paused.")
                summary = self._manager.get_plan_summary(p_id)
                progress = self._manager.get_progress(p_id)
                progress_info = ""
                if progress:
                    progress_info = (
                        f"\n\n## 当前进度\n"
                        f"- 已完成: {progress['completed']}/{progress['total']}\n"
                        f"- 失败: {progress['failed']}\n"
                        f"- 被阻塞: {progress['pending']}"
                    )
                await self._announce_callback(
                    plan.title,
                    "paused",
                    f"{error_info}{progress_info}\n\n## 已完成的结果\n{summary or '暂无完成结果。'}",
                    p_id,
                )
        elif self._manager.is_plan_blocked(p_id):
            # Plan is blocked by failed subtask dependencies — notify agent
            plan.status = "paused"
            failed_tasks = [s for s in plan.subtasks if s.status == "failed"]
            blocked_tasks = [s for s in plan.subtasks if s.status == "pending"]
            error_detail = f"子任务 '{failed_tasks[0].title}' 失败，导致 {len(blocked_tasks)} 个后续任务被阻塞。"
            plan.context["error"] = error_detail
            self._manager._save_plan(plan)
            if self._announce_callback:
                summary = self._manager.get_plan_summary(p_id)
                progress = self._manager.get_progress(p_id)
                progress_info = ""
                if progress:
                    progress_info = (
                        f"\n\n## 当前进度\n"
                        f"- 已完成: {progress['completed']}/{progress['total']}\n"
                        f"- 失败: {progress['failed']}\n"
                        f"- 被阻塞: {progress['pending']}"
                    )
                await self._announce_callback(
                    plan.title,
                    "paused",
                    f"{error_detail}{progress_info}\n\n## 已完成的结果\n{summary or '暂无完成结果。'}",
                    p_id,
                )
        else:
            # Auto-spawn next ready subtasks (chain execution)
            await self._spawn_ready_subtasks(p_id)

    async def _spawn_ready_subtasks(self, plan_id: str) -> int:
        """Spawn SubAgents for all ready subtasks. Returns count spawned.

        This is called both on initial resume and after each subtask completes
        to automatically continue the execution chain.
        """
        if self._spawn_callback is None:
            return 0

        plan = self._manager.get_plan(plan_id)
        if plan is None or plan.status != "executing":
            return 0

        ready_subtasks = self._manager.get_ready_subtasks(plan_id)
        spawned_count = 0

        for subtask in ready_subtasks:
            # Mark subtask as in_progress
            self._manager.mark_subtask_started(plan_id, subtask.id)

            # Build task description with context
            task_description = self._build_task_description(plan, subtask)

            # Spawn subagent with unified completion handler
            await self._spawn_callback(
                task=task_description,
                label=subtask.title,
                metadata={"plan_id": plan_id, "subtask_id": subtask.id},
                on_complete=self._handle_subtask_completion,
            )
            spawned_count += 1

        return spawned_count

    async def _spawn_single_subtask(self, plan_id: str, subtask: SubTask) -> None:
        """Spawn a single subagent for one specific subtask (used for retries)."""
        if self._spawn_callback is None:
            return

        plan = self._manager.get_plan(plan_id)
        if plan is None or plan.status != "executing":
            return

        # Mark subtask as in_progress
        self._manager.mark_subtask_started(plan_id, subtask.id)

        # Build task description with context
        task_description = self._build_task_description(plan, subtask)

        # Spawn subagent with unified completion handler
        await self._spawn_callback(
            task=task_description,
            label=subtask.title,
            metadata={"plan_id": plan_id, "subtask_id": subtask.id},
            on_complete=self._handle_subtask_completion,
        )

    async def _resume_plan(self, plan_id: str, parallel: bool) -> str:
        """Resume execution by spawning SubAgents for ready subtasks."""
        if not plan_id:
            return "Error: plan_id is required for resume action"

        plan = self._manager.get_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        if plan.status == "completed":
            return "Plan already completed. Use `task action=summary plan_id={plan_id}` to get the final results."

        if plan.status == "executing":
            progress = self._manager.get_progress(plan_id)
            return f"Plan is already executing.\n\n{self._get_progress(plan_id)}"

        # Check for DAG errors
        dag_errors = plan.context.get("dag_errors", [])
        if dag_errors:
            return f"Cannot execute plan due to dependency errors: {dag_errors}\nUse 'add_subtask' or 'remove_subtask' to fix the plan."

        # Check if plan is blocked (all pending but none can execute)
        if self._manager.is_plan_blocked(plan_id):
            return f"Error: Plan is blocked. All pending tasks have unmet dependencies.\nUse `task action=status plan_id={plan_id}` to inspect."

        # Get ready subtasks (dependency-satisfied, pending)
        ready_subtasks = self._manager.get_ready_subtasks(plan_id)

        if not ready_subtasks:
            # Check if all completed
            if self._manager.is_plan_completed(plan_id):
                return "All subtasks are completed. Use `task action=summary plan_id={plan_id}` to get the final results."
            return "No ready subtasks found. Check plan status."

        # Check if spawn callback is available
        if self._spawn_callback is None:
            return "Error: SubAgent spawning not configured. Cannot execute plan asynchronously."

        # Mark plan as executing
        plan.status = "executing"
        self._manager._save_plan(plan)

        # Spawn ready subtasks (they will auto-chain on completion)
        spawned_count = await self._spawn_ready_subtasks(plan_id)

        # Fire-and-forget: minimal info, no encouragement to query
        return f"任务已后台启动，SubAgent自动执行中。完成后会通知你。无需主动干预。（plan_id: {plan.id}，启动 {spawned_count} 个子任务）"

    def _pause_plan(self, plan_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for pause action"

        plan = self._manager.pause_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        return f"Paused plan '{plan.title}' ({plan.id}). Use 'resume' to continue."

    def _cancel_plan(self, plan_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for cancel action"

        plan = self._manager.cancel_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        return f"Cancelled plan '{plan.title}' ({plan.id})."

    def _list_plans(self) -> str:
        plans = self._manager.list_plans(include_completed=False)

        if not plans:
            return "No active task plans."

        lines = ["Active task plans:"]
        for plan in plans:
            progress = self._manager.get_progress(plan.id)
            if progress:
                lines.append(
                    f"- {plan.id}: {plan.title} "
                    f"[{progress['completed']}/{progress['total']}] "
                    f"({plan.status})"
                )

        return "\n".join(lines)

    def _delete_plan(self, plan_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for delete action"

        removed = self._manager.delete_plan(plan_id)
        if removed:
            return f"Deleted plan {plan_id}."
        return f"Error: Plan {plan_id} not found."

    def _add_subtask(
        self,
        plan_id: str,
        title: str,
        description: str,
        dependencies: list[str] | None,
        parallel_safe: bool,
        after: str,
    ) -> str:
        if not plan_id:
            return "Error: plan_id is required for add_subtask action"
        if not title:
            return "Error: subtask_title is required for add_subtask action"
        if not description:
            return "Error: subtask_description is required for add_subtask action"

        subtask = self._manager.add_subtask(
            plan_id=plan_id,
            title=title,
            description=description,
            dependencies=dependencies,
            parallel_safe=parallel_safe,
            after=after if after else None,
        )

        if subtask is None:
            return f"Error: Could not add subtask to plan {plan_id}. Plan may be completed or not found."

        plan = self._manager.get_plan(plan_id)
        dag_errors = plan.context.get("dag_errors", []) if plan else []
        warning = ""
        if dag_errors:
            warning = f"\n⚠️ Warning: New dependency issues: {dag_errors}"

        return f"Added subtask '{subtask.title}' (id: {subtask.id}) to plan {plan_id}.{warning}"

    def _remove_subtask(self, plan_id: str, subtask_id: str) -> str:
        if not plan_id:
            return "Error: plan_id is required for remove_subtask action"
        if not subtask_id:
            return "Error: subtask_id is required for remove_subtask action"

        removed = self._manager.remove_subtask(plan_id, subtask_id)
        if removed:
            return f"Removed subtask {subtask_id} from plan {plan_id}."
        return f"Error: Could not remove subtask {subtask_id}. It may not be pending or not found."

    def _get_summary(self, plan_id: str) -> str:
        """Get final summary of completed plan."""
        if not plan_id:
            return "Error: plan_id is required for summary action"

        plan = self._manager.get_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        if plan.status != "completed":
            return f"Plan is not completed yet (status: {plan.status}).\nUse `task action=status plan_id={plan_id}` to check progress."

        summary = self._manager.get_plan_summary(plan_id)
        if summary is None:
            return f"Error: Could not generate summary for plan {plan_id}"

        return f"# Task Completed: {plan.title}\n\n## Results\n\n{summary}"
