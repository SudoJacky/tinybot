"""Tests for shell tool security enhancements."""

import pytest

from tinybot.agent.tools.shell import (
    ExecTool,
    DEFAULT_DENY_PATTERNS,
    DEFAULT_ALLOWLIST_PATTERNS,
)


@pytest.fixture
def exec_tool():
    """Create basic ExecTool instance."""
    return ExecTool()


@pytest.fixture
def exec_tool_with_audit_disabled():
    """Create ExecTool with audit disabled."""
    return ExecTool(enable_audit=False)


class TestDefaultPatterns:
    """Tests for default deny and allow patterns."""

    def test_deny_patterns_count(self):
        """Test that default deny patterns exist."""
        assert len(DEFAULT_DENY_PATTERNS) > 0

    def test_allowlist_patterns_count(self):
        """Test that default allowlist patterns exist."""
        assert len(DEFAULT_ALLOWLIST_PATTERNS) > 0

    def test_deny_rm_rf(self):
        """Test that rm -rf is denied."""
        assert any("rm" in p for p in DEFAULT_DENY_PATTERNS)

    def test_allowlist_clean_cache_dirs(self):
        """Test that cleaning cache dirs is allowed."""
        assert any("node_modules" in p for p in DEFAULT_ALLOWLIST_PATTERNS)


class TestCommandGuard:
    """Tests for command guard functionality."""

    @pytest.mark.parametrize(
        "command",
        [
            "rm -rf /",
            "rm -rf /*",
            "rm -fr /home",
            "sudo rm -rf /",
            "format c:",
            "mkfs.ext4 /dev/sda",
            "dd if=/dev/zero of=/dev/sda",
            "shutdown now",
            "reboot",
            ":(){ :|:& };:",
            "chmod 777 /etc/passwd",
            "iptables -F",
        ],
    )
    def test_blocked_commands(self, exec_tool, command):
        """Test that dangerous commands are blocked."""
        result = exec_tool._guard_command(command, "/tmp")
        assert result is not None
        assert "blocked" in result.lower()

    @pytest.mark.parametrize(
        "command",
        [
            "ls -la",
            "cat file.txt",
            "echo hello",
            "python script.py",
            "npm install",
            "git status",
        ],
    )
    def test_allowed_commands(self, exec_tool, command):
        """Test that safe commands are allowed."""
        result = exec_tool._guard_command(command, "/tmp")
        assert result is None

    @pytest.mark.parametrize(
        "command",
        [
            "rm -rf .git",
            "rm -rf node_modules",
            "rm -rf __pycache__",
            "rm -rf dist",
            "rm -rf build",
            "rm -rf .pytest_cache",
        ],
    )
    def test_allowlist_overrides_deny(self, exec_tool, command):
        """Test that allowlist patterns override deny patterns."""
        result = exec_tool._guard_command(command, "/tmp")
        # These should be allowed due to allowlist
        assert result is None


class TestCustomPatterns:
    """Tests for custom deny/allow patterns."""

    def test_custom_deny_patterns(self):
        """Test adding custom deny patterns."""
        tool = ExecTool(custom_deny_patterns=[r"\bmydangerouscmd\b"])
        result = tool._guard_command("mydangerouscmd --option", "/tmp")
        assert result is not None

    def test_custom_allow_patterns(self):
        """Test adding custom allow patterns."""
        tool = ExecTool(custom_allow_patterns=[r"\bmycustomcmd\b"])
        # Custom allow pattern should work
        result = tool._guard_command("mycustomcmd", "/tmp")
        # Note: this tests if the pattern is added, not override behavior
        # For override, we'd need a command that matches both deny and custom allow

    def test_provided_deny_patterns_override(self):
        """Test that provided deny_patterns override defaults."""
        custom_deny = [r"\btestblock\b"]
        tool = ExecTool(deny_patterns=custom_deny)
        # rm -rf should now be allowed since we override defaults
        result = tool._guard_command("rm -rf /tmp/test", "/tmp")
        assert result is None
        # But our custom pattern should block
        result = tool._guard_command("testblock something", "/tmp")
        assert result is not None


class TestPathTraversal:
    """Tests for path traversal protection."""

    def test_path_traversal_blocked(self):
        """Test that path traversal is blocked when restrict_to_workspace."""
        tool = ExecTool(restrict_to_workspace=True)
        result = tool._guard_command("cat ../secret.txt", "/home/user/workspace")
        assert result is not None
        assert "path traversal" in result.lower()

    def test_path_traversal_allowed_without_restrict(self, exec_tool):
        """Test that path traversal is allowed without restrict flag."""
        result = exec_tool._guard_command("cat ../secret.txt", "/home/user/workspace")
        # Without restrict flag, should not block path traversal
        assert result is None or "path traversal" not in result.lower()


class TestInternalUrlBlocking:
    """Tests for internal URL blocking."""

    @pytest.mark.parametrize(
        "command",
        [
            "curl http://127.0.0.1:8080",
            "wget http://localhost/api",
            "curl http://192.168.1.1",
            "curl http://10.0.0.1",
        ],
    )
    def test_internal_url_blocked(self, exec_tool, command):
        """Test that internal URLs are blocked."""
        result = exec_tool._guard_command(command, "/tmp")
        assert result is not None
        assert "internal" in result.lower() or "private" in result.lower()


class TestExecToolInitialization:
    """Tests for ExecTool initialization."""

    def test_default_timeout(self, exec_tool):
        """Test default timeout value."""
        assert exec_tool.timeout == 60

    def test_custom_timeout(self):
        """Test custom timeout value."""
        tool = ExecTool(timeout=120)
        assert tool.timeout == 120

    def test_audit_enabled_by_default(self, exec_tool):
        """Test that audit is enabled by default."""
        assert exec_tool.enable_audit is True

    def test_audit_can_be_disabled(self):
        """Test that audit can be disabled."""
        tool = ExecTool(enable_audit=False)
        assert tool.enable_audit is False


class TestExtractPaths:
    """Tests for path extraction from commands."""

    def test_extract_windows_path(self, exec_tool):
        """Test extracting Windows path."""
        paths = exec_tool._extract_absolute_paths("cat C:\\Users\\test.txt")
        assert "C:\\Users\\test.txt" in paths

    def test_extract_posix_path(self, exec_tool):
        """Test extracting POSIX path."""
        paths = exec_tool._extract_absolute_paths("cat /home/user/test.txt")
        assert "/home/user/test.txt" in paths

    def test_extract_home_path(self, exec_tool):
        """Test extracting home path."""
        paths = exec_tool._extract_absolute_paths("cat ~/test.txt")
        assert "~/test.txt" in paths

    def test_extract_multiple_paths(self, exec_tool):
        """Test extracting multiple paths."""
        paths = exec_tool._extract_absolute_paths("cp /home/a.txt /home/b.txt")
        assert len(paths) >= 2
