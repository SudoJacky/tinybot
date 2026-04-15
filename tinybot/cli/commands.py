"""CLI commands for tinybot."""

import asyncio
import os
import random
import signal
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any


import select

# Force UTF-8 encoding for Windows console
if sys.platform == "win32":
    if sys.stdout.encoding != "utf-8":
        os.environ["PYTHONIOENCODING"] = "utf-8"
        # Re-open stdout/stderr with UTF-8 encoding
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

import typer
from loguru import logger
from prompt_toolkit import PromptSession, print_formatted_text
from prompt_toolkit.application import Application, run_in_terminal
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import ANSI, HTML
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys
from prompt_toolkit.layout import ConditionalContainer, HSplit, Layout, VSplit, Window


from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import Frame, TextArea

from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table
from rich.text import Text

from tinybot import __logo__, __version__
from tinybot.cli.stream import StreamRenderer, ThinkingSpinner, _THINKING_MESSAGES

from tinybot.config.paths import get_cli_history_path, get_workspace_path, is_default_workspace

from tinybot.config.schema import Config
from tinybot.utils.helper import sync_workspace_templates
from tinybot.utils.restart import (
    consume_restart_notice_from_env,
    format_restart_completed_message,
    should_show_cli_restart_notice,
)

app = typer.Typer(
    name="tinybot",
    context_settings={"help_option_names": ["-h", "--help"]},
    help=f"{__logo__} tinybot - Personal AI Assistant",
    no_args_is_help=True,
)

console = Console()
EXIT_COMMANDS = {"exit", "quit", "/exit", "/quit", ":q"}
_UI_SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
_UI_REPLY_MESSAGES = (
    "tinybot is drafting a reply...",
    "tinybot is choosing the clearest words...",
    "tinybot is turning thoughts into tokens...",
    "tinybot is polishing the response...",
    "tinybot is typing with robotic confidence...",
)

# ---------------------------------------------------------------------------

# CLI input: prompt_toolkit for editing, paste, history, and display
# ---------------------------------------------------------------------------

_PROMPT_SESSION: PromptSession | None = None
_SAVED_TERM_ATTRS = None  # original termios settings, restored on exit


def _flush_pending_tty_input() -> None:
    """Drop unread keypresses typed while the model was generating output."""
    try:
        fd = sys.stdin.fileno()
        if not os.isatty(fd):
            return
    except Exception:
        return

    try:
        import termios
        termios.tcflush(fd, termios.TCIFLUSH)
        return
    except Exception:
        pass

    try:
        while True:
            ready, _, _ = select.select([fd], [], [], 0)
            if not ready:
                break
            if not os.read(fd, 4096):
                break
    except Exception:
        return


def _restore_terminal() -> None:
    """Restore terminal to its original state (echo, line buffering, etc.)."""
    if _SAVED_TERM_ATTRS is None:
        return
    try:
        import termios
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _SAVED_TERM_ATTRS)
    except Exception:
        pass


def _init_prompt_session() -> None:
    """Create the prompt_toolkit session with persistent file history."""
    global _PROMPT_SESSION, _SAVED_TERM_ATTRS

    # Save terminal state so we can restore it on exit
    try:
        import termios
        _SAVED_TERM_ATTRS = termios.tcgetattr(sys.stdin.fileno())
    except Exception:
        pass

    from tinybot.config.paths import get_cli_history_path

    history_file = get_cli_history_path()
    history_file.parent.mkdir(parents=True, exist_ok=True)

    _PROMPT_SESSION = PromptSession(
        history=FileHistory(str(history_file)),
        enable_open_in_editor=False,
        multiline=False,  # Enter submits (single line mode)
    )


def _make_console() -> Console:
    return Console(file=sys.stdout)


def _render_interactive_ansi(render_fn) -> str:
    """Render Rich output to ANSI so prompt_toolkit can print it safely."""
    ansi_console = Console(
        force_terminal=True,
        color_system=console.color_system or "standard",
        width=console.width,
    )
    with ansi_console.capture() as capture:
        render_fn(ansi_console)
    return capture.get()


def _print_agent_response(
        response: str,
        render_markdown: bool,
        metadata: dict | None = None,
) -> None:
    """Render assistant response with consistent terminal styling."""
    console = _make_console()
    content = response or ""
    body = _response_renderable(content, render_markdown, metadata)
    console.print()
    console.print(f"[cyan]{__logo__} tinybot[/cyan]")
    console.print(body)
    console.print()


def _response_renderable(content: str, render_markdown: bool, metadata: dict | None = None):
    """Render plain-text command output without markdown collapsing newlines."""
    if not render_markdown:
        return Text(content)
    if (metadata or {}).get("render_as") == "text":
        return Text(content)
    return Markdown(content)


async def _print_interactive_line(text: str) -> None:
    """Print async interactive updates with prompt_toolkit-safe Rich styling."""

    def _write() -> None:
        ansi = _render_interactive_ansi(
            lambda c: c.print(f"  [dim]↳ {text}[/dim]")
        )
        print_formatted_text(ANSI(ansi), end="")

    await run_in_terminal(_write)


async def _print_interactive_response(
        response: str,
        render_markdown: bool,
        metadata: dict | None = None,
) -> None:
    """Print async interactive replies with prompt_toolkit-safe Rich styling."""

    def _write() -> None:
        content = response or ""
        ansi = _render_interactive_ansi(
            lambda c: (
                c.print(),
                c.print(f"[cyan]{__logo__} tinybot[/cyan]"),
                c.print(_response_renderable(content, render_markdown, metadata)),
                c.print(),
            )
        )
        print_formatted_text(ANSI(ansi), end="")

    await run_in_terminal(_write)


def _print_cli_progress_line(text: str, thinking: ThinkingSpinner | None) -> None:
    """Print a CLI progress line, pausing the spinner if needed."""
    with thinking.pause() if thinking else nullcontext():
        console.print(f"  [dim]↳ {text}[/dim]")


async def _print_interactive_progress_line(text: str, thinking: ThinkingSpinner | None) -> None:
    """Print an interactive progress line, pausing the spinner if needed."""
    with thinking.pause() if thinking else nullcontext():
        await _print_interactive_line(text)


def _is_exit_command(command: str) -> bool:
    """Return True when input should end interactive chat."""
    return command.lower() in EXIT_COMMANDS


async def _read_interactive_input_async() -> str:
    """Read user input using prompt_toolkit (handles paste, history, display).

    prompt_toolkit natively handles:
    - Multiline paste (bracketed paste mode)
    - History navigation (up/down arrows)
    - Clean display (no ghost characters or artifacts)
    """
    if _PROMPT_SESSION is None:
        raise RuntimeError("Call _init_prompt_session() first")
    try:
        with patch_stdout():
            return await _PROMPT_SESSION.prompt_async(
                HTML("<b fg='ansiblue'>You:</b> "),
            )
    except EOFError as exc:
        raise KeyboardInterrupt from exc


