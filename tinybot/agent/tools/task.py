"""Task management tool for complex multi-step tasks."""

from typing import Any

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import ArraySchema, BooleanSchema, StringSchema, tool_parameters_schema
from tinybot.task.service import TaskManager
from tinybot.task.types import TaskPlan


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
            enum=["create", "status", "progress", "resume", "pause", "cancel", "list", "delete", "add_subtask", "remove_subtask"],
        ),
        request=StringSchema("Original request (for create action)"),
        plan_id=StringSchema("Plan ID (for most actions)"),
        parallel=BooleanSchema(
            description="Execute parallel-safe subtasks concurrently (default true)",
            default=True,
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

    def __init__(self, task_manager: TaskManager):
        self._manager = task_manager
        self._channel = ""
        self._chat_id = ""

    def set_context(self, channel: str, chat_id: str) -> None:
        """Set the current session context."""
        self._channel = channel
        self._chat_id = chat_id

    @property
    def name(self) -> str:
        return "task"

    @property
    def description(self) -> str:
        return (
            "Manage complex multi-step tasks: create (auto-decompose), check status/progress, "
            "resume/pause/cancel execution, add/remove subtasks dynamically. "
            "Use this tool for complex requests that benefit from structured planning."
        )

    async def execute(
        self,
        action: str,
        request: str = "",
        plan_id: str = "",
        parallel: bool = True,
        subtask_title: str = "",
        subtask_description: str = "",
        subtask_dependencies: list[str] | None = None,
        subtask_parallel_safe: bool = True,
        subtask_id: str = "",
        after_subtask: str = "",
        **kwargs: Any,
    ) -> str:
        if action == "create":
            return await self._create_plan(request)
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
        return f"Unknown action: {action}"

    async def _create_plan(self, request: str) -> str:
        if not request:
            return "Error: request is required for create action"

        plan = await self._manager.create_plan(
            request=request,
            channel=self._channel,
            chat_id=self._chat_id,
        )

        summary = _format_plan_summary(plan)

        # Check for DAG errors
        dag_errors = plan.context.get("dag_errors", [])
        warning = ""
        if dag_errors:
            warning = f"\n\n⚠️ Warning: Plan has dependency issues: {dag_errors}\nPlease fix before executing."

        return f"Created task plan:\n\n{summary}\n\nUse `task action=resume plan_id={plan.id}` to start execution.{warning}"

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

    async def _resume_plan(self, plan_id: str, parallel: bool) -> str:
        if not plan_id:
            return "Error: plan_id is required for resume action"

        plan = self._manager.get_plan(plan_id)
        if plan is None:
            return f"Error: Plan {plan_id} not found"

        if plan.status == "completed":
            return "Plan already completed."

        if plan.status == "executing":
            return "Plan is already executing."

        # Check for DAG errors
        dag_errors = plan.context.get("dag_errors", [])
        if dag_errors:
            return f"Cannot execute plan due to dependency errors: {dag_errors}\nUse 'add_subtask' or 'remove_subtask' to fix the plan."

        result = await self._manager.execute_plan(
            plan_id=plan_id,
            parallel=parallel,
        )
        return result

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