"""High-level programmatic interface to tinybot."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tinybot.agent.hook import AgentHook
from tinybot.agent.loop import AgentLoop
from tinybot.bus.queue import MessageBus


@dataclass(slots=True)
class RunResult:
    """Result of a single agent run."""

    content: str
    tools_used: list[str]
    messages: list[dict[str, Any]]


class Tinybot:
    """Programmatic facade for running the tinybot agent.

    Usage::

        bot = tinybot.from_config()
        result = await bot.run("Summarize this repo", hooks=[MyHook()])
        print(result.content)
    """

    def __init__(self, loop: AgentLoop) -> None:
        self._loop = loop

    @classmethod
    def from_config(
            cls,
            config_path: str | Path | None = None,
            *,
            workspace: str | Path | None = None,
    ) -> Tinybot:
        """Create a tinybot instance from a config file.

        Args:
            config_path: Path to ``config.json``.  Defaults to
                ``~/.tinybot/config.json``.
            workspace: Override the workspace directory from config.
        """
        from tinybot.config.loader import load_config
        from tinybot.config.schema import Config

        resolved: Path | None = None
        if config_path is not None:
            resolved = Path(config_path).expanduser().resolve()
            if not resolved.exists():
                raise FileNotFoundError(f"Config not found: {resolved}")

        config: Config = load_config(resolved)
        if workspace is not None:
            config.agents.defaults.workspace = str(
                Path(workspace).expanduser().resolve()
            )

        from tinybot.providers.registry import create_provider

        provider = create_provider(config)
        bus = MessageBus()

        loop = AgentLoop.from_config(config, bus, provider)
        return cls(loop)

    async def run(
            self,
            message: str,
            *,
            session_key: str = "sdk:default",
            hooks: list[AgentHook] | None = None,
    ) -> RunResult:
        """Run the agent once and return the result.

        Args:
            message: The user message to process.
            session_key: Session identifier for conversation isolation.
                Different keys get independent history.
            hooks: Optional lifecycle hooks for this run.
        """
        prev = self._loop._extra_hooks
        if hooks is not None:
            self._loop._extra_hooks = list(hooks)
        try:
            response = await self._loop.process_direct(
                message, session_key=session_key,
            )
        finally:
            self._loop._extra_hooks = prev

        content = (response.content if response else None) or ""
        return RunResult(content=content, tools_used=[], messages=[])
