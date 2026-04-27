"""Knowledge base storage for RAG: manage documents with hybrid retrieval.

Features:
- Document local storage with file preservation
- Rich metadata: file_path, start_char, end_char, page for source location
- Dense vector indexing (embedding cosine similarity)
- Sparse retrieval (BM25 keyword matching - custom implementation)
- Hybrid retrieval with RRF (Reciprocal Rank Fusion)
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from bisect import bisect_right
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import fitz  # PyMuPDF
from loguru import logger

from tinybot.utils.fs import ensure_dir

if TYPE_CHECKING:
    from tinybot.agent.vector_store import VectorStore
    from tinybot.config.schema import Config, KnowledgeConfig


_KNOWLEDGE_COLLECTION_DENSE = "knowledge_dense"


_CJK_PATTERN = re.compile(r"[一-鿿぀-ゟ゠-ヿ가-힯]")
_NGRAM_SIZE = 2
_MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def _tokenize(text: str) -> list[str]:
    """Smart tokenization supporting both CJK and non-CJK text.

    For CJK (Chinese/Japanese/Korean) text: uses N-gram tokenization.
    For non-CJK text: uses word-based tokenization with punctuation removal.
    """
    if not text:
        return []

    # Check if text contains CJK characters
    has_cjk = bool(_CJK_PATTERN.search(text))

    if has_cjk:
        # CJK text: use N-gram tokenization for better matching
        tokens = []
        # First, extract CJK segments and process them with N-gram
        # Also preserve non-CJK words (English, numbers) within CJK text
        i = 0
        while i < len(text):
            char = text[i]
            if _CJK_PATTERN.match(char):
                # CJK character - collect consecutive CJK chars
                cjk_start = i
                while i < len(text) and _CJK_PATTERN.match(text[i]):
                    i += 1
                cjk_segment = text[cjk_start:i]
                # Generate N-grams from CJK segment
                for n in range(_NGRAM_SIZE, min(len(cjk_segment) + 1, _NGRAM_SIZE + 2)):
                    for j in range(len(cjk_segment) - n + 1):
                        tokens.append(cjk_segment[j:j + n].lower())
            elif char.isalnum():
                # Non-CJK alphanumeric - collect as word
                word_start = i
                while i < len(text) and text[i].isalnum() and not _CJK_PATTERN.match(text[i]):
                    i += 1
                word = text[word_start:i].lower()
                if len(word) >= 2:
                    tokens.append(word)
            else:
                i += 1
        return tokens
    else:
        # Non-CJK text: use traditional word-based tokenization
        text = text.lower()
        text = re.sub(r"[^\w\s]", " ", text)
        tokens = text.split()
        return [t for t in tokens if len(t) >= 2]


class BM25Index:
    """Simple BM25 index for keyword matching.

    BM25 formula:
    score(D, Q) = Σ IDF(qi) * (f(qi, D) * (k+1)) / (f(qi, D) + k * (1 - b + b * |D|/avgdl))

    Where:
    - f(qi, D) = term frequency of qi in document D
    - |D| = document length
    - avgdl = average document length
    - k, b = BM25 parameters
    """

    def __init__(self, k: float = 1.2, b: float = 0.75):
        self.k = k
        self.b = b
        # Inverted index: term -> list of (chunk_id, term_freq)
        self._inverted_index: dict[str, list[tuple[str, int]]] = {}
        # Document lengths: chunk_id -> length (number of tokens)
        self._doc_lengths: dict[str, int] = {}
        # Average document length
        self._avg_doc_length: float = 0.0
        # Total documents
        self._total_docs: int = 0
        # Document frequency: term -> number of documents containing term
        self._doc_freq: dict[str, int] = {}
        # Chunk contents: chunk_id -> content
        self._chunk_contents: dict[str, str] = {}

    def add_chunk(self, chunk_id: str, content: str) -> None:
        """Add a chunk to the index."""
        tokens = _tokenize(content)
        self._doc_lengths[chunk_id] = len(tokens)
        self._chunk_contents[chunk_id] = content

        # Count term frequencies for this chunk
        term_freqs: dict[str, int] = {}
        for token in tokens:
            term_freqs[token] = term_freqs.get(token, 0) + 1

        # Update inverted index
        for term, freq in term_freqs.items():
            if term not in self._inverted_index:
                self._inverted_index[term] = []
            self._inverted_index[term].append((chunk_id, freq))
            # Update document frequency
            self._doc_freq[term] = self._doc_freq.get(term, 0) + 1

        self._total_docs += 1
        # Update average doc length
        total_len = sum(self._doc_lengths.values())
        self._avg_doc_length = total_len / self._total_docs if self._total_docs > 0 else 0.0

    def remove_chunks(self, chunk_ids: list[str]) -> None:
        """Remove chunks from the index."""
        # Rebuild index without these chunks (simple approach)
        remaining_chunks = {
            cid: self._chunk_contents[cid]
            for cid in self._chunk_contents
            if cid not in chunk_ids
        }

        # Reset and re-add
        self._inverted_index.clear()
        self._doc_lengths.clear()
        self._doc_freq.clear()
        self._chunk_contents.clear()
        self._total_docs = 0
        self._avg_doc_length = 0.0

        for chunk_id, content in remaining_chunks.items():
            self.add_chunk(chunk_id, content)

    def query(self, query_text: str, top_k: int = 10) -> list[tuple[str, float]]:
        """Query the index and return top_k (chunk_id, score) tuples."""
        query_tokens = _tokenize(query_text)
        if not query_tokens:
            return []

        scores: dict[str, float] = {}

        for term in query_tokens:
            if term not in self._inverted_index:
                continue

            # IDF calculation
            df = self._doc_freq.get(term, 0)
            if df == 0:
                continue
            idf = math.log((self._total_docs - df + 0.5) / (df + 0.5) + 1)

            # Score each document containing this term
            for chunk_id, tf in self._inverted_index[term]:
                doc_len = self._doc_lengths.get(chunk_id, 0)
                # BM25 formula
                numerator = tf * (self.k + 1)
                denominator = tf + self.k * (1 - self.b + self.b * doc_len / self._avg_doc_length)
                term_score = idf * numerator / denominator

                scores[chunk_id] = scores.get(chunk_id, 0.0) + term_score

        # Sort by score and return top_k
        sorted_results = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return sorted_results[:top_k]

    def save(self, path: Path) -> None:
        """Save index to JSON file."""
        data = {
            "k": self.k,
            "b": self.b,
            "inverted_index": self._inverted_index,
            "doc_lengths": self._doc_lengths,
            "avg_doc_length": self._avg_doc_length,
            "total_docs": self._total_docs,
            "doc_freq": self._doc_freq,
            "chunk_contents": self._chunk_contents,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def load(self, path: Path) -> None:
        """Load index from JSON file."""
        if not path.exists():
            return
        try:
            content = path.read_text(encoding="utf-8")
            if not content.strip():
                # Empty file, skip loading
                logger.debug("BM25Index: empty index file at {}, skipping load", path)
                return
            data = json.loads(content)
        except json.JSONDecodeError as e:
            logger.warning("BM25Index: corrupted index file at {}, skipping load: {}", path, e)
            return
        except Exception as e:
            logger.warning("BM25Index: error loading index file at {}: {}", path, e)
            return
        self.k = data.get("k", 1.2)
        self.b = data.get("b", 0.75)
        self._inverted_index = data.get("inverted_index", {})
        self._doc_lengths = data.get("doc_lengths", {})
        self._avg_doc_length = data.get("avg_doc_length", 0.0)
        self._total_docs = data.get("total_docs", 0)
        self._doc_freq = data.get("doc_freq", {})
        self._chunk_contents = data.get("chunk_contents", {})


@dataclass
class KnowledgeDocument:
    """A single document record in the knowledge base."""

    id: str = ""
    name: str = ""
    file_path: str = ""  # Path to saved original file
    original_path: str | None = None  # User's original file path (if provided)
    source: str = "manual_upload"  # manual_upload, file_import, web_crawl
    file_type: str = "txt"  # txt, md, pdf
    content: str = ""  # Full content (stored or reference to file)
    created_at: str = ""
    chunk_count: int = 0
    category: str = ""
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class KnowledgeChunk:
    """A single chunk of a document for retrieval with position metadata."""

    id: str = ""
    doc_id: str = ""
    content: str = ""
    summary: str = ""  # AI-generated summary (1-2 sentences)
    chunk_index: int = 0
    start_char: int = 0  # Start position in original document
    end_char: int = 0  # End position in original document
    line_start: int = 0  # Start line number (1-based)
    line_end: int = 0  # End line number (1-based)
    page: int | None = None  # Page number (for PDF)
    created_at: str = ""
    doc_name: str = ""
    file_path: str = ""  # Reference to source file
    category: str = ""
    tags: list[str] = field(default_factory=list)
    section_path: str = ""
    block_type: str = "text"


class KnowledgeStore:
    """File-based storage for knowledge documents with hybrid retrieval.

    Supports:
    - Dense retrieval: semantic search with embedding vectors
    - Sparse retrieval: keyword matching with BM25
    - Hybrid retrieval: RRF fusion of both methods
    """

    _DEFAULT_MAX_DOCUMENTS = 1000

    def __init__(
        self,
        workspace: Path,
        vector_store: VectorStore | None = None,
        config: KnowledgeConfig | None = None,
        config_ref: Config | None = None,
    ):
        self.workspace = workspace
        self.vector_store = vector_store
        self.config = config
        self.config_ref = config_ref  # Full config for LLM calls
        self.knowledge_dir = ensure_dir(workspace / "knowledge")
        self.files_dir = ensure_dir(self.knowledge_dir / "files")
        self.documents_file = self.knowledge_dir / "documents.jsonl"
        self.chunks_file = self.knowledge_dir / "chunks.jsonl"
        self.bm25_index_file = self.knowledge_dir / "bm25_index.json"
        self._cursor_file = self.knowledge_dir / ".cursor"
        self._indexed_ids: set[str] = set()
        self._lock = threading.Lock()

        # Initialize BM25 index
        k = config.bm25_k if config else 1.2
        b = config.bm25_b if config else 0.75
        self._bm25_index = BM25Index(k=k, b=b)
        self._bm25_index.load(self.bm25_index_file)

    def add_document(
        self,
        name: str,
        content: str | bytes | bytearray,
        tags: list[str] | None = None,
        category: str = "",
        source: str = "manual_upload",
        file_type: str = "txt",
        original_path: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Add a document to the knowledge base.

        The document is:
        1. Saved locally to files directory
        2. Split into chunks with position metadata
        3. Indexed to both dense and sparse collections

        Args:
            name: Document name/title.
            content: Document content (text for txt/md, bytes for PDF).
            tags: Optional list of tags for filtering.
            category: Optional category classification.
            source: Source type (manual_upload, file_import, web_crawl).
            file_type: File type (txt, md, pdf).
            original_path: User's original file path (if importing from file).
            metadata: Optional additional metadata.

        Returns:
            The document ID.
        """
        # Handle PDF files
        if file_type == "pdf":
            return self._add_pdf_document(
                name=name,
                pdf_content=content,
                tags=tags,
                category=category,
                source=source,
                original_path=original_path,
                metadata=metadata,
            )

        # Handle text files (txt, md)
        if isinstance(content, (bytes, bytearray)):
            content = bytes(content).decode("utf-8")

        if not content.strip():
            raise ValueError("Document content cannot be empty")

        now = datetime.now()
        ts = now.strftime("%Y-%m-%dT%H:%M:%S")

        # Generate document ID
        id_base = f"{ts}:{name}:{hashlib.sha1(content.encode()).hexdigest()[:8]}"
        doc_id = f"doc_{hashlib.sha1(id_base.encode()).hexdigest()[:8]}"

        # Save original file
        file_path = self._save_document_file(doc_id, content, file_type)

        # Split content into chunks with position metadata
        chunks = self._chunk_text_with_positions(content, file_type=file_type)

        # Generate summaries for chunks (if enabled)
        chunks = self._generate_chunk_summaries(chunks, name)

        # Create document record
        doc = KnowledgeDocument(
            id=doc_id,
            name=name,
            file_path=str(file_path),
            original_path=original_path,
            source=source,
            file_type=file_type,
            content=content,  # Store full content
            created_at=ts,
            chunk_count=len(chunks),
            category=category,
            tags=tags or [],
            metadata=metadata or {},
        )

        # Write document index
        with open(self.documents_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(doc), ensure_ascii=False) + "\n")

        # Save chunks index
        for chunk in chunks:
            chunk_record = KnowledgeChunk(
                id=f"chunk_{doc_id}_{chunk['index']}",
                doc_id=doc_id,
                content=chunk["content"],
                summary=chunk.get("summary", ""),
                chunk_index=chunk["index"],
                start_char=chunk["start_char"],
                end_char=chunk["end_char"],
                line_start=chunk.get("line_start", 1),
                line_end=chunk.get("line_end", 1),
                page=chunk.get("page"),
                created_at=ts,
                doc_name=name,
                file_path=str(file_path),
                category=category,
                tags=tags or [],
                section_path=chunk.get("section_path", ""),
                block_type=chunk.get("block_type", "text"),
            )
            with open(self.chunks_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(chunk_record), ensure_ascii=False) + "\n")

        # Update cursor
        cursor = self._next_cursor()
        self._cursor_file.write_text(str(cursor), encoding="utf-8")

        logger.debug(
            "KnowledgeStore: adding document '{}' (id={}, category={}, tags={}, {} chars)",
            name,
            doc_id,
            category or "none",
            tags or [],
            len(content),
        )

        # Index to dense collection (requires vector_store)
        if self.vector_store is not None:
            self._index_chunks_dense(doc_id, name, str(file_path), chunks, ts, category, tags or [])

        # Index to sparse collection (BM25, independent of vector_store)
        self._index_chunks_sparse(doc_id, name, str(file_path), chunks, ts, category, tags or [])

        logger.info(
            "KnowledgeStore: added document '{}' (id={}, {} chunks, {} chars)",
            name,
            doc_id,
            len(chunks),
            len(content),
        )

        return doc_id

    def _add_pdf_document(
        self,
        name: str,
        pdf_content: str | bytes,
        tags: list[str] | None = None,
        category: str = "",
        source: str = "manual_upload",
        original_path: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Add a PDF document to the knowledge base.

        Args:
            name: Document name/title.
            pdf_content: PDF content as bytes, or file path as string.
            tags: Optional list of tags for filtering.
            category: Optional category classification.
            source: Source type (manual_upload, file_import, web_crawl).
            original_path: User's original file path (if importing from file).
            metadata: Optional additional metadata.

        Returns:
            The document ID.
        """
        now = datetime.now()
        ts = now.strftime("%Y-%m-%dT%H:%M:%S")

        # Parse PDF and extract text with page information
        pdf_pages = self._parse_pdf(pdf_content)
        if not pdf_pages:
            raise ValueError("PDF document contains no extractable text")

        # Combine all page text for ID generation and storage
        full_text = "\n\n".join(p["content"] for p in pdf_pages)

        # Generate document ID
        if isinstance(pdf_content, (bytes, bytearray)):
            content_hash = hashlib.sha1(bytes(pdf_content)).hexdigest()[:8]
        else:
            content_hash = hashlib.sha1(full_text.encode()).hexdigest()[:8]
        id_base = f"{ts}:{name}:{content_hash}"
        doc_id = f"doc_{hashlib.sha1(id_base.encode()).hexdigest()[:8]}"

        # Save original PDF file
        if isinstance(pdf_content, (bytes, bytearray)):
            file_path = self._save_document_file(doc_id, bytes(pdf_content), "pdf")
        else:
            # pdf_content is a path string
            import shutil
            file_name = f"{doc_id}.pdf"
            file_path = self.files_dir / file_name
            shutil.copy(pdf_content, file_path)
            logger.debug("KnowledgeStore: copied PDF file to {}", file_path)

        # Chunk PDF content with page metadata
        chunks = self._chunk_pdf(pdf_pages)

        # Generate summaries for chunks (if enabled)
        chunks = self._generate_chunk_summaries(chunks, name)

        # Create document record (store extracted text, not binary)
        doc = KnowledgeDocument(
            id=doc_id,
            name=name,
            file_path=str(file_path),
            original_path=original_path,
            source=source,
            file_type="pdf",
            content=full_text,  # Store extracted text for searching
            created_at=ts,
            chunk_count=len(chunks),
            category=category,
            tags=tags or [],
            metadata=metadata or {},
        )

        # Write document index
        with open(self.documents_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(doc), ensure_ascii=False) + "\n")

        # Save chunks index
        for chunk in chunks:
            chunk_record = KnowledgeChunk(
                id=f"chunk_{doc_id}_{chunk['index']}",
                doc_id=doc_id,
                content=chunk["content"],
                summary=chunk.get("summary", ""),
                chunk_index=chunk["index"],
                start_char=chunk["start_char"],
                end_char=chunk["end_char"],
                line_start=chunk.get("line_start", 1),
                line_end=chunk.get("line_end", 1),
                page=chunk.get("page"),
                created_at=ts,
                doc_name=name,
                file_path=str(file_path),
                category=category,
                tags=tags or [],
                section_path=chunk.get("section_path", ""),
                block_type=chunk.get("block_type", "pdf_text"),
            )
            with open(self.chunks_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(chunk_record), ensure_ascii=False) + "\n")

        # Update cursor
        cursor = self._next_cursor()
        self._cursor_file.write_text(str(cursor), encoding="utf-8")

        logger.debug(
            "KnowledgeStore: adding PDF document '{}' (id={}, category={}, tags={}, {} pages)",
            name,
            doc_id,
            category or "none",
            tags or [],
            len(pdf_pages),
        )

        # Index to dense collection (requires vector_store)
        if self.vector_store is not None:
            self._index_chunks_dense(doc_id, name, str(file_path), chunks, ts, category, tags or [])

        # Index to sparse collection (BM25, independent of vector_store)
        self._index_chunks_sparse(doc_id, name, str(file_path), chunks, ts, category, tags or [])

        logger.info(
            "KnowledgeStore: added PDF document '{}' (id={}, {} chunks, {} pages)",
            name,
            doc_id,
            len(chunks),
            len(pdf_pages),
        )

        return doc_id

    def _parse_pdf(self, pdf_content: str | bytes) -> list[dict[str, Any]]:
        """Parse PDF and extract text from each page.

        Args:
            pdf_content: PDF content as bytes/bytearray, or file path as string.

        Returns:
            List of dicts with: content (text), page (1-based), start_char, end_char.
        """
        # Open PDF document
        if isinstance(pdf_content, (bytes, bytearray)):
            doc = fitz.open(stream=bytes(pdf_content), filetype="pdf")
        else:
            # pdf_content is a file path
            doc = fitz.open(pdf_content)

        pages: list[dict[str, Any]] = []
        global_char_offset = 0

        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text")

            if not text.strip():
                # Skip empty pages
                global_char_offset += 0
                continue

            page_info = {
                "content": text.strip(),
                "page": page_num + 1,  # 1-based page number
                "start_char": global_char_offset,
                "end_char": global_char_offset + len(text.strip()),
            }
            pages.append(page_info)
            global_char_offset += len(text.strip()) + 2  # +2 for separator when joining

        doc.close()
        logger.debug(
            "KnowledgeStore: parsed PDF ({} pages, {} chars total)",
            len(pages),
            global_char_offset,
        )
        return pages

    def _chunk_pdf(self, pdf_pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Chunk PDF content while preserving page metadata.

        Args:
            pdf_pages: List of page dicts from _parse_pdf.

        Returns:
            List of chunk dicts with: content, index, start_char, end_char, page, block_type.
        """
        chunk_size = self.config.chunk_size if self.config else 500
        chunk_overlap = self.config.chunk_overlap if self.config else 100

        logger.debug(
            "KnowledgeStore: chunking PDF ({} pages, chunk_size={}, overlap={})",
            len(pdf_pages),
            chunk_size,
            chunk_overlap,
        )

        chunks: list[dict[str, Any]] = []
        chunk_index = 0

        for page_info in pdf_pages:
            page_text = page_info["content"]
            page_num = page_info["page"]
            page_start = page_info["start_char"]

            if len(page_text) <= chunk_size:
                # Whole page fits in one chunk
                chunks.append({
                    "content": page_text,
                    "index": chunk_index,
                    "start_char": page_start,
                    "end_char": page_start + len(page_text),
                    "line_start": 1,
                    "line_end": page_text.count("\n") + 1,
                    "page": page_num,
                    "section_path": f"Page {page_num}",
                    "block_type": "pdf_text",
                })
                chunk_index += 1
            else:
                # Split large page into multiple chunks
                page_chunks = self._split_pdf_page(
                    page_text,
                    page_num,
                    page_start,
                    chunk_size,
                    chunk_overlap,
                    chunk_index,
                )
                chunks.extend(page_chunks)
                chunk_index += len(page_chunks)

        logger.debug(
            "KnowledgeStore: chunked PDF into {} chunks",
            len(chunks),
        )
        return chunks

    def _split_pdf_page(
        self,
        page_text: str,
        page_num: int,
        page_start: int,
        chunk_size: int,
        chunk_overlap: int,
        start_index: int,
    ) -> list[dict[str, Any]]:
        """Split a large PDF page into multiple chunks.

        Args:
            page_text: Text content of the page.
            page_num: Page number (1-based).
            page_start: Global character offset for this page.
            chunk_size: Maximum chunk size.
            chunk_overlap: Overlap between chunks.
            start_index: Starting chunk index.

        Returns:
            List of chunk dicts.
        """
        chunks: list[dict[str, Any]] = []
        start = 0
        index = start_index

        # Build line position map for this page
        line_positions: list[int] = [0]
        for i, char in enumerate(page_text):
            if char == "\n":
                line_positions.append(i + 1)

        def get_line_number(char_pos: int) -> int:
            return max(1, bisect_right(line_positions, char_pos))

        while start < len(page_text):
            end = min(start + chunk_size, len(page_text))

            # Try to find natural break point
            if end < len(page_text):
                for offset in range(min(50, chunk_size // 10)):
                    if end - offset <= start:
                        break
                    char = page_text[end - offset]
                    if char in ("\n", " ", ".", "!", "?", "；", "。", "！", "？"):
                        end = end - offset + 1
                        break

            chunk_content = page_text[start:end].strip()
            if chunk_content:
                line_start = get_line_number(start)
                line_end = get_line_number(end)
                chunks.append({
                    "content": chunk_content,
                    "index": index,
                    "start_char": page_start + start,
                    "end_char": page_start + end,
                    "line_start": line_start,
                    "line_end": line_end,
                    "page": page_num,
                    "section_path": f"Page {page_num}",
                    "block_type": "pdf_text",
                })
                index += 1

            # Next start with overlap
            next_start = end - chunk_overlap
            if next_start <= start:
                next_start = end
            start = next_start

        return chunks

    def _generate_chunk_summaries(
        self,
        chunks: list[dict[str, Any]],
        doc_name: str,
    ) -> list[dict[str, Any]]:
        """Generate summaries for chunks using LLM.

        Args:
            chunks: List of chunk dicts with 'content' field.
            doc_name: Document name for context.

        Returns:
            Chunks with 'summary' field added.
        """
        if not self.config or not self.config.generate_summary:
            return chunks

        if not self.config_ref:
            logger.warning("KnowledgeStore: generate_summary enabled but no config_ref provided")
            return chunks

        # Get LLM configuration
        agent_defaults = self.config_ref.agents.defaults
        model = agent_defaults.model
        provider_config = self.config_ref.get_provider(model)

        if not provider_config or not provider_config.api_key:
            logger.warning("KnowledgeStore: no LLM provider configured for summary generation")
            return chunks

        api_key = provider_config.api_key
        api_base = provider_config.api_base or self.config_ref.get_api_base(model) or "https://api.openai.com/v1"

        logger.info(
            "KnowledgeStore: generating summaries for {} chunks (model={})",
            len(chunks),
            model,
        )

        # Use OpenAI client for batch generation
        try:
            import httpx
        except ImportError:
            logger.warning("KnowledgeStore: httpx not available for summary generation")
            return chunks

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if provider_config.extra_headers:
            headers.update(provider_config.extra_headers)

        summary_prompt = """请用1-2句话总结以下文本片段的核心内容，要求简洁准确，突出关键信息。不要添加任何解释或引言，直接输出总结内容。

文本片段：
{content}

总结："""

        # Batch process chunks
        batch_size = 5
        for batch_start in range(0, len(chunks), batch_size):
            batch = chunks[batch_start:batch_start + batch_size]
            batch_num = batch_start // batch_size + 1
            total_batches = (len(chunks) + batch_size - 1) // batch_size

            logger.debug(
                "KnowledgeStore: processing summary batch {} of {}",
                batch_num,
                total_batches,
            )

            for i, chunk in enumerate(batch):
                content = chunk["content"]
                if len(content) < 50:
                    # Skip very short chunks
                    chunk["summary"] = ""
                    continue

                prompt = summary_prompt.format(content=content[:2000])  # Limit content length

                try:
                    with httpx.Client(timeout=30.0) as client:
                        response = client.post(
                            f"{api_base}/chat/completions",
                            headers=headers,
                            json={
                                "model": model,
                                "messages": [{"role": "user", "content": prompt}],
                                "max_tokens": 100,
                                "temperature": 0.3,
                            },
                        )
                        response.raise_for_status()
                        result = response.json()
                        summary = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                        chunk["summary"] = summary.strip()
                except Exception as e:
                    logger.warning(
                        "KnowledgeStore: failed to generate summary for chunk {}: {}",
                        chunk["index"],
                        e,
                    )
                    chunk["summary"] = ""

        logger.info(
            "KnowledgeStore: generated {} summaries",
            sum(1 for c in chunks if c.get("summary")),
        )
        return chunks

    def query(
        self,
        query_text: str,
        top_k: int = 5,
        mode: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Query knowledge base using configured retrieval mode.

        Args:
            query_text: The search query.
            top_k: Maximum number of results.
            mode: Retrieval mode ("dense", "sparse", "hybrid").
                If None, uses config setting.
            category: Optional category filter.
            tags: Optional tags filter.

        Returns:
            List of result dicts with content, metadata, and scores.
        """
        if mode is None:
            mode = self.config.retrieval_mode if self.config else "hybrid"

        logger.debug(
            "KnowledgeStore: query (mode={}, top_k={}, category={}, tags={})",
            mode,
            top_k,
            category or "none",
            tags or [],
        )

        candidate_k = self._rerank_candidate_count(top_k)

        if mode == "dense":
            results = self._query_dense(query_text, candidate_k, category, tags)
        elif mode == "sparse":
            results = self._query_sparse(query_text, candidate_k, category, tags)
        else:
            results = self.query_hybrid(query_text, candidate_k, category, tags)

        results = self._maybe_rerank(query_text, results, top_k)

        logger.debug(
            "KnowledgeStore: query returned {} results (mode={})",
            len(results),
            mode,
        )
        return results

    def _rerank_candidate_count(self, top_k: int) -> int:
        if not self.config or not self.config.rerank_enabled:
            return top_k
        requested = self.config.rerank_top_n or top_k
        return max(top_k, min(max(requested * 3, top_k * 3), 50))

    def query_hybrid(
        self,
        query_text: str,
        top_k: int = 5,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Hybrid retrieval: dense + sparse with RRF fusion.

        Args:
            query_text: The search query.
            top_k: Maximum number of results.
            category: Optional category filter.
            tags: Optional tags filter.

        Returns:
            List of results sorted by RRF score.
        """
        # Get more results from each method for better fusion
        fetch_k = top_k * 3

        logger.debug("KnowledgeStore: hybrid query fetching {} from each method", fetch_k)

        dense_results = self._query_dense(query_text, fetch_k, category, tags)
        sparse_results = self._query_sparse(query_text, fetch_k, category, tags)

        logger.debug(
            "KnowledgeStore: hybrid retrieved {} dense + {} sparse results",
            len(dense_results),
            len(sparse_results),
        )

        # RRF fusion
        rrf_k = self.config.rrf_k if self.config else 60
        fused = self._rrf_fusion(dense_results, sparse_results, rrf_k)

        logger.debug("KnowledgeStore: hybrid RRF fusion produced {} results (rrf_k={})", len(fused), rrf_k)

        return fused[:top_k]

    def _maybe_rerank(
        self,
        query_text: str,
        results: list[dict[str, Any]],
        top_k: int,
    ) -> list[dict[str, Any]]:
        """Optionally rerank retrieved candidates with an OpenAI-compatible rerank API."""
        if not results or not self.config or not self.config.rerank_enabled:
            return results

        api_key = self.config.rerank_api_key or os.environ.get(self.config.rerank_api_key_env_var, "")
        if not api_key:
            logger.warning(
                "KnowledgeStore: rerank enabled but no API key configured (env={})",
                self.config.rerank_api_key_env_var,
            )
            return results[:top_k]

        documents = [r.get("content", "") for r in results]
        if not any(documents):
            return results[:top_k]

        top_n = self.config.rerank_top_n or top_k
        top_n = max(1, min(top_n, len(results)))

        try:
            from openai import OpenAI

            client = OpenAI(
                api_key=api_key,
                base_url=self.config.rerank_api_base,
            )
            response = client.post(
                "/reranks",
                body={
                    "model": self.config.rerank_model,
                    "query": query_text,
                    "documents": documents,
                    "top_n": top_n,
                },
                cast_to=object,
            )
            reranked = self._apply_rerank_response(results, response, top_n)
            logger.debug(
                "KnowledgeStore: reranked {} candidates to {} results with model={}",
                len(results),
                len(reranked),
                self.config.rerank_model,
            )
            return reranked
        except Exception as e:
            logger.warning("KnowledgeStore: rerank failed, using original retrieval order: {}", e)
            return results[:top_k]

    def _apply_rerank_response(
        self,
        results: list[dict[str, Any]],
        response: Any,
        top_n: int,
    ) -> list[dict[str, Any]]:
        data = response if isinstance(response, dict) else self._object_to_dict(response)
        raw_items = data.get("results") or data.get("data") or data.get("output", {}).get("results") or []
        reranked: list[dict[str, Any]] = []
        seen: set[int] = set()

        for rank, item in enumerate(raw_items, 1):
            item_data = item if isinstance(item, dict) else self._object_to_dict(item)
            index = item_data.get("index")
            if index is None:
                index = item_data.get("document_index")
            if index is None:
                index = item_data.get("corpus_id")
            if not isinstance(index, int) or index < 0 or index >= len(results):
                continue

            candidate = dict(results[index])
            score = item_data.get("relevance_score")
            if score is None:
                score = item_data.get("score")
            candidate["rerank_score"] = score
            candidate["rerank_rank"] = rank
            candidate["rerank_model"] = self.config.rerank_model if self.config else ""
            candidate["pre_rerank_score"] = candidate.get("rrf_score") or candidate.get("bm25_score") or candidate.get("distance")
            candidate["method"] = f"{candidate.get('method') or 'retrieval'}+rerank"
            reranked.append(candidate)
            seen.add(index)

        if len(reranked) < top_n:
            for index, candidate in enumerate(results):
                if index in seen:
                    continue
                fallback = dict(candidate)
                fallback["rerank_rank"] = len(reranked) + 1
                fallback["rerank_model"] = self.config.rerank_model if self.config else ""
                fallback["pre_rerank_score"] = fallback.get("rrf_score") or fallback.get("bm25_score") or fallback.get("distance")
                reranked.append(fallback)
                if len(reranked) >= top_n:
                    break

        return reranked[:top_n]

    @staticmethod
    def _object_to_dict(value: Any) -> dict[str, Any]:
        if hasattr(value, "model_dump"):
            return value.model_dump()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        if hasattr(value, "__dict__"):
            return dict(value.__dict__)
        return {}

    def _rrf_fusion(
        self,
        dense_results: list[dict[str, Any]],
        sparse_results: list[dict[str, Any]],
        k: int = 60,
    ) -> list[dict[str, Any]]:
        """Reciprocal Rank Fusion algorithm.

        RRF_score(d) = Σ 1/(k + rank(d))

        Args:
            dense_results: Results from dense retrieval.
            sparse_results: Results from sparse retrieval.
            k: RRF constant (default 60).

        Returns:
            Fused results sorted by RRF score.
        """
        scores: dict[str, float] = {}
        result_map: dict[str, dict[str, Any]] = {}

        dense_weight = self.config.dense_weight if self.config else 1.0
        sparse_weight = self.config.sparse_weight if self.config else 1.0

        # Process dense results
        for rank, r in enumerate(dense_results, 1):
            chunk_id = r["id"]
            contribution = dense_weight / (k + rank)
            scores[chunk_id] = scores.get(chunk_id, 0) + contribution
            if chunk_id not in result_map:
                result_map[chunk_id] = dict(r)
            result_map[chunk_id]["dense_rank"] = rank
            result_map[chunk_id]["dense_contribution"] = contribution
            result_map[chunk_id]["dense_distance"] = r.get("distance")

        # Process sparse results
        for rank, r in enumerate(sparse_results, 1):
            chunk_id = r["id"]
            contribution = sparse_weight / (k + rank)
            scores[chunk_id] = scores.get(chunk_id, 0) + contribution
            if chunk_id not in result_map:
                result_map[chunk_id] = dict(r)
            result_map[chunk_id]["sparse_rank"] = rank
            result_map[chunk_id]["sparse_contribution"] = contribution
            result_map[chunk_id]["bm25_score"] = r.get("bm25_score")

        # Sort by RRF score descending
        sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)

        results = []
        for chunk_id in sorted_ids:
            r = result_map[chunk_id]
            r["rrf_score"] = scores[chunk_id]
            methods = []
            if r.get("dense_rank") is not None:
                methods.append("dense")
            if r.get("sparse_rank") is not None:
                methods.append("sparse")
            r["method"] = "hybrid"
            r["matched_methods"] = methods
            results.append(r)

        return results

    def _query_dense(
        self,
        query_text: str,
        top_k: int,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Dense vector retrieval using embedding similarity."""
        if not self.vector_store:
            logger.warning("KnowledgeStore: vector_store not available for dense query")
            return []

        try:
            collection = self.vector_store._get_or_create_collection(
                _KNOWLEDGE_COLLECTION_DENSE
            )

            count = collection.count()
            if count == 0:
                logger.debug("KnowledgeStore: dense collection is empty, returning no results")
                return []

            logger.debug(
                "KnowledgeStore: dense query (collection_count={}, top_k={}, filter={})",
                count,
                top_k,
                category or "none",
            )

            filters: list[dict[str, Any]] = []
            if category:
                filters.append({"category": category})

            where_filter = {"$and": filters} if len(filters) > 1 else (filters[0] if filters else None)
            n_results = min(top_k, count)

            results = collection.query(
                query_texts=[query_text],
                n_results=n_results,
                where=where_filter,
                include=["documents", "distances", "metadatas"],
            )

            raw_count = len(results.get("ids", [[]])[0]) if results else 0
            logger.debug("KnowledgeStore: dense query returned {} raw results", raw_count)
        except Exception as e:
            logger.warning(
                "KnowledgeStore: dense query failed (top_k={}, category={}): {}",
                top_k,
                category or "none",
                e,
            )
            return []

        return self._process_query_results(results, tags, "dense")

    def _query_sparse(
        self,
        query_text: str,
        top_k: int,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Sparse retrieval using custom BM25 index."""
        try:
            logger.debug(
                "KnowledgeStore: sparse BM25 query (top_k={}, category={})",
                top_k,
                category or "none",
            )

            # Get BM25 results
            bm25_results = self._bm25_index.query(query_text, top_k=top_k * 2)

            if not bm25_results:
                logger.debug("KnowledgeStore: BM25 returned no results")
                return []

            logger.debug("KnowledgeStore: BM25 returned {} raw results", len(bm25_results))

            # Build result list with metadata from chunks file
            chunks_data = self._read_chunks()
            chunk_meta_map = {c.id: c for c in chunks_data}

            out: list[dict[str, Any]] = []
            for chunk_id, bm25_score in bm25_results:
                meta = chunk_meta_map.get(chunk_id)
                if not meta:
                    continue

                # Apply category filter
                if category and meta.category != category:
                    continue

                # Apply tags filter
                if tags:
                    meta_tags = set(meta.tags or [])
                    if not meta_tags.intersection(set(tags)):
                        continue

                result = {
                    "id": chunk_id,
                    "content": meta.content,
                    "doc_id": meta.doc_id,
                    "doc_name": meta.doc_name,
                    "file_path": meta.file_path,
                    "start_char": meta.start_char,
                    "end_char": meta.end_char,
                    "line_start": meta.line_start,
                    "line_end": meta.line_end,
                    "page": meta.page,
                    "section_path": meta.section_path,
                    "block_type": meta.block_type,
                    "bm25_score": bm25_score,
                    "method": "sparse",
                    "matched_methods": ["sparse"],
                }
                out.append(result)

            logger.debug("KnowledgeStore: sparse query returned {} filtered results", len(out))
            return out[:top_k]
        except Exception as e:
            logger.warning(
                "KnowledgeStore: sparse query failed (top_k={}, category={}): {}",
                top_k,
                category or "none",
                e,
            )
            return []

    def _process_query_results(
        self,
        results: dict[str, Any],
        tags: list[str] | None,
        method: str,
    ) -> list[dict[str, Any]]:
        """Process raw query results into standardized format."""
        ids = results.get("ids", [[]])[0]
        documents = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]

        out: list[dict[str, Any]] = []
        for chunk_id, doc, dist, meta in zip(ids, documents, distances, metadatas):
            if not doc:
                continue

            # Apply tags filter
            if tags:
                meta_tags_raw = meta.get("tags", "[]") if meta else "[]"
                try:
                    meta_tags = set(json.loads(meta_tags_raw))
                except (json.JSONDecodeError, TypeError):
                    meta_tags = set()
                if not meta_tags.intersection(set(tags)):
                    continue

            result = {
                "id": chunk_id,
                "content": doc,
                "doc_id": meta.get("doc_id", "") if meta else "",
                "doc_name": meta.get("doc_name", "") if meta else "",
                "file_path": meta.get("file_path", "") if meta else "",
                "start_char": meta.get("start_char", 0) if meta else 0,
                "end_char": meta.get("end_char", 0) if meta else 0,
                "line_start": meta.get("line_start", 0) if meta else 0,
                "line_end": meta.get("line_end", 0) if meta else 0,
                "page": meta.get("page") if meta else None,
                "section_path": meta.get("section_path", "") if meta else "",
                "block_type": meta.get("block_type", "text") if meta else "text",
                "distance": dist,
                "method": method,
                "matched_methods": [method],
                "metadata": meta or {},
            }
            out.append(result)

        return out

    def list_documents(
        self,
        category: str | None = None,
        limit: int = 50,
    ) -> list[KnowledgeDocument]:
        """List all documents in the knowledge base."""
        documents = self._read_documents()

        if category:
            documents = [d for d in documents if d.category == category]

        documents.sort(key=lambda d: d.created_at, reverse=True)
        return documents[:limit]

    def get_document_content(self, doc_id: str) -> str | None:
        """Get full content of a document by ID.

        Reads from saved file if available.
        For PDF files, returns the extracted text stored in doc.content.
        """
        documents = self._read_documents()
        for doc in documents:
            if doc.id == doc_id:
                # PDF files: return extracted text from doc.content, not binary file
                if doc.file_type == "pdf":
                    return doc.content
                if doc.file_path and Path(doc.file_path).exists():
                    return Path(doc.file_path).read_text(encoding="utf-8")
                return doc.content
        return None

    def get_document(self, doc_id: str) -> KnowledgeDocument | None:
        """Get a document record by ID.

        Returns the full document object with metadata.
        """
        documents = self._read_documents()
        for doc in documents:
            if doc.id == doc_id:
                return doc
        return None

    def get_chunk_context(
        self,
        doc_id: str,
        start_char: int,
        end_char: int,
        context_chars: int = 200,
    ) -> str | None:
        """Get surrounding context for a chunk.

        Args:
            doc_id: Document ID.
            start_char: Chunk start position.
            end_char: Chunk end position.
            context_chars: Number of chars before/after to include.

        Returns:
            Expanded context text or None.
        """
        content = self.get_document_content(doc_id)
        if not content:
            return None

        # Expand range with context
        expanded_start = max(0, start_char - context_chars)
        expanded_end = min(len(content), end_char + context_chars)

        return content[expanded_start:expanded_end]

    def delete_document(self, doc_id: str) -> bool:
        """Delete a document and all its chunks."""
        documents = self._read_documents()

        doc_to_delete = None
        for doc in documents:
            if doc.id == doc_id:
                doc_to_delete = doc
                break

        if not doc_to_delete:
            return False

        # Remove from documents list
        kept = [d for d in documents if d.id != doc_id]
        self._write_documents(kept)

        # Remove chunks file entries
        self._remove_chunks_for_doc(doc_id)

        # Delete saved file
        if doc_to_delete.file_path:
            try:
                Path(doc_to_delete.file_path).unlink(missing_ok=True)
            except Exception:
                pass

        # Remove from vector store (dense)
        if self.vector_store is not None:
            self._delete_from_collection(_KNOWLEDGE_COLLECTION_DENSE, doc_id)

        # Remove from BM25 index
        self._delete_from_bm25_index(doc_id)

        with self._lock:
            self._indexed_ids.discard(doc_id)

        logger.info("KnowledgeStore: deleted document '{}' ({})", doc_to_delete.name, doc_id)
        return True

    def get_stats(self) -> dict[str, Any]:
        """Get statistics about the knowledge base."""
        documents = self._read_documents()
        chunks = self._read_chunks()

        total_chars = sum(len(d.content) for d in documents)
        categories: dict[str, int] = {}
        for doc in documents:
            categories[doc.category or "uncategorized"] = categories.get(doc.category or "uncategorized", 0) + 1

        return {
            "document_count": len(documents),
            "chunk_count": len(chunks),
            "total_chars": total_chars,
            "categories": categories,
            "indexed_dense": len(self._indexed_ids),
            "indexed_sparse": len(self._bm25_index._chunk_contents),
        }

    def rebuild_bm25_index(self) -> dict[str, Any]:
        """Rebuild BM25 index from existing chunks.

        Useful when the tokenizer is updated and existing index needs to be refreshed.
        Returns statistics about the rebuild operation.
        """
        logger.info("KnowledgeStore: rebuilding BM25 index...")

        # Clear existing BM25 index
        self._bm25_index = BM25Index(
            k=self.config.bm25_k if self.config else 1.2,
            b=self.config.bm25_b if self.config else 0.75,
        )

        # Read all chunks and re-index
        chunks = self._read_chunks()
        indexed_count = 0

        for chunk in chunks:
            chunk_id = chunk.id
            content = chunk.content
            if content:
                self._bm25_index.add_chunk(chunk_id, content)
                indexed_count += 1

        # Save the rebuilt index
        self._bm25_index.save(self.bm25_index_file)

        # Update indexed IDs tracking
        documents = self._read_documents()
        with self._lock:
            self._indexed_ids = {d.id for d in documents}

        logger.info(
            "KnowledgeStore: BM25 index rebuilt ({} chunks indexed, {} terms)",
            indexed_count,
            len(self._bm25_index._inverted_index),
        )

        return {
            "chunks_indexed": indexed_count,
            "terms_created": len(self._bm25_index._inverted_index),
            "total_docs": self._bm25_index._total_docs,
        }

    def _save_document_file(
        self,
        doc_id: str,
        content: str | bytes | bytearray,
        file_type: str,
    ) -> Path:
        """Save document content to local file.

        Args:
            doc_id: Document ID
            content: Text content (str) for txt/md, or binary content (bytes/bytearray) for PDF
            file_type: File type (txt, md, pdf)

        Returns:
            Path to saved file
        """
        file_name = f"{doc_id}.{file_type}"
        file_path = self.files_dir / file_name

        if file_type == "pdf":
            if isinstance(content, (bytes, bytearray)):
                file_path.write_bytes(bytes(content))
            else:
                # If text is passed for PDF, it's already extracted - save as txt
                file_path.write_text(content, encoding="utf-8")
        else:
            file_path.write_text(content, encoding="utf-8")

        logger.debug("KnowledgeStore: saved document file to {}", file_path)
        return file_path

    def _chunk_text_with_positions(self, text: str, file_type: str = "txt") -> list[dict[str, Any]]:
        """Split text into chunks with position metadata.

        Returns list of dicts with: content, index, start_char, end_char, line_start, line_end.
        """
        chunk_size = self.config.chunk_size if self.config else 500
        chunk_overlap = self.config.chunk_overlap if self.config else 100

        logger.debug(
            "KnowledgeStore: chunking text (len={}, chunk_size={}, overlap={}, file_type={})",
            len(text),
            chunk_size,
            chunk_overlap,
            file_type,
        )

        # Build line position map: char_index -> line_number (1-based)
        line_positions: list[int] = []  # char index where each line starts
        line_positions.append(0)  # Line 1 starts at char 0
        for i, char in enumerate(text):
            if char == "\n":
                line_positions.append(i + 1)  # Next line starts after newline

        def get_line_number(char_pos: int) -> int:
            """Get line number (1-based) for a character position."""
            return max(1, bisect_right(line_positions, char_pos))

        if len(text) <= chunk_size:
            logger.debug("KnowledgeStore: text fits in single chunk (no splitting needed)")
            line_end = get_line_number(len(text))
            section_path = self._find_primary_markdown_heading(text) if self._is_markdown(file_type, text) else ""
            return [{
                "content": text,
                "index": 0,
                "start_char": 0,
                "end_char": len(text),
                "line_start": 1,
                "line_end": line_end,
                "section_path": section_path,
                "block_type": "markdown" if section_path else "text",
            }]

        if self._is_markdown(file_type, text):
            chunks = self._chunk_markdown_blocks(text, chunk_size, chunk_overlap, get_line_number)
            if chunks:
                return chunks

        chunks: list[dict[str, Any]] = []
        start = 0
        index = 0

        while start < len(text):
            end = min(start + chunk_size, len(text))

            # Find natural break point
            if end < len(text):
                for offset in range(min(50, chunk_size // 10)):
                    if end - offset <= start:
                        break
                    char = text[end - offset]
                    if char in ("\n", " ", ".", "!", "?", "；", "。", "！", "？"):
                        end = end - offset + 1
                        break

            chunk_content = text[start:end].strip()
            if chunk_content:
                line_start = get_line_number(start)
                line_end = get_line_number(end)
                chunks.append({
                    "content": chunk_content,
                    "index": index,
                    "start_char": start,
                    "end_char": end,
                    "line_start": line_start,
                    "line_end": line_end,
                    "section_path": "",
                    "block_type": "text",
                })
                index += 1

            # Next start with overlap
            next_start = end - chunk_overlap
            if next_start <= start:
                next_start = end
            start = next_start

        logger.debug(
            "KnowledgeStore: chunked text into {} chunks (avg_size={:.0f})",
            len(chunks),
            sum(len(c["content"]) for c in chunks) / len(chunks) if chunks else 0,
        )

        return chunks

    @staticmethod
    def _is_markdown(file_type: str, text: str) -> bool:
        if file_type.lower() in {"md", "markdown"}:
            return True
        return bool(re.search(r"(?m)^(#{1,6})\s+\S+", text)) or "```" in text

    @staticmethod
    def _find_primary_markdown_heading(text: str) -> str:
        for line in text.splitlines():
            match = _MARKDOWN_HEADING_RE.match(line.strip())
            if match:
                return match.group(2).strip()
        return ""

    def _chunk_markdown_blocks(
        self,
        text: str,
        chunk_size: int,
        chunk_overlap: int,
        get_line_number: Any,
    ) -> list[dict[str, Any]]:
        """Chunk Markdown on block boundaries while preserving code fences."""
        blocks = self._markdown_blocks(text)
        if not blocks:
            return []

        chunks: list[dict[str, Any]] = []
        current: list[dict[str, Any]] = []
        current_len = 0

        def emit_current() -> None:
            nonlocal current, current_len
            if not current:
                return
            start = current[0]["start"]
            end = current[-1]["end"]
            content = text[start:end].strip()
            if content:
                chunks.append({
                    "content": content,
                    "index": len(chunks),
                    "start_char": start,
                    "end_char": end,
                    "line_start": get_line_number(start),
                    "line_end": get_line_number(end),
                    "section_path": current[-1].get("section_path", ""),
                    "block_type": "code" if all(b.get("block_type") == "code" for b in current) else "markdown",
                })
            keep: list[dict[str, Any]] = []
            kept_len = 0
            for block in reversed(current):
                block_len = block["end"] - block["start"]
                if kept_len + block_len > chunk_overlap:
                    break
                keep.insert(0, block)
                kept_len += block_len
            current = keep
            current_len = kept_len

        for block in blocks:
            block_len = block["end"] - block["start"]
            if block_len > chunk_size:
                emit_current()
                if block.get("block_type") == "code":
                    start = block["start"]
                    end = block["end"]
                    chunks.append({
                        "content": text[start:end].strip(),
                        "index": len(chunks),
                        "start_char": start,
                        "end_char": end,
                        "line_start": get_line_number(start),
                        "line_end": get_line_number(end),
                        "section_path": block.get("section_path", ""),
                        "block_type": "code",
                    })
                else:
                    chunks.extend(self._split_large_markdown_block(
                        block,
                        text,
                        chunk_size,
                        chunk_overlap,
                        get_line_number,
                        len(chunks),
                    ))
                continue

            if current and current_len + block_len > chunk_size:
                emit_current()

            current.append(block)
            current_len += block_len

        emit_current()

        for index, chunk in enumerate(chunks):
            chunk["index"] = index

        logger.debug(
            "KnowledgeStore: markdown chunked text into {} chunks (avg_size={:.0f})",
            len(chunks),
            sum(len(c["content"]) for c in chunks) / len(chunks) if chunks else 0,
        )
        return chunks

    def _markdown_blocks(self, text: str) -> list[dict[str, Any]]:
        lines = text.splitlines(keepends=True)
        blocks: list[dict[str, Any]] = []
        headings: list[str] = []
        pos = 0
        block_start = 0
        block_lines: list[str] = []
        in_fence = False

        def section_path() -> str:
            return " > ".join(h for h in headings if h)

        def flush(end_pos: int) -> None:
            nonlocal block_start, block_lines
            if not block_lines:
                return
            content = "".join(block_lines).strip()
            if content:
                blocks.append({
                    "start": block_start,
                    "end": end_pos,
                    "section_path": section_path(),
                    "block_type": "code" if content.startswith(("```", "~~~")) else "markdown",
                })
            block_lines = []
            block_start = end_pos

        for line in lines:
            line_start = pos
            line_end = pos + len(line)
            stripped = line.strip()
            fence = _FENCE_RE.match(stripped)
            heading = _MARKDOWN_HEADING_RE.match(stripped) if not in_fence else None

            if heading:
                flush(line_start)
                level = len(heading.group(1))
                title = heading.group(2).strip()
                headings = headings[:level - 1]
                headings.append(title)
                block_start = line_start
                block_lines = [line]
                flush(line_end)
            else:
                if not block_lines:
                    block_start = line_start
                block_lines.append(line)
                if fence:
                    in_fence = not in_fence
                if not in_fence and stripped == "":
                    flush(line_end)

            pos = line_end

        flush(len(text))
        return blocks

    def _split_large_markdown_block(
        self,
        block: dict[str, Any],
        text: str,
        chunk_size: int,
        chunk_overlap: int,
        get_line_number: Any,
        start_index: int,
    ) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        start = block["start"]
        block_end = block["end"]
        while start < block_end:
            end = min(start + chunk_size, block_end)
            if end < block_end:
                for offset in range(min(80, max(1, chunk_size // 5))):
                    pos = end - offset
                    if pos <= start:
                        break
                    if text[pos:pos + 1] in ("\n", " ", ".", "!", "?", ";", ":", ",", "\u3002", "\uff01", "\uff1f", "\uff1b", "\uff1a", "\uff0c"):
                        end = pos + 1
                        break
            content = text[start:end].strip()
            if content:
                chunks.append({
                    "content": content,
                    "index": start_index + len(chunks),
                    "start_char": start,
                    "end_char": end,
                    "line_start": get_line_number(start),
                    "line_end": get_line_number(end),
                    "section_path": block.get("section_path", ""),
                    "block_type": "markdown",
                })
            next_start = end - chunk_overlap
            start = end if next_start <= start else next_start
        return chunks

    def _index_chunks_dense(
        self,
        doc_id: str,
        doc_name: str,
        file_path: str,
        chunks: list[dict[str, Any]],
        ts: str,
        category: str,
        tags: list[str],
    ) -> None:
        """Index chunks to dense collection (embedding)."""
        if not self.vector_store:
            logger.warning("KnowledgeStore: vector_store not available for dense indexing")
            return

        try:
            collection = self.vector_store._get_or_create_collection(
                _KNOWLEDGE_COLLECTION_DENSE
            )

            logger.debug(
                "KnowledgeStore: indexing {} chunks for doc '{}' to dense collection",
                len(chunks),
                doc_name,
            )

            # Build chunk data
            chunk_ids: list[str] = []
            chunk_docs: list[str] = []
            chunk_metas: list[dict[str, Any]] = []

            for chunk in chunks:
                chunk_id = f"chunk_{doc_id}_{chunk['index']}"
                chunk_ids.append(chunk_id)
                chunk_docs.append(chunk["content"])
                chunk_metas.append({
                    "doc_id": doc_id,
                    "doc_name": doc_name,
                    "file_path": file_path,
                    "chunk_index": chunk["index"],
                    "start_char": chunk["start_char"],
                    "end_char": chunk["end_char"],
                    "line_start": chunk.get("line_start", 1),
                    "line_end": chunk.get("line_end", 1),
                    "page": chunk.get("page"),
                    "section_path": chunk.get("section_path", ""),
                    "block_type": chunk.get("block_type", "text"),
                    "created_at": ts,
                    "category": category,
                    "tags": json.dumps(tags, ensure_ascii=False),
                    "source": "knowledge",
                })

            # Batch upsert to avoid embedding API batch size limit (max 10)
            batch_size = 10
            total_batches = (len(chunk_ids) + batch_size - 1) // batch_size
            logger.debug(
                "KnowledgeStore: upserting {} chunks in {} batches (batch_size={})",
                len(chunk_ids),
                total_batches,
                batch_size,
            )

            for i in range(0, len(chunk_ids), batch_size):
                batch_num = i // batch_size + 1
                batch_ids = chunk_ids[i:i + batch_size]
                batch_docs = chunk_docs[i:i + batch_size]
                batch_metas = chunk_metas[i:i + batch_size]
                logger.debug(
                    "KnowledgeStore: upserting batch {} of {} ({} chunks)",
                    batch_num,
                    total_batches,
                    len(batch_ids),
                )
                collection.upsert(
                    ids=batch_ids,
                    documents=batch_docs,
                    metadatas=batch_metas,
                )

            with self._lock:
                self._indexed_ids.add(doc_id)

            logger.info(
                "KnowledgeStore: indexed {} chunks (dense) for doc '{}' (id={})",
                len(chunks),
                doc_name,
                doc_id,
            )
        except Exception as e:
            logger.warning(
                "KnowledgeStore: dense indexing failed for doc '{}' (id={}, {} chunks): {}",
                doc_name,
                doc_id,
                len(chunks),
                e,
            )

    def _index_chunks_sparse(
        self,
        doc_id: str,
        doc_name: str,
        file_path: str,
        chunks: list[dict[str, Any]],
        ts: str,
        category: str,
        tags: list[str],
    ) -> None:
        """Index chunks to BM25 index."""
        try:
            for chunk in chunks:
                chunk_id = f"chunk_{doc_id}_{chunk['index']}"
                content = chunk["content"]
                self._bm25_index.add_chunk(chunk_id, content)

            # Save BM25 index to file
            self._bm25_index.save(self.bm25_index_file)

            logger.debug(
                "KnowledgeStore: indexed {} chunks (sparse BM25) for doc '{}'",
                len(chunks),
                doc_name,
            )
        except Exception as e:
            logger.warning("KnowledgeStore: sparse indexing failed: {}", e)

    def _delete_from_collection(self, collection_name: str, doc_id: str) -> None:
        """Delete all chunks for a document from a collection."""
        try:
            collection = self.vector_store._get_collection(collection_name)
            if collection is None:
                return

            all_ids = collection.get()["ids"]
            chunk_ids = [id for id in all_ids if id.startswith(f"chunk_{doc_id}_")]
            if chunk_ids:
                collection.delete(ids=chunk_ids)
                logger.debug(
                    "KnowledgeStore: deleted {} chunks from {}",
                    len(chunk_ids),
                    collection_name,
                )
        except Exception as e:
            logger.warning("KnowledgeStore: failed to delete from {}: {}", collection_name, e)

    def _delete_from_bm25_index(self, doc_id: str) -> None:
        """Delete all chunks for a document from BM25 index."""
        try:
            # Find all chunk IDs for this document
            chunk_ids = [
                cid for cid in self._bm25_index._chunk_contents.keys()
                if cid.startswith(f"chunk_{doc_id}_")
            ]
            if chunk_ids:
                self._bm25_index.remove_chunks(chunk_ids)
                self._bm25_index.save(self.bm25_index_file)
                logger.debug(
                    "KnowledgeStore: deleted {} chunks from BM25 index",
                    len(chunk_ids),
                )
        except Exception as e:
            logger.warning("KnowledgeStore: failed to delete from BM25: {}", e)

    def _read_documents(self) -> list[KnowledgeDocument]:
        """Read all documents from the JSONL file."""
        documents: list[KnowledgeDocument] = []
        try:
            with open(self.documents_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        documents.append(KnowledgeDocument(**data))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return documents

    def _read_chunks(self) -> list[KnowledgeChunk]:
        """Read all chunks from the JSONL file."""
        chunks: list[KnowledgeChunk] = []
        try:
            with open(self.chunks_file, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        chunks.append(KnowledgeChunk(**data))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return chunks

    def _remove_chunks_for_doc(self, doc_id: str) -> None:
        """Remove chunks for a document from chunks file."""
        chunks = self._read_chunks()
        kept = [c for c in chunks if c.doc_id != doc_id]
        self._write_chunks(kept)

    def _write_documents(self, documents: list[KnowledgeDocument]) -> None:
        """Write all documents to the JSONL file."""
        with open(self.documents_file, "w", encoding="utf-8") as f:
            for doc in documents:
                f.write(json.dumps(asdict(doc), ensure_ascii=False) + "\n")
        self._cursor_file.write_text(str(len(documents)), encoding="utf-8")

        with self._lock:
            self._indexed_ids.clear()

    def _write_chunks(self, chunks: list[KnowledgeChunk]) -> None:
        """Write all chunks to the JSONL file."""
        with open(self.chunks_file, "w", encoding="utf-8") as f:
            for chunk in chunks:
                f.write(json.dumps(asdict(chunk), ensure_ascii=False) + "\n")

    def _next_cursor(self) -> int:
        """Read the current cursor counter and return next value."""
        if self._cursor_file.exists():
            try:
                return int(self._cursor_file.read_text(encoding="utf-8").strip()) + 1
            except (ValueError, OSError):
                pass
        return len(self._read_documents()) + 1
