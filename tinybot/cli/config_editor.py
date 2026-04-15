"""TUI configuration editor for tinybot.

A full-screen interactive configuration editor using prompt_toolkit,
similar to Claude Code's CLI interface.
"""

from __future__ import annotations

import json
import types
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, NamedTuple, get_args, get_origin

from prompt_toolkit.application import Application
from prompt_toolkit.document import Document
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys
from prompt_toolkit.layout import ConditionalContainer, HSplit, Layout, VSplit, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import D
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import Frame, TextArea
from prompt_toolkit.filters import Condition
from pydantic import BaseModel

from tinybot import __logo__, __version__
from tinybot.config.schema import Config


# --- Sensitive Field Masking (from onboard.py) ---
_SENSITIVE_KEYWORDS = frozenset({"api_key", "token", "secret", "password", "credentials"})


def _is_sensitive_field(field_name: str) -> bool:
    """Check if a field name indicates sensitive content."""
    return any(kw in field_name.lower() for kw in _SENSITIVE_KEYWORDS)


def _mask_value(value: str) -> str:
    """Mask a sensitive value, showing only the last 4 characters."""
    if len(value) <= 4:
        return "****"
    return "*" * (len(value) - 4) + value[-4:]


# --- Type Introspection (from onboard.py) ---
class FieldTypeInfo(NamedTuple):
    """Result of field type introspection."""
    type_name: str
    inner_type: Any


def _get_field_type_info(field_info) -> FieldTypeInfo:
    """Extract field type info from Pydantic field."""
    annotation = field_info.annotation
    if annotation is None:
        return FieldTypeInfo("str", None)

    origin = get_origin(annotation)
    args = get_args(annotation)

    if origin is types.UnionType:
        non_none_args = [a for a in args if a is not type(None)]
        if len(non_none_args) == 1:
            annotation = non_none_args[0]
            origin = get_origin(annotation)
            args = get_args(annotation)

    _SIMPLE_TYPES: dict[type, str] = {bool: "bool", int: "int", float: "float"}

    if origin is list or (hasattr(origin, "__name__") and origin.__name__ == "List"):
        return FieldTypeInfo("list", args[0] if args else str)
    if origin is dict or (hasattr(origin, "__name__") and origin.__name__ == "Dict"):
        return FieldTypeInfo("dict", None)
    for py_type, name in _SIMPLE_TYPES.items():
        if annotation is py_type:
            return FieldTypeInfo(name, None)
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return FieldTypeInfo("model", annotation)
    return FieldTypeInfo("str", None)


def _get_field_display_name(field_key: str, field_info) -> str:
    """Get display name for a field."""
    if field_info and field_info.description:
        return field_info.description
    name = field_key
    suffix_map = {
        "_s": " (seconds)",
        "_ms": " (ms)",
        "_url": " URL",
        "_path": " Path",
        "_id": " ID",
        "_key": " Key",
        "_token": " Token",
    }
    for suffix, replacement in suffix_map.items():
        if name.endswith(suffix):
            name = name[: -len(suffix)] + replacement
            break
    return name.replace("_", " ").title()


def _format_value(value: Any, field_name: str = "") -> str:
    """Format a value for display, with sensitive field masking."""
    if value is None or value == "" or value == {} or value == []:
        return "(not set)"
    if _is_sensitive_field(field_name) and isinstance(value, str):
        return _mask_value(value)
    if isinstance(value, BaseModel):
        parts = []
        for fname, _finfo in type(value).model_fields.items():
            fval = getattr(value, fname, None)
            formatted = _format_value(fval, fname)
            if formatted != "(not set)":
                parts.append(f"{fname}={formatted}")
        return ", ".join(parts) if parts else "(not set)"
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value) if value else "{}"
    return str(value)


def _format_value_for_input(value: Any, field_type: str) -> str:
    """Format a value for use as input default."""
    if value is None or value == "":
        return ""
    if field_type == "list" and isinstance(value, list):
        return ",".join(str(v) for v in value)
    if field_type == "dict" and isinstance(value, dict):
        return json.dumps(value)
    return str(value)


