"""Knowledge base HTTP API endpoints.

Provides REST endpoints for RAG operations:
- List, add, get, delete documents
- Upload files (txt, md, pdf)
- Query knowledge base with hybrid retrieval
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime
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


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _job_snapshot(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job.get("id", ""),
        "doc_id": job.get("doc_id", ""),
        "name": job.get("name", ""),
        "status": job.get("status", "queued"),
        "stage": job.get("stage", "queued"),
        "message": job.get("message", ""),
        "processed": job.get("processed", 0),
        "total": job.get("total", 1),
        "error": job.get("error", ""),
        "created_at": job.get("created_at", ""),
        "updated_at": job.get("updated_at", ""),
        "completed_at": job.get("completed_at", ""),
    }


def _knowledge_jobs(app: web.Application) -> tuple[dict[str, dict[str, Any]], threading.Lock]:
    if "knowledge_jobs" not in app:
        app["knowledge_jobs"] = {}
    if "knowledge_jobs_lock" not in app:
        app["knowledge_jobs_lock"] = threading.Lock()
    return app["knowledge_jobs"], app["knowledge_jobs_lock"]


def _start_index_job(
    request: web.Request,
    *,
    doc_id: str,
    name: str,
) -> dict[str, Any]:
    knowledge_store = request.app["knowledge_store"]
    jobs, lock = _knowledge_jobs(request.app)
    job_id = f"kjob_{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id,
        "doc_id": doc_id,
        "name": name,
        "status": "queued",
        "stage": "queued",
        "message": "Queued for knowledge graph indexing",
        "processed": 0,
        "total": 1,
        "error": "",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "completed_at": "",
    }
    with lock:
        jobs[job_id] = job

    def update(stage: str, message: str, processed: int, total: int) -> None:
        with lock:
            current = jobs.get(job_id)
            if not current:
                return
            current.update({
                "status": "running" if stage != "completed" else "completed",
                "stage": stage,
                "message": message,
                "processed": processed,
                "total": max(1, total),
                "updated_at": _now_iso(),
            })
            if stage == "completed":
                current["completed_at"] = current["updated_at"]

    def run() -> None:
        try:
            update("starting", "Starting knowledge indexing", 0, 1)
            knowledge_store.index_document(doc_id, progress_callback=update)
        except Exception as e:
            logger.exception("Knowledge index job {} failed", job_id)
            with lock:
                current = jobs.get(job_id)
                if current:
                    current.update({
                        "status": "failed",
                        "stage": "failed",
                        "message": "Knowledge indexing failed",
                        "error": str(e),
                        "updated_at": _now_iso(),
                        "completed_at": _now_iso(),
                    })

    thread = threading.Thread(target=run, name=f"knowledge-index-{job_id}", daemon=True)
    thread.start()
    return _job_snapshot(job)


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
    async_index = (
        request.query.get("async_index", "").lower() in {"1", "true", "yes", "on"}
        or body.get("async_index") is True
    )

    try:
        doc_id = knowledge_store.add_document(
            name=name,
            content=content,
            tags=tags,
            category=category,
            file_type=file_type,
            original_path=original_path,
            defer_index=async_index,
        )
        job = _start_index_job(request, doc_id=doc_id, name=name) if async_index else None

        payload = {
            "id": doc_id,
            "name": name,
            "message": (
                f"Document '{name}' saved; knowledge indexing is running"
                if async_index
                else f"Document '{name}' added successfully"
            ),
        }
        if job:
            payload["job"] = job
            payload["job_id"] = job["id"]
        return web.json_response(payload, status=202 if async_index else 200)
    except ValueError as e:
        return _error_json(400, str(e))
    except Exception as e:
        logger.exception("Error adding document")
        return _error_json(500, f"Error adding document: {e}", err_type="server_error")


async def handle_upload_document(request: web.Request) -> web.Response:
    """POST /v1/knowledge/documents/upload

    Handles multipart/form-data file upload.
    Supported file types: txt, md, pdf

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
    supported_types = {"txt", "md", "pdf"}
    if file_ext not in supported_types:
        return _error_json(
            400,
            f"Unsupported file type '{file_ext}'. Supported: {', '.join(sorted(supported_types))}",
        )

    # Process file content
    if file_ext == "pdf":
        # PDF files use raw binary content
        content = file_content
    else:
        # Text files need UTF-8 decoding
        try:
            content = file_content.decode("utf-8")
        except UnicodeDecodeError as e:
            return _error_json(400, f"Error decoding file content (expected UTF-8): {e}")

        if not content.strip():
            return _error_json(400, "File content is empty")

    async_index = request.query.get("async_index", "").lower() in {"1", "true", "yes", "on"}

    try:
        doc_id = knowledge_store.add_document(
            name=filename,
            content=content,
            tags=tags,
            category=category,
            file_type=file_ext,
            source="file_upload",
            defer_index=async_index,
        )
        job = _start_index_job(request, doc_id=doc_id, name=filename) if async_index else None

        payload = {
            "id": doc_id,
            "name": filename,
            "file_type": file_ext,
            "size_bytes": len(file_content),
            "message": (
                f"File '{filename}' uploaded; knowledge indexing is running"
                if async_index
                else f"File '{filename}' uploaded and indexed successfully"
            ),
        }
        if job:
            payload["job"] = job
            payload["job_id"] = job["id"]
        return web.json_response(payload, status=202 if async_index else 200)
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
    - mode: Retrieval mode (dense/sparse/hybrid/semantic/local/global/drift, default hybrid)
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
                    "parent_id": r.get("parent_id"),
                    "chunk_type": r.get("chunk_type"),
                    "content": r.get("content"),
                    "matched_child_ids": r.get("matched_child_ids", []),
                    "matched_child_snippets": r.get("matched_child_snippets", []),
                    "doc_id": r.get("doc_id"),
                    "doc_name": r.get("doc_name"),
                    "file_path": r.get("file_path"),
                    "start_char": r.get("start_char"),
                    "end_char": r.get("end_char"),
                    "line_start": r.get("line_start"),
                    "line_end": r.get("line_end"),
                    "section_path": r.get("section_path"),
                    "block_type": r.get("block_type"),
                    "score": (
                        r.get("rerank_score")
                        or r.get("semantic_fusion_score")
                        or r.get("semantic_score")
                        or r.get("rrf_score")
                        or r.get("bm25_score")
                        or r.get("distance")
                    ),
                    "rerank_score": r.get("rerank_score"),
                    "rerank_rank": r.get("rerank_rank"),
                    "rerank_model": r.get("rerank_model"),
                    "pre_rerank_score": r.get("pre_rerank_score"),
                    "rrf_score": r.get("rrf_score"),
                    "semantic_score": r.get("semantic_score"),
                    "semantic_rank": r.get("semantic_rank"),
                    "semantic_fusion_score": r.get("semantic_fusion_score"),
                    "bm25_score": r.get("bm25_score"),
                    "dense_distance": r.get("dense_distance") if r.get("dense_distance") is not None else r.get("distance"),
                    "dense_rank": r.get("dense_rank"),
                    "sparse_rank": r.get("sparse_rank"),
                    "dense_contribution": r.get("dense_contribution"),
                    "sparse_contribution": r.get("sparse_contribution"),
                    "method": r.get("method"),
                    "matched_methods": r.get("matched_methods", []),
                    "matched_entities": r.get("matched_entities", []),
                    "matched_claims": r.get("matched_claims", []),
                    "matched_relations": r.get("matched_relations", []),
                    "matched_communities": r.get("matched_communities", []),
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
            "entity_count": stats.get("entity_count", 0),
            "claim_count": stats.get("claim_count", 0),
            "relation_count": stats.get("relation_count", 0),
            "community_count": stats.get("community_count", 0),
            "community_count_by_level": stats.get("community_count_by_level", {}),
            "community_report_count": stats.get("community_report_count", 0),
        })
    except Exception as e:
        logger.exception("Error getting stats")
        return _error_json(500, f"Error getting stats: {e}", err_type="server_error")