def _format_task_progress_text(snapshot: dict[str, Any]) -> str:
    """Render task progress as compact plain text for the full-screen UI."""
    plans = sorted(
        snapshot.get("plans", []),
        key=lambda plan: (
            0 if plan.get("active") else 1,
            -plan.get("last_update", 0.0),
        ),
    )
    if not plans:
        return ""

    # Use simple ASCII symbols for better terminal compatibility
    plan_icons = {
        "planning": "[*]",
        "executing": "[>]",
        "completed": "[+]",
        "failed": "[!]",
        "paused": "[=]",
    }
    status_icons = {
        "pending": "  ",
        "in_progress": "> ",
        "completed": "+ ",
        "failed": "! ",
        "skipped": "- ",
    }

    lines: list[str] = []
    for index, plan in enumerate(plans):
        if index:
            lines.append("")
        total = plan.get("total", 0)
        completed = plan.get("completed", 0)
        failed = plan.get("failed", 0)
        skipped = plan.get("skipped", 0)
        pct = (completed / total * 100) if total > 0 else 0
        icon = plan_icons.get(plan.get("plan_status", "planning"), "[?]")
        status_label = plan.get("plan_status", "planning")
        header = f"{icon} {plan.get('plan_title', 'Task')} [{completed}/{total} ({pct:.0f}%)] {status_label}"
        if failed:
            header += f"  failed={failed}"
        if skipped:
            header += f"  skipped={skipped}"
        lines.append(header)

        for subtask in plan.get("subtasks", []):
            status = subtask.get("status", "pending")
            sub_icon = status_icons.get(status, "❓")
            title = (subtask.get("title") or "").strip() or "Untitled task"
            error = (subtask.get("error") or "").strip()
            line = f"  {sub_icon} {title}"
            if error and status == "failed":
                line += f" — {error[:60]}"
            lines.append(line)

        meta: list[str] = []
        if plan.get("current"):
            meta.append(f"current: {plan['current']}")
        if plan.get("next"):
            meta.append(f"next: {plan['next']}")
        if meta:
            lines.append("  " + " | ".join(meta))

    return "\n".join(lines)


