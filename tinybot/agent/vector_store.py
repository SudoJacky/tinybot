"""ChromaDB-backed vector store for session conversation summaries."""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger


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
                            model_name="all-MiniLM-L6-v2",
                            device=device,
                        )
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
    ) -> None:
        """Store a consolidation summary along with original message chunks.

        Args:
            session_key: The session identifier.
            summary: LLM-generated summary text.
            messages: The original messages being consolidated.
            boundary_start: Start index in session.messages.
            boundary_end: End index in session.messages.
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
        collection.upsert(
            ids=[main_id],
            documents=[summary],
            metadatas=[{
                "type": "summary",
                "boundary_start": boundary_start,
                "boundary_end": boundary_end,
                "message_count": len(messages),
                "created_at": now,
            }],
        )

        chunk_size = 5
        chunks: list[str] = []
        chunk_ids: list[str] = []
        chunk_metas: list[dict[str, Any]] = []

        for i in range(0, len(messages), chunk_size):
            batch = messages[i : i + chunk_size]
            lines = []
            for m in batch:
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
            chunk_text = "\n".join(lines)
            chunks.append(chunk_text)
            chunk_ids.append(f"chunk_{boundary_start}_{i}_{len(batch)}")
            chunk_metas.append({
                "type": "original_chunk",
                "summary_ref": main_id,
                "boundary_start": boundary_start,
                "created_at": now,
            })

        if chunks:
            existing = collection.get(ids=chunk_ids, include=[])
            existing_ids = set(existing["ids"]) if existing["ids"] else set()
            new_chunks = [
                c for c, cid in zip(chunks, chunk_ids) if cid not in existing_ids
            ]
            new_ids = [cid for cid in chunk_ids if cid not in existing_ids]
            new_metas = [
                m for m, cid in zip(chunk_metas, chunk_ids) if cid not in existing_ids
            ]
            if new_chunks:
                collection.upsert(
                    ids=new_ids,
                    documents=new_chunks,
                    metadatas=new_metas,
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

    def delete_collection(self, session_key: str) -> None:
        """Delete the entire collection for a session (e.g. /new command)."""
        collection_name = self._collection_name(session_key)
        try:
            self.client.delete_collection(name=collection_name)
            logger.debug("VectorStore: deleted collection for {}", session_key)
        except Exception:
            pass
