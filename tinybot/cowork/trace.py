"""Structured Cowork trace helpers."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from tinybot.cowork.types import CoworkSession, CoworkTraceSpan, now_iso


def compact_text(value: Any, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: max(0, limit - 3)].rstrip() + "..."


def duration_ms(started_at: str, ended_at: str) -> int | None:
    try:
        started = datetime.fromisoformat(started_at)
        ended = datetime.fromisoformat(ended_at)
    except Exception:
        return None
    return max(0, int((ended - started).total_seconds() * 1000))


class CoworkTraceRecorder:
    """Append compact trace spans to a Cowork session."""

    def __init__(self, new_id) -> None:
        self._new_id = new_id

    def start_span(
        self,
        session: CoworkSession,
        *,
        kind: str,
        name: str,
        run_id: str | None = None,
        round_id: str | None = None,
        actor_id: str | None = None,
        parent_id: str | None = None,
        input_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
    ) -> CoworkTraceSpan:
        span = CoworkTraceSpan(
            id=self._new_id("span"),
            session_id=session.id,
            run_id=run_id,
            round_id=round_id,
            kind=kind,
            name=name,
            actor_id=actor_id,
            parent_id=parent_id,
            status="running",
            input_ref=compact_text(input_ref, 300),
            summary=compact_text(summary, 360),
            data=data or {},
        )
        session.trace_spans.append(span)
        return span

    def finish_span(
        self,
        span: CoworkTraceSpan,
        *,
        status: str = "completed",
        output_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
    ) -> CoworkTraceSpan:
        ended_at = now_iso()
        span.status = status
        span.ended_at = ended_at
        span.duration_ms = duration_ms(span.started_at, ended_at)
        if output_ref:
            span.output_ref = compact_text(output_ref, 300)
        if summary:
            span.summary = compact_text(summary, 360)
        if data:
            span.data.update(data)
        return span

    def fail_span(self, span: CoworkTraceSpan, error: str, *, summary: str = "") -> CoworkTraceSpan:
        self.finish_span(span, status="failed", summary=summary or error)
        span.error = compact_text(error, 500)
        return span

    def event_span(
        self,
        session: CoworkSession,
        *,
        kind: str,
        name: str,
        status: str = "completed",
        actor_id: str | None = None,
        run_id: str | None = None,
        round_id: str | None = None,
        parent_id: str | None = None,
        input_ref: str = "",
        output_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> CoworkTraceSpan:
        span = self.start_span(
            session,
            kind=kind,
            name=name,
            run_id=run_id,
            round_id=round_id,
            actor_id=actor_id,
            parent_id=parent_id,
            input_ref=input_ref,
            summary=summary,
            data=data,
        )
        self.finish_span(span, status=status, output_ref=output_ref, summary=summary, data=data)
        if error:
            span.error = compact_text(error, 500)
        return span
