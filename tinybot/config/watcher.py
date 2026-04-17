"""Configuration hot reload - watch for config file changes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING
from collections.abc import Callable

from loguru import logger

if TYPE_CHECKING:
    from tinybot.config.schema import Config


class ConfigWatcher:
    """Watch config file changes and apply hot reload.

    This class monitors a configuration file for modifications and
    triggers a callback when changes are detected. It supports
    graceful handling of parse errors and maintains the last known
    good configuration.
    """

    def __init__(
        self,
        config_path: Path,
        on_change: Callable[[Config], None],
        check_interval: float = 5.0,
    ):
        """Initialize config watcher.

        Args:
            config_path: Path to the configuration file
            on_change: Callback to invoke when config changes
            check_interval: Seconds between file checks
        """
        self._path = config_path
        self._on_change = on_change
        self._check_interval = check_interval
        self._last_mtime: float = 0
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start watching for config changes."""
        if self._running:
            return

        self._running = True
        self._last_mtime = self._get_mtime()

        self._task = asyncio.create_task(self._watch_loop())
        logger.info("ConfigWatcher started for {}", self._path)

    def stop(self) -> None:
        """Stop watching for config changes."""
        self._running = False
        if self._task:
            self._task.cancel()
            self._task = None
        logger.info("ConfigWatcher stopped")

    def _get_mtime(self) -> float:
        """Get file modification time, or 0 if file doesn't exist."""
        try:
            return self._path.stat().st_mtime
        except FileNotFoundError:
            return 0
        except Exception as e:
            logger.warning("Error reading config file mtime: {}", e)
            return 0

    async def _watch_loop(self) -> None:
        """Main watch loop - check file periodically."""
        while self._running:
            try:
                await asyncio.sleep(self._check_interval)
                self._check_and_reload()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception("ConfigWatcher error: {}", e)

    def _check_and_reload(self) -> None:
        """Check if file changed and reload if necessary."""
        current_mtime = self._get_mtime()
        if current_mtime <= self._last_mtime:
            return

        self._last_mtime = current_mtime
        logger.info("Config file changed, attempting reload: {}", self._path)

        try:
            from tinybot.config.loader import load_config
            new_config = load_config(self._path)
            self._on_change(new_config)
            logger.info("Config reloaded successfully")
        except Exception as e:
            logger.warning("Failed to reload config: {}. Using previous config.", e)


class HotReloadMixin:
    """Mixin class for components that support hot config reload.

    Provides a standard interface for applying configuration updates
    that don't require a full restart.
    """

    def apply_config_update(self, new_config: Config) -> None:
        """Apply configuration updates from hot reload.

        Override this method to implement component-specific
        configuration update logic.

        Args:
            new_config: The new configuration to apply
        """
        # Default implementation - override in subclasses
        logger.debug(
            "{} received config update (override apply_config_update to handle)",
            type(self).__name__,
        )


# Configuration attributes that can be hot-reloaded without restart
HOT_RELOADABLE_ATTRS = [
    "max_tool_iterations",
    "max_tool_result_chars",
    "temperature",
    "timezone",
    "reasoning_effort",
]

# Configuration attributes that require restart
RESTART_REQUIRED_ATTRS = [
    "workspace",
    "model",
    "provider",
    "mcp_servers",
    "enable_vector_store",
]


def classify_config_change(old_config: Config, new_config: Config) -> dict[str, list[str]]:
    """Classify configuration changes by reload requirement.

    Args:
        old_config: Previous configuration
        new_config: New configuration

    Returns:
        Dict with 'hot_reloadable' and 'restart_required' keys listing changed attrs
    """
    result: dict[str, list[str]] = {
        "hot_reloadable": [],
        "restart_required": [],
    }

    old_defaults = old_config.agents.defaults
    new_defaults = new_config.agents.defaults

    for attr in HOT_RELOADABLE_ATTRS:
        old_val = getattr(old_defaults, attr, None)
        new_val = getattr(new_defaults, attr, None)
        if old_val != new_val:
            result["hot_reloadable"].append(attr)

    for attr in RESTART_REQUIRED_ATTRS:
        old_val = getattr(old_defaults, attr, None)
        new_val = getattr(new_defaults, attr, None)
        if old_val != new_val:
            result["restart_required"].append(attr)

    return result
