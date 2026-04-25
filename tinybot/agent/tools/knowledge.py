"""Knowledge base tools: add, query, list, delete documents with hybrid retrieval."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

if TYPE_CHECKING:
    from tinybot.agent.knowledge import KnowledgeStore


@tool_parameters(
    tool_parameters_schema(
        name=StringSchema("The document name/title"),
        content=StringSchema("The document content text"),
        tags=ArraySchema(StringSchema(""), description="Optional list of tags for filtering"),
        category=StringSchema("Optional category classification"),
        file_type=StringSchema("File type: txt, md (default txt)"),
        original_path=StringSchema("Original file path if importing from file"),
        required=["name", "content"],
    )
)
class AddDocumentTool(Tool):
    """Add a document to the knowledge base for future retrieval."""

    def __init__(self, knowledge_store: KnowledgeStore):
        self._knowledge_store = knowledge_store

    @property
    def name(self) -> str:
        return "add_document"

    @property
    def description(self) -> str:
        return (
            "Add a document to the knowledge base. "
            "The document will be saved locally, split into chunks, and indexed for hybrid retrieval "
            "(semantic embedding + keyword BM25). "
            "Use this to store information that should be referenced in future conversations."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        name: str | None = None,
        content: str | None = None,
        tags: list[str] | None = None,
        category: str | None = None,
        file_type: str | None = None,
        original_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not name:
            return "Error: Document name is required"
        if not content:
            return "Error: Document content is required"

        try:
            doc_id = self._knowledge_store.add_document(
                name=name,
                content=content,
                tags=tags,
                category=category or "",
                file_type=file_type or "txt",
                original_path=original_path,
            )
            return f"Successfully added document '{name}' to knowledge base (ID: {doc_id})\nDocument saved locally and indexed for hybrid retrieval."
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error adding document: {e}"


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("The search query text"),
        top_k=IntegerSchema(5, description="Maximum number of chunks to return (default 5)", minimum=1, maximum=20),
        mode=StringSchema("Retrieval mode: dense (semantic), sparse (keyword), or hybrid (default hybrid)"),
        category=StringSchema("Optional category filter"),
        tags=ArraySchema(StringSchema(""), description="Optional tags filter (any match)"),
        get_context=StringSchema("Set to 'true' to include surrounding context from original document"),
        required=["query"],
    )
)
class QueryKnowledgeTool(Tool):
    """Query the knowledge base for relevant information using hybrid retrieval."""

    def __init__(self, knowledge_store: KnowledgeStore):
        self._knowledge_store = knowledge_store

    @property
    def name(self) -> str:
        return "query_knowledge"

    @property
    def description(self) -> str:
        return (
            "Query the knowledge base using hybrid retrieval. "
            "Combines semantic search (embedding) with keyword matching (BM25) for better results. "
            "Returns document chunks with source location info (file_path, character positions)."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        query: str | None = None,
        top_k: int | None = None,
        mode: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        get_context: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not query:
            return "Error: Query text is required"

        try:
            results = self._knowledge_store.query(
                query_text=query,
                top_k=top_k or 5,
                mode=mode,
                category=category,
                tags=tags,
            )

            if not results:
                return "No relevant knowledge found for your query."

            include_context = get_context and get_context.lower() in ("true", "yes", "1")

            lines = ["## Knowledge Base Results\n"]
            for idx, result in enumerate(results, 1):
                doc_name = result.get("doc_name", "Unknown")
                content = result.get("content", "")
                file_path = result.get("file_path", "")
                start_char = result.get("start_char", 0)
                end_char = result.get("end_char", 0)
                method = result.get("method", "unknown")
                rrf_score = result.get("rrf_score")

                # Build score info
                if rrf_score:
                    score_info = f"RRF score: {rrf_score:.4f}"
                elif method == "dense":
                    dist = result.get("distance", 0)
                    score_info = f"semantic distance: {dist:.3f}"
                else:
                    score_info = f"method: {method}"

                lines.append(f"### Result {idx} (from '{doc_name}', {score_info})\n")

                # Source location info
                if file_path:
                    lines.append(f"**Source**: {file_path} (chars {start_char}-{end_char})\n\n")

                lines.append(f"{content}\n\n")

                # Include surrounding context if requested
                if include_context and result.get("doc_id"):
                    doc_id = result["doc_id"]
                    context = self._knowledge_store.get_chunk_context(
                        doc_id, start_char, end_char, context_chars=300
                    )
                    if context and len(context) > len(content):
                        lines.append("**Expanded context**:\n")
                        lines.append(f"{context}\n\n")

            return "".join(lines)
        except Exception as e:
            return f"Error querying knowledge base: {e}"


@tool_parameters(
    tool_parameters_schema(
        category=StringSchema("Optional category filter"),
        limit=IntegerSchema(20, description="Maximum number of documents to return (default 20)", minimum=1, maximum=100),
    )
)
class ListDocumentsTool(Tool):
    """List all documents in the knowledge base."""

    def __init__(self, knowledge_store: KnowledgeStore):
        self._knowledge_store = knowledge_store

    @property
    def name(self) -> str:
        return "list_documents"

    @property
    def description(self) -> str:
        return (
            "List all documents in the knowledge base. "
            "Returns document names, IDs, file locations, and metadata."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        category: str | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            documents = self._knowledge_store.list_documents(
                category=category,
                limit=limit or 20,
            )

            if not documents:
                return "Knowledge base is empty. Use add_document to add documents."

            lines = ["## Knowledge Base Documents\n"]
            for doc in documents:
                tags_str = ", ".join(doc.tags) if doc.tags else "none"
                lines.append(f"- **{doc.name}** (ID: {doc.id})\n")
                lines.append(f"  - File: {doc.file_path}\n")
                lines.append(f"  - Type: {doc.file_type}\n")
                lines.append(f"  - Category: {doc.category or 'uncategorized'}\n")
                lines.append(f"  - Tags: {tags_str}\n")
                lines.append(f"  - Chunks: {doc.chunk_count}\n")
                lines.append(f"  - Length: {len(doc.content)} chars\n")
                lines.append(f"  - Created: {doc.created_at}\n\n")

            return "".join(lines)
        except Exception as e:
            return f"Error listing documents: {e}"


@tool_parameters(
    tool_parameters_schema(
        doc_id=StringSchema("The document ID to delete"),
        required=["doc_id"],
    )
)
class DeleteDocumentTool(Tool):
    """Delete a document from the knowledge base."""

    def __init__(self, knowledge_store: KnowledgeStore):
        self._knowledge_store = knowledge_store

    @property
    def name(self) -> str:
        return "delete_document"

    @property
    def description(self) -> str:
        return (
            "Delete a document and all its chunks from the knowledge base. "
            "Removes the saved file and all indexed data. "
            "Use list_documents to find document IDs."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        doc_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not doc_id:
            return "Error: Document ID is required"

        try:
            deleted = self._knowledge_store.delete_document(doc_id)
            if deleted:
                return f"Successfully deleted document {doc_id} and all associated data."
            else:
                return f"Error: Document {doc_id} not found"
        except Exception as e:
            return f"Error deleting document: {e}"


@tool_parameters(
    tool_parameters_schema(
        doc_id=StringSchema("The document ID"),
        required=["doc_id"],
    )
)
class GetDocumentTool(Tool):
    """Get full content of a document."""

    def __init__(self, knowledge_store: KnowledgeStore):
        self._knowledge_store = knowledge_store

    @property
    def name(self) -> str:
        return "get_document"

    @property
    def description(self) -> str:
        return (
            "Get the full content of a document by its ID. "
            "Useful for reading the complete source document after finding relevant chunks."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        doc_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not doc_id:
            return "Error: Document ID is required"

        try:
            content = self._knowledge_store.get_document_content(doc_id)
            if content:
                return f"## Document Content (ID: {doc_id})\n\n{content}"
            else:
                return f"Error: Document {doc_id} not found"
        except Exception as e:
            return f"Error getting document: {e}"
