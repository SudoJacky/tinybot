"""In-memory, per-session temporary knowledge for uploaded chat files."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import fitz
from loguru import logger

from tinybot.agent.knowledge import BM25Index


@dataclass
class SessionKnowledgeDocument:
    id: str
    name: str
    file_type: str
    content: str
    created_at: str
    chunk_count: int
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SessionKnowledgeChunk:
    id: str
    doc_id: str
    doc_name: str
    content: str
    chunk_index: int
    line_start: int = 1
    line_end: int = 1
    page: int | None = None


class SessionKnowledgeStore:
    """Small in-memory RAG store scoped to a conversation session.

    Data is intentionally not persisted. Restarting the process or opening a new
    chat session drops these uploads.
    """

    def __init__(self, *, chunk_size: int = 900, chunk_overlap: int = 120):
        self.chunk_size = max(200, chunk_size)
        self.chunk_overlap = max(0, min(chunk_overlap, self.chunk_size // 2))
        self._documents: dict[str, list[SessionKnowledgeDocument]] = {}
        self._chunks: dict[str, list[SessionKnowledgeChunk]] = {}
        self._indexes: dict[str, BM25Index] = {}
        self._lock = threading.Lock()

    def add_upload(
        self,
        session_key: str,
        *,
        name: str,
        content: str | bytes | bytearray,
        file_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> SessionKnowledgeDocument:
        file_type = file_type.lower().lstrip(".")
        if file_type not in {"txt", "md", "pdf"}:
            raise ValueError("Unsupported temporary file type")

        text, page_chunks = self._extract_content(content, file_type)
        if not text.strip():
            raise ValueError("Uploaded file contains no extractable text")

        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        digest = hashlib.sha1(f"{session_key}:{name}:{now}:{text[:200]}".encode()).hexdigest()[:10]
        doc_id = f"session_doc_{digest}"
        chunks = page_chunks if page_chunks else self._chunk_text(text)
        chunk_records = [
            SessionKnowledgeChunk(
                id=f"session_chunk_{doc_id}_{idx}",
                doc_id=doc_id,
                doc_name=name,
                content=chunk["content"],
                chunk_index=idx,
                line_start=chunk.get("line_start", 1),
                line_end=chunk.get("line_end", 1),
                page=chunk.get("page"),
            )
            for idx, chunk in enumerate(chunks)
            if chunk.get("content", "").strip()
        ]
        if not chunk_records:
            raise ValueError("Uploaded file contains no indexable text")

        doc = SessionKnowledgeDocument(
            id=doc_id,
            name=name,
            file_type=file_type,
            content=text,
            created_at=now,
            chunk_count=len(chunk_records),
            metadata=metadata or {},
        )

        with self._lock:
            self._documents.setdefault(session_key, []).append(doc)
            self._chunks.setdefault(session_key, []).extend(chunk_records)
            index = self._indexes.setdefault(session_key, BM25Index())
            for chunk in chunk_records:
                index.add_chunk(chunk.id, chunk.content)

        logger.info(
            "SessionKnowledgeStore: added temporary document '{}' to {} ({} chunks)",
            name,
            session_key,
            len(chunk_records),
        )
        return doc

    def query(
        self,
        session_key: str,
        query_text: str,
        top_k: int = 3,
    ) -> list[dict[str, Any]]:
        if not query_text.strip():
            return []
        with self._lock:
            index = self._indexes.get(session_key)
            chunks = {chunk.id: chunk for chunk in self._chunks.get(session_key, [])}
            ranked = index.query(query_text, top_k=top_k) if index else []

        results: list[dict[str, Any]] = []
        for chunk_id, score in ranked:
            chunk = chunks.get(chunk_id)
            if not chunk:
                continue
            results.append({
                "id": chunk.id,
                "doc_id": chunk.doc_id,
                "doc_name": chunk.doc_name,
                "content": chunk.content,
                "line_start": chunk.line_start,
                "line_end": chunk.line_end,
                "page": chunk.page,
                "score": score,
                "source": "session_upload",
                "temporary": True,
            })
        return results

    def context_for_session(
        self,
        session_key: str,
        query_text: str,
        *,
        max_chars: int = 24000,
        fallback_top_k: int = 8,
    ) -> list[dict[str, Any]]:
        """Return session uploads for prompt injection.

        Small uploads are returned in full. When all uploaded content exceeds
        ``max_chars``, return relevant chunks instead so the model still sees
        the most useful parts without crowding out the chat.
        """
        with self._lock:
            documents = list(self._documents.get(session_key, []))

        if not documents:
            return []

        total_chars = sum(len(doc.content) for doc in documents)
        if total_chars <= max_chars:
            return [
                {
                    "id": doc.id,
                    "doc_id": doc.id,
                    "doc_name": doc.name,
                    "content": doc.content,
                    "file_type": doc.file_type,
                    "source": "session_upload",
                    "temporary": True,
                    "injection_mode": "full",
                }
                for doc in documents
            ]

        snippets = self.query(session_key, query_text, top_k=fallback_top_k)
        if not snippets:
            with self._lock:
                chunks = list(self._chunks.get(session_key, []))[:fallback_top_k]
            snippets = [
                {
                    "id": chunk.id,
                    "doc_id": chunk.doc_id,
                    "doc_name": chunk.doc_name,
                    "content": chunk.content,
                    "line_start": chunk.line_start,
                    "line_end": chunk.line_end,
                    "page": chunk.page,
                    "source": "session_upload",
                    "temporary": True,
                }
                for chunk in chunks
            ]
        for item in snippets:
            item["injection_mode"] = "excerpt"
            item["truncated"] = True
        return snippets

    def list_documents(self, session_key: str) -> list[dict[str, Any]]:
        with self._lock:
            return [asdict(doc) for doc in self._documents.get(session_key, [])]

    def clear_session(self, session_key: str) -> None:
        with self._lock:
            self._documents.pop(session_key, None)
            self._chunks.pop(session_key, None)
            self._indexes.pop(session_key, None)

    def _extract_content(
        self,
        content: str | bytes | bytearray,
        file_type: str,
    ) -> tuple[str, list[dict[str, Any]]]:
        if file_type == "pdf":
            return self._extract_pdf(content), []
        if isinstance(content, (bytes, bytearray)):
            return bytes(content).decode("utf-8"), []
        return str(content), []

    def _extract_pdf(self, content: str | bytes | bytearray) -> str:
        if isinstance(content, (bytes, bytearray)):
            doc = fitz.open(stream=bytes(content), filetype="pdf")
        else:
            doc = fitz.open(str(content))
        try:
            pages: list[str] = []
            for index, page in enumerate(doc, 1):
                text = page.get_text("text").strip()
                if text:
                    pages.append(f"[Page {index}]\n{text}")
            return "\n\n".join(pages)
        finally:
            doc.close()

    def _chunk_text(self, text: str) -> list[dict[str, Any]]:
        line_starts = [0]
        for idx, char in enumerate(text):
            if char == "\n":
                line_starts.append(idx + 1)

        def line_for(pos: int) -> int:
            line = 1
            for start in line_starts:
                if start <= pos:
                    line += 1
                else:
                    break
            return max(1, line - 1)

        chunks: list[dict[str, Any]] = []
        start = 0
        while start < len(text):
            end = min(len(text), start + self.chunk_size)
            if end < len(text):
                window = text[start:end]
                break_at = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "), window.rfind(" "))
                if break_at > self.chunk_size // 2:
                    end = start + break_at + 1
            content = text[start:end].strip()
            if content:
                chunks.append({
                    "content": content,
                    "line_start": line_for(start),
                    "line_end": line_for(end),
                })
            if end >= len(text):
                break
            start = max(end - self.chunk_overlap, start + 1)
        return chunks
