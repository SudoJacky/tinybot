from tinybot.agent.session_knowledge import SessionKnowledgeStore


def test_session_uploads_are_isolated_by_session():
    store = SessionKnowledgeStore(chunk_size=120, chunk_overlap=20)

    first = store.add_upload(
        "websocket:first",
        name="alpha.txt",
        content="Alpha project uses a temporary design brief for search.",
        file_type="txt",
    )
    store.add_upload(
        "websocket:second",
        name="beta.txt",
        content="Beta project has unrelated deployment notes.",
        file_type="txt",
    )

    assert first.chunk_count == 1
    first_results = store.query("websocket:first", "temporary design brief", top_k=3)
    second_results = store.query("websocket:second", "temporary design brief", top_k=3)

    assert first_results
    assert first_results[0]["doc_name"] == "alpha.txt"
    assert second_results == []


def test_clear_session_removes_temporary_uploads():
    store = SessionKnowledgeStore()
    store.add_upload(
        "websocket:chat",
        name="notes.md",
        content="# Notes\n\nSession-only context survives only in memory.",
        file_type="md",
    )

    assert store.list_documents("websocket:chat")
    store.clear_session("websocket:chat")

    assert store.list_documents("websocket:chat") == []
    assert store.query("websocket:chat", "Session-only context", top_k=1) == []


def test_small_uploads_are_returned_as_full_session_context():
    store = SessionKnowledgeStore()
    doc = store.add_upload(
        "websocket:chat",
        name="brief.txt",
        content="This whole brief should be available to the current session.",
        file_type="txt",
    )

    context_items = store.context_for_session("websocket:chat", "summary", max_chars=500)

    assert doc.chunk_count == 1
    assert context_items
    assert context_items[0]["doc_name"] == "brief.txt"
    assert context_items[0]["injection_mode"] == "full"
    assert "whole brief" in context_items[0]["content"]


def test_large_uploads_fall_back_to_relevant_excerpts():
    store = SessionKnowledgeStore(chunk_size=80, chunk_overlap=10)
    store.add_upload(
        "websocket:chat",
        name="large.txt",
        content=("alpha topic appears here.\n\n" * 8) + ("beta deployment detail lives here.\n\n" * 8),
        file_type="txt",
    )

    context_items = store.context_for_session(
        "websocket:chat",
        "beta deployment",
        max_chars=100,
        fallback_top_k=2,
    )

    assert context_items
    assert all(item["injection_mode"] == "excerpt" for item in context_items)
    assert any("beta deployment" in item["content"] for item in context_items)
