"""ChromaDB-backed vector store for session conversation summaries."""

from __future__ import annotations

import asyncio
import json
import re
import threading
from collections import OrderedDict
from datetime import datetime
from functools import lru_cache

from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from tinybot.session.manager import SessionManager


class CachedEmbeddingFunction:
    """Wrapper that caches embedding results to avoid redundant computation.

    ChromaDB's embedding function interface requires a __call__ method that
    takes a list of texts and returns a list of embedding vectors.

    Design Note: The cache uses class-level variables intentionally.
    All VectorStore instances share the same embedding cache because:
      1. Embedding computation is expensive (network calls to embedding API)
      2. Same text always produces the same embedding vector
      3. Sharing cache across instances avoids redundant computation

    If per-instance cache isolation is needed (rare), create a separate
    embedding function wrapper instead of modifying this class.
    """

    # Class-level cache shared across all instances (intentional design)
    _cache_lock = threading.Lock()
    _cache: OrderedDict[str, list[float]] = OrderedDict()
    _max_cache_size = 1000
    _hits = 0
    _misses = 0

    def __init__(self, underlying_fn):
        self._underlying = underlying_fn
        # Forward ChromaDB-required attributes from underlying function
        self.name = getattr(underlying_fn, "name", "cached_embedding")

    def __call__(self, input: list[str]) -> list[list[float]]:
        """Compute embeddings with caching for repeated texts.

        ChromaDB expects 'input' as parameter name (v0.4.16+ interface).
        """
        # Pre-allocate results list with placeholders
        results: list[list[float] | None] = [None] * len(input)
        uncached_texts: list[str] = []
        uncached_indices: list[int] = []

        for i, text in enumerate(input):
            cache_key = self._make_cache_key(text)
            with CachedEmbeddingFunction._cache_lock:
                if cache_key in CachedEmbeddingFunction._cache:
                    results[i] = CachedEmbeddingFunction._cache[cache_key]
                    CachedEmbeddingFunction._hits += 1
                else:
                    uncached_texts.append(text)
                    uncached_indices.append(i)
                    CachedEmbeddingFunction._misses += 1

        if uncached_texts:
            new_embeddings = self._underlying(uncached_texts)
            for text, embedding in zip(uncached_texts, new_embeddings):
                cache_key = self._make_cache_key(text)
                with CachedEmbeddingFunction._cache_lock:
                    CachedEmbeddingFunction._cache[cache_key] = embedding
                    if len(CachedEmbeddingFunction._cache) > CachedEmbeddingFunction._max_cache_size:
                        CachedEmbeddingFunction._cache.popitem(last=False)

            for idx, embedding in zip(uncached_indices, new_embeddings):
                results[idx] = embedding

        return [r for r in results]  # Convert None placeholders to actual values

    def embed_query(self, input: list[str]) -> list[list[float]]:
        """Embed query texts (ChromaDB interface requirement).

        ChromaDB calls this with input as keyword argument, expecting list output.
        """
        return self(input)

    def embed_documents(self, documents: list[str]) -> list[list[float]]:
        """Embed multiple documents (ChromaDB interface requirement)."""
        return self(documents)

    @staticmethod
    def _make_cache_key(text: str) -> str:
        """Create a stable cache key from text."""
        return text[:200] + str(hash(text))

    @classmethod
    def get_cache_stats(cls) -> dict[str, int]:
        """Return cache statistics."""
        with cls._cache_lock:
            return {
                "hits": cls._hits,
                "misses": cls._misses,
                "size": len(cls._cache),
                "max_size": cls._max_cache_size,
            }

    @classmethod
    def clear_cache(cls) -> None:
        """Clear the embedding cache."""
        with cls._cache_lock:
            cls._cache.clear()
            cls._hits = 0
            cls._misses = 0


