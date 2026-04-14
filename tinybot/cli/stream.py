"""Streaming renderer for CLI output.

Uses Rich Live with auto_refresh=False for stable, flicker-free
markdown rendering during streaming. Ellipsis mode handles overflow.

Also provides TaskProgressPanel for persistent, in-place task progress display.
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
import time
import threading
from dataclasses import dataclass, field
from typing import Any

from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.text import Text
from rich.panel import Panel



from tinybot import __logo__


_THINKING_MESSAGES = [
    "tinybot is thinking...",
    "tinybot is pondering the meaning of life...",
    "tinybot is connecting the neural dots...",
    "tinybot is brewing ideas...",
    "tinybot is consulting the oracle...",
    "tinybot is staring into the void for inspiration...",
    "tinybot is having an existential crisis...",
    "tinybot is arguing with itself internally...",
    "tinybot is scrolling through its memories...",
    "tinybot is doing its best, okay?",
    "tinybot is trying very hard not to get distracted...",
    "tinybot is thinking outside the bot...",
    "tinybot is weighing 42 possible answers...",
    "tinybot is channeling its inner genius...",
    "tinybot is on it — probably...",
    "tinybot is loading its brain cells...",
    "tinybot is thinking at the speed of thought...",
    "tinybot is formulating a brilliant response...",
    "tinybot is asking a friend for advice...",
    "tinybot is pretending to be smart...",
    "tinybot is doing complex math... 2 + 2 = ...",
    "tinybot is carefully choosing its words...",
    "tinybot is thinking... no wait, it's got it!",
    "tinybot is thinking so hard you can almost hear it...",
]

_SPINNER_STYLES = [
    "dots4",
    "star2",
    "material",
    "aesthetic",
    "earth",
    "moon",
    "arc",
    "runner",
    "shark",
    "weather",
    "hearts",
    "christmas",
]


def _make_console() -> Console:
    return Console(file=sys.stdout)



class ThinkingSpinner:
    """Spinner with random humorous messages and varied animations."""

    def __init__(self, console: Console | None = None):
        c = console or _make_console()
        message = random.choice(_THINKING_MESSAGES)
        spinner = random.choice(_SPINNER_STYLES)
        self._spinner = c.status(f"[dim]{message}[/dim]", spinner=spinner)
        self._active = False

    def __enter__(self):
        self._spinner.start()
        self._active = True
        return self

    def __exit__(self, *exc):
        self._active = False
        self._spinner.stop()
        return False

    def pause(self):
        """Context manager: temporarily stop spinner for clean output."""
        from contextlib import contextmanager

        @contextmanager
        def _ctx():
            if self._spinner and self._active:
                self._spinner.stop()
            try:
                yield
            finally:
                if self._spinner and self._active:
                    self._spinner.start()

        return _ctx()


class StreamRenderer:
    """Rich Live streaming with markdown. auto_refresh=False avoids render races.

    Deltas arrive pre-filtered (no <think> tags) from the agent loop.

    Flow per round:
      spinner -> first visible delta -> header + Live renders ->
      on_end -> Live stops (content stays on screen)
    """

    def __init__(self, render_markdown: bool = True, show_spinner: bool = True):
        self._md = render_markdown
        self._show_spinner = show_spinner
        self._buf = ""
        self._reasoning_buf = ""
        self._live: Live | None = None
        self._t = 0.0
        self.streamed = False
        self._md_obj: Markdown | None = None
        self._md_buf_len: int = 0
        self._console = _make_console()
        self._plain = (
            not self._console.is_terminal
            or self._console.color_system is None
            or self._console.no_color
            or bool(os.environ.get("tinybot_FORCE_PLAIN_STREAM"))
        )
        self._last_plain_delta = ""
        self._last_plain_reasoning_delta = ""
        self._plain_reasoning_started = False
        self._spinner: ThinkingSpinner | None = None
        # Cache static Text objects for Rich Live stability
        self._thinking_label = Text("Thinking:", style="dim")
        self._empty_text = Text("")
        self._start_spinner()

    def _render_content(self, force_rebuild: bool = False):
        if not self._buf:
            return Text("")
        if self._md:
            # Reuse cached Markdown object; recreate when ~256 chars of new content
            # or when explicitly forced (e.g., final render)
            if force_rebuild or self._md_obj is None or (len(self._buf) - self._md_buf_len) > 256:
                self._md_obj = Markdown(self._buf)
                self._md_buf_len = len(self._buf)
            return self._md_obj
        return Text(self._buf)

    def _render(self, force_rebuild: bool = False):
        blocks = []
        # Reasoning always shown when present
        if self._reasoning_buf:
            blocks.extend([
                self._thinking_label,
                Text(self._reasoning_buf, style="dim"),
                self._empty_text,
            ])
        # Content
        if self._buf:
            blocks.append(self._render_content(force_rebuild=force_rebuild))
        # Always return Group for consistent type
        return Group(*blocks) if blocks else Group(self._empty_text)


    def _start_spinner(self) -> None:
        if self._plain or not self._show_spinner:
            return
        self._spinner = ThinkingSpinner(self._console)
        self._spinner.__enter__()

    def _stop_spinner(self) -> None:
        if self._spinner:
            self._spinner.__exit__(None, None, None)
            self._spinner = None

    def _ensure_live_started(self) -> None:
        if self._live is not None:
            return
        if not self._buf.strip() and not self._reasoning_buf.strip():
            return
        self._stop_spinner()
        c = self._console
        c.print()
        c.print(f"[cyan]{__logo__} tinybot[/cyan]")
        self._live = Live(self._render(), console=c, auto_refresh=False)
        self._live.start()

    def _refresh_live(self, delta: str) -> None:
        if self._live is None:
            return
        now = time.monotonic()
        if "\n" in delta or (now - self._t) > 0.1:
            self._live.update(self._render())
            self._live.refresh()
            self._t = now

    async def on_reasoning_delta(self, delta: str) -> None:
        if self._plain:
            norm = delta.replace("\r", "")
            if norm and norm == self._last_plain_reasoning_delta:
                return
            self._last_plain_reasoning_delta = norm
            self._reasoning_buf += delta
            if not self._plain_reasoning_started:
                self._console.print("Thinking:")
                self._plain_reasoning_started = True
            self._console.print(delta, end="")
            self._console.file.flush()
            return

        self._reasoning_buf += delta
        self._ensure_live_started()
        self._refresh_live(delta)

    async def on_delta(self, delta: str) -> None:
        self.streamed = True
        if self._plain:
            norm = delta.replace("\r", "")
            if norm and norm == self._last_plain_delta:
                return
            self._last_plain_delta = norm
            if self._reasoning_buf and not self._buf:
                self._console.print()

            self._buf += delta
            self._console.print(delta, end="")
            self._console.file.flush()
            return

        self._buf += delta
        self._ensure_live_started()
        self._refresh_live(delta)

    async def on_end(self, *, resuming: bool = False) -> None:
        if self._plain:
            self._console.print()
            if resuming:
                self._buf = ""
                self._reasoning_buf = ""
                self._plain_reasoning_started = False
            self._last_plain_delta = ""
            self._last_plain_reasoning_delta = ""
            return

        if self._live:
            # Force rebuild Markdown to ensure final content is complete
            self._live.update(self._render(force_rebuild=True))
            self._live.refresh()
            self._live.stop()
            self._live = None
        self._stop_spinner()
        if resuming:
            self._buf = ""
            self._reasoning_buf = ""
            self._md_obj = None
            self._md_buf_len = 0
            self._start_spinner()
        else:
            self._console.print()

    async def close(self) -> None:
        """Stop spinner/live without rendering a final streamed round."""
        if self._plain:
            return
        if self._live:
            self._live.stop()
            self._live = None
        self._stop_spinner()


@dataclass
class TaskProgressState:
    """Shared task progress state for the CLI panel."""

    plans: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_update: float = 0.0
    version: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _changed: threading.Condition = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._changed = threading.Condition(self._lock)

    def reset(self) -> None:
        """Clear all tracked plans while preserving the same state object."""
        with self._changed:
            self.plans.clear()
            self.last_update = time.monotonic()
            self.version += 1
            self._changed.notify_all()

    def update(self, progress: dict[str, Any]) -> None:
        """Merge a task progress update into the tracked plan list."""
        plan_id = progress.get("plan_id", "")
        if not plan_id:
            return

        prog = progress.get("progress", {})
        now = time.monotonic()
        with self._changed:
            plan_state = self.plans.get(plan_id, {}).copy()
            plan_state.update({
                "plan_id": plan_id,
                "plan_title": progress.get("plan_title", ""),
                "plan_status": progress.get("plan_status", ""),
                "event": progress.get("event", ""),
                "total": prog.get("total", 0),
                "completed": prog.get("completed", 0),
                "in_progress": prog.get("in_progress", 0),
                "pending": prog.get("pending", 0),
                "failed": prog.get("failed", 0),
                "skipped": prog.get("skipped", 0),
                "current": prog.get("current"),
                "current_all": list(prog.get("current_all") or []),
                "next": prog.get("next"),
                "subtasks": [dict(subtask) for subtask in progress.get("subtasks", [])],
                "last_update": now,
                "active": progress.get("plan_status", "") == "executing",
            })
            self.plans[plan_id] = plan_state
            self.last_update = now
            self.version += 1
            self._changed.notify_all()

    def mark_inactive(self, plan_id: str | None = None, status: str | None = None) -> None:
        """Mark a tracked plan as inactive while preserving its final state."""
        with self._changed:
            target_id = plan_id
            if target_id is None:
                target_id = max(
                    self.plans,
                    key=lambda key: self.plans[key].get("last_update", 0.0),
                    default=None,
                )
            if not target_id or target_id not in self.plans:
                return

            plan_state = self.plans[target_id].copy()
            plan_state["active"] = False
            if status:
                plan_state["plan_status"] = status
            plan_state["last_update"] = time.monotonic()
            self.plans[target_id] = plan_state
            self.last_update = plan_state["last_update"]
            self.version += 1
            self._changed.notify_all()

    def wait_for_change(self, last_version: int, timeout: float | None = None) -> int:
        """Block until the version changes or timeout elapses."""
        with self._changed:
            if self.version == last_version:
                self._changed.wait(timeout=timeout)
            return self.version

    def get_snapshot(self) -> dict[str, Any]:
        """Return all tracked plans ordered by most recent update."""
        with self._changed:
            plans = sorted(
                (
                    {
                        **plan,
                        "subtasks": [dict(subtask) for subtask in plan.get("subtasks", [])],
                        "current_all": list(plan.get("current_all") or []),
                    }
                    for plan in self.plans.values()
                ),
                key=lambda item: item.get("last_update", 0.0),
                reverse=True,
            )
            return {
                "plans": plans,
                "last_update": self.last_update,
                "version": self.version,
            }


class TaskProgressPanel:
    """Persistent, in-place task progress display using Rich Live."""

    PLAN_STATUS_ICONS = {
        "planning": "📝",
        "executing": "▶️",
        "completed": "✅",
        "failed": "❌",
        "paused": "⏸️",
    }
    PLAN_STATUS_STYLES = {
        "planning": "yellow",
        "executing": "bold cyan",
        "completed": "green",
        "failed": "red",
        "paused": "yellow",
    }
    PLAN_STATUS_LABELS = {
        "planning": "planning",
        "executing": "running",
        "completed": "done",
        "failed": "failed",
        "paused": "paused",
    }
    STATUS_ICONS = {
        "pending": "⏳",
        "in_progress": "▶️",
        "completed": "✅",
        "failed": "❌",
        "skipped": "⏭️",
    }
    SUBTASK_STYLES = {
        "pending": "dim",
        "in_progress": "bold cyan",
        "completed": "green",
        "failed": "red",
        "skipped": "yellow",
    }

    def __init__(
        self,
        state: TaskProgressState,
        console: Console | None = None,
    ):
        self._state = state
        self._console = console or _make_console()
        self._live: Live | None = None
        self._started = False

    def _sorted_plans(self, plans: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            plans,
            key=lambda plan: (
                0 if plan.get("active") else 1,
                -plan.get("last_update", 0.0),
            ),
        )

    def _render_plan_header(self, plan: dict[str, Any]) -> Text:
        status = plan.get("plan_status", "planning")
        icon = self.PLAN_STATUS_ICONS.get(status, "📋")
        style = self.PLAN_STATUS_STYLES.get(status, "white")
        status_label = self.PLAN_STATUS_LABELS.get(status, status)
        total = plan.get("total", 0)
        completed = plan.get("completed", 0)
        failed = plan.get("failed", 0)
        skipped = plan.get("skipped", 0)
        progress_pct = (completed / total * 100) if total > 0 else 0

        header = Text()
        header.append(f"{icon} {plan.get('plan_title', 'Task')}", style=style)
        header.append(f" [{completed}/{total} ({progress_pct:.0f}%)]", style="bold")
        header.append(f"  {status_label}", style=style)
        if failed:
            header.append(f"  failed={failed}", style="red")
        if skipped:
            header.append(f"  skipped={skipped}", style="yellow")
        return header

    def _render_subtask_line(self, subtask: dict[str, Any]) -> Text:
        status = subtask.get("status", "pending")
        icon = self.STATUS_ICONS.get(status, "❓")
        style = self.SUBTASK_STYLES.get(status, "white")
        title = (subtask.get("title") or "").strip() or "Untitled task"
        error = (subtask.get("error") or "").strip()

        line = Text("  ")
        line.append(f"{icon} ")
        line.append(title, style=style)
        if error and status == "failed":
            line.append(f" — {error[:60]}", style="dim red")
        return line

    def _render_plan_meta(self, plan: dict[str, Any]) -> Text | None:
        parts: list[str] = []
        current = plan.get("current")
        next_task = plan.get("next")
        if current:
            parts.append(f"current: {current}")
        if next_task:
            parts.append(f"next: {next_task}")
        if not parts:
            return None
        return Text("  " + " | ".join(parts), style="dim")

    def _render_plan(self, plan: dict[str, Any]) -> Group:
        rows: list[Any] = [self._render_plan_header(plan)]

        subtasks = plan.get("subtasks", [])
        if subtasks:
            rows.extend(self._render_subtask_line(subtask) for subtask in subtasks)
        else:
            rows.append(Text("  No subtasks", style="dim"))

        meta = self._render_plan_meta(plan)
        if meta is not None:
            rows.append(meta)

        return Group(*rows)

    def _render(self) -> Panel:
        """Render all tracked task plans."""
        snapshot = self._state.get_snapshot()
        plans = self._sorted_plans(snapshot["plans"])

        if not plans:
            body: Any = Text("No task updates yet", style="dim")
        else:
            blocks: list[Any] = []
            for index, plan in enumerate(plans):
                if index:
                    blocks.append(Text(""))
                blocks.append(self._render_plan(plan))
            body = Group(*blocks)

        border_style = "cyan" if any(plan.get("active") for plan in plans) else "dim"
        return Panel.fit(body, title="📋 Task Progress", border_style=border_style)


    def start(self) -> None:
        """Start the progress panel display once and reuse it for refreshes."""
        if self._started or self._plain():
            return

        self._started = True
        self._live = Live(
            self._render(),
            console=self._console,
            auto_refresh=False,
            transient=False,
        )
        self._live.start()

    def _plain(self) -> bool:
        """Check if we should use plain output."""
        return (
            not self._console.is_terminal
            or self._console.color_system is None
            or self._console.no_color
            or bool(os.environ.get("tinybot_FORCE_PLAIN_STREAM"))
        )

    def refresh(self) -> None:
        """Refresh the existing Live region in place."""
        if self._live and self._started:
            self._live.update(self._render())
            self._live.refresh()

    def stop(self, clear: bool = False) -> None:
        """Stop the progress panel display."""
        if not self._started:
            return

        self._started = False
        if self._live:
            if not clear:
                self._live.update(self._render())
                self._live.refresh()
            self._live.stop()
            self._live = None

    def update_and_refresh(self, progress: dict[str, Any]) -> None:
        """Update state and refresh display (convenience method)."""
        self._state.update(progress)
        self.refresh()

    @property
    def is_active(self) -> bool:
        """Check if any tracked plan is still executing."""
        snapshot = self._state.get_snapshot()
        return any(plan.get("active") for plan in snapshot["plans"])

    @property
    def is_started(self) -> bool:
        """Check if the panel is currently started."""
        return self._started