class InteractiveChatUI:
    """Full-screen interactive CLI with fixed bottom input."""

    def __init__(
        self,
        *,
        render_markdown: bool,
        history: FileHistory,
        on_submit,
        initial_transcript: list[str] | None = None,
    ):
        self._render_markdown = render_markdown
        self._on_submit = on_submit
        self._blocks: list[str] = [block for block in (initial_transcript or []) if block.strip()]
        self._current_response = ""
        self._current_reasoning = ""
        self._progress_text = ""
        self._busy = False
        self._status = "Press Enter to send, Ctrl+C to exit"
        self._busy_mode = "thinking"
        self._busy_message = ""
        self._spinner_index = 0
        self._spinner_task: asyncio.Task | None = None
        self._transcript_follow = True

        self._transcript = TextArea(
            text="",
            read_only=True,
            focusable=False,
            scrollbar=True,
            wrap_lines=True,
            style="class:transcript-area",
        )
        self._progress = TextArea(
            text="",
            read_only=True,
            focusable=False,
            scrollbar=True,
            wrap_lines=False,
            height=10,
            style="class:progress-area",
        )
        self._input = TextArea(
            text="",
            multiline=False,
            wrap_lines=False,
            history=history,
            accept_handler=self._accept_input,
            style="class:input-field",
        )

        kb = KeyBindings()

        @kb.add("c-c")
        def _exit(_event) -> None:
            self.exit()

        @kb.add("escape")
        def _focus_input(event) -> None:
            event.app.layout.focus(self._input)

        @kb.add(Keys.ScrollUp, eager=True)
        def _scroll_up(_event) -> None:
            self._scroll_transcript(-3)

        @kb.add(Keys.ScrollDown, eager=True)
        def _scroll_down(_event) -> None:
            self._scroll_transcript(3)


        @kb.add("pageup", eager=True)
        def _page_up(_event) -> None:
            self._scroll_transcript(-12)

        @kb.add("pagedown", eager=True)
        def _page_down(_event) -> None:
            self._scroll_transcript(12)

        self._show_progress = Condition(lambda: bool(self._progress.text.strip()))
        self._show_activity = Condition(lambda: self._busy)
        progress_container = ConditionalContainer(
            content=Frame(self._progress, title="Task Progress", style="class:panel"),
            filter=self._show_progress,
        )
        activity_container = ConditionalContainer(
            content=Window(
                content=FormattedTextControl(self._activity_fragments),
                height=1,
                style="class:activity-bar",
            ),
            filter=self._show_activity,
        )
        input_row = VSplit([
            Window(
                content=FormattedTextControl(lambda: [("class:prompt", "You: ")]),
                width=5,
                dont_extend_width=True,
            ),
            self._input,
        ], height=1)
        status_bar = Window(
            content=FormattedTextControl(self._status_fragments),
            height=1,
            style="class:status",
        )
        style = Style.from_dict({
            "": "bg:#11121a #c0caf5",
            "frame.border": "#414868",
            "frame.label": "bold #7dcfff",
            "panel": "bg:#11121a",
            "transcript-area": "bg:#11121a #c0caf5",
            "progress-area": "bg:#0f1720 #a9b1d6",
            "input-field": "bg:#1a1b26 #e5e9f0",
            "prompt": "bold #7aa2f7",
            "status": "bg:#1f2335 #c0caf5",
            "activity-bar": "bg:#16161e",
            "activity.thinking": "bold #e0af68",
            "activity.replying": "bold #7dcfff",
        })

        self._app = Application(
            layout=Layout(
                HSplit([
                    progress_container,
                    activity_container,
                    Frame(self._transcript, title="Conversation", style="class:panel"),
                    input_row,
                    status_bar,
                ]),
                focused_element=self._input,
            ),
            key_bindings=kb,
            full_screen=True,
            mouse_support=True,
            style=style,
        )
        self._refresh_views()

    def _status_fragments(self):
        if self._busy:
            label = "tinybot is thinking..." if self._busy_mode == "thinking" else "tinybot is replying..."
            return [("class:status", f" {label} · Scroll -> PageUp/PageDown the conversation · Esc to return to the bottom input ")]
        return [("class:status", f" {self._status} · Scroll -> PageUp/PageDown the conversation · Esc to return to the bottom input ")]

    def _activity_fragments(self):
        if not self._busy:
            return []
        spinner = _UI_SPINNER_FRAMES[self._spinner_index % len(_UI_SPINNER_FRAMES)]
        style = "class:activity.thinking" if self._busy_mode == "thinking" else "class:activity.replying"
        message = self._busy_message or ("tinybot is thinking..." if self._busy_mode == "thinking" else "tinybot is replying...")
        return [(style, f" {spinner} {message} ")]

    def _start_spinner(self) -> None:
        if self._spinner_task and not self._spinner_task.done():
            return

        async def _animate() -> None:
            try:
                while self._busy:
                    await asyncio.sleep(0.12)
                    self._spinner_index = (self._spinner_index + 1) % len(_UI_SPINNER_FRAMES)
                    self._invalidate()
            except asyncio.CancelledError:
                pass

        self._spinner_task = asyncio.create_task(_animate())

    def _stop_spinner(self) -> None:
        task = self._spinner_task
        self._spinner_task = None
        self._spinner_index = 0
        if task:
            task.cancel()

    def _set_busy_mode(self, mode: str, *, refresh_message: bool = False) -> None:
        self._busy = True
        if refresh_message or self._busy_mode != mode or not self._busy_message:
            pool = _THINKING_MESSAGES if mode == "thinking" else _UI_REPLY_MESSAGES
            self._busy_message = random.choice(pool)
        self._busy_mode = mode
        self._status = "tinybot is thinking..." if mode == "thinking" else "tinybot is replying..."
        self._start_spinner()

    def _finish_busy_state(self) -> None:
        self._busy = False
        self._busy_mode = "thinking"
        self._busy_message = ""
        self._status = "Press Enter to send, Ctrl+C to exit"
        self._stop_spinner()

    def _scroll_transcript(self, lines: int) -> None:
        buffer = self._transcript.buffer
        if not buffer.text:
            return
        self._transcript_follow = False
        if lines < 0:
            buffer.cursor_up(count=-lines)
        elif lines > 0:
            buffer.cursor_down(count=lines)
        self._transcript_follow = buffer.cursor_position >= len(buffer.text)
        self._invalidate()

    def _accept_input(self, buffer) -> bool:
        text = buffer.text.strip()
        if not text:
            buffer.set_document(Document(""), bypass_readonly=True)
            return False
        if self._busy:
            self._status = "正在回复中；请稍候再发送"
            buffer.set_document(Document(buffer.text, cursor_position=len(buffer.text)), bypass_readonly=True)
            self._invalidate()
            return True

        asyncio.create_task(self._submit_text(text))
        buffer.set_document(Document(""), bypass_readonly=True)
        return False

    async def _submit_text(self, text: str) -> None:
        self._transcript_follow = True
        self._set_busy_mode("thinking", refresh_message=True)
        self._append_block(f"You: {text}")
        self._refresh_views()
        await self._on_submit(text)

    def _append_block(self, text: str) -> None:
        block = text.rstrip()
        if block:
            self._blocks.append(block)

    def _assistant_block(self, content: str, reasoning: str = "") -> str:
        parts = [f"{__logo__} tinybot"]
        clean_reasoning = reasoning.rstrip()
        clean_content = content.rstrip()
        if clean_reasoning:
            parts.extend(["Thinking:", clean_reasoning])
        if clean_content:
            parts.append(clean_content)
        return "\n".join(parts).rstrip()

    def _render_transcript_text(self) -> str:
        blocks = list(self._blocks)
        if self._current_reasoning or self._current_response:
            blocks.append(self._assistant_block(self._current_response, self._current_reasoning))
        return "\n\n".join(block for block in blocks if block).rstrip()

    def _set_textarea_text(self, area: TextArea, text: str, *, follow_end: bool) -> None:
        buffer = area.buffer
        if buffer.text == text:
            return
        cursor_position = len(text) if follow_end else min(buffer.cursor_position, len(text))
        buffer.set_document(Document(text, cursor_position=cursor_position), bypass_readonly=True)

    def _refresh_views(self) -> None:
        self._set_textarea_text(self._transcript, self._render_transcript_text(), follow_end=self._transcript_follow)
        self._set_textarea_text(self._progress, self._progress_text, follow_end=True)
        self._invalidate()

    def _invalidate(self) -> None:
        if self._app.is_running:
            self._app.invalidate()

    def set_task_progress(self, snapshot: dict[str, Any]) -> None:
        self._progress_text = _format_task_progress_text(snapshot)
        self._refresh_views()

    def add_progress_line(self, text: str) -> None:
        self._append_block(f"↳ {text}")
        self._refresh_views()

    def on_reasoning_delta(self, delta: str) -> None:
        self._set_busy_mode("thinking")
        self._current_reasoning += delta
        self._refresh_views()

    def on_stream_delta(self, delta: str) -> None:
        if not self._current_response:
            self._set_busy_mode("replying", refresh_message=True)
        else:
            self._set_busy_mode("replying")
        self._current_response += delta
        self._refresh_views()

    def on_stream_end(self, *, resuming: bool = False) -> None:
        if self._current_reasoning or self._current_response:
            self._append_block(self._assistant_block(self._current_response, self._current_reasoning))
            self._current_reasoning = ""
            self._current_response = ""
            self._refresh_views()
        if resuming:
            self._set_busy_mode("thinking", refresh_message=True)
        else:
            self._finish_busy_state()
            self._refresh_views()

    def add_assistant_response(
        self,
        response: str,
        metadata: dict | None = None,
    ) -> None:
        content = response or ""
        if content:
            self._append_block(self._assistant_block(content))
        self._finish_busy_state()
        self._refresh_views()

    def finish_turn(self) -> None:
        self._finish_busy_state()
        self._refresh_views()

    async def run(self) -> None:
        await self._app.run_async()

    def exit(self) -> None:
        self._stop_spinner()
        if self._app.is_running:
            self._app.exit()



def version_callback(value: bool):

    if value:
        console.print(f"{__logo__} tinybot v{__version__}")
        raise typer.Exit()


@app.callback()
def main(
        version: bool = typer.Option(
            None, "--version", "-v", callback=version_callback, is_eager=True
        ),
):
    """tinybot - Personal AI Assistant."""
    pass


# ============================================================================
# Onboard / Setup
# ============================================================================


