"""Knowledge base HTTP API endpoints.

Provides REST endpoints for RAG operations:
- List, add, get, delete documents
- Upload files (txt, md)
- Query knowledge base with hybrid retrieval
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger


def _error_json(status: int, message: str, err_type: str = "invalid_request_error") -> web.Response:
    return web.json_response(
        {"error": {"message": message, "type": err_type, "code": status}},
        status=status,
    )


def _success_json(data: dict[str, Any]) -> web.Response:
    return web.json_response(data, status=200)


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------

async def handle_list_documents(request: web.Request) -> web.Response:
    """GET /v1/knowledge/documents

    Query params:
    - category: Optional category filter
    - limit: Max documents to return (default 20)
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    category = request.query.get("category")
    limit = int(request.query.get("limit", "20"))

    try:
        documents = knowledge_store.list_documents(category=category, limit=limit)

        data = {
            "object": "list",
            "data": [
                {
                    "id": doc.id,
                    "name": doc.name,
                    "file_path": doc.file_path,
                    "file_type": doc.file_type,
                    "category": doc.category,
                    "tags": doc.tags,
                    "chunk_count": doc.chunk_count,
                    "content_length": len(doc.content),
                    "created_at": doc.created_at,
                }
                for doc in documents
            ],
            "total": len(documents),
        }
        return _success_json(data)
    except Exception as e:
        logger.exception("Error listing documents")
        return _error_json(500, f"Error listing documents: {e}", err_type="server_error")


async def handle_add_document(request: web.Request) -> web.Response:
    """POST /v1/knowledge/documents

    Body:
    - name: Document name (required)
    - content: Document content (required)
    - tags: Optional list of tags
    - category: Optional category
    - file_type: File type (txt/md, default txt)
    - original_path: Optional original file path
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        body = await request.json()
    except Exception:
        return _error_json(400, "Invalid JSON body")

    name = body.get("name")
    content = body.get("content")

    if not name:
        return _error_json(400, "Document name is required")
    if not content:
        return _error_json(400, "Document content is required")

    tags = body.get("tags", [])
    category = body.get("category", "")
    file_type = body.get("file_type", "txt")
    original_path = body.get("original_path")

    try:
        doc_id = knowledge_store.add_document(
            name=name,
            content=content,
            tags=tags,
            category=category,
            file_type=file_type,
            original_path=original_path,
        )

        return _success_json({
            "id": doc_id,
            "name": name,
            "message": f"Document '{name}' added successfully",
        })
    except ValueError as e:
        return _error_json(400, str(e))
    except Exception as e:
        logger.exception("Error adding document")
        return _error_json(500, f"Error adding document: {e}", err_type="server_error")


async def handle_upload_document(request: web.Request) -> web.Response:
    """POST /v1/knowledge/documents/upload

    Handles multipart/form-data file upload.
    Supported file types: txt, md

    Form fields:
    - file: The uploaded file (required)
    - category: Optional category classification
    - tags: Optional comma-separated tags
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    reader = await request.multipart()
    file_content: bytes | None = None
    filename: str | None = None
    category: str = ""
    tags: list[str] = []

    try:
        while True:
            field = await reader.next()
            if field is None:
                break

            if field.filename:
                # This is the file field
                filename = field.filename
                file_content = await field.read()
            elif field.name == "category":
                category_val = await field.read()
                category = category_val.decode("utf-8").strip()
            elif field.name == "tags":
                tags_val = await field.read()
                tags_str = tags_val.decode("utf-8").strip()
                tags = [t.strip() for t in tags_str.split(",") if t.strip()]
    except Exception as e:
        logger.exception("Error parsing multipart upload")
        return _error_json(400, f"Error parsing upload: {e}")

    if not filename or file_content is None:
        return _error_json(400, "No file uploaded")

    # Validate file type
    file_ext = Path(filename).suffix.lower().lstrip(".")
    supported_types = {"txt", "md"}
    if file_ext not in supported_types:
        return _error_json(
            400,
            f"Unsupported file type '{file_ext}'. Supported: {', '.join(sorted(supported_types))}",
        )

    # Decode content
    try:
        content = file_content.decode("utf-8")
    except UnicodeDecodeError as e:
        return _error_json(400, f"Error decoding file content (expected UTF-8): {e}")

    if not content.strip():
        return _error_json(400, "File content is empty")

    try:
        doc_id = knowledge_store.add_document(
            name=filename,
            content=content,
            tags=tags,
            category=category,
            file_type=file_ext,
            source="file_upload",
        )

        return _success_json({
            "id": doc_id,
            "name": filename,
            "file_type": file_ext,
            "size_bytes": len(file_content),
            "message": f"File '{filename}' uploaded and indexed successfully",
        })
    except ValueError as e:
        return _error_json(400, str(e))
    except Exception as e:
        logger.exception("Error uploading file")
        return _error_json(500, f"Error uploading file: {e}", err_type="server_error")


