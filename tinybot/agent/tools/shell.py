"""Shell execution tool with enhanced security and audit logging."""

import asyncio
import os
import re
import sys
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from tinybot.config.paths import get_media_dir
from tinybot.security.audit import log_command_exec


# Default deny patterns for dangerous commands
DEFAULT_DENY_PATTERNS = [
    # File deletion
    r"\brm\s+-[rf]{1,2}\b",  # rm -r, rm -rf, rm -fr
    r"\bdel\s+/[fq]\b",  # del /f, del /q
    r"\brmdir\s+/s\b",  # rmdir /s
    r"\bshred\b",  # secure delete
    # Disk operations
    r"(?:^|[;&|]\s*)format\b",  # format (as standalone command)
    r"\b(mkfs|diskpart)\b",  # disk operations
    r"\bdd\s+if=",  # dd input
    r">\s*/dev/sd",  # write to disk
    r">\s*/dev/nvme",  # write to NVMe
    # System control
    r"\b(shutdown|reboot|poweroff|init\s+[06])\b",  # system power/reboot
    r"\bsystemctl\s+(stop|disable|mask)\b",  # systemd service control
    r"\b(service\s+\w+\s+stop)\b",  # service stop
    # Network dangerous
    r"\biptables\s+-f\b",  # flush firewall rules
    r"\b(nmap|netcat|nc)\s+.*-e\b",  # network backdoor patterns
    # Malicious patterns
    r":\(\)\s*\{.*\};\s*:",  # fork bomb
    r"\bchmod\s+[-+]?[ugo]*[ugo]*[ugo]*[ugo]*777\b",  # chmod 777 (too permissive)
    r"\bchown\s+.*:.*\s+/",  # chown on root paths
    # Privilege escalation
    r"\b(sudo|su)\s+.*(?:rm|del|format|mkfs|dd)\b",  # sudo dangerous commands
    # Data exfiltration risk
    r"\b(curl|wget)\s+.*\b(?:-o|--output)\b.*(?:/etc|/var|/root|~/.ssh)",  # download to sensitive paths
    # Environment manipulation
    r"\bexport\s+PATH=.*:\.:",  # PATH with current dir (attack vector)
]

# Whitelist patterns that can override deny patterns (carefully selected)
DEFAULT_ALLOWLIST_PATTERNS = [
    # Safe cleanup patterns
    r"\brm\s+-rf\s+\.git\b",  # clean git repo (common dev task)
    r"\brm\s+-rf\s+(?:node_modules|__pycache__|.pytest_cache)\b",  # clean build/cache dirs
    r"\brm\s+-rf\s+(?:dist|build|target|\.ruff_cache)\b",  # clean build outputs
]