# --- Configuration Sections ---
_CONFIG_SECTIONS = [
    ("agents.defaults", "Agent Settings"),
    ("providers", "LLM Providers"),
    ("channels", "Channels"),
    ("gateway", "Gateway"),
    ("api", "API Server"),
    ("tools", "Tools"),
]

# Maximum visible lines in each panel (for virtual scrolling)
_VISIBLE_LINES = 15


def _get_nested_attr(obj: Any, path: str) -> Any:
    """Get a nested attribute by dot-separated path."""
    parts = path.split(".")
    current = obj
    for part in parts:
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
    return current


def _set_nested_attr(obj: Any, path: str, value: Any) -> None:
    """Set a nested attribute by dot-separated path."""
    parts = path.split(".")
    current = obj
    for part in parts[:-1]:
        if isinstance(current, dict):
            current = current.setdefault(part, {})
        else:
            current = getattr(current, part)
    final_key = parts[-1]
    if isinstance(current, dict):
        current[final_key] = value
    else:
        setattr(current, final_key, value)


def _get_section_fields(config: Config, section_path: str) -> list[tuple[str, Any, FieldTypeInfo]]:
    """Get all fields for a configuration section."""
    obj = _get_nested_attr(config, section_path)
    if obj is None:
        return []

    # Check if this is a top-level dict section (providers, channels)
    if section_path in ("providers", "channels") and isinstance(obj, dict):
        # Return list of provider/channel names
        return [
            (key, value, FieldTypeInfo("dict_item", None))
            for key, value in obj.items()
        ]

    if isinstance(obj, BaseModel):
        fields = []
        for name, info in type(obj).model_fields.items():
            value = getattr(obj, name, None)
            ftype = _get_field_type_info(info)
            fields.append((name, value, ftype))
        return fields

    return []


@lru_cache(maxsize=1)
def _get_provider_names() -> dict[str, str]:
    """Get provider display names from registry."""
    from tinybot.providers.registry import PROVIDERS
    return {
        spec.name: spec.display_name or spec.name
        for spec in PROVIDERS
        if not spec.is_oauth
    }


@lru_cache(maxsize=1)
def _get_channel_names() -> dict[str, str]:
    """Get channel display names from registry."""
    from tinybot.channels.registry import discover_all
    return {
        name: getattr(cls, "display_name", name.capitalize())
        for name, cls in discover_all().items()
    }


# --- State Management ---
@dataclass
class ConfigEditorState:
    """State for the configuration editor."""
    config: Config
    original: Config
    current_path: str = "agents.defaults"  # Current section path
    selected_index: int = 0  # Index in current menu
    focus_panel: str = "menu"  # "menu" or "fields"
    editing: bool = False  # Whether in edit mode
    edit_field: str = ""  # Field being edited
    edit_value: str = ""  # Current edit input
    status: str = ""
    has_changes: bool = False
    confirm_exit: bool = False
    # Scroll offset for each panel (number of lines hidden at top)
    menu_scroll_offset: int = 0
    fields_scroll_offset: int = 0


# --- TUI Styles ---
_STYLE = Style.from_dict({
    "": "bg:#1a1b26 #c0caf5",
    "frame.border": "#414868",
    "frame.label": "bold #7dcfff",
    "menu": "bg:#16161e #a9b1d6",
    "menu.selected": "bg:#3d59a1 #e5e9f0 bold",
    "fields": "bg:#1a1b26 #c0caf5",
    "fields.selected": "bg:#3d59a1 #e5e9f0 bold",
    "input": "bg:#24283b #e5e9f0",
    "input.label": "bold #7aa2f7",
    "status": "bg:#1f2335 #c0caf5",
    "status.warning": "bg:#1f2335 #e0af68",
    "status.success": "bg:#1f2335 #9ece6a",
    "header": "bold #7aa2f7",
    "dim": "#565f89",
})


