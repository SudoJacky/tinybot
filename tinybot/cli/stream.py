"""Streaming renderer for CLI output.

Uses Rich Live with auto_refresh=False for stable, flicker-free
markdown rendering during streaming. Ellipsis mode handles overflow.
"""

from __future__ import annotations

import os
import random
import sys
import time

from rich.console import Console, Group
from rich.live import Live
from rich.markdown import Markdown
from rich.text import Text


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
    "fire",
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


