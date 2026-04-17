"""Tests for ToolRegistry."""

import pytest

from tinybot.agent.tools.base import Tool
from tinybot.agent.tools.registry import ToolRegistry


class MockTool1(Tool):
    """Mock tool 1 for testing."""

    @property
    def name(self) -> str:
        return "tool1"

    @property
    def description(self) -> str:
        return "Mock tool 1"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs):
        return "tool1 result"


class MockTool2(Tool):
    """Mock tool 2 for testing."""

    @property
    def name(self) -> str:
        return "tool2"

    @property
    def description(self) -> str:
        return "Mock tool 2"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs):
        return "tool2 result"


class TestToolRegistry:
    """Tests for ToolRegistry."""

    def test_empty_registry(self):
        """Empty registry should have no tools."""
        registry = ToolRegistry()
        assert len(registry) == 0
        assert registry.tool_names == []

    def test_register_tool(self):
        """Registering a tool should add it to registry."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        assert len(registry) == 1
        assert registry.has("tool1")
        assert registry.get("tool1") == tool

    def test_unregister_tool(self):
        """Unregistering a tool should remove it."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        registry.unregister("tool1")
        assert len(registry) == 0
        assert not registry.has("tool1")

    def test_unregister_nonexistent(self):
        """Unregistering nonexistent tool should not raise."""
        registry = ToolRegistry()
        registry.unregister("nonexistent")
        assert len(registry) == 0

    def test_get_nonexistent(self):
        """Getting nonexistent tool should return None."""
        registry = ToolRegistry()
        assert registry.get("nonexistent") is None

    def test_contains(self):
        """Registry should support 'in' operator."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        assert "tool1" in registry
        assert "other" not in registry

    def test_get_definitions(self):
        """get_definitions should return tool schemas."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        definitions = registry.get_definitions()
        assert len(definitions) == 1
        assert definitions[0]["type"] == "function"

    def test_filtered_registry(self):
        """filtered should exclude specified tools."""
        registry = ToolRegistry()
        tool1 = MockTool1()
        tool2 = MockTool2()
        registry.register(tool1)
        registry.register(tool2)

        filtered = registry.filtered(exclude={"tool1"})
        assert len(filtered) == 1
        assert "tool2" in filtered
        assert "tool1" not in filtered

    def test_filtered_no_exclude(self):
        """filtered with no exclude should return self."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        filtered = registry.filtered(exclude=None)
        assert filtered is registry

    def test_prepare_call_success(self):
        """prepare_call should resolve tool and validate params."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        result_tool, params, error = registry.prepare_call("tool1", {})
        assert result_tool == tool
        assert error is None

    def test_prepare_call_not_found(self):
        """prepare_call should return error for nonexistent tool."""
        registry = ToolRegistry()
        tool, params, error = registry.prepare_call("nonexistent", {})
        assert tool is None
        assert error is not None
        assert "not found" in error

    @pytest.mark.asyncio
    async def test_execute_tool(self):
        """execute should run tool and return result."""
        registry = ToolRegistry()
        tool = MockTool1()
        registry.register(tool)
        result = await registry.execute("tool1", {})
        assert result == "tool1 result"

    @pytest.mark.asyncio
    async def test_execute_nonexistent(self):
        """execute should return error for nonexistent tool."""
        registry = ToolRegistry()
        result = await registry.execute("nonexistent", {})
        assert "Error" in result
        assert "not found" in result


class TestToolRegistryPlaceholder:
    """Placeholder tests for ToolRegistry module."""

    def test_placeholder(self):
        """Placeholder test."""
        assert True
