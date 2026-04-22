"""Tests for SessionManager lookup and deletion helpers."""

import shutil
import uuid
from pathlib import Path

import pytest

from tinybot.session.manager import SessionManager


@pytest.fixture
def local_workspace():
    base = Path("tests")
    path = base / f"_tmp_session_{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True, exist_ok=True)
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_get_returns_none_for_missing_session(local_workspace):
    manager = SessionManager(local_workspace)
    assert manager.get("missing:session") is None


def test_delete_removes_session_file_and_cache(local_workspace):
    manager = SessionManager(local_workspace)
    session = manager.get_or_create("websocket:test-chat")
    session.add_message("user", "hello")
    manager.save(session)

    assert manager.get("websocket:test-chat") is not None
    assert manager.delete("websocket:test-chat") is True
    assert manager.get("websocket:test-chat") is None
    assert manager.delete("websocket:test-chat") is False
