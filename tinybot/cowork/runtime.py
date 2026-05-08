"""Standalone cowork runtime.

This keeps Cowork usable as an independent product surface while still reusing
Tinybot's provider, runner, tools, and workspace security primitives.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tinybot.agent.tools.cowork import CoworkTool
from tinybot.config.schema import Config
from tinybot.cowork.service import CoworkService
from tinybot.providers.base import LLMProvider


class CoworkRuntime:
    """Standalone entry point for Cowork commands, API routes, or WebUI pages."""

    def __init__(self, config: Config, provider: LLMProvider) -> None:
        defaults = config.agents.defaults
        self.config = config
        self.provider = provider
        self.workspace: Path = config.workspace_path
        self.service = CoworkService(self.workspace)
        self.tool = CoworkTool(
            service=self.service,
            provider=provider,
            workspace=self.workspace,
            model=defaults.model,
            max_tool_result_chars=defaults.max_tool_result_chars,
            exec_config=config.tools.exec,
            restrict_to_workspace=config.tools.restrict_to_workspace,
        )

    async def start(self, goal: str, *, auto_run: bool = False, max_rounds: int = 1, max_agents: int = 3) -> str:
        return await self.tool.execute(
            action="start",
            goal=goal,
            auto_run=auto_run,
            max_rounds=max_rounds,
            max_agents=max_agents,
        )

    async def run(self, session_id: str, *, max_rounds: int = 1, max_agents: int = 3) -> str:
        return await self.tool.execute(
            action="run",
            session_id=session_id,
            max_rounds=max_rounds,
            max_agents=max_agents,
        )

    async def execute(self, action: str, **kwargs: Any) -> str:
        return await self.tool.execute(action=action, **kwargs)