@app.command()
def onboard(
        workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
        config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
        wizard: bool = typer.Option(False, "--wizard", help="Use interactive wizard"),
):
    """Initialize tinybot configuration and workspace."""
    from tinybot.config.loader import get_config_path, load_config, save_config, set_config_path
    from tinybot.config.schema import Config

    if config:
        config_path = Path(config).expanduser().resolve()
        set_config_path(config_path)
        console.print(f"[dim]Using config: {config_path}[/dim]")
    else:
        config_path = get_config_path()

    def _apply_workspace_override(loaded: Config) -> Config:
        if workspace:
            loaded.agents.defaults.workspace = workspace
        return loaded

    # Create or update config
    if config_path.exists():
        if wizard:
            config = _apply_workspace_override(load_config(config_path))
        else:
            console.print(f"[yellow]Config already exists at {config_path}[/yellow]")
            console.print("  [bold]y[/bold] = overwrite with defaults (existing values will be lost)")
            console.print("  [bold]N[/bold] = refresh config, keeping existing values and adding new fields")
            if typer.confirm("Overwrite?"):
                config = _apply_workspace_override(Config())
                save_config(config, config_path)
                console.print(f"[green]✓[/green] Config reset to defaults at {config_path}")
            else:
                config = _apply_workspace_override(load_config(config_path))
                save_config(config, config_path)
                console.print(f"[green]✓[/green] Config refreshed at {config_path} (existing values preserved)")
    else:
        config = _apply_workspace_override(Config())
        # In wizard mode, don't save yet - the wizard will handle saving if should_save=True
        if not wizard:
            save_config(config, config_path)
            console.print(f"[green]✓[/green] Created config at {config_path}")

    # Run interactive wizard if enabled
    if wizard:
        from tinybot.cli.onboard import run_onboard

        try:
            result = run_onboard(initial_config=config)
            if not result.should_save:
                console.print("[yellow]Configuration discarded. No changes were saved.[/yellow]")
                return

            config = result.config
            save_config(config, config_path)
            console.print(f"[green]✓[/green] Config saved at {config_path}")
        except Exception as e:
            console.print(f"[red]✗[/red] Error during configuration: {e}")
            console.print("[yellow]Please run 'tinybot onboard' again to complete setup.[/yellow]")
            raise typer.Exit(1)
    _onboard_plugins(config_path)

    # Create workspace, preferring the configured workspace path.
    workspace_path = get_workspace_path(config.workspace_path)
    if not workspace_path.exists():
        workspace_path.mkdir(parents=True, exist_ok=True)
        console.print(f"[green]✓[/green] Created workspace at {workspace_path}")

    sync_workspace_templates(workspace_path)

    agent_cmd = 'tinybot agent -m "Hello!"'
    gateway_cmd = "tinybot gateway"
    if config:
        agent_cmd += f" --config {config_path}"
        gateway_cmd += f" --config {config_path}"

    console.print(f"\n{__logo__} tinybot is ready!")
    console.print("\nNext steps:")
    if wizard:
        console.print(f"  1. Chat: [cyan]{agent_cmd}[/cyan]")
        console.print(f"  2. Start gateway: [cyan]{gateway_cmd}[/cyan]")
    else:
        console.print(f"  1. Add your API key to [cyan]{config_path}[/cyan]")
        console.print("     Get one at: https://openrouter.ai/keys")
        console.print(f"  2. Chat: [cyan]{agent_cmd}[/cyan]")

def _merge_missing_defaults(existing: Any, defaults: Any) -> Any:
    """Recursively fill in missing values from defaults without overwriting user config."""
    if not isinstance(existing, dict) or not isinstance(defaults, dict):
        return existing

    merged = dict(existing)
    for key, value in defaults.items():
        if key not in merged:
            merged[key] = value
        else:
            merged[key] = _merge_missing_defaults(merged[key], value)
    return merged


def _onboard_plugins(config_path: Path) -> None:
    """Inject default config for all discovered channels (built-in + plugins)."""
    import json

    from tinybot.channels.registry import discover_all

    all_channels = discover_all()
    if not all_channels:
        return

    with open(config_path, encoding="utf-8") as f:
        data = json.load(f)

    channels = data.setdefault("channels", {})
    for name, cls in all_channels.items():
        if name not in channels:
            channels[name] = cls.default_config()
        else:
            channels[name] = _merge_missing_defaults(channels[name], cls.default_config())

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ============================================================================
# Config Editor TUI
# ============================================================================


@app.command()
def config_edit(
        config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
        skip_onboard: bool = typer.Option(False, "--skip-onboard", help="Skip onboarding wizard for new configs"),
):
    """Launch interactive TUI configuration editor.

    If no config file exists, runs onboarding wizard first to set up basic configuration.
    Use --skip-onboard to create a default config without the wizard.
    """
    from tinybot.cli.config_editor import run_config_editor
    from tinybot.config.loader import get_config_path, load_config, save_config, set_config_path

    if config:
        config_path = Path(config).expanduser().resolve()
        if not config_path.exists():
            console.print(f"[red]Error: Config file not found: {config_path}[/red]")
            raise typer.Exit(1)
        set_config_path(config_path)
        console.print(f"[dim]Using config: {config_path}[/dim]")
    else:
        config_path = get_config_path()

    # Handle missing config file
    if not config_path.exists():
        if skip_onboard:
            # Create default config without wizard
            console.print(f"[dim]Creating default config at {config_path}[/dim]")
            config_obj = Config()
            save_config(config_obj, config_path)
            _onboard_plugins(config_path)
            console.print(f"[green]✓[/green] Created config at {config_path}")
        else:
            # Run onboarding wizard for new config
            console.print(f"[dim]No config found at {config_path}[/dim]")
            console.print("[cyan]Starting onboarding wizard...[/cyan]")

            from tinybot.cli.onboard import run_onboard

            try:
                result = run_onboard(initial_config=Config())
                if not result.should_save:
                    console.print("[yellow]Configuration cancelled. No config file created.[/yellow]")
                    raise typer.Exit(0)

                config_obj = result.config
                save_config(config_obj, config_path)
                _onboard_plugins(config_path)
                console.print(f"[green]✓[/green] Config saved at {config_path}")
            except Exception as e:
                console.print(f"[red]✗[/red] Error during onboarding: {e}")
                console.print("[yellow]You can run 'tinybot config-edit --skip-onboard' to create a default config.[/yellow]")
                raise typer.Exit(1)
    else:
        config_obj = load_config(config_path)

    def save_callback(cfg: Config) -> None:
        save_config(cfg, config_path)

    try:
        run_config_editor(config_obj, save_callback)
        console.print(f"[green]✓[/green] Config saved at {config_path}")
    except KeyboardInterrupt:
        console.print("\n[yellow]Configuration editor closed[/yellow]")
    except Exception as e:
        console.print(f"[red]✗[/red] Error running config editor: {e}")
        raise typer.Exit(1)


