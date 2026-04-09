import re
from pathlib import Path
from typing import Any

_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*]')


def ensure_dir(path: Path) -> Path:
    """Ensure directory exists, return it."""
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_filename(name: str) -> str:
    """Replace unsafe path characters with underscores."""
    return _UNSAFE_CHARS.sub("_", name).strip()


def find_legal_message_start(messages: list[dict[str, Any]]) -> int:
    """Find the first index whose tool results have matching assistant calls."""
    declared: set[str] = set()
    start = 0
    for i, msg in enumerate(messages):
        role = msg.get("role")
        if role == "assistant":
            for tc in msg.get("tool_calls") or []:
                if isinstance(tc, dict) and tc.get("id"):
                    declared.add(str(tc["id"]))
        elif role == "tool":
            tid = msg.get("tool_call_id")
            if tid and str(tid) not in declared:
                start = i + 1
                declared.clear()
                for prev in messages[start: i + 1]:
                    if prev.get("role") == "assistant":
                        for tc in prev.get("tool_calls") or []:
                            if isinstance(tc, dict) and tc.get("id"):
                                declared.add(str(tc["id"]))
    return start
