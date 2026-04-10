"""Streaming renderer for CLI output.

Uses Rich Live with auto_refresh=False for stable, flicker-free
markdown rendering during streaming. Ellipsis mode handles overflow.
"""

from __future__ import annotations

import os
import sys
import time

from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.text import Text


from tinybot import __logo__


def _make_console() -> Console:
    return Console(file=sys.stdout)



class ThinkingSpinner:
    """Spinner that shows 'tinybot is thinking...' with pause support."""

    def __init__(self, console: Console | None = None):
        c = console or _make_console()
        self._spinner = c.status("[dim]tinybot is thinking...[/dim]", spinner="dots")
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
        self._start_spinner()

    def _render_content(self):
        return Markdown(self._buf) if self._md and self._buf else Text(self._buf or "")

    def _render(self):
        blocks = []
        if self._reasoning_buf:
            blocks.extend([
                Text("思考：", style="dim"),
                Text(self._reasoning_buf, style="dim"),
            ])
            if self._buf:
                blocks.append(Text(""))
        if self._buf or not blocks:
            blocks.append(self._render_content())
        return Group(*blocks) if len(blocks) > 1 else blocks[0]


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
        if "\n" in delta or (now - self._t) > 0.05:
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
                self._console.print("思考：")
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
            self._live.update(self._render())
            self._live.refresh()
            self._live.stop()
            self._live = None
        self._stop_spinner()
        if resuming:
            self._buf = ""
            self._reasoning_buf = ""
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


