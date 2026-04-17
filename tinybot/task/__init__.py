"""Task management module for automatic task decomposition and execution.

This module provides:
- TaskManager: Core service for creating and executing task plans
- TaskTool: Agent tool for task management via the task system
- Types: SubTask, TaskPlan, TaskStore data structures
"""

from tinybot.task.service import TaskManager
from tinybot.task.types import SubTask, TaskPlan, TaskStore

__all__ = ["TaskManager", "TaskTool", "SubTask", "TaskPlan", "TaskStore"]


def create_task_tool(task_manager: TaskManager):
    """Factory function to create a TaskTool instance."""
    from tinybot.agent.tools.task import TaskTool
    return TaskTool(task_manager)
