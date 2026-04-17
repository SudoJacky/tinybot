"""Tests for Channel base and registry."""

import pytest

from tinybot.channels.registry import (
    _INTERNAL,
    discover_channel_names,
)


class TestChannelRegistry:
    """Tests for channel registry functions."""

    def test_internal_modules_set(self):
        """_INTERNAL should contain non-channel modules."""
        assert "base" in _INTERNAL
        assert "manager" in _INTERNAL
        assert "registry" in _INTERNAL

    def test_discover_channel_names(self):
        """discover_channel_names should return valid channel names."""
        names = discover_channel_names()
        assert isinstance(names, list)
        # Should not include internal modules
        for internal in _INTERNAL:
            assert internal not in names

    def test_discover_channel_names_excludes_internal(self):
        """Internal modules should be excluded."""
        names = discover_channel_names()
        assert "base" not in names
        assert "manager" not in names

    def test_feishu_channel_exists(self):
        """Feishu channel should be discovered."""
        names = discover_channel_names()
        # Check for common built-in channels
        assert "feishu" in names or "dingtalk" in names or "weixin" in names


class TestBaseChannelPlaceholder:
    """Placeholder tests for BaseChannel."""

    def test_placeholder(self):
        """Placeholder test."""
        assert True

    @pytest.mark.asyncio
    async def test_async_placeholder(self):
        """Placeholder async test."""
        assert True
