"""Task types for the task management module."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


@dataclass
class SubTask:
    """A single subtask within a task plan."""

    id: str  # Unique identifier (uuid[:8])
    title: str  # Short title
    description: str  # Detailed description/execution instructions
    status: Literal["pending", "in_progress", "completed", "failed", "skipped"] = "pending"
    dependencies: list[str] = field(default_factory=list)  # IDs of dependent subtasks
    parallel_safe: bool = True  # Whether this can run concurrently with other subtasks
    result: str | None = None  # Execution result summary
    error: str | None = None  # Failure reason
    started_at: datetime | None = None
    completed_at: datetime | None = None
    retry_count: int = 0
    max_retries: int = 2  # Default max retry count


@dataclass
class TaskPlan:
    """A task plan containing multiple subtasks."""

    id: str  # Unique plan identifier
    title: str  # Task title
    original_request: str  # Original user request
    subtasks: list[SubTask] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    status: Literal["planning", "executing", "completed", "failed", "paused"] = "planning"
    current_subtask_ids: list[str] = field(default_factory=list)  # Currently executing subtasks (for parallel)
    context: dict[str, Any] = field(default_factory=dict)  # Execution context (intermediate results)

    def get_subtask(self, subtask_id: str) -> SubTask | None:
        """Get a subtask by ID."""
        return next((s for s in self.subtasks if s.id == subtask_id), None)

    def count_by_status(self, status: str) -> int:
        """Count subtasks with a specific status."""
        return sum(1 for s in self.subtasks if s.status == status)


@dataclass
class TaskStore:
    """Persistent store for task plans."""

    version: int = 1
    plans: list[TaskPlan] = field(default_factory=list)

    def get_plan(self, plan_id: str) -> TaskPlan | None:
        """Get a plan by ID."""
        return next((p for p in self.plans if p.id == plan_id), None)

    def add_plan(self, plan: TaskPlan) -> None:
        """Add a plan to the store."""
        self.plans.append(plan)

    def remove_plan(self, plan_id: str) -> bool:
        """Remove a plan by ID. Returns True if removed."""
        before = len(self.plans)
        self.plans = [p for p in self.plans if p.id != plan_id]
        return len(self.plans) < before