class VectorStore:
    """Stores and retrieves conversation summaries using ChromaDB.

    Each session has its own collection. When consolidation happens,
    old messages are summarized and stored as a single document with
    their original text chunks as additional context.

    Supports multiple embedding providers:
      - local: sentence-transformers models (downloaded or local path)
      - openai: OpenAI embedding API
      - azure: Azure OpenAI embedding API
      - custom: OpenAI-compatible custom endpoint
    """

    _lock = threading.Lock()
    _client = None
    _embedding_fn = None
    _embedding_config: Any = None  # Track which config was loaded
    _initialized = False
    _init_event: asyncio.Event | None = None
    _collections: dict[str, Any] = {}  # collection_name -> collection cache
    _collection_lock = threading.Lock()
    _query_stats: dict[str, int] = {"queries": 0, "cache_hits": 0}

    def __init__(self, persist_dir: Path | str, embedding_config: Any = None) -> None:
        """Initialize VectorStore with optional embedding configuration.

        Args:
            persist_dir: Directory for ChromaDB persistence
            embedding_config: EmbeddingConfig instance or None for defaults
        """
        self._persist_dir = Path(persist_dir)
        self._embedding_config_input = embedding_config

    async def async_initialize(self) -> None:
        """Pre-load embedding model asynchronously to avoid blocking later calls.

        Should be called during application startup. If the model is already
        loaded, this method returns immediately.
        """
        if self._initialized:
            return

        if self._init_event is None:
            self._init_event = asyncio.Event()

        def _load_blocking():
            try:
                self._get_embedding_function()
                VectorStore._initialized = True
            except Exception as e:
                logger.warning("VectorStore: async init failed: {}", e)

        # Run the blocking load in a thread pool
        await asyncio.to_thread(_load_blocking)
        if self._init_event:
            self._init_event.set()

    async def await_embedding_ready(self, timeout: float = 30.0) -> bool:
        """Wait for embedding model to be ready, with timeout.

        Args:
            timeout: Maximum seconds to wait.

        Returns:
            True if ready, False if timeout or initialization failed.
        """
        if self._initialized:
            return True

        if self._init_event is None:
            self._init_event = asyncio.Event()

        try:
            await asyncio.wait_for(self._init_event.wait(), timeout=timeout)
            return self._initialized
        except TimeoutError:
            logger.warning("VectorStore: embedding init timed out after {}s", timeout)
            return False

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
        # Resolve current config
        if self._embedding_config_input is not None:
            config = self._embedding_config_input
        else:
            from tinybot.config.schema import EmbeddingConfig
            config = EmbeddingConfig()

        # Check if we need to recreate embedding function:
        # 1. Not initialized yet
        # 2. Config changed (different provider or model)
        # Note: Must access class variables via class name for proper comparison
        needs_create = (
            VectorStore._embedding_fn is None or
            self._config_changed(config)
        )

        if needs_create:
            with VectorStore._lock:
                # Double-check under lock
                if VectorStore._embedding_fn is None or self._config_changed(config):
                    # Create embedding function based on provider type
                    if config.provider == "local":
                        base_fn = self._create_local_embedding_function(config)
                    elif config.provider in ("openai", "azure", "custom"):
                        base_fn = self._create_api_embedding_function(config)
                    else:
                        # Fallback to local
                        logger.warning("Unknown embedding provider '{}', using local", config.provider)
                        base_fn = self._create_local_embedding_function(config)

                    # Wrap with caching layer - set on CLASS level
                    VectorStore._embedding_fn = CachedEmbeddingFunction(base_fn)
                    VectorStore._embedding_config = config
                    logger.info(
                        "Embedding initialized: provider={}, model={}, api_base={}",
                        config.provider, config.model_name, config.api_base or "local"
                    )

    def _config_changed(self, new_config: Any) -> bool:
        """Check if embedding config has changed, requiring re-initialization."""
        # Access class variable via class name
        if VectorStore._embedding_config is None:
            return True
        old = VectorStore._embedding_config
        # Compare key fields that affect embedding creation
        return (
            old.provider != new_config.provider or
            old.model_name != new_config.model_name or
            old.api_base != new_config.api_base or
            old.api_key != new_config.api_key or
            old.api_key_env_var != new_config.api_key_env_var or
            old.api_version != new_config.api_version
        )

    def _create_local_embedding_function(self, config: Any):
        """Create local sentence-transformers embedding function."""
        from chromadb.utils.embedding_functions import (
            SentenceTransformerEmbeddingFunction,
        )

        model_name = config.model_name

        # Check if it's already a local path
        if Path(model_name).exists():
            logger.info("Loading embedding model from local path: {}", model_name)
            model_local_path = Path(model_name)
        else:
            # Check local cache for this model
            model_cache_dir = Path.home() / ".tinybot" / "models"
            model_local_path = model_cache_dir / model_name.replace("/", "_")

            if model_local_path.exists() and (model_local_path / "config.json").exists():
                model_name = str(model_local_path)
                logger.info("Loading embedding model from local cache: {}", model_local_path)
            else:
                model_cache_dir.mkdir(parents=True, exist_ok=True)
                logger.info("Downloading embedding model '{}' (first run only)...", config.model_name)

        device = "cpu"
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
        except ImportError:
            pass

        logger.info("Embedding device: {}", device)
        base_fn = SentenceTransformerEmbeddingFunction(
            model_name=model_name,
            device=device,
        )

        # Persist downloaded model to local cache for future use
        if not Path(model_name).exists() and not (model_local_path / "config.json").exists():
            try:
                base_fn.model.save(str(model_local_path))
                logger.info("Embedding model saved to local cache: {}", model_local_path)
            except Exception as e:
                logger.warning("Failed to cache embedding model: {}", e)

        return base_fn

    def _create_api_embedding_function(self, config: Any):
        """Create API-based embedding function (OpenAI/Azure/Custom)."""
        import chromadb.utils.embedding_functions as ef

        # Resolve API key: direct value or environment variable
        api_key = config.api_key
        if not api_key and config.api_key_env_var:
            import os
            api_key = os.environ.get(config.api_key_env_var, "")

        if not api_key:
            raise ValueError(
                f"Embedding API key not configured. Set '{config.api_key_env_var}' "
                f"environment variable or provide 'api_key' in config."
            )

        # Build parameters based on provider type
        if config.provider == "azure":
            logger.info(
                "Using Azure OpenAI embedding: endpoint={}, model={}, version={}",
                config.api_base, config.model_name, config.api_version
            )
            return ef.OpenAIEmbeddingFunction(
                api_key=api_key,
                api_base=config.api_base,
                api_type="azure",
                api_version=config.api_version,
                model_name=config.model_name,
            )
        else:
            # openai or custom (OpenAI-compatible endpoint)
            api_base = config.api_base or "https://api.openai.com/v1"
            logger.info(
                "Using OpenAI-compatible embedding: endpoint={}, model={}",
                api_base, config.model_name
            )
            return ef.OpenAIEmbeddingFunction(
                api_key=api_key,
                api_base=api_base,
                model_name=config.model_name,
            )

    def _collection_name(self, session_key: str) -> str:
        safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in session_key)
        return f"session_{safe}"[:63]

    def _get_collection(self, collection_name: str) -> Any | None:
        """Get a cached collection or fetch it from client.

        Args:
            collection_name: The collection name.

        Returns:
            The collection object, or None if not found.
        """
        with self._collection_lock:
            if collection_name in self._collections:
                VectorStore._query_stats["cache_hits"] += 1
                return self._collections[collection_name]

        VectorStore._query_stats["queries"] += 1
        try:
            collection = self.client.get_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
            )
            with self._collection_lock:
                self._collections[collection_name] = collection
            return collection
        except Exception:
            return None

    def _get_or_create_collection(self, collection_name: str) -> Any:
        """Get or create a collection, updating the cache.

        Args:
            collection_name: The collection name.

        Returns:
            The collection object.
        """
        try:
            collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )
            with self._collection_lock:
                self._collections[collection_name] = collection
            return collection
        except Exception:
            # Fallback: delete and recreate
            self.client.delete_collection(name=collection_name)
            collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self._get_embedding_function(),
                metadata={"hnsw:space": "cosine"},
            )
            with self._collection_lock:
                self._collections[collection_name] = collection
            return collection

    def invalidate_collection_cache(self, session_key: str) -> None:
        """Remove a cached collection for a session."""
        collection_name = self._collection_name(session_key)
        with self._collection_lock:
            self._collections.pop(collection_name, None)

    @classmethod
    def get_query_stats(cls) -> dict[str, int]:
        """Return collection query statistics."""
        return dict(cls._query_stats)

    @classmethod
    def clear_collection_cache(cls) -> None:
        """Clear all cached collections."""
        with cls._collection_lock:
            cls._collections.clear()
            cls._query_stats = {"queries": 0, "cache_hits": 0}

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
        collection = self._get_or_create_collection(collection_name)

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
        collection = self._get_collection(collection_name)
        if collection is None:
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
        collection = self._get_collection(collection_name)
        if collection is None:
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
        collection = self._get_collection(collection_name)
        if collection is None:
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
        collection = self._get_collection(collection_name)
        if collection is None:
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
        collection = self._get_collection(collection_name)
        if collection is None:
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
        collection = self._get_collection(collection_name)
        if collection is None:
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
            self.invalidate_collection_cache(session_key)
            logger.debug("VectorStore: deleted collection for {}", session_key)
        except Exception:
            pass
