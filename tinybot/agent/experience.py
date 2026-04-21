"""Experience storage for self-evolution: record reusable workflows and recoveries."""

from __future__ import annotations

import hashlib
import json
import platform
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from tinybot.utils.fs import ensure_dir

if TYPE_CHECKING:
    from tinybot.agent.vector_store import VectorStore


@dataclass
class Experience:
    """A single experience record representing a reusable workflow or recovery."""

    id: str = ""
    timestamp: str = ""
    tool_name: str = ""
    error_type: str = ""
    error_message: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    outcome: str = "success"  # "success" | "failure" | "resolved"
    experience_type: str = "reference"  # "workflow" | "recovery" | "reference"
    trigger_stage: str = "general"  # "before_plan" | "on_error" | ...
    resolution: str = ""
    context_summary: str = ""
    action_hint: str = ""
    applicability: str = ""
    params_summary: str = ""
    problem_signature: str = ""
    environment: str = ""
    confidence: float = 0.5
    source: str = "manual"  # "manual" | "tool_event" | "llm_summary"
    attempt_no: int = 1
    session_key: str = ""
    related_experience_id: str = ""
    merged_count: int = 0
    last_used_at: str = ""
    category: str = ""
    tags: list[str] = field(default_factory=list)
    use_count: int = 0
    applied_count: int = 0
    retry_success_count: int = 0
    success_count: int = 0
    feedback_positive: int = 0
    feedback_negative: int = 0


