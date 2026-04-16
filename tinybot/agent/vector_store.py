"""ChromaDB-backed vector store for session conversation summaries."""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime

from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from tinybot.session.manager import SessionManager


class VectorStore:
    """Stores and retrieves conversation summaries using ChromaDB.

    Each session has its own collection. When consolidation happens,
    old messages are summarized and stored as a single document with
    their original text chunks as additional context.
    """

    _lock = threading.Lock()
    _client = None
    _embedding_fn = None

    def __init__(self, persist_dir: Path | str) -> None:
        self._persist_dir = Path(persist_dir)

    @property
    def client(self):
        if self._client is None:
            with self._lock:
                if self._client is None:
                    import chromadb

                    self._client = chromadb.PersistentClient(
                        path=str(self._persist_dir)
                    )
                    logger.info(
                        "ChromaDB initialized at {}", self._persist_dir
                    )
        return self._client

    def _get_embedding_function(self):
        if self._embedding_fn is None:
            with self._lock:
                if self._embedding_fn is None:
                    from chromadb.utils.embedding_functions import (
                        SentenceTransformerEmbeddingFunction,
                    )

                    model_cache_dir = Path.home() / ".tinybot" / "models"
                    model_local_path = model_cache_dir / "all-MiniLM-L6-v2"

                    if model_local_path.exists() and (
                        model_local_path / "config.json"
                    ).exists():
                        model_name = str(model_local_path)
                        logger.info(
                            "Loading embedding model from local cache: {}",
                            model_local_path,
                        )
                    else:
                        model_name = "all-MiniLM-L6-v2"
                        model_cache_dir.mkdir(parents=True, exist_ok=True)
                        logger.info(
                            "Downloading embedding model (first run only)..."
                        )

                    device = "cpu"
                    try:
                        import torch

                        if torch.cuda.is_available():
                            device = "cuda"
                    except ImportError:
                        pass

                    logger.info("Embedding device: {}", device)
                    self._embedding_fn = (
                        SentenceTransformerEmbeddingFunction(
                            model_name=model_name,
                            device=device,
                        )
                    )

                    # Persist downloaded model to local cache for future use
                    if not (model_local_path / "config.json").exists():
                        try:
                            self._embedding_fn.model.save(str(model_local_path))
                            logger.info(
                                "Embedding model saved to local cache: {}",
                                model_local_path,
                            )
                        except Exception as e:
                            logger.warning(
                                "Failed to cache embedding model: {}", e
                            )
        return self._embedding_fn

    def _collection_name(self, session_key: str) -> str:
        safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in session_key)
        return f"session_{safe}"[:63]

    def store_summary(
        self,
        session_key: str,
        summary: str,
        messages: list[dict[str, Any]],
        boundary_start: int,
        boundary_end: int,
        topics: list[str] | None = None,
    ) -> None:
        """Store a consolidation summary with session_key metadata.

        No longer stores original message chunks — those are retrieved
        dynamically from SessionManager during search.

        Args:
            session_key: The session identifier.
            summary: LLM-generated summary text.
            messages: The original messages being consolidated (used for count only).
            boundary_start: Start index in session.messages.
            boundary_end: End index in session.messages.
            topics: Optional list of topic keywords for filtering.
        """
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )
        except Exception:
            self.client.delete_collection(name=collection_name)
            collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )

        now = datetime.now().isoformat()

        main_id = f"summary_{boundary_start}_{boundary_end}"
        summary_meta: dict[str, Any] = {
            "type": "summary",
            "session_key": session_key,
            "boundary_start": boundary_start,
            "boundary_end": boundary_end,
            "message_count": len(messages),
            "created_at": now,
        }
        if topics:
            summary_meta["topics"] = json.dumps(topics, ensure_ascii=False)
        collection.upsert(
            ids=[main_id],
            documents=[summary],
            metadatas=[summary_meta],
        )

        logger.info(
            "VectorStore: stored summary for {} ({} msgs, boundary {}-{})",
            session_key, len(messages), boundary_start, boundary_end,
        )

    def get_latest_summary(self, session_key: str) -> str | None:
        """Return the most recent summary for a session, or None."""
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return None

        results = collection.get(
            where={"type": "summary"},
            include=["documents", "metadatas"],
        )

        if not results["documents"]:
            return None

        summaries = list(zip(results["documents"], results["metadatas"]))
        summaries.sort(key=lambda x: x[1].get("boundary_end", 0), reverse=True)
        return summaries[0][0] if summaries else None

    def search_relevant_chunks(
        self,
        session_key: str,
        query: str,
        top_k: int = 3,
        exclude_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Semantic search for history fragments relevant to *query*.

        Searches both summary and original_chunk documents in the session's
        ChromaDB collection, returning the *top_k* most relevant text
        fragments ordered by descending similarity.

        Args:
            session_key: The session identifier (``channel:chat_id``).
            query: The current user message (or a derived search query).
            top_k: Maximum number of results to return.
            exclude_ids: Optional set of document IDs to exclude (for dedup).

        Returns:
            A list of dicts with keys: id, content, distance, metadata.
        """
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return []

        count = collection.count()
        if count == 0:
            return []

        n_results = min(top_k + (len(exclude_ids) if exclude_ids else 0), count)
        if n_results <= 0:
            return []

        try:
            results = collection.query(
                query_texts=[query],
                n_results=n_results,
                include=["documents", "distances", "metadatas"],
            )
        except Exception:
            logger.warning("VectorStore: semantic search failed for {}", session_key)
            return []

        ids = results.get("ids", [[]])[0]
        documents = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]

        out: list[dict[str, Any]] = []
        for doc_id, doc, dist, meta in zip(ids, documents, distances, metadatas):
            if not doc:
                continue
            if exclude_ids and doc_id in exclude_ids:
                continue
            out.append({
                "id": doc_id,
                "content": doc,
                "distance": dist,
                "metadata": meta or {},
            })
        return out[:top_k]

    def search_relevant_summaries(
        self,
        session_key: str,
        query: str,
        top_k: int = 2,
    ) -> list[dict[str, Any]]:
        """Semantic search for summaries relevant to *query*.

        Args:
            session_key: The session identifier.
            query: The search query text.
            top_k: Maximum number of summaries to return.

        Returns:
            A list of dicts with keys: id, content, distance, metadata.
        """
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return []

        count = collection.count()
        if count == 0:
            return []

        n_results = min(top_k, count)
        try:
            results = collection.query(
                query_texts=[query],
                n_results=n_results,
                where={"type": "summary"},
                include=["documents", "distances", "metadatas"],
            )
        except Exception:
            logger.warning("VectorStore: summary search failed for {}", session_key)
            return []

        ids = results.get("ids", [[]])[0]
        documents = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]

        out: list[dict[str, Any]] = []
        for doc_id, doc, dist, meta in zip(ids, documents, distances, metadatas):
            if not doc:
                continue
            out.append({
                "id": doc_id,
                "content": doc,
                "distance": dist,
                "metadata": meta or {},
            })
        return out

    @staticmethod
    def _query_terms(query: str) -> set[str]:
        lowered = query.lower()
        terms = {match.group(0) for match in re.finditer(r"[a-z0-9_]{2,}", lowered)}

        cjk_text = "".join(ch for ch in query if "\u4e00" <= ch <= "\u9fff")
        for size in (2, 3):
            for idx in range(max(0, len(cjk_text) - size + 1)):
                terms.add(cjk_text[idx: idx + size])
        return {term for term in terms if term}

    @classmethod
    def _lexical_score(cls, query: str, text: str) -> float:
        if not query.strip() or not text.strip():
            return 0.0
        query_terms = cls._query_terms(query)
        lowered_text = text.lower()
        score = 0.0
        for term in query_terms:
            if term in lowered_text:
                score += 1.6 if len(term) >= 4 else 1.0
        if query.strip()[:80] and query.strip()[:80].lower() in lowered_text:
            score += 2.5
        return score

    @classmethod
    def _rerank_by_query(
        cls,
        query: str,
        items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not query.strip() or len(items) <= 1:
            return items

        def _rank(item: dict[str, Any]) -> tuple[float, float]:
            text = str(item.get("content") or "")
            lexical = cls._lexical_score(query, text)
            distance = float(item.get("distance") or 0.0)
            return (lexical - (distance * 0.75), -distance)

        return sorted(items, key=_rank, reverse=True)

    def search_with_hierarchy(

        self,
        session_key: str,
        query: str,
        max_summaries: int = 2,
        max_chunks_per_summary: int = 2,
        distance_threshold: float = 1.5,
        session_manager: SessionManager | None = None,
    ) -> list[dict[str, Any]]:
        """Hierarchical retrieval: find relevant summaries, then their original messages.

        Step 1: Search for the most relevant summaries.
        Step 2: For each summary, retrieve original messages:
                - If session_key is in metadata (new data): dynamically read from
                  SessionManager using boundary info.
                - If session_key is absent (legacy data): fall back to reading
                  pre-stored original_chunk documents.
        Step 3: Combine results sorted by boundary (chronological order).

        Args:
            session_key: The session identifier.
            query: The search query text.
            max_summaries: Maximum number of summaries to retrieve.
            max_chunks_per_summary: Maximum chunks per summary.
            distance_threshold: Skip results with distance above this threshold.
            session_manager: Optional SessionManager for dynamic message retrieval.

        Returns:
            A list of dicts with keys: id, type, content, distance, metadata,
            boundary (int or None).
        """
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return []

        # Step 1: search summaries
        summaries = self.search_relevant_summaries(
            session_key, query, top_k=max_summaries,
        )
        summaries = self._rerank_by_query(query, summaries)


        # Adapt distance threshold based on collection size:
        # fewer documents → looser threshold (more tolerant),
        # more documents → tighter threshold (more selective).
        adaptive_threshold = distance_threshold
        try:
            doc_count = collection.count()
            if doc_count >= 20:
                adaptive_threshold = min(distance_threshold, 1.0)
            elif doc_count >= 10:
                adaptive_threshold = min(distance_threshold, 1.2)
        except Exception:
            pass

        if not summaries:
            return []

        results: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        for summary in summaries:
            if summary["distance"] > adaptive_threshold:
                continue
            summary_id = summary["id"]
            meta = summary["metadata"]
            boundary_end = meta.get("boundary_end", 0)

            results.append({
                "id": summary_id,
                "type": "summary",
                "content": summary["content"],
                "distance": summary["distance"],
                "metadata": meta,
                "boundary": boundary_end,
            })
            seen_ids.add(summary_id)

            # Step 2: retrieve original messages
            stored_session_key = meta.get("session_key")

            if stored_session_key and session_manager is not None:
                # New data path: dynamically read from SessionManager
                chunks = self._read_chunks_from_session(
                    session_manager,
                    stored_session_key,
                    {**meta, "id": summary_id},
                    query,
                    max_chunks=max_chunks_per_summary,
                )

                for chunk in chunks:
                    cid = chunk["id"]
                    if cid in seen_ids:
                        continue
                    seen_ids.add(cid)
                    results.append(chunk)
            else:
                # Legacy data path: fall back to pre-stored chunks
                chunks = self._read_legacy_chunks(
                    collection, summary_id, query,
                    max_chunks=max_chunks_per_summary,
                    adaptive_threshold=adaptive_threshold,
                )
                for chunk in chunks:
                    cid = chunk["id"]
                    if cid in seen_ids:
                        continue
                    seen_ids.add(cid)
                    results.append(chunk)

        # Step 3: sort by boundary (chronological) then trim
        results.sort(key=lambda x: x.get("boundary") or 0)

        # Apply per-summary chunk limit
        summary_chunk_counts: dict[str, int] = {}
        trimmed: list[dict[str, Any]] = []
        for item in results:
            if item["type"] == "summary":
                trimmed.append(item)
                continue
            # chunk
            parent = item["metadata"].get("summary_ref", "")
            count = summary_chunk_counts.get(parent, 0)
            if count >= max_chunks_per_summary:
                continue
            summary_chunk_counts[parent] = count + 1
            trimmed.append(item)

        return trimmed

    @staticmethod
    def _format_message_chunk(messages: list[dict[str, Any]]) -> str:
        """Format a list of messages into chunk text (matches legacy chunk format)."""
        lines = []
        for m in messages:
            role = m.get("role", "?")
            content = m.get("content", "")
            if isinstance(content, list):
                parts = []
                for p in content:
                    if isinstance(p, dict) and p.get("type") == "text":
                        parts.append(p.get("text", ""))
                content = "\n".join(parts)
            ts = (m.get("timestamp") or "?")[:16]
            lines.append(f"[{ts}] {role}: {content}")
        return "\n".join(lines)

    def _read_chunks_from_session(
        self,
        session_manager: SessionManager,
        session_key: str,
        summary_meta: dict[str, Any],
        query: str,
        max_chunks: int = 2,
    ) -> list[dict[str, Any]]:
        """Dynamically read original messages from SessionManager.

        Splits the boundary range into chunks and returns formatted results.
        """
        boundary_start = summary_meta.get("boundary_start", 0)
        boundary_end = summary_meta.get("boundary_end", 0)
        summary_id = summary_meta.get("id", "")

        try:
            session = session_manager.get_or_create(session_key)
        except Exception:
            logger.debug(
                "VectorStore: failed to get session {} for dynamic chunk reading",
                session_key,
            )
            return []

        # Clamp indices to actual session length
        msg_count = len(session.messages)
        start = max(0, min(boundary_start, msg_count))
        end = max(0, min(boundary_end, msg_count))
        if start >= end:
            return []

        raw_messages = session.messages[start:end]
        if not raw_messages:
            return []

        # Split into chunks of 5 messages each (same as legacy format)
        chunk_size = 5
        chunks: list[dict[str, Any]] = []
        for i in range(0, len(raw_messages), chunk_size):
            batch = raw_messages[i : i + chunk_size]
            chunk_text = self._format_message_chunk(batch)
            chunk_id = f"dynamic_chunk_{boundary_start}_{start + i}_{len(batch)}"
            chunks.append({
                "id": chunk_id,
                "type": "chunk",
                "content": chunk_text,
                "distance": 0.0,  # Dynamic chunks are re-ranked locally below
                "metadata": {
                    "summary_ref": summary_id,
                    "boundary_start": boundary_start,
                    "session_key": session_key,
                },
                "boundary": start + i,
            })

        if len(chunks) > max_chunks:
            chunks = self._rerank_by_query(query, chunks)[:max_chunks]
            chunks.sort(key=lambda item: item.get("boundary") or 0)

        return chunks


    @staticmethod
    def _read_legacy_chunks(
        collection,
        summary_ref: str,
        query: str,
        max_chunks: int = 2,
        adaptive_threshold: float = 1.5,
    ) -> list[dict[str, Any]]:
        """Read pre-stored original_chunk documents (legacy data compatibility)."""
        try:
            # Count child chunks first
            child_count_result = collection.get(
                where={
                    "$and": [
                        {"type": "original_chunk"},
                        {"summary_ref": summary_ref},
                    ]
                },
                include=[],
            )
            child_ids = child_count_result.get("ids", [])
            if not child_ids:
                return []

            # Use semantic search to rank chunks by actual relevance
            n_chunk_results = min(max_chunks, len(child_ids))
            chunk_results = collection.query(
                query_texts=[query],
                n_results=n_chunk_results,
                where={
                    "$and": [
                        {"type": "original_chunk"},
                        {"summary_ref": summary_ref},
                    ]
                },
                include=["documents", "distances", "metadatas"],
            )
        except Exception:
            return []

        c_ids = chunk_results.get("ids", [[]])[0]
        c_docs = chunk_results.get("documents", [[]])[0]
        c_dists = chunk_results.get("distances", [[]])[0]
        c_metas = chunk_results.get("metadatas", [[]])[0]

        out: list[dict[str, Any]] = []
        for cid, cdoc, cdist, cmeta in zip(c_ids, c_docs, c_dists, c_metas):
            if not cdoc:
                continue
            if cdist > adaptive_threshold:
                continue
            out.append({
                "id": cid,
                "type": "chunk",
                "content": cdoc,
                "distance": cdist,
                "metadata": cmeta or {},
                "boundary": (cmeta or {}).get("boundary_start", 0),
            })
        return out

    def search_by_topics(
        self,
        session_key: str,
        topics: list[str],
        query: str,
        top_k: int = 2,
    ) -> list[dict[str, Any]]:
        """Search summaries matching given topic keywords, then rank by semantic relevance.

        ChromaDB metadata filtering does not support array-contains queries,
        so we retrieve all summaries and filter in Python.

        Args:
            session_key: The session identifier.
            topics: Topic keywords to match (any match counts).
            query: The search query text for ranking.
            top_k: Maximum number of results to return.

        Returns:
            A list of dicts with keys: id, content, distance, metadata.
        """
        if not topics:
            return []

        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return []

        # Retrieve all summaries and filter by topics in Python
        try:
            all_summaries = collection.get(
                where={"type": "summary"},
                include=["documents", "metadatas"],
            )
        except Exception:
            return []

        if not all_summaries["documents"]:
            return []

        # Filter: keep summaries whose stored topics overlap with query topics
        candidate_ids: list[str] = []
        candidate_docs: list[str] = []
        candidate_metas: list[dict] = []
        topics_set = set(topics)

        for sid, doc, meta in zip(
            all_summaries["ids"],
            all_summaries["documents"],
            all_summaries["metadatas"],
        ):
            if not doc:
                continue
            stored_topics_raw = meta.get("topics", "[]")
            try:
                stored_topics = set(json.loads(stored_topics_raw))
            except (json.JSONDecodeError, TypeError):
                stored_topics = set()
            if topics_set & stored_topics:
                candidate_ids.append(sid)
                candidate_docs.append(doc)
                candidate_metas.append(meta or {})

        if not candidate_docs:
            return []

        # Re-rank candidates by semantic relevance to query
        n_results = min(top_k, len(candidate_docs))
        try:
            ranked = collection.query(
                query_texts=[query],
                n_results=n_results,
                where={"type": "summary"},
                include=["documents", "distances", "metadatas"],
            )
        except Exception:
            return []

        # Intersect ranked results with topic-filtered candidates
        candidate_id_set = set(candidate_ids)
        out: list[dict[str, Any]] = []
        for rid, rdoc, rdist, rmeta in zip(
            ranked.get("ids", [[]])[0],
            ranked.get("documents", [[]])[0],
            ranked.get("distances", [[]])[0],
            ranked.get("metadatas", [[]])[0],
        ):
            if rid in candidate_id_set and rdoc:
                out.append({
                    "id": rid,
                    "content": rdoc,
                    "distance": rdist,
                    "metadata": rmeta or {},
                })
        return out[:top_k]

    def get_all_summaries(self, session_key: str) -> list[dict[str, Any]]:
        """Return all summaries for a session, sorted by boundary_end descending.

        Each element is ``{"content": str, "boundary_end": int, "created_at": str}``.
        """
        collection_name = self._collection_name(session_key)
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
        except Exception:
            return []

        results = collection.get(
            where={"type": "summary"},
            include=["documents", "metadatas"],
        )

        if not results["documents"]:
            return []

        items = [
            {
                "content": doc,
                "boundary_end": meta.get("boundary_end", 0),
                "created_at": meta.get("created_at", ""),
            }
            for doc, meta in zip(results["documents"], results["metadatas"])
        ]
        items.sort(key=lambda x: x["boundary_end"], reverse=True)
        return items

    def delete_collection(self, session_key: str) -> None:
        """Delete the entire collection for a session (e.g. /new command)."""
        collection_name = self._collection_name(session_key)
        try:
            self.client.delete_collection(name=collection_name)
            logger.debug("VectorStore: deleted collection for {}", session_key)
        except Exception:
            pass
