"""Tests for SessionManager thread-safe operations."""

import tempfile
import threading
from pathlib import Path

import pytest

from tinybot.session.manager import Session, SessionManager


class TestSessionManagerThreadSafe:
    """Tests for thread-safe session management."""

    @pytest.fixture
    def temp_workspace(self):
        """Create a temporary workspace."""
        import shutil

        tmpdir = tempfile.mkdtemp()
        yield Path(tmpdir)
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_get_or_create_is_thread_safe(self, temp_workspace):
        """Test that concurrent get_or_create calls are thread-safe."""
        manager = SessionManager(temp_workspace)
        results: list[Session] = []
        errors: list[Exception] = []

        def get_session():
            try:
                session = manager.get_or_create("test:session")
                results.append(session)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=get_session) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # No errors should occur
        assert len(errors) == 0

        # All threads should get the same session object (or equal sessions)
        assert len(results) == 10
        assert all(s.key == "test:session" for s in results)

    def test_save_and_invalidate_are_thread_safe(self, temp_workspace):
        """Test that save and invalidate operations are thread-safe."""
        manager = SessionManager(temp_workspace)

        session = Session(key="test:session")
        session.add_message("user", "hello")

        def save_session():
            manager.save(session)

        def invalidate_session():
            manager.invalidate("test:session")

        threads = [threading.Thread(target=save_session) for _ in range(5)] + [
            threading.Thread(target=invalidate_session) for _ in range(5)
        ]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # No exceptions should be raised
        # Final state should be consistent
        final_session = manager.get_or_create("test:session")
        assert final_session.key == "test:session"

    def test_double_checked_locking_fast_path(self, temp_workspace):
        """Test that cached sessions are returned quickly without lock."""
        manager = SessionManager(temp_workspace)

        # First call creates and caches
        session1 = manager.get_or_create("test:session")

        # Second call should use cache (fast path)
        session2 = manager.get_or_create("test:session")

        assert session1 is session2  # Same object reference


class TestSessionDataclass:
    """Tests for Session dataclass operations."""

    def test_add_message_updates_timestamp(self):
        """Test that add_message updates timestamps."""
        session = Session(key="test")
        old_updated = session.updated_at

        session.add_message("user", "hello")

        assert session.updated_at >= old_updated
        assert len(session.messages) == 1

    def test_clear_resets_session(self):
        """Test that clear resets session state."""
        session = Session(key="test")
        session.add_message("user", "hello")
        session.user_profile = {"name": "test"}

        session.clear()

        assert len(session.messages) == 0
        assert session.last_consolidated == 0
        assert session.user_profile == {}

    def test_get_history_respects_max_messages(self):
        """Test that get_history respects max_messages limit."""
        session = Session(key="test")
        for i in range(100):
            session.add_message("user", f"msg{i}")

        history = session.get_history(max_messages=10)
        assert len(history) <= 10