@tool_parameters(
    tool_parameters_schema(
        command=StringSchema("The shell command to execute"),
        working_dir=StringSchema("Optional working directory for the command"),
        timeout=IntegerSchema(
            60,
            description=(
                "Timeout in seconds. Increase for long-running commands "
                "like compilation or installation (default 60, max 600)."
            ),
            minimum=1,
            maximum=600,
        ),
        required=["command"],
    )
)
class ExecTool(Tool):
    """Tool to execute shell commands with enhanced security checks and audit logging."""

    def __init__(
        self,
        timeout: int = 60,
        working_dir: str | None = None,
        deny_patterns: list[str] | None = None,
        allow_patterns: list[str] | None = None,
        restrict_to_workspace: bool = False,
        path_append: str = "",
        enable_audit: bool = True,
        custom_deny_patterns: list[str] | None = None,
        custom_allow_patterns: list[str] | None = None,
    ):
        self.timeout = timeout
        self.working_dir = working_dir
        # Combine default deny patterns with custom ones
        self.deny_patterns = deny_patterns or DEFAULT_DENY_PATTERNS
        if custom_deny_patterns:
            self.deny_patterns.extend(custom_deny_patterns)
        # Combine default allowlist with custom ones
        self.allow_patterns = allow_patterns or DEFAULT_ALLOWLIST_PATTERNS
        if custom_allow_patterns:
            self.allow_patterns.extend(custom_allow_patterns)
        self.restrict_to_workspace = restrict_to_workspace
        self.path_append = path_append
        self.enable_audit = enable_audit

    @property
    def name(self) -> str:
        return "exec"

    _MAX_TIMEOUT = 600
    _MAX_OUTPUT = 10_000

    @property
    def description(self) -> str:
        return "Execute a shell command and return its output. Use with caution."

    @property
    def exclusive(self) -> bool:
        return True

    async def execute(
        self,
        command: str,
        working_dir: str | None = None,
        timeout: int | None = None,
        **kwargs: Any,
    ) -> str:
        cwd = working_dir or self.working_dir or os.getcwd()
        guard_error = self._guard_command(command, cwd)
        if guard_error:
            # Log blocked command
            if self.enable_audit:
                log_command_exec(
                    command=command,
                    blocked=True,
                    reason=guard_error,
                    working_dir=cwd,
                )
            return guard_error

        effective_timeout = min(timeout or self.timeout, self._MAX_TIMEOUT)

        env = os.environ.copy()
        if self.path_append:
            env["PATH"] = env.get("PATH", "") + os.pathsep + self.path_append

        exit_code: int | None = None
        try:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=effective_timeout,
                )
                exit_code = process.returncode
            except TimeoutError:
                process.kill()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                except TimeoutError:
                    pass
                finally:
                    if sys.platform != "win32":
                        try:
                            os.waitpid(process.pid, os.WNOHANG)
                        except (ProcessLookupError, ChildProcessError) as e:
                            logger.debug("Process already reaped or not found: {}", e)
                # Log timed out command
                if self.enable_audit:
                    log_command_exec(
                        command=command,
                        blocked=False,
                        working_dir=cwd,
                        exit_code=-1,
                        timeout=effective_timeout,
                    )
                return f"Error: Command timed out after {effective_timeout} seconds"

            output_parts = []

            if stdout:
                output_parts.append(stdout.decode("utf-8", errors="replace"))

            if stderr:
                stderr_text = stderr.decode("utf-8", errors="replace")
                if stderr_text.strip():
                    output_parts.append(f"STDERR:\n{stderr_text}")

            output_parts.append(f"\nExit code: {process.returncode}")

            result = "\n".join(output_parts) if output_parts else "(no output)"

            # Head + tail truncation to preserve both start and end of output
            max_len = self._MAX_OUTPUT
            if len(result) > max_len:
                half = max_len // 2
                result = result[:half] + f"\n\n... ({len(result) - max_len:,} chars truncated) ...\n\n" + result[-half:]

            # Log successful command execution
            if self.enable_audit:
                log_command_exec(
                    command=command,
                    blocked=False,
                    working_dir=cwd,
                    exit_code=exit_code,
                    timeout=effective_timeout,
                )

            return result

        except Exception as e:
            # Log failed command execution
            if self.enable_audit:
                log_command_exec(
                    command=command,
                    blocked=False,
                    working_dir=cwd,
                    exit_code=-1,
                    timeout=effective_timeout,
                )
            return f"Error executing command: {str(e)}"

    def _guard_command(self, command: str, cwd: str) -> str | None:
        """Best-effort safety guard for potentially destructive commands."""
        cmd = command.strip()
        lower = cmd.lower()

        # First check allowlist - if matches, skip deny check
        for pattern in self.allow_patterns:
            if re.search(pattern, lower):
                logger.debug("Command '{}' matches allowlist pattern, skipping deny check", cmd)
                return None

        # Then check denylist
        for pattern in self.deny_patterns:
            if re.search(pattern, lower):
                return "Error: Command blocked by safety guard (dangerous pattern detected)"

        # If explicit allowlist is configured (beyond defaults), require match
        if self.allow_patterns and len(self.allow_patterns) > len(DEFAULT_ALLOWLIST_PATTERNS):
            # User has added custom allow patterns, enforce strict allowlist mode
            default_count = len(DEFAULT_ALLOWLIST_PATTERNS)
            custom_allow = self.allow_patterns[default_count:]
            if custom_allow and not any(re.search(p, lower) for p in custom_allow):
                return "Error: Command blocked by safety guard (not in custom allowlist)"

        from tinybot.security import contains_internal_url

        if contains_internal_url(cmd):
            return "Error: Command blocked by safety guard (internal/private URL detected)"

        if self.restrict_to_workspace:
            if "..\\" in cmd or "../" in cmd:
                return "Error: Command blocked by safety guard (path traversal detected)"

            cwd_path = Path(cwd).resolve()

            for raw in self._extract_absolute_paths(cmd):
                try:
                    expanded = os.path.expandvars(raw.strip())
                    p = Path(expanded).expanduser().resolve()
                except Exception:
                    continue

                media_path = get_media_dir().resolve()
                if (
                    p.is_absolute()
                    and cwd_path not in p.parents
                    and p != cwd_path
                    and media_path not in p.parents
                    and p != media_path
                ):
                    return "Error: Command blocked by safety guard (path outside working dir)"

        return None

    @staticmethod
    def _extract_absolute_paths(command: str) -> list[str]:
        # Windows: match drive-root paths like `C:\` as well as `C:\path\to\file`
        # NOTE: `*` is required so `C:\` (nothing after the slash) is still extracted.
        win_paths = re.findall(r"[A-Za-z]:\\[^\s\"'|><;]*", command)
        posix_paths = re.findall(r"(?:^|[\s|>'\"])(/[^\s\"'>;|<]+)", command)  # POSIX: /absolute only
        home_paths = re.findall(r"(?:^|[\s|>'\"])(~[^\s\"'>;|<]*)", command)  # POSIX/Windows home shortcut: ~
        return win_paths + posix_paths + home_paths