def _make_provider(config: Config):
    """Create the appropriate LLM provider from config.

    Routing is driven by ``ProviderSpec.backend`` in the registry.
    """
    from tinybot.providers.registry import create_provider

    def _on_missing_key(provider_name: str) -> None:
        console.print("[red]Error: No API key configured.[/red]")
        console.print("Set one in ~/.tinybot/config.json under providers section")
        raise typer.Exit(1)

    return create_provider(config, on_missing_key=_on_missing_key)


def _load_runtime_config(config: str | None = None, workspace: str | None = None) -> Config:
    """Load config and optionally override the active workspace."""
    from tinybot.config.loader import load_config, set_config_path

    config_path = None
    if config:
        config_path = Path(config).expanduser().resolve()
        if not config_path.exists():
            console.print(f"[red]Error: Config file not found: {config_path}[/red]")
            raise typer.Exit(1)
        set_config_path(config_path)
        console.print(f"[dim]Using config: {config_path}[/dim]")

    loaded = load_config(config_path)
    _warn_deprecated_config_keys(config_path)
    if workspace:
        loaded.agents.defaults.workspace = workspace
    return loaded


def _warn_deprecated_config_keys(config_path: Path | None) -> None:
    """Hint users to remove obsolete keys from their config file."""
    import json
    from tinybot.config.loader import get_config_path

    path = config_path or get_config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    if "memoryWindow" in raw.get("agents", {}).get("defaults", {}):
        console.print(
            "[dim]Hint: `memoryWindow` in your config is no longer used "
            "and can be safely removed.[/dim]"
        )


def _migrate_cron_store(config: "Config") -> None:
    """One-time migration: move legacy global cron store into the workspace."""
    from tinybot.config.paths import get_cron_dir

    legacy_path = get_cron_dir() / "jobs.json"
    new_path = config.workspace_path / "cron" / "jobs.json"
    if legacy_path.is_file() and not new_path.exists():
        new_path.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.move(str(legacy_path), str(new_path))


# ============================================================================
# OpenAI-Compatible API Server
# ============================================================================