class ExperienceStore:
    """File-based storage for tool call experiences."""

    _DEFAULT_MAX_EXPERIENCES = 500
    _EXPERIENCE_COLLECTION = "experiences"

    def __init__(
        self,
        workspace: Path,
        max_experiences: int = _DEFAULT_MAX_EXPERIENCES,
        vector_store: VectorStore | None = None,
    ):
        self.workspace = workspace
        self.max_experiences = max_experiences
        self.vector_store = vector_store
        self.experience_dir = ensure_dir(workspace / "experiences")
        self.experience_file = self.experience_dir / "experiences.jsonl"
        self._cursor_file = self.experience_dir / ".cursor"
        self._indexed_ids: set[str] = set()

    def append_experience(
        self,
        tool_name: str,
        error_type: str = "",
        error_message: str = "",
        params: dict[str, Any] | None = None,
        outcome: str = "success",
        resolution: str = "",
        context_summary: str = "",
        confidence: float = 0.5,
        session_key: str = "",
        category: str = "",
        tags: list[str] | None = None,
        experience_type: str = "reference",
        trigger_stage: str = "general",
        action_hint: str = "",
        applicability: str = "",
        params_summary: str = "",
        environment: str = "",
        source: str = "manual",
        attempt_no: int = 1,
        related_experience_id: str = "",
        problem_signature: str = "",
    ) -> str:
        """Append a new experience and return its ID."""
        now = datetime.now()
        ts = now.strftime("%Y-%m-%dT%H:%M:%S")
        stable_params_summary = params_summary or self._summarize_params(params or {})
        stable_environment = environment or self._default_environment()
        stable_problem_signature = problem_signature or self._build_problem_signature(
            tool_name=tool_name,
            error_type=error_type,
            category=category,
            context_summary=context_summary,
            params_summary=stable_params_summary,
            experience_type=experience_type,
        )

        id_base = (
            f"{ts}:{tool_name}:{error_type}:{session_key}:{experience_type}:{trigger_stage}"
        )
        id_hash = hashlib.sha1(id_base.encode()).hexdigest()[:8]
        exp_id = f"exp_{id_hash}"

        exp = Experience(
            id=exp_id,
            timestamp=ts,
            tool_name=tool_name,
            error_type=error_type,
            error_message=error_message[:200] if error_message else "",
            params=params or {},
            outcome=outcome,
            experience_type=experience_type,
            trigger_stage=trigger_stage,
            resolution=resolution[:500] if resolution else "",
            context_summary=context_summary[:200] if context_summary else "",
            action_hint=action_hint[:240] if action_hint else "",
            applicability=applicability[:240] if applicability else "",
            params_summary=stable_params_summary[:240],
            problem_signature=stable_problem_signature[:240],
            environment=stable_environment[:120],
            confidence=min(1.0, max(0.0, confidence)),
            source=source,
            attempt_no=max(1, attempt_no),
            session_key=session_key,
            related_experience_id=related_experience_id,
            last_used_at=ts,
            category=category,
            tags=tags or [],
        )

        with open(self.experience_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(exp), ensure_ascii=False) + "\n")

        self._cursor_file.write_text(str(len(self.read_experiences())), encoding="utf-8")
        logger.debug(
            "ExperienceStore: appended {} ({}/{}/{})",
            exp_id,
            exp.experience_type,
            tool_name,
            outcome,
        )

        if self.vector_store:
            self._index_single_experience(exp)

        return exp_id

    def read_experiences(self) -> list[Experience]:
        """Read all experiences from the JSONL file."""
        experiences: list[Experience] = []
        try:
            with open(self.experience_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        experiences.append(Experience(**data))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return experiences

    def search_by_context(
        self,
        tool_name: str | None = None,
        error_type: str | None = None,
        outcome: str | None = None,
        keywords: list[str] | None = None,
        min_confidence: float = 0.0,
        limit: int = 10,
        experience_type: str | None = None,
        trigger_stage: str | None = None,
        category: str | None = None,
    ) -> list[Experience]:
        """Search experiences by explicit filters and keyword matching."""
        experiences = self.read_experiences()
        results: list[Experience] = []

        for exp in experiences:
            if tool_name and exp.tool_name != tool_name:
                continue
            if error_type and exp.error_type != error_type:
                continue
            if outcome and exp.outcome != outcome:
                continue
            if experience_type and exp.experience_type != experience_type:
                continue
            if trigger_stage and exp.trigger_stage != trigger_stage:
                continue
            if category and exp.category != category:
                continue
            if exp.confidence < min_confidence:
                continue

            if keywords:
                combined = " ".join(
                    part.lower()
                    for part in (
                        exp.context_summary,
                        exp.resolution,
                        exp.action_hint,
                        exp.applicability,
                        exp.params_summary,
                    )
                    if part
                )
                if not any(kw.lower() in combined for kw in keywords):
                    continue

            results.append(exp)

        results.sort(key=lambda e: e.confidence, reverse=True)
        return results[:limit]

    def search_by_problem(
        self,
        keywords: list[str],
        limit: int = 5,
        min_confidence: float = 0.5,
    ) -> list[Experience]:
        """Search resolved experiences by problem keywords."""
        return self.search_by_context(
            keywords=keywords,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=limit,
        )

    def search_semantic(
        self,
        query: str,
        tool_name: str | None = None,
        outcome: str | None = None,
        category: str | None = None,
        experience_type: str | None = None,
        trigger_stage: str | None = None,
        min_confidence: float = 0.3,
        limit: int = 5,
    ) -> list[Experience]:
        """Semantic search with keyword fallback."""
        if not self.vector_store:
            keywords = [w for w in query.split() if len(w) >= 2]
            return self.search_by_context(
                keywords=keywords,
                tool_name=tool_name,
                outcome=outcome,
                category=category,
                experience_type=experience_type,
                trigger_stage=trigger_stage,
                min_confidence=min_confidence,
                limit=limit,
            )

        self._ensure_vector_index()

        filters: list[dict[str, Any]] = []
        if tool_name:
            filters.append({"tool_name": tool_name})
        if outcome:
            filters.append({"outcome": outcome})
        if category:
            filters.append({"category": category})
        if experience_type:
            filters.append({"experience_type": experience_type})
        if trigger_stage:
            filters.append({"trigger_stage": trigger_stage})

        try:
            collection = self.vector_store._get_or_create_collection(
                self._EXPERIENCE_COLLECTION
            )
            where_filter: dict[str, Any] | None = None
            if filters:
                where_filter = {"$and": filters} if len(filters) > 1 else filters[0]

            results = collection.query(
                query_texts=[query],
                n_results=limit * 2,
                where=where_filter,
                include=["documents", "distances", "metadatas"],
            )
        except Exception:
            logger.warning("ExperienceStore: semantic search failed")
            return []

        ids = results.get("ids", [[]])[0]
        metas = results.get("metadatas", [[]])[0]
        dists = results.get("distances", [[]])[0]

        matched: list[Experience] = []
        for exp_id, meta, dist in zip(ids, metas, dists):
            if not meta:
                continue
            exp = self._load_from_metadata(meta)
            if not exp.id:
                exp.id = exp_id
            if exp.confidence < min_confidence:
                continue
            exp._distance = dist  # type: ignore[attr-defined]
            matched.append(exp)

        matched.sort(key=lambda e: (getattr(e, "_distance", 1.0), -e.confidence))
        return matched[:limit]

    def search_workflows(
        self,
        query: str,
        limit: int = 3,
        min_confidence: float = 0.5,
    ) -> list[Experience]:
        """Find reusable workflow experiences for a user request."""
        return self.search_semantic(
            query=query,
            experience_type="workflow",
            trigger_stage="before_plan",
            min_confidence=min_confidence,
            limit=limit,
        )

    def search_recoveries(
        self,
        query: str,
        tool_name: str | None = None,
        error_type: str | None = None,
        limit: int = 3,
        min_confidence: float = 0.4,
    ) -> list[Experience]:
        """Find recovery experiences for an execution failure."""
        exact = self.search_by_context(
            tool_name=tool_name,
            error_type=error_type,
            outcome="resolved",
            experience_type="recovery",
            trigger_stage="on_error",
            min_confidence=min_confidence,
            limit=limit,
        )
        if exact:
            return exact

        semantic = self.search_semantic(
            query=query,
            tool_name=tool_name,
            outcome="resolved",
            experience_type="recovery",
            trigger_stage="on_error",
            min_confidence=min_confidence,
            limit=limit,
        )
        if semantic:
            return semantic

        return self.search_semantic(
            query=query,
            outcome="resolved",
            experience_type="recovery",
            trigger_stage="on_error",
            min_confidence=min_confidence,
            limit=limit,
        )

    def _ensure_vector_index(self) -> None:
        if not self.vector_store:
            return

        try:
            collection = self.vector_store._get_or_create_collection(
                self._EXPERIENCE_COLLECTION
            )
        except Exception:
            logger.warning("ExperienceStore: failed to get/create collection")
            return

        experiences = self.read_experiences()
        new_ids: list[str] = []
        new_docs: list[str] = []
        new_metas: list[dict[str, Any]] = []

        for exp in experiences:
            if exp.id in self._indexed_ids:
                continue
            new_ids.append(exp.id)
            new_docs.append(self._build_embedding_text(exp))
            new_metas.append(self._experience_to_metadata(exp))
            self._indexed_ids.add(exp.id)

        if new_ids:
            try:
                collection.upsert(
                    ids=new_ids,
                    documents=new_docs,
                    metadatas=new_metas,
                )
                logger.debug(
                    "ExperienceStore: indexed {} experiences to vector store",
                    len(new_ids),
                )
            except Exception:
                logger.warning("ExperienceStore: vector upsert failed")

    def _build_embedding_text(self, exp: Experience) -> str:
        parts = []
        if exp.context_summary:
            parts.append(exp.context_summary)
        if exp.action_hint:
            parts.append(f"Action: {exp.action_hint}")
        if exp.applicability:
            parts.append(f"When: {exp.applicability}")
        if exp.params_summary:
            parts.append(f"Params: {exp.params_summary}")
        if exp.error_message:
            parts.append(f"Error: {exp.error_message}")
        if exp.resolution:
            parts.append(f"Resolution: {exp.resolution}")
        if exp.tool_name:
            parts.append(f"Tool: {exp.tool_name}")
        if exp.category:
            parts.append(f"Category: {exp.category}")
        if exp.experience_type:
            parts.append(f"Type: {exp.experience_type}")
        if exp.trigger_stage:
            parts.append(f"Stage: {exp.trigger_stage}")
        if exp.environment:
            parts.append(f"Environment: {exp.environment}")
        return " | ".join(parts)

    def _experience_to_metadata(self, exp: Experience) -> dict[str, Any]:
        return {
            "id": exp.id,
            "tool_name": exp.tool_name,
            "error_type": exp.error_type,
            "outcome": exp.outcome,
            "confidence": exp.confidence,
            "category": exp.category or "",
            "experience_type": exp.experience_type,
            "trigger_stage": exp.trigger_stage,
            "action_hint": exp.action_hint[:200] if exp.action_hint else "",
            "applicability": exp.applicability[:200] if exp.applicability else "",
            "params_summary": exp.params_summary[:200] if exp.params_summary else "",
            "environment": exp.environment or "",
            "source": exp.source,
            "related_experience_id": exp.related_experience_id or "",
            "tags": json.dumps(exp.tags, ensure_ascii=False) if exp.tags else "[]",
            "resolution": exp.resolution[:200] if exp.resolution else "",
        }

    def _load_from_metadata(self, meta: dict[str, Any]) -> Experience:
        tags: list[str] = []
        if meta.get("tags"):
            try:
                tags = json.loads(meta["tags"])
            except json.JSONDecodeError:
                pass

        return Experience(
            id=meta.get("id", ""),
            tool_name=meta.get("tool_name", ""),
            error_type=meta.get("error_type", ""),
            outcome=meta.get("outcome", "success"),
            confidence=meta.get("confidence", 0.5),
            category=meta.get("category", ""),
            experience_type=meta.get("experience_type", "reference"),
            trigger_stage=meta.get("trigger_stage", "general"),
            action_hint=meta.get("action_hint", ""),
            applicability=meta.get("applicability", ""),
            params_summary=meta.get("params_summary", ""),
            environment=meta.get("environment", ""),
            source=meta.get("source", "manual"),
            related_experience_id=meta.get("related_experience_id", ""),
            tags=tags,
            resolution=meta.get("resolution", ""),
        )

    def _index_single_experience(self, exp: Experience) -> None:
        if not self.vector_store:
            return

        try:
            collection = self.vector_store._get_or_create_collection(
                self._EXPERIENCE_COLLECTION
            )
            collection.upsert(
                ids=[exp.id],
                documents=[self._build_embedding_text(exp)],
                metadatas=[self._experience_to_metadata(exp)],
            )
            self._indexed_ids.add(exp.id)
        except Exception:
            logger.warning("ExperienceStore: failed to index experience {}", exp.id)

    def get_similar_experiences(
        self,
        tool_name: str,
        error_type: str = "",
        limit: int = 5,
        min_confidence: float = 0.3,
    ) -> list[Experience]:
        exact = self.search_by_context(
            tool_name=tool_name,
            error_type=error_type,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=limit,
        )

        if len(exact) >= limit:
            return exact

        tool_only = self.search_by_context(
            tool_name=tool_name,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=limit - len(exact),
        )

        seen_ids = {e.id for e in exact}
        combined = exact + [e for e in tool_only if e.id not in seen_ids]
        return combined[:limit]

    def merge_similar(self) -> int:
        experiences = self.read_experiences()
        if not experiences:
            return 0

        groups: dict[str, list[Experience]] = {}
        for exp in experiences:
            groups.setdefault(self._build_merge_key(exp), []).append(exp)

        merged_count = 0
        new_experiences: list[Experience] = []

        for group in groups.values():
            if len(group) == 1:
                new_experiences.append(group[0])
                continue

            group.sort(key=lambda e: e.timestamp, reverse=True)
            base = group[0]
            last_used_dates = [e.last_used_at for e in group if e.last_used_at]
            last_used_at = max(last_used_dates) if last_used_dates else base.last_used_at

            merged = Experience(
                id=base.id,
                timestamp=base.timestamp,
                tool_name=base.tool_name,
                error_type=base.error_type,
                error_message=base.error_message,
                params=base.params,
                outcome=base.outcome,
                experience_type=base.experience_type,
                trigger_stage=base.trigger_stage,
                resolution=base.resolution,
                context_summary=base.context_summary,
                action_hint=base.action_hint,
                applicability=base.applicability,
                params_summary=base.params_summary,
                problem_signature=base.problem_signature,
                environment=base.environment,
                confidence=min(1.0, 0.5 + 0.1 * len(group)),
                source=base.source,
                attempt_no=max((e.attempt_no for e in group), default=base.attempt_no),
                session_key=base.session_key,
                related_experience_id=base.related_experience_id,
                merged_count=len(group),
                last_used_at=last_used_at,
                category=base.category,
                tags=base.tags,
                use_count=sum(e.use_count for e in group),
                applied_count=sum(e.applied_count for e in group),
                retry_success_count=sum(e.retry_success_count for e in group),
                success_count=sum(e.success_count for e in group),
                feedback_positive=sum(e.feedback_positive for e in group),
                feedback_negative=sum(e.feedback_negative for e in group),
            )
            new_experiences.append(merged)
            merged_count += len(group) - 1

        self._write_experiences(new_experiences)
        logger.info("ExperienceStore: merged {} experiences", merged_count)
        return merged_count

    def compact(self) -> None:
        experiences = self.read_experiences()
        if len(experiences) <= self.max_experiences:
            return

        experiences.sort(key=lambda e: (e.confidence, e.timestamp), reverse=True)
        kept = experiences[:self.max_experiences]
        self._write_experiences(kept)
        logger.info("ExperienceStore: compacted to {} experiences", len(kept))

    def decay_confidence(self, days_threshold: int = 30, decay_rate: float = 0.1) -> int:
        experiences = self.read_experiences()
        if not experiences:
            return 0

        now = datetime.now()
        decayed_count = 0

        for exp in experiences:
            if not exp.last_used_at:
                continue

            try:
                last_used = datetime.fromisoformat(exp.last_used_at)
            except ValueError:
                continue

            days_unused = (now - last_used).days
            if days_unused > days_threshold:
                periods = days_unused // days_threshold
                new_confidence = exp.confidence * (1 - decay_rate * periods)
                new_confidence = max(0.1, new_confidence)
                if new_confidence < exp.confidence:
                    exp.confidence = new_confidence
                    decayed_count += 1

        if decayed_count > 0:
            self._write_experiences(experiences)
            logger.info(
                "ExperienceStore: decayed {} experiences (threshold={} days)",
                decayed_count,
                days_threshold,
            )

        return decayed_count

    def prune_stale(
        self,
        min_confidence: float = 0.3,
        max_age_days: int = 90,
    ) -> int:
        experiences = self.read_experiences()
        if not experiences:
            return 0

        now = datetime.now()
        kept: list[Experience] = []
        pruned_count = 0

        for exp in experiences:
            if exp.confidence >= min_confidence:
                kept.append(exp)
                continue

            try:
                created = datetime.fromisoformat(exp.timestamp)
            except ValueError:
                pruned_count += 1
                continue

            age_days = (now - created).days
            if age_days < max_age_days:
                kept.append(exp)
            else:
                pruned_count += 1

        if pruned_count > 0:
            self._write_experiences(kept)
            logger.info(
                "ExperienceStore: pruned {} stale experiences (min_conf={}, max_age={} days)",
                pruned_count,
                min_confidence,
                max_age_days,
            )

        return pruned_count

    def mark_used(self, exp_id: str) -> bool:
        experiences = self.read_experiences()
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

        for exp in experiences:
            if exp.id == exp_id:
                exp.last_used_at = now
                exp.use_count += 1
                self._write_experiences(experiences)
                return True

        return False

    def update_confidence(self, exp_id: str, delta: float, is_feedback: bool = True) -> bool:
        experiences = self.read_experiences()

        for exp in experiences:
            if exp.id == exp_id:
                if is_feedback:
                    if delta > 0:
                        exp.feedback_positive += 1
                        exp.success_count += 1
                    else:
                        exp.feedback_negative += 1

                exp.confidence = min(1.0, max(0.1, self._calculate_confidence(exp, delta)))
                self._write_experiences(experiences)
                logger.debug(
                    "ExperienceStore: confidence updated {} -> {} (use={}, feedback={}/{})",
                    exp_id,
                    exp.confidence,
                    exp.use_count,
                    exp.feedback_positive,
                    exp.feedback_negative,
                )
                return True

        return False

    def record_application(self, exp_id: str, succeeded: bool = False) -> bool:
        """Record that an experience was explicitly applied during execution."""
        experiences = self.read_experiences()

        for exp in experiences:
            if exp.id == exp_id:
                exp.applied_count += 1
                if succeeded:
                    exp.retry_success_count += 1
                    exp.success_count += 1
                    exp.feedback_positive += 1
                exp.confidence = min(
                    1.0,
                    max(0.1, self._calculate_confidence(exp, 0.12 if succeeded else 0.03)),
                )
                exp.last_used_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                self._write_experiences(experiences)
                return True

        return False

    def delete_experience(self, exp_id: str) -> bool:
        experiences = self.read_experiences()
        original_count = len(experiences)
        kept = [exp for exp in experiences if exp.id != exp_id]

        if len(kept) < original_count:
            self._write_experiences(kept)
            logger.info("ExperienceStore: deleted experience {}", exp_id)
            return True

        return False

    def record_tool_event(
        self,
        *,
        tool_name: str,
        params: dict[str, Any] | None,
        status: str,
        detail: str,
        session_key: str,
        attempt_no: int = 1,
        related_experience_id: str = "",
    ) -> str | None:
        """Persist actionable tool execution events as structured experiences."""
        params_summary = self._summarize_params(params or {})
        environment = self._default_environment()

        if status == "error":
            error_type, error_message = self._parse_error_detail(detail)
            return self.append_experience(
                tool_name=tool_name,
                error_type=error_type,
                error_message=error_message,
                params=params or {},
                outcome="failure",
                experience_type="recovery",
                trigger_stage="on_error",
                action_hint="Diagnose the failure and retry with a different approach.",
                applicability=f"Tool `{tool_name}` failed on attempt {attempt_no}.",
                params_summary=params_summary,
                environment=environment,
                session_key=session_key,
                source="tool_event",
                attempt_no=attempt_no,
                related_experience_id=related_experience_id,
                confidence=0.35,
                category=self._infer_category(error_type, error_message),
            )

        if status == "ok" and related_experience_id:
            self.record_application(related_experience_id, succeeded=True)
            return self.append_experience(
                tool_name=tool_name,
                params=params or {},
                outcome="resolved",
                experience_type="recovery",
                trigger_stage="after_success",
                resolution="Retry succeeded after applying a previously retrieved recovery strategy.",
                action_hint="Reuse the same recovery pattern when this scenario repeats.",
                applicability=f"Successful retry for `{tool_name}` on attempt {attempt_no}.",
                params_summary=params_summary,
                environment=environment,
                session_key=session_key,
                source="tool_event",
                attempt_no=attempt_no,
                related_experience_id=related_experience_id,
                confidence=0.7,
                category="general",
            )

        return None

    def _write_experiences(self, experiences: list[Experience]) -> None:
        with open(self.experience_file, "w", encoding="utf-8") as f:
            for exp in experiences:
                f.write(json.dumps(asdict(exp), ensure_ascii=False) + "\n")
        self._cursor_file.write_text(str(len(experiences)), encoding="utf-8")

        self._indexed_ids.clear()
        if self.vector_store:
            self._ensure_vector_index()

    def get_stats(self) -> dict[str, Any]:
        experiences = self.read_experiences()
        if not experiences:
            return {"count": 0, "tools": {}, "outcomes": {}}

        tools: dict[str, int] = {}
        outcomes: dict[str, int] = {}
        avg_confidence = 0.0

        for exp in experiences:
            tools[exp.tool_name] = tools.get(exp.tool_name, 0) + 1
            outcomes[exp.outcome] = outcomes.get(exp.outcome, 0) + 1
            avg_confidence += exp.confidence

        return {
            "count": len(experiences),
            "tools": tools,
            "outcomes": outcomes,
            "avg_confidence": avg_confidence / len(experiences),
            "merged_total": sum(e.merged_count for e in experiences),
        }

    def _calculate_confidence(self, exp: Experience, delta: float = 0.0) -> float:
        base = exp.confidence + delta

        usage_weight = min(1.0, exp.use_count / 10.0)
        total_feedback = exp.feedback_positive + exp.feedback_negative
        if total_feedback > 0:
            success_weight = exp.feedback_positive / total_feedback
        else:
            success_weight = 0.5

        freshness_weight = 1.0
        if exp.last_used_at:
            try:
                last_used = datetime.fromisoformat(exp.last_used_at)
                days_unused = (datetime.now() - last_used).days
                freshness_weight = max(0.2, 1.0 - days_unused / 90.0)
            except ValueError:
                pass

        merge_weight = min(1.0, exp.merged_count / 5.0)
        application_weight = min(1.0, exp.applied_count / 5.0)
        retry_weight = (
            exp.retry_success_count / exp.applied_count if exp.applied_count else 0.5
        )

        combined_weight = (
            0.2 * usage_weight
            + 0.2 * success_weight
            + 0.2 * freshness_weight
            + 0.15 * merge_weight
            + 0.15 * application_weight
            + 0.1 * retry_weight
        )
        return base * (0.5 + 0.5 * combined_weight)

    @staticmethod
    def _default_environment() -> str:
        return f"{platform.system()} / Python {platform.python_version()}"

    @staticmethod
    def _summarize_params(params: dict[str, Any]) -> str:
        if not params:
            return ""

        parts: list[str] = []
        for key in sorted(params)[:4]:
            value = params.get(key)
            if isinstance(value, str):
                rendered = value[:60]
            elif isinstance(value, (int, float, bool)):
                rendered = str(value)
            elif isinstance(value, list):
                rendered = f"list[{len(value)}]"
            elif isinstance(value, dict):
                rendered = f"dict[{len(value)}]"
            else:
                rendered = type(value).__name__
            parts.append(f"{key}={rendered}")
        return ", ".join(parts)

    @staticmethod
    def _parse_error_detail(detail: str) -> tuple[str, str]:
        if ":" in detail:
            error_type, error_message = detail.split(":", 1)
            return error_type.strip() or "UnknownError", error_message.strip()[:200]
        return "UnknownError", detail[:200]

    @staticmethod
    def _infer_category(error_type: str, error_message: str) -> str:
        text = f"{error_type} {error_message}".lower()
        if any(token in text for token in ("path", "file", "directory", "not found")):
            return "path"
        if any(token in text for token in ("permission", "denied", "access")):
            return "permission"
        if any(token in text for token in ("encoding", "unicode", "utf")):
            return "encoding"
        if any(token in text for token in ("timeout", "connection", "network")):
            return "network"
        if any(token in text for token in ("config", "environment", "setting")):
            return "config"
        if any(token in text for token in ("dependency", "module", "package")):
            return "dependency"
        return "general"

    def _build_problem_signature(
        self,
        *,
        tool_name: str,
        error_type: str,
        category: str,
        context_summary: str,
        params_summary: str,
        experience_type: str,
    ) -> str:
        signature_parts = [
            experience_type,
            tool_name.strip().lower(),
            error_type.strip().lower(),
            category.strip().lower(),
            context_summary.strip().lower()[:80],
            params_summary.strip().lower()[:80],
        ]
        return "|".join(part for part in signature_parts if part)

    def _build_merge_key(self, exp: Experience) -> str:
        tag_part = ",".join(sorted(exp.tags)[:3])
        return "|".join(
            part
            for part in (
                exp.experience_type,
                exp.trigger_stage,
                exp.tool_name,
                exp.error_type,
                exp.category,
                exp.problem_signature or exp.context_summary[:80],
                exp.params_summary[:80],
                tag_part,
                exp.outcome,
            )
            if part
        )
