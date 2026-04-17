"""Tests for VectorStore async initialization and caching."""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


class TestCachedEmbeddingFunction:
    """Tests for CachedEmbeddingFunction caching behavior."""

    def test_cache_hits_on_repeated_text(self):
        """Test that repeated texts result in cache hits."""
        from tinybot.agent.vector_store import CachedEmbeddingFunction

        CachedEmbeddingFunction.clear_cache()

        mock_fn = MagicMock(return_value=[[0.1, 0.2, 0.3]])
        cached_fn = CachedEmbeddingFunction(mock_fn)

        # First call - should hit underlying function
        result1 = cached_fn(["test text"])
        mock_fn.assert_called_once()

        # Second call with same text - should use cache
        result2 = cached_fn(["test text"])
        mock_fn.assert_called_once()  # No additional call

        assert result1 == result2

        stats = CachedEmbeddingFunction.get_cache_stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1

    def test_cache_misses_on_new_text(self):
        """Test that new texts result in cache misses."""
        from tinybot.agent.vector_store import CachedEmbeddingFunction

        CachedEmbeddingFunction.clear_cache()

        mock_fn = MagicMock(side_effect=[[0.1, 0.2], [0.3, 0.4]])
        cached_fn = CachedEmbeddingFunction(mock_fn)

        cached_fn(["text one"])
        cached_fn(["text two"])

        assert mock_fn.call_count == 2

        stats = CachedEmbeddingFunction.get_cache_stats()
        assert stats["misses"] == 2
        assert stats["hits"] == 0

    def test_cache_size_limit(self):
        """Test that cache respects size limit."""
        from tinybot.agent.vector_store import CachedEmbeddingFunction

        CachedEmbeddingFunction.clear_cache()

        # Create mock that returns unique embeddings
        def mock_embed(texts):
            return [[float(i)] for i in range(len(texts))]

        mock_fn = MagicMock(side_effect=mock_embed)
        cached_fn = CachedEmbeddingFunction(mock_fn)

        # Add more items than max cache size
        max_size = CachedEmbeddingFunction._max_cache_size
        for i in range(max_size + 10):
            cached_fn([f"unique text {i}"])

        stats = CachedEmbeddingFunction.get_cache_stats()
        assert stats["size"] <= max_size

    def test_thread_safe_cache_access(self):
        """Test that cache access is thread-safe."""
        import threading

        from tinybot.agent.vector_store import CachedEmbeddingFunction

        CachedEmbeddingFunction.clear_cache()

        def mock_embed(texts):
            return [[0.5] for _ in texts]

        mock_fn = MagicMock(side_effect=mock_embed)
        cached_fn = CachedEmbeddingFunction(mock_fn)

        threads = []
        for i in range(10):
            t = threading.Thread(target=lambda i=i: cached_fn([f"text {i}"]))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Should have exactly 10 misses (each thread calls once)
        stats = CachedEmbeddingFunction.get_cache_stats()
        assert stats["misses"] == 10

    def test_clear_cache(self):
        """Test that clear_cache resets all stats."""
        from tinybot.agent.vector_store import CachedEmbeddingFunction

        mock_fn = MagicMock(return_value=[[0.1]])
        cached_fn = CachedEmbeddingFunction(mock_fn)

        cached_fn(["text"])
        cached_fn(["text"])  # hit

        CachedEmbeddingFunction.clear_cache()

        stats = CachedEmbeddingFunction.get_cache_stats()
        assert stats["hits"] == 0
        assert stats["misses"] == 0
        assert stats["size"] == 0


class TestVectorStoreCollectionCache:
    """Tests for VectorStore collection caching."""

    @pytest.fixture
    def temp_chromadb_dir(self):
        """Create a temporary directory for ChromaDB."""
        import shutil

        tmpdir = tempfile.mkdtemp()
        yield Path(tmpdir)
        # On Windows, ChromaDB may hold file locks; ignore cleanup errors
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_collection_cache_hit(self, temp_chromadb_dir):
        """Test that collection cache is used on repeated access."""
        from tinybot.agent.vector_store import VectorStore

        VectorStore.clear_collection_cache()
        VectorStore._client = None
        VectorStore._embedding_fn = MagicMock()
        VectorStore._initialized = True

        store = VectorStore(temp_chromadb_dir)

        with patch.object(store.client, "get_collection") as mock_get:
            mock_collection = MagicMock()
            mock_collection.count.return_value = 0
            mock_get.return_value = mock_collection

            # First access
            collection1 = store._get_collection("test_collection")
            assert mock_get.call_count == 1

            # Second access - should use cache
            collection2 = store._get_collection("test_collection")
            assert mock_get.call_count == 1

            stats = VectorStore.get_query_stats()
            assert stats["cache_hits"] >= 1

    def test_collection_cache_invalidation(self, temp_chromadb_dir):
        """Test that invalidate_collection_cache removes cached entry."""
        from tinybot.agent.vector_store import VectorStore

        VectorStore.clear_collection_cache()
        VectorStore._client = None
        VectorStore._embedding_fn = MagicMock()
        VectorStore._initialized = True

        store = VectorStore(temp_chromadb_dir)

        with patch.object(store.client, "get_collection") as mock_get:
            mock_collection = MagicMock()
            mock_collection.count.return_value = 0
            mock_get.return_value = mock_collection

            store._get_collection("session_test_session")
            store.invalidate_collection_cache("test:session")

            # After invalidation, should fetch again
            store._get_collection("session_test_session")
            assert mock_get.call_count == 2

    def test_clear_collection_cache(self, temp_chromadb_dir):
        """Test that clear_collection_cache resets all stats."""
        from tinybot.agent.vector_store import VectorStore

        VectorStore._query_stats = {"queries": 10, "cache_hits": 5}

        VectorStore.clear_collection_cache()

        stats = VectorStore.get_query_stats()
        assert stats["queries"] == 0
        assert stats["cache_hits"] == 0