@app.command()
def serve(
        port: int | None = typer.Option(None, "--port", "-p", help="API server port"),
        host: str | None = typer.Option(None, "--host", "-H", help="Bind address"),
        timeout: float | None = typer.Option(None, "--timeout", "-t", help="Per-request timeout (seconds)"),
        verbose: bool = typer.Option(False, "--verbose", "-v", help="Show tinybot runtime logs"),
        workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
        config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Start the OpenAI-compatible API server (/v1/chat/completions)."""
    try:
        from aiohttp import web  # noqa: F401
    except ImportError:
        console.print("[red]aiohttp is required. Install with: pip install 'tinybot-ai[api]'[/red]")
        raise typer.Exit(1)

    from loguru import logger
    from tinybot.agent.loop import AgentLoop
    from tinybot.api.server import create_app
    from tinybot.bus.queue import MessageBus
    from tinybot.session.manager import SessionManager

    if verbose:
        logger.enable("tinybot")
    else:
        logger.disable("tinybot")

    runtime_config = _load_runtime_config(config, workspace)
    api_cfg = runtime_config.api
    host = host if host is not None else api_cfg.host
    port = port if port is not None else api_cfg.port
    timeout = timeout if timeout is not None else api_cfg.timeout
    sync_workspace_templates(runtime_config.workspace_path)
    bus = MessageBus()
    provider = _make_provider(runtime_config)
    session_manager = SessionManager(runtime_config.workspace_path)
    agent_loop = AgentLoop.from_config(
        runtime_config, bus, provider,
        session_manager=session_manager,
    )

    model_name = runtime_config.agents.defaults.model
    console.print(f"{__logo__} Starting OpenAI-compatible API server")
    console.print(f"  [cyan]Endpoint[/cyan] : http://{host}:{port}/v1/chat/completions")
    console.print(f"  [cyan]Model[/cyan]    : {model_name}")
    console.print("  [cyan]Session[/cyan]  : api:default")
    console.print(f"  [cyan]Timeout[/cyan]  : {timeout}s")
    if host in {"0.0.0.0", "::"}:
        console.print(
            "[yellow]Warning:[/yellow] API is bound to all interfaces. "
            "Only do this behind a trusted network boundary, firewall, or reverse proxy."
        )
    console.print()

    api_app = create_app(agent_loop, model_name=model_name, request_timeout=timeout)

    async def on_startup(_app):
        await agent_loop._connect_mcp()

    async def on_cleanup(_app):
        await agent_loop.close_mcp()

    api_app.on_startup.append(on_startup)
    api_app.on_cleanup.append(on_cleanup)

    web.run_app(api_app, host=host, port=port, print=lambda msg: logger.info(msg))


# ============================================================================
# Gateway / Server
# ============================================================================


@app.command()
def gateway(
        port: int | None = typer.Option(None, "--port", "-p", help="Gateway port"),
        workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
        verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
        config: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Start the tinybot gateway."""
    from tinybot.agent.loop import AgentLoop
    from tinybot.bus.queue import MessageBus
    from tinybot.channels.manager import ChannelManager
    from tinybot.cron.service import CronService
    from tinybot.cron.types import CronJob
    from tinybot.heartbeat.service import HeartbeatService
    from tinybot.session.manager import SessionManager

    if verbose:
        import logging
        logging.basicConfig(level=logging.DEBUG)

    config = _load_runtime_config(config, workspace)
    port = port if port is not None else config.gateway.port

    console.print(f"{__logo__} Starting tinybot gateway version {__version__} on port {port}...")
    sync_workspace_templates(config.workspace_path)
    bus = MessageBus()
    provider = _make_provider(config)
    session_manager = SessionManager(config.workspace_path)

    # Preserve existing single-workspace installs, but keep custom workspaces clean.
    if is_default_workspace(config.workspace_path):
        _migrate_cron_store(config)

    # Create cron service with workspace-scoped store
    cron_store_path = config.workspace_path / "cron" / "jobs.json"
    cron = CronService(cron_store_path)

    # Create agent with cron service
    agent = AgentLoop.from_config(
        config, bus, provider,
        cron_service=cron,
        session_manager=session_manager,
    )

    # Set cron callback (needs agent)
    async def on_cron_job(job: CronJob) -> str | None:
        """Execute a cron job through the agent."""
        # Dream is an internal job — run directly, not through the agent loop.
        if job.name == "dream":
            try:
                await agent.dream.run()
                logger.info("Dream cron job completed")
            except Exception:
                logger.exception("Dream cron job failed")
            return None

        from tinybot.agent.tools.cron import CronTool
        from tinybot.agent.tools.message import MessageTool
        from tinybot.utils.evaluator import evaluate_response

        reminder_note = (
            "[Scheduled Task] Timer finished.\n\n"
            f"Task '{job.name}' has been triggered.\n"
            f"Scheduled instruction: {job.payload.message}"
        )

        cron_tool = agent.tools.get("cron")
        cron_token = None
        if isinstance(cron_tool, CronTool):
            cron_token = cron_tool.set_cron_context(True)
        try:
            resp = await agent.process_direct(
                reminder_note,
                session_key=f"cron:{job.id}",
                channel=job.payload.channel or "cli",
                chat_id=job.payload.to or "direct",
            )
        finally:
            if isinstance(cron_tool, CronTool) and cron_token is not None:
                cron_tool.reset_cron_context(cron_token)

        response = resp.content if resp else ""

        message_tool = agent.tools.get("message")
        if isinstance(message_tool, MessageTool) and message_tool._sent_in_turn:
            return response

        if job.payload.deliver and job.payload.to and response:
            should_notify = await evaluate_response(
                response, job.payload.message, provider, agent.model,
            )
            if should_notify:
                from tinybot.bus.events import OutboundMessage
                await bus.publish_outbound(OutboundMessage(
                    channel=job.payload.channel or "cli",
                    chat_id=job.payload.to,
                    content=response,
                ))
        return response

    cron.on_job = on_cron_job

    # Create channel manager
    channels = ChannelManager(config, bus)

    def _pick_heartbeat_target() -> tuple[str, str]:
        """Pick a routable channel/chat target for heartbeat-triggered messages."""
        enabled = set(channels.enabled_channels)
        # Prefer the most recently updated non-internal session on an enabled channel.
        for item in session_manager.list_sessions():
            key = item.get("key") or ""
            if ":" not in key:
                continue
            channel, chat_id = key.split(":", 1)
            if channel in {"cli", "system"}:
                continue
            if channel in enabled and chat_id:
                return channel, chat_id
        # Fallback keeps prior behavior but remains explicit.
        return "cli", "direct"

    # Create heartbeat service
    async def on_heartbeat_execute(tasks: str) -> str:
        """Phase 2: execute heartbeat tasks through the full agent loop."""
        channel, chat_id = _pick_heartbeat_target()

        async def _silent(*_args, **_kwargs):
            pass

        resp = await agent.process_direct(
            tasks,
            session_key="heartbeat",
            channel=channel,
            chat_id=chat_id,
            on_progress=_silent,
        )

        # Keep a small tail of heartbeat history so the loop stays bounded
        # without losing all short-term context between runs.
        session = agent.sessions.get_or_create("heartbeat")
        session.retain_recent_legal_suffix(hb_cfg.keep_recent_messages)
        agent.sessions.save(session)

        return resp.content if resp else ""

    async def on_heartbeat_notify(response: str) -> None:
        """Deliver a heartbeat response to the user's channel."""
        from tinybot.bus.events import OutboundMessage
        channel, chat_id = _pick_heartbeat_target()
        if channel == "cli":
            return  # No external channel available to deliver to
        await bus.publish_outbound(OutboundMessage(channel=channel, chat_id=chat_id, content=response))

    hb_cfg = config.gateway.heartbeat
    heartbeat = HeartbeatService(
        workspace=config.workspace_path,
        provider=provider,
        model=agent.model,
        on_execute=on_heartbeat_execute,
        on_notify=on_heartbeat_notify,
        interval_s=hb_cfg.interval_s,
        enabled=hb_cfg.enabled,
        timezone=config.agents.defaults.timezone,
    )

    if channels.enabled_channels:
        console.print(f"[green]✓[/green] Channels enabled: {', '.join(channels.enabled_channels)}")
    else:
        console.print("[yellow]Warning: No channels enabled[/yellow]")

    cron_status = cron.status()
    if cron_status["jobs"] > 0:
        console.print(f"[green]✓[/green] Cron: {cron_status['jobs']} scheduled jobs")

    console.print(f"[green]✓[/green] Heartbeat: every {hb_cfg.interval_s}s")

    # Register Dream system job (always-on, idempotent on restart)
    dream_cfg = config.agents.defaults.dream
    if dream_cfg.model_override:
        agent.dream.model = dream_cfg.model_override
    agent.dream.max_batch_size = dream_cfg.max_batch_size
    agent.dream.max_iterations = dream_cfg.max_iterations
    from tinybot.cron.types import CronJob, CronPayload
    cron.register_system_job(CronJob(
        id="dream",
        name="dream",
        schedule=dream_cfg.build_schedule(config.agents.defaults.timezone),
        payload=CronPayload(kind="system_event"),
    ))
    console.print(f"[green]✓[/green] Dream: {dream_cfg.describe_schedule()}")

    async def run():
        try:
            await cron.start()
            await heartbeat.start()
            await asyncio.gather(
                agent.run(),
                channels.start_all(),
            )
        except KeyboardInterrupt:
            console.print("\nShutting down...")
        except Exception:
            import traceback
            console.print("\n[red]Error: Gateway crashed unexpectedly[/red]")
            console.print(traceback.format_exc())
        finally:
            await agent.close_mcp()
            heartbeat.stop()
            cron.stop()
            agent.stop()
            await channels.stop_all()

    asyncio.run(run())


# ============================================================================
# Agent Commands
# ============================================================================


@app.command()
def agent(
        message: str = typer.Option(None, "--message", "-m", help="Message to send to the agent"),
        session_id: str = typer.Option("cli:direct", "--session", "-s", help="Session ID"),
        workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
        config: str | None = typer.Option(None, "--config", "-c", help="Config file path"),
        markdown: bool = typer.Option(True, "--markdown/--no-markdown", help="Render assistant output as Markdown"),
        logs: bool = typer.Option(False, "--logs/--no-logs", help="Show tinybot runtime logs during chat"),
):
    """Interact with the agent directly."""
    from loguru import logger

    from tinybot.agent.loop import AgentLoop
    from tinybot.bus.queue import MessageBus
    from tinybot.cron.service import CronService

    config = _load_runtime_config(config, workspace)
    sync_workspace_templates(config.workspace_path)

    bus = MessageBus()
    provider = _make_provider(config)

    # Preserve existing single-workspace installs, but keep custom workspaces clean.
    if is_default_workspace(config.workspace_path):
        _migrate_cron_store(config)

    # Create cron service with workspace-scoped store
    cron_store_path = config.workspace_path / "cron" / "jobs.json"
    cron = CronService(cron_store_path)

    if logs:
        logger.enable("tinybot")
    else:
        logger.disable("tinybot")

    agent_loop = AgentLoop.from_config(
        config, bus, provider,
        cron_service=cron,
    )
    restart_notice_text = None
    restart_notice = consume_restart_notice_from_env()
    if restart_notice and should_show_cli_restart_notice(restart_notice, session_id):
        restart_notice_text = format_restart_completed_message(restart_notice.started_at_raw)
        if message:
            _print_agent_response(restart_notice_text, render_markdown=False)


    # Shared reference for progress callbacks
    _thinking: ThinkingSpinner | None = None

    async def _cli_progress(content: str, *, tool_hint: bool = False) -> None:
        ch = agent_loop.channels_config
        if ch and tool_hint and not ch.send_tool_hints:
            return
        if ch and not tool_hint and not ch.send_progress:
            return
        _print_cli_progress_line(content, _thinking)

    if message:
        # Single message mode — direct call, no bus needed
        async def run_once():
            renderer = StreamRenderer(render_markdown=markdown)
            response = await agent_loop.process_direct(
                message,
                session_id,
                on_progress=_cli_progress,
                on_stream=renderer.on_delta,
                on_reasoning_stream=renderer.on_reasoning_delta,
                on_stream_end=renderer.on_end,
            )
            if not renderer.streamed:
                await renderer.close()
                _print_agent_response(
                    response.content if response else "",
                    render_markdown=markdown,
                    metadata=response.metadata if response else None,
                )
            await agent_loop.close_mcp()

        asyncio.run(run_once())
    else:
        # Interactive mode — full-screen TUI with fixed bottom input.
        from tinybot.bus.events import InboundMessage

        if ":" in session_id:
            cli_channel, cli_chat_id = session_id.split(":", 1)
        else:
            cli_channel, cli_chat_id = "cli", session_id

        # Ignore SIGPIPE to prevent silent process termination when writing to closed pipes.
        if hasattr(signal, "SIGPIPE"):
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)

        async def run_interactive():
            history_file = get_cli_history_path()
            history_file.parent.mkdir(parents=True, exist_ok=True)

            initial_blocks = [
                f"{__logo__} Interactive mode (type exit or press Ctrl+C to quit)",
            ]
            if restart_notice_text:
                initial_blocks.append(f"{__logo__} tinybot\n{restart_notice_text}")

            async def _submit_user_input(user_input: str) -> None:
                command = user_input.strip()
                if not command:
                    return
                if _is_exit_command(command):
                    ui.exit()
                    return

                agent_loop.task_progress_state.reset()
                await bus.publish_inbound(InboundMessage(
                    channel=cli_channel,
                    sender_id="user",
                    chat_id=cli_chat_id,
                    content=user_input,
                    metadata={"_wants_stream": True},
                ))

            ui = InteractiveChatUI(
                render_markdown=markdown,
                history=FileHistory(str(history_file)),
                on_submit=_submit_user_input,
                initial_transcript=initial_blocks,
            )

            def _handle_signal(signum, _frame):
                ui.exit()

            if hasattr(signal, "SIGTERM"):
                signal.signal(signal.SIGTERM, _handle_signal)
            if hasattr(signal, "SIGHUP"):
                signal.signal(signal.SIGHUP, _handle_signal)

            bus_task = asyncio.create_task(agent_loop.run())

            async def _refresh_progress_panel():
                last_version = agent_loop.task_progress_state.get_snapshot()["version"]
                ui.set_task_progress(agent_loop.task_progress_state.get_snapshot())
                while True:
                    try:
                        state = agent_loop.task_progress_state
                        version = await asyncio.to_thread(state.wait_for_change, last_version, 0.25)
                        if version == last_version:
                            continue
                        last_version = version
                        ui.set_task_progress(state.get_snapshot())
                    except asyncio.CancelledError:
                        break

            async def _consume_outbound():
                while True:
                    try:
                        msg = await bus.consume_outbound()
                        if msg.metadata.get("_reasoning_delta"):
                            ui.on_reasoning_delta(msg.content)
                            continue
                        if msg.metadata.get("_stream_delta"):
                            ui.on_stream_delta(msg.content)
                            continue
                        if msg.metadata.get("_stream_end"):
                            ui.on_stream_end(resuming=msg.metadata.get("_resuming", False))
                            continue
                        if msg.metadata.get("_streamed"):
                            ui.finish_turn()
                            continue

                        if msg.metadata.get("_progress"):
                            is_tool_hint = msg.metadata.get("_tool_hint", False)
                            ch = agent_loop.channels_config
                            if ch and is_tool_hint and not ch.send_tool_hints:
                                continue
                            if ch and not is_tool_hint and not ch.send_progress:
                                continue
                            ui.add_progress_line(msg.content)
                            continue

                        ui.add_assistant_response(msg.content, msg.metadata)
                    except asyncio.CancelledError:
                        break

            outbound_task = asyncio.create_task(_consume_outbound())
            progress_refresh_task = asyncio.create_task(_refresh_progress_panel())

            try:
                await ui.run()
            finally:
                agent_loop.stop()
                outbound_task.cancel()
                progress_refresh_task.cancel()
                await asyncio.gather(bus_task, outbound_task, progress_refresh_task, return_exceptions=True)
                await agent_loop.close_mcp()

        asyncio.run(run_interactive())
        _restore_terminal()
        console.print("\nGoodbye!")