async def handle_knowledge_graph(request: web.Request) -> web.Response:
    """GET /v1/knowledge/graph

    Query params:
    - doc_id: Optional document id filter
    - limit: Max nodes to return (default 80)
    - edge_limit: Max grouped edges to return (default limit * 2)
    - min_confidence: Minimum relation confidence (default 0)
    - include_orphans: Include entities without relation edges (default false)
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        limit = int(request.query.get("limit", "80"))
        edge_limit = int(request.query.get("edge_limit", str(limit * 2)))
        min_confidence = float(request.query.get("min_confidence", "0"))
    except ValueError:
        return _error_json(400, "Invalid graph query params")

    include_orphans = request.query.get("include_orphans", "false").lower() in {"1", "true", "yes", "on"}
    doc_id = request.query.get("doc_id") or None

    try:
        graph = knowledge_store.get_entity_graph(
            doc_id=doc_id,
            limit=limit,
            edge_limit=edge_limit,
            min_confidence=min_confidence,
            include_orphans=include_orphans,
        )
        return _success_json(graph)
    except Exception as e:
        logger.exception("Error getting knowledge graph")
        return _error_json(500, f"Error getting knowledge graph: {e}", err_type="server_error")


async def handle_knowledge_graphrag(request: web.Request) -> web.Response:
    """GET /v1/knowledge/graphrag

    Query params:
    - doc_id: Optional document id filter
    - min_confidence: Minimum entity/relation/claim confidence (default 0)
    - level: Community level to return (default config)
    - include_reports: Include community_reports table (default true)
    - include_covariates: Include covariates table (default true)
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    try:
        min_confidence = float(request.query.get("min_confidence", "0"))
        level = int(request.query["level"]) if "level" in request.query else None
    except ValueError:
        return _error_json(400, "Invalid GraphRAG query params")

    doc_id = request.query.get("doc_id") or None
    include_reports = request.query.get("include_reports", "true").lower() in {"1", "true", "yes", "on"}
    include_covariates = request.query.get("include_covariates", "true").lower() in {"1", "true", "yes", "on"}

    try:
        index = knowledge_store.get_graphrag_index(
            doc_id=doc_id,
            min_confidence=min_confidence,
            level=level,
            include_reports=include_reports,
            include_covariates=include_covariates,
        )
        return _success_json(index)
    except Exception as e:
        logger.exception("Error getting GraphRAG index")
        return _error_json(500, f"Error getting GraphRAG index: {e}", err_type="server_error")