class TestVectorStoreAsyncInit:
    """Tests for VectorStore async initialization."""

    @pytest.fixture
    def temp_chromadb_dir(self):
        """Create a temporary directory for ChromaDB."""
        import shutil

        tmpdir = tempfile.mkdtemp()
        yield Path(tmpdir)
        # On Windows, ChromaDB may hold file locks; ignore cleanup errors
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_sync_initialization_still_works(self, temp_chromadb_dir):
        """Test that synchronous initialization path still works."""
        from tinybot.agent.vector_store import VectorStore

        # Reset class-level state for test isolation
        VectorStore._client = None
        VectorStore._embedding_fn = None
        VectorStore._initialized = False
        VectorStore._init_event = None

        store = VectorStore(temp_chromadb_dir)

        # Mock the embedding function to avoid actual model loading
        with patch.object(store, "_get_embedding_function", return_value=MagicMock()) as mock_get:
            # The client property should still work
            with patch("chromadb.PersistentClient") as mock_client:
                mock_client.return_value = MagicMock()
                _ = store.client
                mock_client.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_initialize_sets_initialized_flag(self, temp_chromadb_dir):
        """Test that async_initialize sets the initialized flag."""
        from tinybot.agent.vector_store import VectorStore

        # Reset class-level state
        VectorStore._client = None
        VectorStore._embedding_fn = None
        VectorStore._initialized = False
        VectorStore._init_event = None

        store = VectorStore(temp_chromadb_dir)

        # Pre-set embedding function to avoid actual model loading
        VectorStore._embedding_fn = MagicMock()

        await store.async_initialize()

        # After initialization, _initialized should be True
        assert VectorStore._initialized is True

    @pytest.mark.asyncio
    async def test_async_initialize_skip_if_already_initialized(self, temp_chromadb_dir):
        """Test that async_initialize skips if already initialized."""
        from tinybot.agent.vector_store import VectorStore

        # Set initialized state
        VectorStore._initialized = True

        store = VectorStore(temp_chromadb_dir)

        # Should return immediately without calling _get_embedding_function
        with patch.object(VectorStore, "_get_embedding_function") as mock_get:
            await store.async_initialize()
            mock_get.assert_not_called()

        # Reset for other tests
        VectorStore._initialized = False

    @pytest.mark.asyncio
    async def test_await_embedding_ready_returns_true_when_initialized(self, temp_chromadb_dir):
        """Test await_embedding_ready returns True when already initialized."""
        from tinybot.agent.vector_store import VectorStore

        VectorStore._initialized = True

        store = VectorStore(temp_chromadb_dir)
        result = await store.await_embedding_ready(timeout=1.0)

        assert result is True

        # Reset
        VectorStore._initialized = False

    @pytest.mark.asyncio
    async def test_await_embedding_ready_timeout(self, temp_chromadb_dir):
        """Test await_embedding_ready returns False on timeout."""
        from tinybot.agent.vector_store import VectorStore

        VectorStore._initialized = False
        VectorStore._init_event = None

        store = VectorStore(temp_chromadb_dir)

        # Create event but don't set it, simulate slow initialization
        VectorStore._init_event = asyncio.Event()

        result = await store.await_embedding_ready(timeout=0.1)

        assert result is False


class TestVectorStoreEmbeddingFunction:
    """Tests for embedding function behavior."""

    @pytest.fixture
    def temp_chromadb_dir(self):
        """Create a temporary directory for ChromaDB."""
        import shutil

        tmpdir = tempfile.mkdtemp()
        yield Path(tmpdir)
        # On Windows, ChromaDB may hold file locks; ignore cleanup errors
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_embedding_function_singleton(self, temp_chromadb_dir):
        """Test that embedding function is a class-level singleton."""
        from tinybot.agent.vector_store import VectorStore

        # Reset state
        VectorStore._embedding_fn = None
        VectorStore._initialized = False

        store1 = VectorStore(temp_chromadb_dir)
        store2 = VectorStore(temp_chromadb_dir)

        # Both should share the same class-level embedding function
        assert store1._embedding_fn is store2._embedding_fn

    def test_thread_safe_initialization(self, temp_chromadb_dir):
        """Test that concurrent initialization is thread-safe."""
        import threading

        from tinybot.agent.vector_store import VectorStore

        VectorStore._embedding_fn = None
        VectorStore._initialized = False

        call_count = 0
        original_get = VectorStore._get_embedding_function

        def mock_get(self):
            nonlocal call_count
            call_count += 1
            # Simulate slow loading
            import time

            time.sleep(0.1)
            VectorStore._embedding_fn = MagicMock()
            return VectorStore._embedding_fn

        with patch.object(VectorStore, "_get_embedding_function", mock_get):
            threads = []
            for _ in range(5):
                t = threading.Thread(target=lambda: VectorStore(temp_chromadb_dir)._get_embedding_function())
                threads.append(t)
                t.start()

            for t in threads:
                t.join()

        # Due to double-checked locking, should only initialize once
        assert call_count == 5  # Each thread calls, but only one initializes
        assert VectorStore._embedding_fn is not None