# ============================================================================
# Channel Commands
# ============================================================================


channels_app = typer.Typer(help="Manage channels")
app.add_typer(channels_app, name="channels")


@channels_app.command("status")
def channels_status(
        config_path: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Show channel status."""
    from tinybot.channels.registry import discover_all
    from tinybot.config.loader import load_config, set_config_path

    resolved_config_path = Path(config_path).expanduser().resolve() if config_path else None
    if resolved_config_path is not None:
        set_config_path(resolved_config_path)

    config = load_config(resolved_config_path)

    table = Table(title="Channel Status")
    table.add_column("Channel", style="cyan")
    table.add_column("Enabled", style="green")

    for name, cls in sorted(discover_all().items()):
        enabled = config.channels.is_enabled(name)
        table.add_row(
            cls.display_name,
            "[green]\u2713[/green]" if enabled else "[dim]\u2717[/dim]",
        )

    console.print(table)


def _get_bridge_dir() -> Path:
    """Get the bridge directory, setting it up if needed."""
    import shutil
    import subprocess

    # User's bridge location
    from tinybot.config.paths import get_bridge_install_dir

    user_bridge = get_bridge_install_dir()

    # Check if already built
    if (user_bridge / "dist" / "index.js").exists():
        return user_bridge

    # Check for npm
    npm_path = shutil.which("npm")
    if not npm_path:
        console.print("[red]npm not found. Please install Node.js >= 18.[/red]")
        raise typer.Exit(1)

    # Find source bridge: first check package data, then source dir
    pkg_bridge = Path(__file__).parent.parent / "bridge"  # tinybot/bridge (installed)
    src_bridge = Path(__file__).parent.parent.parent / "bridge"  # repo root/bridge (dev)

    source = None
    if (pkg_bridge / "package.json").exists():
        source = pkg_bridge
    elif (src_bridge / "package.json").exists():
        source = src_bridge

    if not source:
        console.print("[red]Bridge source not found.[/red]")
        console.print("Try reinstalling: pip install --force-reinstall tinybot")
        raise typer.Exit(1)

    console.print(f"{__logo__} Setting up bridge...")

    # Copy to user directory
    user_bridge.parent.mkdir(parents=True, exist_ok=True)
    if user_bridge.exists():
        shutil.rmtree(user_bridge)
    shutil.copytree(source, user_bridge, ignore=shutil.ignore_patterns("node_modules", "dist"))

    # Install and build
    try:
        console.print("  Installing dependencies...")
        subprocess.run([npm_path, "install"], cwd=user_bridge, check=True, capture_output=True)

        console.print("  Building...")
        subprocess.run([npm_path, "run", "build"], cwd=user_bridge, check=True, capture_output=True)

        console.print("[green]✓[/green] Bridge ready\n")
    except subprocess.CalledProcessError as e:
        console.print(f"[red]Build failed: {e}[/red]")
        if e.stderr:
            console.print(f"[dim]{e.stderr.decode()[:500]}[/dim]")
        raise typer.Exit(1)

    return user_bridge


@channels_app.command("login")
def channels_login(
        channel_name: str = typer.Argument(..., help="Channel name (e.g. weixin, whatsapp)"),
        force: bool = typer.Option(False, "--force", "-f", help="Force re-authentication even if already logged in"),
        config_path: str | None = typer.Option(None, "--config", "-c", help="Path to config file"),
):
    """Authenticate with a channel via QR code or other interactive login."""
    from tinybot.channels.registry import discover_all
    from tinybot.config.loader import load_config, set_config_path

    resolved_config_path = Path(config_path).expanduser().resolve() if config_path else None
    if resolved_config_path is not None:
        set_config_path(resolved_config_path)

    config = load_config(resolved_config_path)
    channel_cfg = getattr(config.channels, channel_name, None) or {}

    # Validate channel exists
    all_channels = discover_all()
    if channel_name not in all_channels:
        available = ", ".join(all_channels.keys())
        console.print(f"[red]Unknown channel: {channel_name}[/red]  Available: {available}")
        raise typer.Exit(1)

    console.print(f"{__logo__} {all_channels[channel_name].display_name} Login\n")

    channel_cls = all_channels[channel_name]
    channel = channel_cls(channel_cfg, bus=None)

    success = asyncio.run(channel.login(force=force))

    if not success:
        raise typer.Exit(1)


# ============================================================================
# Plugin Commands
# ============================================================================

plugins_app = typer.Typer(help="Manage channel plugins")
app.add_typer(plugins_app, name="plugins")


@plugins_app.command("list")
def plugins_list():
    """List all discovered channels (built-in and plugins)."""
    from tinybot.channels.registry import discover_all, discover_channel_names
    from tinybot.config.loader import load_config

    config = load_config()
    builtin_names = set(discover_channel_names())
    all_channels = discover_all()

    table = Table(title="Channel Plugins")
    table.add_column("Name", style="cyan")
    table.add_column("Source", style="magenta")
    table.add_column("Enabled", style="green")

    for name in sorted(all_channels):
        cls = all_channels[name]
        source = "builtin" if name in builtin_names else "plugin"
        enabled = config.channels.is_enabled(name)
        table.add_row(
            cls.display_name,
            source,
            "[green]yes[/green]" if enabled else "[dim]no[/dim]",
        )

    console.print(table)


# ============================================================================
# Status Commands
# ============================================================================


@app.command()
def status():
    """Show tinybot status."""
    from tinybot.config.loader import get_config_path, load_config

    config_path = get_config_path()
    config = load_config()
    workspace = config.workspace_path

    console.print(f"{__logo__} tinybot Status\n")

    console.print(f"Config: {config_path} {'[green]✓[/green]' if config_path.exists() else '[red]✗[/red]'}")
    console.print(f"Workspace: {workspace} {'[green]✓[/green]' if workspace.exists() else '[red]✗[/red]'}")

    if config_path.exists():
        from tinybot.providers.registry import PROVIDERS

        console.print(f"Model: {config.agents.defaults.model}")

        # Check API keys from registry
        for spec in PROVIDERS:
            p = getattr(config.providers, spec.name, None)
            if p is None:
                continue
            if spec.is_oauth:
                console.print(f"{spec.label}: [green]✓ (OAuth)[/green]")
            elif spec.is_local:
                # Local deployments show api_base instead of api_key
                if p.api_base:
                    console.print(f"{spec.label}: [green]✓ {p.api_base}[/green]")
                else:
                    console.print(f"{spec.label}: [dim]not set[/dim]")
            else:
                has_key = bool(p.api_key)
                console.print(f"{spec.label}: {'[green]✓[/green]' if has_key else '[dim]not set[/dim]'}")


# ============================================================================
# OAuth Login
# ============================================================================

provider_app = typer.Typer(help="Manage providers")
app.add_typer(provider_app, name="provider")

_LOGIN_HANDLERS: dict[str, callable] = {}


def _register_login(name: str):
    def decorator(fn):
        _LOGIN_HANDLERS[name] = fn
        return fn

    return decorator


@provider_app.command("login")
def provider_login(
        provider: str = typer.Argument(..., help="OAuth provider (e.g. 'openai-codex', 'github-copilot')"),
):
    """Authenticate with an OAuth provider."""
    from tinybot.providers.registry import PROVIDERS

    key = provider.replace("-", "_")
    spec = next((s for s in PROVIDERS if s.name == key and s.is_oauth), None)
    if not spec:
        names = ", ".join(s.name.replace("_", "-") for s in PROVIDERS if s.is_oauth)
        console.print(f"[red]Unknown OAuth provider: {provider}[/red]  Supported: {names}")
        raise typer.Exit(1)

    handler = _LOGIN_HANDLERS.get(spec.name)
    if not handler:
        console.print(f"[red]Login not implemented for {spec.label}[/red]")
        raise typer.Exit(1)

    console.print(f"{__logo__} OAuth Login - {spec.label}\n")
    handler()



if __name__ == "__main__":
    app()
