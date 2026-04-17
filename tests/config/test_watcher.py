"""Tests for ConfigWatcher module."""

import asyncio
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock
from tinybot.config.watcher import (
    ConfigWatcher,
    HotReloadMixin,
    classify_config_change,
    HOT_RELOADABLE_ATTRS,
    RESTART_REQUIRED_ATTRS,
)


class TestConfigWatcher:
    """Tests for ConfigWatcher class."""

    def test_init(self):
        """Test ConfigWatcher initialization."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path("/tmp/config.yaml"),
            on_change=callback,
            check_interval=5.0,
        )
        assert watcher._path == Path("/tmp/config.yaml")
        assert watcher._on_change == callback
        assert watcher._check_interval == 5.0
        assert watcher._running is False

    def test_get_mtime_file_exists(self):
        """Test _get_mtime when file exists."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path(__file__),  # Use this test file
            on_change=callback,
        )
        mtime = watcher._get_mtime()
        assert mtime > 0

    def test_get_mtime_file_not_exists(self):
        """Test _get_mtime when file doesn't exist."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path("/nonexistent/config.yaml"),
            on_change=callback,
        )
        mtime = watcher._get_mtime()
        assert mtime == 0

    @pytest.mark.asyncio
    async def test_start_stop(self):
        """Test start and stop methods."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path("/tmp/config.yaml"),
            on_change=callback,
            check_interval=1.0,
        )

        await watcher.start()
        assert watcher._running is True
        assert watcher._task is not None

        watcher.stop()
        assert watcher._running is False

    @pytest.mark.asyncio
    async def test_watch_loop_cancellation(self):
        """Test that watch loop handles cancellation gracefully."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path("/tmp/config.yaml"),
            on_change=callback,
            check_interval=0.1,
        )

        await watcher.start()
        await asyncio.sleep(0.2)  # Let it run briefly
        watcher.stop()

        # Should complete without error
        if watcher._task:
            try:
                await watcher._task
            except asyncio.CancelledError:
                pass  # Expected

    def test_check_and_reload_no_change(self):
        """Test _check_and_reload when file hasn't changed."""
        callback = MagicMock()
        watcher = ConfigWatcher(
            config_path=Path(__file__),
            on_change=callback,
        )
        watcher._last_mtime = watcher._get_mtime() + 1000  # Set future time

        watcher._check_and_reload()
        callback.assert_not_called()

    def test_check_and_reload_with_change(self):
        """Test _check_and_reload when file has changed."""
        from tinybot.config.schema import Config

        mock_config = MagicMock(spec=Config)
        callback = MagicMock()

        watcher = ConfigWatcher(
            config_path=Path(__file__),
            on_change=callback,
        )
        watcher._last_mtime = 0  # Force reload

        with patch("tinybot.config.loader.load_config", return_value=mock_config):
            watcher._check_and_reload()
            callback.assert_called_once_with(mock_config)

    def test_check_and_reload_parse_error(self):
        """Test _check_and_reload handles parse errors gracefully."""
        callback = MagicMock()

        watcher = ConfigWatcher(
            config_path=Path(__file__),
            on_change=callback,
        )
        watcher._last_mtime = 0  # Force reload

        with patch("tinybot.config.loader.load_config", side_effect=Exception("Parse error")):
            watcher._check_and_reload()
            callback.assert_not_called()  # Should not call on error


class TestHotReloadMixin:
    """Tests for HotReloadMixin class."""

    def test_mixin_default_implementation(self):
        """Test default apply_config_update implementation."""

        class TestComponent(HotReloadMixin):
            pass

        from tinybot.config.schema import Config

        mock_config = MagicMock(spec=Config)

        component = TestComponent()
        component.apply_config_update(mock_config)  # Should not raise


class TestClassifyConfigChange:
    """Tests for classify_config_change function."""

    def test_no_changes(self):
        """Test when configs are identical."""
        from tinybot.config.schema import Config, AgentDefaults, AgentsConfig

        defaults1 = AgentDefaults()
        defaults2 = AgentDefaults()
        config1 = Config(agents=AgentsConfig(defaults=defaults1))
        config2 = Config(agents=AgentsConfig(defaults=defaults2))

        result = classify_config_change(config1, config2)
        assert result["hot_reloadable"] == []
        assert result["restart_required"] == []

    def test_hot_reloadable_change(self):
        """Test when hot-reloadable attributes change."""
        from tinybot.config.schema import Config, AgentDefaults, AgentsConfig

        defaults1 = AgentDefaults(max_tool_iterations=100)
        defaults2 = AgentDefaults(max_tool_iterations=200)
        config1 = Config(agents=AgentsConfig(defaults=defaults1))
        config2 = Config(agents=AgentsConfig(defaults=defaults2))

        result = classify_config_change(config1, config2)
        assert "max_tool_iterations" in result["hot_reloadable"]
        assert result["restart_required"] == []

    def test_restart_required_change(self):
        """Test when restart-required attributes change."""
        from tinybot.config.schema import Config, AgentDefaults, AgentsConfig

        defaults1 = AgentDefaults(model="model-a")
        defaults2 = AgentDefaults(model="model-b")
        config1 = Config(agents=AgentsConfig(defaults=defaults1))
        config2 = Config(agents=AgentsConfig(defaults=defaults2))

        result = classify_config_change(config1, config2)
        assert "model" in result["restart_required"]
        assert result["hot_reloadable"] == []

    def test_mixed_changes(self):
        """Test when both types of attributes change."""
        from tinybot.config.schema import Config, AgentDefaults, AgentsConfig

        defaults1 = AgentDefaults(model="model-a", max_tool_iterations=100)
        defaults2 = AgentDefaults(model="model-b", max_tool_iterations=200)
        config1 = Config(agents=AgentsConfig(defaults=defaults1))
        config2 = Config(agents=AgentsConfig(defaults=defaults2))

        result = classify_config_change(config1, config2)
        assert "max_tool_iterations" in result["hot_reloadable"]
        assert "model" in result["restart_required"]


class TestConstants:
    """Tests for configuration constants."""

    def test_hot_reloadable_attrs_list(self):
        """Test HOT_RELOADABLE_ATTRS contains expected attributes."""
        expected = [
            "max_tool_iterations",
            "max_tool_result_chars",
            "temperature",
            "timezone",
            "reasoning_effort",
        ]
        assert HOT_RELOADABLE_ATTRS == expected

    def test_restart_required_attrs_list(self):
        """Test RESTART_REQUIRED_ATTRS contains expected attributes."""
        expected = [
            "workspace",
            "model",
            "provider",
            "mcp_servers",
            "enable_vector_store",
        ]
        assert RESTART_REQUIRED_ATTRS == expected