async def handle_knowledge_job(request: web.Request) -> web.Response:
    """GET /v1/knowledge/jobs/{job_id}

    Return progress for a background knowledge indexing job.
    """
    job_id = request.match_info.get("job_id", "")
    jobs, lock = _knowledge_jobs(request.app)
    with lock:
        job = jobs.get(job_id)
        if not job:
            return _error_json(404, f"Knowledge job {job_id} not found")
        return _success_json(_job_snapshot(job))


async def handle_rebuild_index(request: web.Request) -> web.Response:
    """POST /v1/knowledge/rebuild-index

    Rebuild indexes from existing chunks.
    Query params:
    - type: Index type to rebuild (bm25/semantic/all, default bm25)

    Useful when tokenizer is updated or semantic extraction rules change.
    """
    knowledge_store = request.app.get("knowledge_store")
    if not knowledge_store:
        return _error_json(503, "Knowledge store not initialized")

    rebuild_type = request.query.get("type", "bm25")

    try:
        if rebuild_type == "bm25":
            result = knowledge_store.rebuild_bm25_index()
            return _success_json({
                "message": "BM25 index rebuilt successfully",
                "chunks_indexed": result.get("chunks_indexed", 0),
                "terms_created": result.get("terms_created", 0),
                "total_docs": result.get("total_docs", 0),
            })
        elif rebuild_type == "semantic":
            result = knowledge_store.rebuild_semantic_index()
            return _success_json({
                "message": "Semantic index rebuilt successfully",
                "entities": result.get("entities", 0),
                "claims": result.get("claims", 0),
                "relations": result.get("relations", 0),
                "mentions": result.get("mentions", 0),
                "communities": result.get("communities", 0),
                "community_reports": result.get("community_reports", 0),
            })
        elif rebuild_type == "all":
            bm25_result = knowledge_store.rebuild_bm25_index()
            semantic_result = knowledge_store.rebuild_semantic_index()
            return _success_json({
                "message": "All indexes rebuilt successfully",
                "bm25": {
                    "chunks_indexed": bm25_result.get("chunks_indexed", 0),
                    "terms_created": bm25_result.get("terms_created", 0),
                    "total_docs": bm25_result.get("total_docs", 0),
                },
                "semantic": {
                    "entities": semantic_result.get("entities", 0),
                    "claims": semantic_result.get("claims", 0),
                    "relations": semantic_result.get("relations", 0),
                    "mentions": semantic_result.get("mentions", 0),
                    "communities": semantic_result.get("communities", 0),
                    "community_reports": semantic_result.get("community_reports", 0),
                },
            })
        else:
            return _error_json(400, f"Invalid rebuild type '{rebuild_type}'. Valid options: bm25, semantic, all")
    except Exception as e:
        logger.exception("Error rebuilding index")
        return _error_json(500, f"Error rebuilding index: {e}", err_type="server_error")


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_knowledge_routes(app: web.Application) -> None:
    """Register all knowledge API routes."""
    _knowledge_jobs(app)
    app.router.add_get("/v1/knowledge/documents", handle_list_documents)
    app.router.add_post("/v1/knowledge/documents", handle_add_document)
    app.router.add_post("/v1/knowledge/documents/upload", handle_upload_document)
    app.router.add_get("/v1/knowledge/documents/{doc_id}", handle_get_document)
    app.router.add_delete("/v1/knowledge/documents/{doc_id}", handle_delete_document)
    app.router.add_post("/v1/knowledge/query", handle_query_knowledge)
    app.router.add_get("/v1/knowledge/stats", handle_knowledge_stats)
    app.router.add_get("/v1/knowledge/graph", handle_knowledge_graph)
    app.router.add_get("/v1/knowledge/graphrag", handle_knowledge_graphrag)
    app.router.add_get("/v1/knowledge/jobs/{job_id}", handle_knowledge_job)
    app.router.add_post("/v1/knowledge/rebuild-index", handle_rebuild_index)