async def handle_get_document(request: web.Request) -> web.Response:
    """GET /v1/knowledge/documents/{doc_id}

    Returns full document content.
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    doc_id = request.match_info.get("doc_id")
    if not doc_id:
        return _error_json(400, "Document ID is required")

    try:
        doc = knowledge_store.get_document(doc_id)
        if doc is None:
            return _error_json(404, f"Document {doc_id} not found")

        content = knowledge_store.get_document_content(doc_id)
        if content is None:
            content = doc.content

        return _success_json({
            "id": doc.id,
            "name": doc.name,
            "content": content,
            "file_path": doc.file_path,
            "file_type": doc.file_type,
            "category": doc.category,
            "tags": doc.tags,
            "chunk_count": doc.chunk_count,
            "created_at": doc.created_at,
        })
    except Exception as e:
        logger.exception("Error getting document")
        return _error_json(500, f"Error getting document: {e}", err_type="server_error")


async def handle_delete_document(request: web.Request) -> web.Response:
    """DELETE /v1/knowledge/documents/{doc_id}"""
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    doc_id = request.match_info.get("doc_id")
    if not doc_id:
        return _error_json(400, "Document ID is required")

    try:
        deleted = knowledge_store.delete_document(doc_id)
        if deleted:
            return _success_json({
                "id": doc_id,
                "message": f"Document {doc_id} deleted successfully",
            })
        else:
            return _error_json(404, f"Document {doc_id} not found")
    except Exception as e:
        logger.exception("Error deleting document")
        return _error_json(500, f"Error deleting document: {e}", err_type="server_error")


# ---------------------------------------------------------------------------
# Query endpoint
# ---------------------------------------------------------------------------

async def handle_query_knowledge(request: web.Request) -> web.Response:
    """POST /v1/knowledge/query

    Body:
    - query: Query text (required)
    - top_k: Max results (default 5)
    - mode: Retrieval mode (dense/sparse/hybrid, default hybrid)
    - category: Optional category filter
    - tags: Optional tags filter
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        body = await request.json()
    except Exception:
        return _error_json(400, "Invalid JSON body")

    query = body.get("query")
    if not query:
        return _error_json(400, "Query text is required")

    top_k = body.get("top_k", 5)
    mode = body.get("mode", "hybrid")
    category = body.get("category")
    tags = body.get("tags")

    try:
        results = knowledge_store.query(
            query_text=query,
            top_k=top_k,
            mode=mode,
            category=category,
            tags=tags,
        )

        data = {
            "object": "list",
            "query": query,
            "mode": mode,
            "data": [
                {
                    "id": r.get("id"),
                    "content": r.get("content"),
                    "doc_id": r.get("doc_id"),
                    "doc_name": r.get("doc_name"),
                    "file_path": r.get("file_path"),
                    "start_char": r.get("start_char"),
                    "end_char": r.get("end_char"),
                    "line_start": r.get("line_start"),
                    "line_end": r.get("line_end"),
                    "section_path": r.get("section_path"),
                    "block_type": r.get("block_type"),
                    "score": r.get("rerank_score") or r.get("rrf_score") or r.get("bm25_score") or r.get("distance"),
                    "rerank_score": r.get("rerank_score"),
                    "rerank_rank": r.get("rerank_rank"),
                    "rerank_model": r.get("rerank_model"),
                    "pre_rerank_score": r.get("pre_rerank_score"),
                    "rrf_score": r.get("rrf_score"),
                    "bm25_score": r.get("bm25_score"),
                    "dense_distance": r.get("dense_distance") if r.get("dense_distance") is not None else r.get("distance"),
                    "dense_rank": r.get("dense_rank"),
                    "sparse_rank": r.get("sparse_rank"),
                    "dense_contribution": r.get("dense_contribution"),
                    "sparse_contribution": r.get("sparse_contribution"),
                    "method": r.get("method"),
                    "matched_methods": r.get("matched_methods", []),
                }
                for r in results
            ],
            "total": len(results),
        }
        return _success_json(data)
    except Exception as e:
        logger.exception("Error querying knowledge")
        return _error_json(500, f"Error querying knowledge: {e}", err_type="server_error")


# ---------------------------------------------------------------------------
# Stats endpoint
# ---------------------------------------------------------------------------

async def handle_knowledge_stats(request: web.Request) -> web.Response:
    """GET /v1/knowledge/stats"""
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        stats = knowledge_store.get_stats()
        return _success_json({
            "total_documents": stats.get("document_count", 0),
            "total_chunks": stats.get("chunk_count", 0),
            "total_chars": stats.get("total_chars", 0),
            "categories": stats.get("categories", {}),
            "indexed_dense": stats.get("indexed_dense", 0),
            "indexed_sparse": stats.get("indexed_sparse", 0),
        })
    except Exception as e:
        logger.exception("Error getting stats")
        return _error_json(500, f"Error getting stats: {e}", err_type="server_error")


async def handle_rebuild_index(request: web.Request) -> web.Response:
    """POST /v1/knowledge/rebuild-index

    Rebuild BM25 index from existing chunks.
    Useful when tokenizer is updated and existing index needs to be refreshed.
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        result = knowledge_store.rebuild_bm25_index()
        return _success_json({
            "message": "BM25 index rebuilt successfully",
            "chunks_indexed": result.get("chunks_indexed", 0),
            "terms_created": result.get("terms_created", 0),
            "total_docs": result.get("total_docs", 0),
        })
    except Exception as e:
        logger.exception("Error rebuilding index")
        return _error_json(500, f"Error rebuilding index: {e}", err_type="server_error")


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_knowledge_routes(app: web.Application) -> None:
    """Register all knowledge API routes."""
    app.router.add_get("/v1/knowledge/documents", handle_list_documents)
    app.router.add_post("/v1/knowledge/documents", handle_add_document)
    app.router.add_post("/v1/knowledge/documents/upload", handle_upload_document)
    app.router.add_get("/v1/knowledge/documents/{doc_id}", handle_get_document)
    app.router.add_delete("/v1/knowledge/documents/{doc_id}", handle_delete_document)
    app.router.add_post("/v1/knowledge/query", handle_query_knowledge)
    app.router.add_get("/v1/knowledge/stats", handle_knowledge_stats)
    app.router.add_post("/v1/knowledge/rebuild-index", handle_rebuild_index)
