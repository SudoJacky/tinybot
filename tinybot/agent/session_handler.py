"""Session lifecycle management: checkpoints, turn saving, sanitization."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from loguru import logger

from tinybot.utils.helper import truncate_text as truncate_content_util
from tinybot.utils.media import image_placeholder_text

if TYPE_CHECKING:
    from tinybot.session.manager import Session


class SessionHandler:
    """Handle session lifecycle: checkpoint management, turn saving, content sanitization."""

    RUNTIME_CHECKPOINT_KEY = "runtime_checkpoint"

    def __init__(self, max_tool_result_chars: int):
        self.max_tool_result_chars = max_tool_result_chars

    def set_checkpoint(self, session: Session, payload: dict[str, Any]) -> None:
        """Persist the latest in-flight turn state into session metadata."""
        session.metadata[self.RUNTIME_CHECKPOINT_KEY] = payload

    def clear_checkpoint(self, session: Session) -> None:
        """Remove runtime checkpoint from session metadata."""
        session.metadata.pop(self.RUNTIME_CHECKPOINT_KEY, None)

    def restore_checkpoint(self, session: Session) -> bool:
        """Materialize an unfinished turn into session history before a new request."""
        checkpoint = session.metadata.get(self.RUNTIME_CHECKPOINT_KEY)
        if not isinstance(checkpoint, dict):
            return False

        assistant_message = checkpoint.get("assistant_message")
        completed_tool_results = checkpoint.get("completed_tool_results") or []
        pending_tool_calls = checkpoint.get("pending_tool_calls") or []

        restored_messages: list[dict[str, Any]] = []
        if isinstance(assistant_message, dict):
            restored = dict(assistant_message)
            restored.setdefault("timestamp", datetime.now().isoformat())
            restored_messages.append(restored)

        for message in completed_tool_results:
            if isinstance(message, dict):
                restored = dict(message)
                restored.setdefault("timestamp", datetime.now().isoformat())
                restored_messages.append(restored)

        for tool_call in pending_tool_calls:
            if not isinstance(tool_call, dict):
                continue
            tool_id = tool_call.get("id")
            name = ((tool_call.get("function") or {}).get("name")) or "tool"
            restored_messages.append({
                "role": "tool",
                "tool_call_id": tool_id,
                "name": name,
                "content": "Error: Task interrupted before this tool finished.",
                "timestamp": datetime.now().isoformat(),
            })

        overlap = 0
        max_overlap = min(len(session.messages), len(restored_messages))
        for size in range(max_overlap, 0, -1):
            existing = session.messages[-size:]
            restored = restored_messages[:size]
            if all(
                self._checkpoint_message_key(left) == self._checkpoint_message_key(right)
                for left, right in zip(existing, restored)
            ):
                overlap = size
                break

        session.messages.extend(restored_messages[overlap:])
        self.clear_checkpoint(session)
        return True

    def save_turn(
        self,
        session: Session,
        messages: list[dict],
        skip: int,
        runtime_context_tag: str,
    ) -> None:
        """Save new-turn messages into session, truncating large tool results."""
        for m in messages[skip:]:
            entry = dict(m)
            role, content = entry.get("role"), entry.get("content")

            # Skip empty assistant messages — they poison session context
            if role == "assistant" and not content and not entry.get("tool_calls"):
                continue

            if role == "tool":
                if isinstance(content, str) and len(content) > self.max_tool_result_chars:
                    entry["content"] = truncate_content_util(content, self.max_tool_result_chars)
                elif isinstance(content, list):
                    filtered = self.sanitize_persisted_blocks(content, truncate_text=True)
                    if not filtered:
                        continue
                    entry["content"] = filtered

            elif role == "user":
                # Strip runtime-context prefix if present
                if isinstance(content, str) and content.startswith(runtime_context_tag):
                    parts = content.split("\n\n", 1)
                    if len(parts) > 1 and parts[1].strip():
                        entry["content"] = parts[1]
                    else:
                        continue

                if isinstance(content, list):
                    filtered = self.sanitize_persisted_blocks(content, drop_runtime=True, runtime_context_tag=runtime_context_tag)
                    if not filtered:
                        continue
                    entry["content"] = filtered

            entry.setdefault("timestamp", datetime.now().isoformat())
            session.messages.append(entry)

        session.updated_at = datetime.now()

    def sanitize_persisted_blocks(
        self,
        content: list[dict[str, Any]],
        *,
        truncate_text: bool = False,
        drop_runtime: bool = False,
        runtime_context_tag: str = "",
    ) -> list[dict[str, Any]]:
        """Strip volatile multimodal payloads before writing session history."""
        filtered: list[dict[str, Any]] = []

        for block in content:
            if not isinstance(block, dict):
                filtered.append(block)
                continue

            # Drop runtime context text blocks if requested
            if (
                drop_runtime
                and runtime_context_tag
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
                and block["text"].startswith(runtime_context_tag)
            ):
                continue

            # Replace inline image data with placeholder
            if (
                block.get("type") == "image_url"
                and block.get("image_url", {}).get("url", "").startswith("data:image/")
            ):
                path = (block.get("_meta") or {}).get("path", "")
                filtered.append({"type": "text", "text": image_placeholder_text(path)})
                continue

            # Truncate large text blocks if requested
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                text = block["text"]
                if truncate_text and len(text) > self.max_tool_result_chars:
                    text = truncate_content_util(text, self.max_tool_result_chars)
                filtered.append({**block, "text": text})
                continue

            filtered.append(block)

        return filtered

    @staticmethod
    def _checkpoint_message_key(message: dict[str, Any]) -> tuple[Any, ...]:
        """Generate a comparison key for checkpoint message matching."""
        return (
            message.get("role"),
            message.get("content"),
            message.get("tool_call_id"),
            message.get("name"),
            message.get("tool_calls"),
            message.get("reasoning_content"),
            message.get("thinking_blocks"),
        )