class ConfigEditorUI:
    """Full-screen TUI configuration editor."""

    def __init__(
        self,
        config: Config,
        on_save: Callable[[Config], None] | None = None,
    ):
        self._state = ConfigEditorState(
            config=config.model_copy(deep=True),
            original=config.model_copy(deep=True),
        )
        self._on_save = on_save
        self._app: Application | None = None

        # Create UI components - use FormattedTextControl for styled highlighting
        self._menu_control = FormattedTextControl(self._get_menu_fragments)
        self._fields_control = FormattedTextControl(self._get_fields_fragments)
        self._input_area = TextArea(
            text="",
            multiline=False,
            focusable=True,
            style="class:input",
        )
        self._input_label = Window(
            content=FormattedTextControl(lambda: [("class:input.label", self._get_input_label())]),
            width=8,
            dont_extend_width=True,
        )

        # Key bindings
        kb = KeyBindings()

        @kb.add("up")
        def _up(event):
            self._navigate_up()

        @kb.add("down")
        def _down(event):
            self._navigate_down()

        @kb.add("pageup")
        def _pageup(event):
            self._navigate_page_up()

        @kb.add("pagedown")
        def _pagedown(event):
            self._navigate_page_down()

        @kb.add("tab")
        def _tab(event):
            self._switch_panel()

        @kb.add("s-tab")  # Shift+Tab
        def _stab(event):
            self._switch_panel()

        @kb.add("enter")
        def _enter(event):
            self._handle_enter()

        @kb.add("escape")
        def _escape(event):
            self._handle_escape()

        @kb.add("s")
        def _save(event):
            self._save_config()

        @kb.add("q")
        def _quit(event):
            self._request_exit()

        @kb.add("c-c")
        def _ctrl_c(event):
            self._force_exit()

        # Conditional containers
        self._show_input = Condition(lambda: self._state.editing)
        self._show_confirm = Condition(lambda: self._state.confirm_exit)

        # Build layout
        self._build_layout(kb)

    def _build_layout(self, kb: KeyBindings) -> None:
        """Build the application layout."""
        # Header
        header = Window(
            content=FormattedTextControl(lambda: [
                ("class:header", f" {__logo__} tinybot[{__version__}] Configuration Editor "),
                ("class:dim", f" {'●' if self._state.has_changes else '○'} "),
            ]),
            height=1,
        )

        # Menu panel (left)
        menu_window = Window(
            content=self._menu_control,
            height=D(max=15),
            style="class:menu",
        )
        menu_frame = Frame(
            menu_window,
            title="Sections",
            style="class:frame",
        )

        # Fields panel (right)
        fields_window = Window(
            content=self._fields_control,
            height=D(max=15),
            style="class:fields",
        )
        fields_frame = Frame(
            fields_window,
            title=self._get_fields_title,
            style="class:frame",
        )

        # Main content area
        content = VSplit([
            menu_frame,
            fields_frame,
        ], height=D(max=15))

        # Input row (conditional)
        input_row = ConditionalContainer(
            content=HSplit([
                self._input_label,
                self._input_area,
            ], height=1),
            filter=self._show_input,
        )

        # Status bar
        status_bar = Window(
            content=FormattedTextControl(self._get_status_fragments),
            height=1,
            style="class:status",
        )

        # Confirm dialog (conditional)
        confirm_dialog = ConditionalContainer(
            content=Window(
                content=FormattedTextControl(lambda: [
                    ("class:status.warning", " Unsaved changes! Press 'y' to save, 'n' to discard, 'Esc' to cancel "),
                ]),
                height=1,
            ),
            filter=self._show_confirm,
        )

        # Additional bindings for confirm dialog
        kb.add("y")(lambda e: self._save_and_exit())
        kb.add("n")(lambda e: self._discard_and_exit())

        self._app = Application(
            layout=Layout(
                HSplit([
                    header,
                    content,
                    input_row,
                    status_bar,
                    confirm_dialog,
                ]),
            ),
            key_bindings=kb,
            full_screen=True,
            style=_STYLE,
            mouse_support=True,
        )

    def _get_fields_title(self) -> str:
        """Get title for fields panel."""
        path = self._state.current_path
        parts = path.split(".")

        # Check top-level sections first
        for sec_path, name in _CONFIG_SECTIONS:
            if path == sec_path:
                return name

        # Handle nested paths: providers.openai -> "DeepSeek (Provider)"
        if len(parts) >= 2:
            # Get the parent section name
            parent_path = parts[0]
            parent_name = None
            for sec_path, name in _CONFIG_SECTIONS:
                if parent_path == sec_path.split(".")[0]:
                    parent_name = name
                    break

            # Get the item name
            item_key = parts[1]
            if parent_path == "providers":
                item_name = _get_provider_names().get(item_key, item_key)
                return f"{item_name} (Provider)"
            elif parent_path == "channels":
                item_name = _get_channel_names().get(item_key, item_key)
                return f"{item_name} (Channel)"
            elif len(parts) > 2:
                # Nested model like agents.defaults.dream
                field_name = parts[-1]
                return _get_field_display_name(field_name, None)

        return "Fields"

    def _get_input_label(self) -> str:
        """Get label for input area."""
        if self._state.editing:
            return f"Value: "
        return "Value: "

    def _get_status_fragments(self) -> list[tuple[str, str]]:
        """Get status bar fragments."""
        parts = [
            "↑↓ Navigate",
            "Enter Select/Edit",
            "Tab Switch",
            "s Save",
            "q Quit",
        ]
        help_text = " · ".join(parts)

        if self._state.status:
            style = "class:status.success" if "saved" in self._state.status.lower() else "class:status"
            # Show status message followed by help text
            return [(style, f" {self._state.status}  |  {help_text} ")]
        return [("class:status", f" {help_text} ")]

    def _get_menu_fragments(self) -> list[tuple[str, str]]:
        """Get menu panel fragments for FormattedTextControl with virtual scrolling."""
        fragments = []
        total_items = len(_CONFIG_SECTIONS)
        scroll_offset = self._state.menu_scroll_offset

        # Calculate visible range
        start = scroll_offset
        end = min(scroll_offset + _VISIBLE_LINES, total_items)

        # Show scroll indicator if there are hidden items above
        if start > 0:
            fragments.append(("class:dim", f" ↑ {start} more above\n"))

        for i in range(start, end):
            path, name = _CONFIG_SECTIONS[i]
            is_selected = i == self._state.selected_index and self._state.focus_panel == "menu"
            is_current = path == self._state.current_path

            current_marker = "▶" if is_current else " "
            text = f" {current_marker} {name}\n"

            if is_selected:
                fragments.append(("class:menu.selected", text))
            else:
                fragments.append(("class:menu", text))

        # Show scroll indicator if there are hidden items below
        if end < total_items:
            hidden_below = total_items - end
            fragments.append(("class:dim", f" ↓ {hidden_below} more below\n"))

        return fragments

    def _get_fields_fragments(self) -> list[tuple[str, str]]:
        """Get fields panel fragments for FormattedTextControl with virtual scrolling."""
        fields = _get_section_fields(self._state.config, self._state.current_path)
        if not fields:
            return [("class:dim", "(no fields)")]

        fragments = []
        total_items = len(fields)
        scroll_offset = self._state.fields_scroll_offset

        # Calculate visible range
        start = scroll_offset
        end = min(scroll_offset + _VISIBLE_LINES, total_items)

        # Show scroll indicator if there are hidden items above
        if start > 0:
            fragments.append(("class:dim", f" ↑ {start} more above\n"))

        path = self._state.current_path

        # Special handling for top-level providers/channels dict sections
        if path in ("providers", "channels"):
            name_map = _get_provider_names() if path == "providers" else _get_channel_names()
            for i in range(start, end):
                key, value, ftype = fields[i]
                display_name = name_map.get(key, key)
                is_selected = i == self._state.selected_index and self._state.focus_panel == "fields"

                if isinstance(value, BaseModel):
                    has_value = bool(value.api_key)
                    status = "✓" if has_value else "○"
                    formatted = f"api_key={_format_value(value.api_key, 'api_key')}"
                elif isinstance(value, dict):
                    has_config = bool(value) and value.get("enabled", False)
                    status = "✓" if has_config else "○"
                    formatted = f"enabled={value.get('enabled', False)}"
                else:
                    status = "○"
                    formatted = "(not set)"

                text = f" {status} {display_name}: {formatted}\n"

                if is_selected:
                    fragments.append(("class:fields.selected", text))
                else:
                    fragments.append(("class:fields", text))
        else:
            obj = _get_nested_attr(self._state.config, path)
            for i in range(start, end):
                name, value, ftype = fields[i]
                is_selected = i == self._state.selected_index and self._state.focus_panel == "fields"

                field_info = None
                if isinstance(obj, BaseModel):
                    field_info = type(obj).model_fields.get(name)

                display = _get_field_display_name(name, field_info)
                formatted = _format_value(value, name)
                status = "✓" if formatted != "(not set)" else "○"

                type_hint = ""
                if ftype.type_name == "bool":
                    type_hint = f" [{value if value is not None else 'unset'}]"
                elif ftype.type_name == "model":
                    type_hint = " →"

                text = f" {status} {display}{type_hint}: {formatted}\n"

                if is_selected:
                    fragments.append(("class:fields.selected", text))
                else:
                    fragments.append(("class:fields", text))

        # Show scroll indicator if there are hidden items below
        if end < total_items:
            hidden_below = total_items - end
            fragments.append(("class:dim", f" ↓ {hidden_below} more below\n"))

        return fragments

    def _navigate_up(self) -> None:
        """Navigate up in current panel with scroll adjustment."""
        if self._state.editing:
            return
        items = _CONFIG_SECTIONS if self._state.focus_panel == "menu" else _get_section_fields(self._state.config, self._state.current_path)
        if items and self._state.selected_index > 0:
            self._state.selected_index -= 1
            self._state.status = ""  # Clear status message on navigation
            # Adjust scroll offset if selection moved above visible range
            self._update_scroll_offset()
            self._refresh_views()

    def _navigate_down(self) -> None:
        """Navigate down in current panel with scroll adjustment."""
        if self._state.editing:
            return
        items = _CONFIG_SECTIONS if self._state.focus_panel == "menu" else _get_section_fields(self._state.config, self._state.current_path)
        if items and self._state.selected_index < len(items) - 1:
            self._state.selected_index += 1
            self._state.status = ""  # Clear status message on navigation
            # Adjust scroll offset if selection moved below visible range
            self._update_scroll_offset()
            self._refresh_views()

    def _navigate_page_up(self) -> None:
        """Navigate up by one page."""
        if self._state.editing:
            return
        items = _CONFIG_SECTIONS if self._state.focus_panel == "menu" else _get_section_fields(self._state.config, self._state.current_path)
        if not items:
            return
        # Move selection up by VISIBLE_LINES, but not below 0
        new_index = max(0, self._state.selected_index - _VISIBLE_LINES)
        self._state.selected_index = new_index
        self._state.status = ""
        self._update_scroll_offset()
        self._refresh_views()

    def _navigate_page_down(self) -> None:
        """Navigate down by one page."""
        if self._state.editing:
            return
        items = _CONFIG_SECTIONS if self._state.focus_panel == "menu" else _get_section_fields(self._state.config, self._state.current_path)
        if not items:
            return
        # Move selection down by VISIBLE_LINES, but not beyond total
        new_index = min(len(items) - 1, self._state.selected_index + _VISIBLE_LINES)
        self._state.selected_index = new_index
        self._state.status = ""
        self._update_scroll_offset()
        self._refresh_views()

    def _update_scroll_offset(self) -> None:
        """Update scroll offset to ensure selected item is visible."""
        if self._state.focus_panel == "menu":
            scroll_offset = self._state.menu_scroll_offset
            total_items = len(_CONFIG_SECTIONS)
        else:
            scroll_offset = self._state.fields_scroll_offset
            total_items = len(_get_section_fields(self._state.config, self._state.current_path))

        selected = self._state.selected_index

        # If selection is above visible range, scroll up
        if selected < scroll_offset:
            new_offset = selected
        # If selection is below visible range, scroll down
        elif selected >= scroll_offset + _VISIBLE_LINES:
            new_offset = selected - _VISIBLE_LINES + 1
        else:
            new_offset = scroll_offset

        # Apply the new offset
        if self._state.focus_panel == "menu":
            self._state.menu_scroll_offset = new_offset
        else:
            self._state.fields_scroll_offset = new_offset

    def _reset_scroll_offsets(self) -> None:
        """Reset scroll offsets when changing sections."""
        self._state.menu_scroll_offset = 0
        self._state.fields_scroll_offset = 0

    def _switch_panel(self) -> None:
        """Switch focus between menu and fields panels."""
        if self._state.editing:
            return
        self._state.focus_panel = "fields" if self._state.focus_panel == "menu" else "menu"
        self._state.selected_index = 0
        self._reset_scroll_offsets()
        # Full refresh needed when switching panels
        self._refresh_views()

    def _handle_enter(self) -> None:
        """Handle Enter key - select or edit."""
        if self._state.editing:
            self._commit_edit()
            return

        if self._state.focus_panel == "menu":
            # Select section
            path, name = _CONFIG_SECTIONS[self._state.selected_index]
            self._state.current_path = path
            self._state.selected_index = 0
            self._state.focus_panel = "fields"
            self._reset_scroll_offsets()
        else:
            # Edit field
            fields = _get_section_fields(self._state.config, self._state.current_path)
            if fields:
                name, value, ftype = fields[self._state.selected_index]

                # Handle nested model - enter sub-section
                if ftype.type_name == "model":
                    self._enter_nested_section(name)
                    return

                # Handle dict sections (providers/channels) - enter sub-section
                if self._state.current_path in ("providers", "channels"):
                    self._enter_dict_section(name)
                    return

                # Handle bool - toggle directly
                if ftype.type_name == "bool":
                    self._toggle_bool(name)
                    return

                # Start editing
                self._start_edit(name, value, ftype)

        # Full refresh needed when changing sections
        self._refresh_views()

    def _enter_nested_section(self, field_name: str) -> None:
        """Enter a nested Pydantic model section."""
        self._state.current_path = f"{self._state.current_path}.{field_name}"
        self._state.selected_index = 0
        self._state.focus_panel = "fields"
        self._reset_scroll_offsets()
        self._refresh_views()

    def _enter_dict_section(self, key: str) -> None:
        """Enter a dict section (provider or channel config)."""
        self._state.current_path = f"{self._state.current_path}.{key}"
        self._state.selected_index = 0
        self._state.focus_panel = "fields"
        self._reset_scroll_offsets()
        self._refresh_views()

    def _toggle_bool(self, field_name: str) -> None:
        """Toggle a boolean field."""
        obj = _get_nested_attr(self._state.config, self._state.current_path)
        if obj and isinstance(obj, BaseModel):
            current = getattr(obj, field_name, None)
            new_value = not bool(current)
            setattr(obj, field_name, new_value)
            self._state.has_changes = True
            self._state.status = f"{field_name} = {new_value}"
        self._refresh_views()

    def _start_edit(self, field_name: str, current_value: Any, ftype: FieldTypeInfo) -> None:
        """Start editing a field."""
        self._state.editing = True
        self._state.edit_field = field_name
        # For sensitive fields, start with empty input
        if _is_sensitive_field(field_name) and current_value:
            self._state.edit_value = ""
        else:
            self._state.edit_value = _format_value_for_input(current_value, ftype.type_name)
        self._input_area.buffer.set_document(Document(self._state.edit_value))
        self._refresh_views()

    def _commit_edit(self) -> None:
        """Commit the current edit."""
        new_value = self._input_area.buffer.text.strip()
        obj = _get_nested_attr(self._state.config, self._state.current_path)

        if obj and isinstance(obj, BaseModel):
            # Get field type info
            field_info = type(obj).model_fields.get(self._state.edit_field)
            if field_info:
                ftype = _get_field_type_info(field_info)

                # Parse value based on type
                parsed = self._parse_input(new_value, ftype.type_name)

                # For sensitive fields, empty means keep original
                if _is_sensitive_field(self._state.edit_field) and not new_value:
                    original = _get_nested_attr(self._state.original, f"{self._state.current_path}.{self._state.edit_field}")
                    if original:
                        parsed = original

                if parsed is not None or new_value == "":
                    setattr(obj, self._state.edit_field, parsed if parsed is not None else None)
                    self._state.has_changes = True
                    self._state.status = f"{self._state.edit_field} updated"
                else:
                    self._state.status = f"Invalid value for {self._state.edit_field}"

        self._state.editing = False
        self._state.edit_field = ""
        self._state.edit_value = ""
        self._input_area.buffer.set_document(Document(""))
        self._refresh_views()

    def _parse_input(self, value: str, field_type: str) -> Any:
        """Parse input value based on field type."""
        if not value:
            return None

        try:
            if field_type == "int":
                return int(value)
            elif field_type == "float":
                return float(value)
            elif field_type == "list":
                return [v.strip() for v in value.split(",") if v.strip()]
            elif field_type == "dict":
                return json.loads(value)
            else:
                return value
        except (ValueError, json.JSONDecodeError):
            return None

    def _handle_escape(self) -> None:
        """Handle Escape key - cancel or go back."""
        if self._state.confirm_exit:
            self._state.confirm_exit = False
            self._refresh_views()
            return

        if self._state.editing:
            self._state.editing = False
            self._state.edit_field = ""
            self._state.edit_value = ""
            self._input_area.buffer.set_document(Document(""))
            self._refresh_views()
            return

        # Get all valid section paths from _CONFIG_SECTIONS
        valid_section_paths = {path for path, _ in _CONFIG_SECTIONS}

        # Check if current path is a top-level section (defined in _CONFIG_SECTIONS)
        if self._state.current_path in valid_section_paths:
            # At top-level section, go to menu
            self._state.focus_panel = "menu"
            # Find the index of current section in menu
            for i, (path, _) in enumerate(_CONFIG_SECTIONS):
                if path == self._state.current_path:
                    self._state.selected_index = i
                    break
            self._state.status = ""
            self._reset_scroll_offsets()
            self._update_scroll_offset()  # Ensure menu selection is visible
            self._refresh_views()
            return

        # Not a top-level section, go back to parent
        parts = self._state.current_path.split(".")
        if len(parts) > 1:
            parent_path = ".".join(parts[:-1])

            # Check if parent is a top-level section (providers, channels) that shows a list
            # These are special "list" sections where we want to show the provider/channel list
            if parent_path in ("providers", "channels"):
                self._state.current_path = parent_path
                self._state.selected_index = 0
                self._state.focus_panel = "fields"
            # Check if parent is a top-level section in _CONFIG_SECTIONS
            elif parent_path in valid_section_paths:
                self._state.current_path = parent_path
                self._state.selected_index = 0
                self._state.focus_panel = "fields"
            else:
                # Parent is a nested path (like agents.defaults.dream -> agents.defaults)
                # Go to parent and keep on fields panel
                self._state.current_path = parent_path
                self._state.selected_index = 0
                self._state.focus_panel = "fields"

            self._reset_scroll_offsets()
            self._update_scroll_offset()  # Ensure fields selection is visible

        self._state.status = ""
        self._refresh_views()

    def _save_config(self) -> None:
        """Save configuration."""
        if self._on_save:
            self._on_save(self._state.config)
        self._state.has_changes = False
        self._state.original = self._state.config.model_copy(deep=True)
        self._state.status = "Configuration saved successfully!"
        self._refresh_views()

    def _request_exit(self) -> None:
        """Request exit, prompting for unsaved changes."""
        if self._state.has_changes:
            self._state.confirm_exit = True
            self._refresh_views()
        else:
            self._force_exit()

    def _save_and_exit(self) -> None:
        """Save and exit."""
        self._save_config()
        self._force_exit()

    def _discard_and_exit(self) -> None:
        """Discard changes and exit."""
        self._state.has_changes = False
        self._force_exit()

    def _force_exit(self) -> None:
        """Force exit without prompting."""
        if self._app and self._app.is_running:
            self._app.exit()

    def _refresh_views(self) -> None:
        """Refresh all UI views by triggering a redraw."""
        self._invalidate()

    def _invalidate(self) -> None:
        """Invalidate the UI to trigger a redraw."""
        if self._app and self._app.is_running:
            self._app.invalidate()

    async def run(self) -> None:
        """Run the configuration editor."""
        if self._app:
            await self._app.run_async()


def run_config_editor(config: Config, save_callback: Callable[[Config], None] | None = None) -> None:
    """Run the configuration editor synchronously (starts its own event loop)."""
    import asyncio
    editor = ConfigEditorUI(config, save_callback)
    asyncio.run(editor.run())


async def run_config_editor_async(config: Config, save_callback: Callable[[Config], None] | None = None) -> None:
    """Run the configuration editor asynchronously (from within an existing event loop)."""
    editor = ConfigEditorUI(config, save_callback)
    await editor.run()