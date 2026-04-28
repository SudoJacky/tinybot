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
_SEMANTIC_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_QUOTED_ENTITY_RE = re.compile(r"[\"'“”‘’《》](.{2,40}?)[\"'“”‘’《》]")
_EN_ENTITY_RE = re.compile(
    r"\b(?:[A-Z][A-Za-z0-9_./+-]*|[A-Z0-9]{2,})"
    r"(?:\s+(?:[A-Z][A-Za-z0-9_./+-]*|[A-Z0-9]{2,})){0,4}\b"
)
_CLAIM_SPLIT_RE = re.compile(r"(?<=[。！？.!?；;])\s*|\n+")
_RELATION_PATTERNS: tuple[tuple[str, str], ...] = (
    ("defined_as", r"(.{2,40}?)(?:是一种|是一类|是一个|指的是|定义为|means|is defined as|refers to)(.{2,80})"),
    ("part_of", r"(.{2,40}?)(?:属于|隶属于|是.+?的一部分|part of|belongs to)(.{2,80})"),
    ("contains", r"(.{2,40}?)(?:包含|包括|由.+?组成|contains|includes|consists of)(.{2,80})"),
    ("depends_on", r"(.{2,40}?)(?:依赖|依靠|取决于|depends on|relies on|requires)(.{2,80})"),
    ("supports", r"(.{2,40}?)(?:支持|提供|实现|用于|supports|provides|implements|is used for)(.{2,80})"),
    ("causes", r"(.{2,40}?)(?:导致|引起|造成|causes|leads to|results in)(.{2,80})"),
    ("owned_by", r"(.{2,40}?)(?:负责|归属|owned by|managed by|maintained by)(.{2,80})"),
    ("located_in", r"(.{2,40}?)(?:位于|部署在|located in|hosted in|deployed in)(.{2,80})"),
)
_ALLOWED_RELATION_PREDICATES = {
    "is_a",
    "part_of",
    "contains",
    "depends_on",
    "requires",
    "supports",
    "used_for",
    "causes",
    "precedes",
    "owned_by",
    "located_in",
    "similar_to",
    "contradicts",
    "defined_as",
}
_PREDICATE_ALIASES = {
    "belong_to": "part_of",
    "belongs_to": "part_of",
    "include": "contains",
    "includes": "contains",
    "use": "used_for",
    "uses": "used_for",
    "implemented_by": "depends_on",
    "need": "requires",
    "needs": "requires",
    "define": "defined_as",
    "defined": "defined_as",
}
_ENTITY_ACTION_MARKERS = (
    "支持",
    "生成",
    "完成",
    "触发",
    "分析",
    "自动",
    "用于",
    "实现",
    "提供",
    "调用",
    "执行",
    "创建",
    "返回",
    "包含",
    "依赖",
    "supports",
    "generates",
    "completes",
    "triggers",
    "analyzes",
    "automatically",
    "used for",
    "implements",
    "provides",
    "calls",
    "executes",
    "creates",
    "returns",
    "contains",
    "depends",
)
_ENTITY_NOISE_PHRASES = {
    "大家好",
    "阿巴阿巴",
    "也就",
    "就只能",
    "讲清楚",
    "一次性给大家讲清楚",
    "我的理解",
    "我的理解上",
    "我们常说的幻觉",
    "现在的大模型不",
    "而且用得比以前更多了",
}
_ENTITY_NOISE_MARKERS = (
    "大家",
    "小伙伴",
    "朋友",
    "我会",
    "我认为",
    "我的",
    "我们",
    "你们",
    "咱们",
    "一次性",
    "讲清楚",
    "看完",
    "听起来",
    "背景交代",
    "正式进入",
    "有朋友",
    "可能会问",
    "也就",
    "就只能",
    "其实",
    "不过",
    "所以",
    "然后",
    "当然",
    "这个",
    "这种",
    "那个",
    "这篇",
    "下面",
    "上面",
    "前面",
    "后面",
    "现在的",
    "以前",
    "以后",
    "已经",
    "而且",
    "用得",
    "比以前",
)
_CJK_ENTITY_BAD_PREFIXES = (
    "现在",
    "以前",
    "以后",
    "而且",
    "并且",
    "同时",
    "如果",
    "那么",
    "但是",
    "不过",
    "因为",
    "所以",
    "对于",
    "关于",
    "比如",
    "例如",
    "有些",
    "很多",
    "这些",
    "那些",
    "这种",
    "这个",
    "那个",
    "我们",
    "大家",
)
_CJK_ENTITY_BAD_SUFFIXES = (
    "了",
    "的",
    "地",
    "得",
    "不",
    "吗",
    "呢",
    "吧",
    "啦",
    "呀",
    "哦",
    "哈",
    "嘛",
)
_RELATION_ENDPOINT_TYPE_RULES: dict[str, tuple[set[str], set[str]]] = {
    "part_of": ({"person", "organization", "product", "module", "api", "file", "technology", "concept", "business_object", "proper_noun", "acronym"}, {"organization", "product", "module", "technology", "concept", "business_object", "proper_noun", "acronym"}),
    "contains": ({"organization", "product", "module", "technology", "concept", "business_object", "proper_noun", "acronym"}, {"product", "module", "api", "file", "technology", "concept", "business_object", "proper_noun", "acronym"}),
    "depends_on": ({"product", "module", "api", "file", "technology", "concept", "business_object", "proper_noun", "acronym"}, {"product", "module", "api", "file", "protocol", "algorithm", "technology", "concept", "proper_noun", "acronym"}),
    "requires": ({"product", "module", "api", "file", "technology", "concept", "business_object", "proper_noun", "acronym"}, {"product", "module", "api", "file", "protocol", "algorithm", "technology", "concept", "proper_noun", "acronym"}),
    "supports": ({"organization", "product", "module", "api", "file", "technology", "concept", "proper_noun", "acronym"}, {"product", "module", "api", "file", "technology", "concept", "business_object", "proper_noun", "acronym"}),
    "used_for": ({"product", "module", "api", "file", "protocol", "algorithm", "technology", "concept", "proper_noun", "acronym"}, {"technology", "concept", "business_object", "proper_noun", "acronym"}),
    "causes": ({"technology", "concept", "business_object", "proper_noun", "acronym"}, {"technology", "concept", "business_object", "proper_noun", "acronym"}),
    "owned_by": ({"product", "module", "api", "file", "business_object", "proper_noun", "acronym"}, {"person", "organization", "proper_noun"}),
    "located_in": ({"organization", "product", "module", "api", "file", "proper_noun", "acronym"}, {"organization", "business_object", "proper_noun"}),
    "defined_as": ({"product", "module", "api", "file", "protocol", "algorithm", "technology", "concept", "business_object", "proper_noun", "acronym"}, {"technology", "concept", "business_object", "proper_noun", "acronym"}),
}
_MARKDOWN_ENTITY_RE = re.compile(r"(?:`([^`]{2,60})`|\*\*([^*\n]{2,60})\*\*)")
_ENTITY_STOPWORDS = {
    "the",
    "this",
    "that",
    "there",
    "these",
    "those",
    "and",
    "or",
    "but",
    "with",
    "from",
    "into",
    "about",
    "summary",
    "content",
    "document",
    "section",
    "hello",
    "hi",
    "thanks",
    "thank you",
}


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
    parent_id: str = ""  # Parent chunk id for child chunks; self id for parent chunks
    chunk_type: str = "parent"  # parent or child
    content: str = ""
    retrieval_text: str = ""  # Normalized text used by dense embeddings and BM25
    semantic_text: str = ""  # Structured text used by entity/claim/relation extraction
    context_content: str = ""  # Readable text injected into model context
    summary: str = ""  # AI-generated summary (1-2 sentences)
    chunk_index: int = 0
    child_index: int = 0
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


@dataclass
class KnowledgeEntity:
    """A canonical entity extracted from knowledge chunks."""

    id: str = ""
    name: str = ""
    canonical_name: str = ""
    type: str = "concept"
    aliases: list[str] = field(default_factory=list)
    doc_ids: list[str] = field(default_factory=list)
    created_at: str = ""
    confidence: float = 0.5


@dataclass
class KnowledgeMention:
    """A concrete mention of an entity in a source chunk."""

    id: str = ""
    entity_id: str = ""
    chunk_id: str = ""
    doc_id: str = ""
    text: str = ""
    start_char: int = 0
    end_char: int = 0
    confidence: float = 0.5


@dataclass
class KnowledgeClaim:
    """An atomic factual statement extracted from a chunk."""

    id: str = ""
    chunk_id: str = ""
    doc_id: str = ""
    text: str = ""
    entity_ids: list[str] = field(default_factory=list)
    confidence: float = 0.5
    created_at: str = ""


@dataclass
class KnowledgeRelation:
    """A typed edge between two entities, backed by source evidence."""

    id: str = ""
    subject_entity_id: str = ""
    predicate: str = ""
    object_entity_id: str = ""
    evidence_chunk_id: str = ""
    doc_id: str = ""
    claim_id: str = ""
    confidence: float = 0.5
    created_at: str = ""


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
        self.entities_file = self.knowledge_dir / "entities.jsonl"
        self.mentions_file = self.knowledge_dir / "mentions.jsonl"
        self.claims_file = self.knowledge_dir / "claims.jsonl"
        self.relations_file = self.knowledge_dir / "relations.jsonl"
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

        # Split into non-overlapping parent chunks, then smaller child chunks for retrieval.
        parent_chunks = self._chunk_text_with_positions(content, file_type=file_type)
        parent_chunks = self._apply_chunk_text_views(parent_chunks, file_type)
        parent_chunks = self._generate_chunk_summaries(parent_chunks, name)
        child_chunks = self._build_child_chunks(parent_chunks)
        child_chunks = self._apply_chunk_text_views(child_chunks, file_type)
        chunks = parent_chunks + child_chunks

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
            chunk_count=len(parent_chunks),
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
                parent_id=(
                    f"chunk_{doc_id}_{chunk.get('parent_index', chunk['index'])}"
                    if chunk.get("chunk_type") == "child"
                    else f"chunk_{doc_id}_{chunk['index']}"
                ),
                chunk_type=chunk.get("chunk_type", "parent"),
                content=chunk["content"],
                retrieval_text=chunk.get("retrieval_text", ""),
                semantic_text=chunk.get("semantic_text", ""),
                context_content=chunk.get("context_content", ""),
                summary=chunk.get("summary", ""),
                chunk_index=chunk["index"],
                child_index=chunk.get("child_index", 0),
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
            self._index_chunks_dense(doc_id, name, str(file_path), child_chunks, ts, category, tags or [])

        # Index to sparse collection (BM25, independent of vector_store)
        self._index_chunks_sparse(doc_id, name, str(file_path), child_chunks, ts, category, tags or [])

        # Build semantic side indexes (claims, entities, relations, mentions)
        self._index_chunks_semantic(doc_id, name, parent_chunks, ts)

        logger.info(
            "KnowledgeStore: added document '{}' (id={}, {} chunks, {} chars)",
            name,
            doc_id,
            len(parent_chunks),
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
        pdf_pages = self._preprocess_pdf_pages(pdf_pages)

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

        # Chunk PDF content into parent chunks, then child chunks for retrieval.
        parent_chunks = self._chunk_pdf(pdf_pages)
        parent_chunks = self._apply_chunk_text_views(parent_chunks, "pdf")
        parent_chunks = self._generate_chunk_summaries(parent_chunks, name)
        child_chunks = self._build_child_chunks(parent_chunks)
        child_chunks = self._apply_chunk_text_views(child_chunks, "pdf")
        chunks = parent_chunks + child_chunks

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
            chunk_count=len(parent_chunks),
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
                parent_id=(
                    f"chunk_{doc_id}_{chunk.get('parent_index', chunk['index'])}"
                    if chunk.get("chunk_type") == "child"
                    else f"chunk_{doc_id}_{chunk['index']}"
                ),
                chunk_type=chunk.get("chunk_type", "parent"),
                content=chunk["content"],
                retrieval_text=chunk.get("retrieval_text", ""),
                semantic_text=chunk.get("semantic_text", ""),
                context_content=chunk.get("context_content", ""),
                summary=chunk.get("summary", ""),
                chunk_index=chunk["index"],
                child_index=chunk.get("child_index", 0),
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
            self._index_chunks_dense(doc_id, name, str(file_path), child_chunks, ts, category, tags or [])

        # Index to sparse collection (BM25, independent of vector_store)
        self._index_chunks_sparse(doc_id, name, str(file_path), child_chunks, ts, category, tags or [])

        # Build semantic side indexes (claims, entities, relations, mentions)
        self._index_chunks_semantic(doc_id, name, parent_chunks, ts)

        logger.info(
            "KnowledgeStore: added PDF document '{}' (id={}, {} chunks, {} pages)",
            name,
            doc_id,
            len(parent_chunks),
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

    def _preprocess_pdf_pages(self, pdf_pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Normalize PDF extraction artifacts before chunking."""
        if not pdf_pages:
            return []

        repeated_edge_lines = self._detect_repeated_pdf_edge_lines(pdf_pages)
        processed: list[dict[str, Any]] = []
        for page_info in pdf_pages:
            lines = page_info.get("content", "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
            kept_lines: list[str] = []
            for line_index, line in enumerate(lines):
                stripped = line.strip()
                if not stripped:
                    kept_lines.append("")
                    continue
                edge_line = line_index < 3 or line_index >= max(0, len(lines) - 3)
                if edge_line and self._pdf_noise_line_key(stripped) in repeated_edge_lines:
                    continue
                if self._is_pdf_page_number_line(stripped):
                    continue
                kept_lines.append(stripped)

            content = self._normalize_pdf_text("\n".join(kept_lines))
            updated = dict(page_info)
            updated["content"] = content
            updated["end_char"] = updated.get("start_char", 0) + len(content)
            processed.append(updated)
        return processed

    def _detect_repeated_pdf_edge_lines(self, pdf_pages: list[dict[str, Any]]) -> set[str]:
        if len(pdf_pages) < 3:
            return set()

        counts: dict[str, int] = {}
        for page_info in pdf_pages:
            lines = [line.strip() for line in page_info.get("content", "").splitlines() if line.strip()]
            edge_lines = lines[:3] + lines[-3:]
            seen: set[str] = set()
            for line in edge_lines:
                key = self._pdf_noise_line_key(line)
                if key and key not in seen:
                    counts[key] = counts.get(key, 0) + 1
                    seen.add(key)

        threshold = max(2, math.ceil(len(pdf_pages) * 0.5))
        return {key for key, count in counts.items() if count >= threshold}

    @staticmethod
    def _pdf_noise_line_key(line: str) -> str:
        key = re.sub(r"\s+", " ", line.strip().lower())
        key = re.sub(r"\d+", "#", key)
        if len(key) < 4:
            return ""
        return key

    @staticmethod
    def _is_pdf_page_number_line(line: str) -> bool:
        return bool(re.match(r"^(?:page\s*)?\d+\s*(?:/|of|-)?\s*\d*$", line.strip(), flags=re.IGNORECASE))

    @staticmethod
    def _normalize_pdf_text(text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"([A-Za-z])-\n([a-z])", r"\1\2", text)
        lines = [line.strip() for line in text.split("\n")]
        paragraphs: list[str] = []
        current = ""

        for line in lines:
            if not line:
                if current:
                    paragraphs.append(current.strip())
                    current = ""
                continue
            starts_new = bool(re.match(r"^(\d+[.)]|\-|\*|[A-Z][A-Z\s]{5,})\s+", line))
            if not current:
                current = line
                continue
            if starts_new or re.search(r"[.!?:;。！？；：)]$", current):
                paragraphs.append(current.strip())
                current = line
            else:
                current = f"{current} {line}"

        if current:
            paragraphs.append(current.strip())
        return "\n\n".join(p for p in paragraphs if p)

    def _chunk_pdf(self, pdf_pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Chunk PDF content while preserving page metadata.

        Args:
            pdf_pages: List of page dicts from _parse_pdf.

        Returns:
            List of chunk dicts with: content, index, start_char, end_char, page, block_type.
        """
        chunk_size = self.config.chunk_size if self.config else 500
        chunk_overlap = 0

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
                    "chunk_type": "parent",
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
                    "chunk_type": "parent",
                })
                index += 1

            start = end

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
        extra_headers = getattr(provider_config, "extra_headers", None)
        if extra_headers:
            headers.update(extra_headers)

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
                content = chunk.get("context_content") or chunk["content"]
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

        candidate_k = max(self._rerank_candidate_count(top_k), top_k * 3)

        if mode == "dense":
            results = self._query_dense(query_text, candidate_k, category, tags)
        elif mode == "sparse":
            results = self._query_sparse(query_text, candidate_k, category, tags)
        elif mode == "semantic":
            results = self._query_semantic(query_text, candidate_k, category, tags)
        else:
            results = self.query_hybrid(query_text, candidate_k, category, tags)
            semantic_results = self._query_semantic(query_text, candidate_k, category, tags)
            results = self._merge_semantic_results(results, semantic_results, candidate_k)

        results = self._maybe_rerank(query_text, results, candidate_k)
        results = self._expand_results_to_parent_chunks(results, top_k)

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

    def _expand_results_to_parent_chunks(
        self,
        results: list[dict[str, Any]],
        top_k: int,
    ) -> list[dict[str, Any]]:
        """Map child retrieval hits back to deduplicated parent chunks."""
        if not results:
            return []

        chunks = self._read_chunks()
        chunk_map = {chunk.id: chunk for chunk in chunks}
        parent_map = {
            chunk.id: chunk
            for chunk in chunks
            if chunk.chunk_type == "parent" or not chunk.parent_id
        }

        expanded: dict[str, dict[str, Any]] = {}
        parent_order: dict[str, int] = {}

        for rank, result in enumerate(results, 1):
            hit_id = result.get("id", "")
            hit_meta = chunk_map.get(hit_id)
            parent_id = (
                result.get("parent_id")
                or (hit_meta.parent_id if hit_meta else "")
                or hit_id
            )
            parent = parent_map.get(parent_id) or hit_meta
            if parent is None:
                continue

            target = expanded.get(parent_id)
            if target is None:
                target = {
                    **result,
                    "id": parent.id,
                    "parent_id": parent.id,
                    "chunk_type": "parent",
                    "content": parent.context_content or parent.content,
                    "raw_content": parent.content,
                    "retrieval_text": parent.retrieval_text,
                    "semantic_text": parent.semantic_text,
                    "summary": parent.summary,
                    "doc_id": parent.doc_id,
                    "doc_name": parent.doc_name,
                    "file_path": parent.file_path,
                    "start_char": parent.start_char,
                    "end_char": parent.end_char,
                    "line_start": parent.line_start,
                    "line_end": parent.line_end,
                    "page": parent.page,
                    "section_path": parent.section_path,
                    "block_type": parent.block_type,
                    "matched_child_ids": [],
                    "matched_child_snippets": [],
                    "matched_methods": [],
                }
                expanded[parent_id] = target
                parent_order[parent_id] = rank

            child_content = result.get("child_content") or (
                (hit_meta.retrieval_text or hit_meta.context_content or hit_meta.content)
                if hit_meta and hit_meta.id != parent.id else ""
            )
            if hit_id and hit_meta and hit_meta.chunk_type == "child" and hit_id not in target["matched_child_ids"]:
                target["matched_child_ids"].append(hit_id)
            if child_content and child_content not in target["matched_child_snippets"]:
                target["matched_child_snippets"].append(child_content)

            for key in ("matched_methods", "matched_entities", "matched_claims", "matched_relations"):
                values = result.get(key) or []
                existing = target.setdefault(key, [])
                for value in values:
                    if value not in existing:
                        existing.append(value)

            for key in (
                "rrf_score",
                "bm25_score",
                "semantic_score",
                "semantic_fusion_score",
                "rerank_score",
                "distance",
            ):
                value = result.get(key)
                if value is None:
                    continue
                current = target.get(key)
                if current is None:
                    target[key] = value
                elif key == "distance":
                    target[key] = min(current, value)
                else:
                    target[key] = max(current, value)

            method = result.get("method")
            if method:
                methods = set(target.get("matched_methods") or [])
                methods.update(str(method).split("+"))
                target["matched_methods"] = sorted(m for m in methods if m)
                if not target.get("method") or target["method"] == "retrieval":
                    target["method"] = method

            target["parent_rank_score"] = target.get("rerank_score")
            if target["parent_rank_score"] is None:
                target["parent_rank_score"] = (
                    target.get("semantic_fusion_score")
                    or target.get("rrf_score")
                    or target.get("semantic_score")
                    or target.get("bm25_score")
                    or (1.0 / max(float(target.get("distance") or 1.0), 1e-6))
                )

        ordered = sorted(
            expanded.values(),
            key=lambda item: (
                float(item.get("parent_rank_score") or 0.0),
                -parent_order.get(item.get("id", ""), 0),
            ),
            reverse=True,
        )
        return ordered[:top_k]

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
                    "parent_id": meta.parent_id or chunk_id,
                    "chunk_type": meta.chunk_type,
                    "child_content": (meta.retrieval_text or meta.context_content or meta.content) if meta.chunk_type == "child" else "",
                    "content": meta.retrieval_text or meta.context_content or meta.content,
                    "raw_content": meta.content,
                    "retrieval_text": meta.retrieval_text,
                    "semantic_text": meta.semantic_text,
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
                "parent_id": meta.get("parent_id", chunk_id) if meta else chunk_id,
                "chunk_type": meta.get("chunk_type", "child") if meta else "child",
                "child_content": doc if meta and meta.get("chunk_type", "child") == "child" else "",
                "content": doc,
                "retrieval_text": doc,
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

        # Remove semantic side-index entries
        self._remove_semantic_for_doc(doc_id)

        with self._lock:
            self._indexed_ids.discard(doc_id)

        logger.info("KnowledgeStore: deleted document '{}' ({})", doc_to_delete.name, doc_id)
        return True

    def get_stats(self) -> dict[str, Any]:
        """Get statistics about the knowledge base."""
        documents = self._read_documents()
        chunks = self._read_chunks()
        parent_chunks = [chunk for chunk in chunks if chunk.chunk_type == "parent" or not chunk.parent_id]
        child_chunks = [chunk for chunk in chunks if chunk.chunk_type == "child"]

        total_chars = sum(len(d.content) for d in documents)
        categories: dict[str, int] = {}
        for doc in documents:
            categories[doc.category or "uncategorized"] = categories.get(doc.category or "uncategorized", 0) + 1

        return {
            "document_count": len(documents),
            "chunk_count": len(parent_chunks),
            "parent_chunk_count": len(parent_chunks),
            "child_chunk_count": len(child_chunks),
            "entity_count": len(self._read_entities()),
            "claim_count": len(self._read_claims()),
            "relation_count": len(self._read_relations()),
            "total_chars": total_chars,
            "categories": categories,
            "indexed_dense": len(self._indexed_ids),
            "indexed_sparse": len(self._bm25_index._chunk_contents),
        }

    def get_entity_graph(
        self,
        doc_id: str | None = None,
        limit: int = 80,
        edge_limit: int = 160,
        min_confidence: float = 0.0,
        include_orphans: bool = False,
    ) -> dict[str, Any]:
        """Return an aggregated entity relation graph for visualization.

        Nodes are canonical knowledge entities. Edges are grouped by
        subject/predicate/object so the UI can render a compact graph while
        still showing evidence from the original source chunks.
        """
        limit = max(1, min(int(limit or 80), 500))
        edge_limit = max(1, min(int(edge_limit or limit * 2), 1000))
        min_confidence = max(0.0, min(float(min_confidence or 0.0), 1.0))

        documents = {doc.id: doc for doc in self._read_documents()}
        chunks = {chunk.id: chunk for chunk in self._read_chunks()}
        claims = {claim.id: claim for claim in self._read_claims()}

        entities = [
            entity
            for entity in self._read_entities()
            if not doc_id or doc_id in entity.doc_ids
        ]
        entity_map = {entity.id: entity for entity in entities}

        mentions = [
            mention
            for mention in self._read_mentions()
            if mention.entity_id in entity_map and (not doc_id or mention.doc_id == doc_id)
        ]
        mention_counts: dict[str, int] = {}
        for mention in mentions:
            mention_counts[mention.entity_id] = mention_counts.get(mention.entity_id, 0) + 1

        relations = [
            relation
            for relation in self._read_relations()
            if relation.subject_entity_id in entity_map
            and relation.object_entity_id in entity_map
            and relation.confidence >= min_confidence
            and (not doc_id or relation.doc_id == doc_id)
        ]

        edge_groups: dict[tuple[str, str, str], dict[str, Any]] = {}
        node_scores: dict[str, float] = {
            entity.id: mention_counts.get(entity.id, 0) + entity.confidence
            for entity in entities
        }

        for relation in relations:
            key = (relation.subject_entity_id, relation.predicate, relation.object_entity_id)
            group = edge_groups.setdefault(
                key,
                {
                    "id": "edge_" + hashlib.sha1(":".join(key).encode()).hexdigest()[:12],
                    "source": relation.subject_entity_id,
                    "target": relation.object_entity_id,
                    "predicate": relation.predicate,
                    "count": 0,
                    "confidence": 0.0,
                    "confidence_total": 0.0,
                    "relation_ids": [],
                    "doc_ids": [],
                    "evidence": [],
                },
            )
            group["count"] += 1
            group["confidence"] = max(group["confidence"], relation.confidence)
            group["confidence_total"] += relation.confidence
            group["relation_ids"].append(relation.id)
            if relation.doc_id and relation.doc_id not in group["doc_ids"]:
                group["doc_ids"].append(relation.doc_id)
            if len(group["evidence"]) < 4:
                claim = claims.get(relation.claim_id)
                chunk = chunks.get(relation.evidence_chunk_id)
                doc = documents.get(relation.doc_id)
                evidence_text = claim.text if claim else ""
                if not evidence_text and chunk:
                    evidence_text = (chunk.context_content or chunk.content)[:240]
                group["evidence"].append({
                    "relation_id": relation.id,
                    "claim_id": relation.claim_id,
                    "chunk_id": relation.evidence_chunk_id,
                    "doc_id": relation.doc_id,
                    "doc_name": doc.name if doc else relation.doc_id,
                    "file_path": chunk.file_path if chunk else "",
                    "line_start": chunk.line_start if chunk else 0,
                    "line_end": chunk.line_end if chunk else 0,
                    "page": chunk.page if chunk else None,
                    "section_path": chunk.section_path if chunk else "",
                    "text": evidence_text,
                    "confidence": relation.confidence,
                })
            node_scores[relation.subject_entity_id] = node_scores.get(relation.subject_entity_id, 0.0) + 2.0
            node_scores[relation.object_entity_id] = node_scores.get(relation.object_entity_id, 0.0) + 2.0

        grouped_edges = sorted(
            edge_groups.values(),
            key=lambda edge: (edge["count"], edge["confidence"]),
            reverse=True,
        )[:edge_limit]

        selected_node_ids: set[str] = set()
        for edge in grouped_edges:
            selected_node_ids.add(edge["source"])
            selected_node_ids.add(edge["target"])

        if include_orphans or not selected_node_ids:
            ranked_orphans = sorted(
                entity_map,
                key=lambda entity_id: (
                    node_scores.get(entity_id, 0.0),
                    entity_map[entity_id].confidence,
                    entity_map[entity_id].name.lower(),
                ),
                reverse=True,
            )
            for entity_id in ranked_orphans:
                if len(selected_node_ids) >= limit:
                    break
                selected_node_ids.add(entity_id)

        if len(selected_node_ids) > limit:
            selected_node_ids = set(sorted(
                selected_node_ids,
                key=lambda entity_id: (
                    node_scores.get(entity_id, 0.0),
                    entity_map[entity_id].confidence,
                    entity_map[entity_id].name.lower(),
                ),
                reverse=True,
            )[:limit])
            grouped_edges = [
                edge
                for edge in grouped_edges
                if edge["source"] in selected_node_ids and edge["target"] in selected_node_ids
            ]

        degrees: dict[str, int] = {entity_id: 0 for entity_id in selected_node_ids}
        for edge in grouped_edges:
            degrees[edge["source"]] = degrees.get(edge["source"], 0) + 1
            degrees[edge["target"]] = degrees.get(edge["target"], 0) + 1
            edge["confidence_avg"] = (
                edge["confidence_total"] / edge["count"] if edge["count"] else edge["confidence"]
            )
            edge["doc_names"] = [
                documents[edge_doc_id].name
                for edge_doc_id in edge["doc_ids"]
                if edge_doc_id in documents
            ]
            edge.pop("confidence_total", None)

        nodes = []
        for entity_id in sorted(
            selected_node_ids,
            key=lambda item: (degrees.get(item, 0), node_scores.get(item, 0.0), entity_map[item].name.lower()),
            reverse=True,
        ):
            entity = entity_map[entity_id]
            nodes.append({
                "id": entity.id,
                "label": entity.name,
                "canonical_name": entity.canonical_name,
                "type": entity.type,
                "aliases": entity.aliases,
                "doc_ids": entity.doc_ids,
                "doc_names": [
                    documents[item].name
                    for item in entity.doc_ids
                    if item in documents
                ],
                "mention_count": mention_counts.get(entity.id, 0),
                "degree": degrees.get(entity.id, 0),
                "confidence": entity.confidence,
                "score": node_scores.get(entity.id, 0.0),
            })

        return {
            "object": "knowledge_graph",
            "nodes": nodes,
            "edges": grouped_edges,
            "stats": {
                "node_count": len(nodes),
                "edge_count": len(grouped_edges),
                "total_entities": len(entities),
                "total_relations": len(relations),
                "total_mentions": len(mentions),
                "doc_id": doc_id or "",
                "limit": limit,
                "edge_limit": edge_limit,
                "min_confidence": min_confidence,
                "include_orphans": include_orphans,
            },
        }

    def get_graphrag_index(
        self,
        doc_id: str | None = None,
        min_confidence: float = 0.0,
    ) -> dict[str, Any]:
        """Return GraphRAG-style knowledge model tables.

        This keeps TinyBot's JSONL storage as the source of truth, while
        exposing an entity/relationship model shaped like GraphRAG outputs:
        text units, entities, relationships, and claim covariates.
        """
        min_confidence = max(0.0, min(float(min_confidence or 0.0), 1.0))

        documents = [
            document
            for document in self._read_documents()
            if not doc_id or document.id == doc_id
        ]
        document_ids = {document.id for document in documents}

        chunks = [
            chunk
            for chunk in self._read_chunks()
            if chunk.chunk_type == "parent"
            and (not doc_id or chunk.doc_id == doc_id)
        ]
        chunk_ids = {chunk.id for chunk in chunks}

        entities = [
            entity
            for entity in self._read_entities()
            if (not doc_id or doc_id in entity.doc_ids)
            and entity.confidence >= min_confidence
        ]
        entity_map = {entity.id: entity for entity in entities}

        mentions = [
            mention
            for mention in self._read_mentions()
            if mention.chunk_id in chunk_ids and mention.entity_id in entity_map
        ]
        claims = [
            claim
            for claim in self._read_claims()
            if claim.chunk_id in chunk_ids and claim.confidence >= min_confidence
        ]
        relations = [
            relation
            for relation in self._read_relations()
            if relation.evidence_chunk_id in chunk_ids
            and relation.subject_entity_id in entity_map
            and relation.object_entity_id in entity_map
            and relation.confidence >= min_confidence
        ]

        entity_text_units: dict[str, set[str]] = {entity.id: set() for entity in entities}
        entity_claims: dict[str, list[str]] = {entity.id: [] for entity in entities}
        entity_degrees: dict[str, int] = {entity.id: 0 for entity in entities}
        relationship_ids_by_chunk: dict[str, list[str]] = {}
        covariate_ids_by_chunk: dict[str, list[str]] = {}
        entity_ids_by_chunk: dict[str, set[str]] = {chunk.id: set() for chunk in chunks}

        for mention in mentions:
            entity_text_units.setdefault(mention.entity_id, set()).add(mention.chunk_id)
            entity_ids_by_chunk.setdefault(mention.chunk_id, set()).add(mention.entity_id)

        for claim in claims:
            covariate_ids_by_chunk.setdefault(claim.chunk_id, []).append(claim.id)
            for entity_id in claim.entity_ids:
                if entity_id in entity_map:
                    entity_text_units.setdefault(entity_id, set()).add(claim.chunk_id)
                    entity_ids_by_chunk.setdefault(claim.chunk_id, set()).add(entity_id)
                    if claim.text and claim.text not in entity_claims.setdefault(entity_id, []):
                        entity_claims[entity_id].append(claim.text)

        relationship_groups: dict[tuple[str, str, str], dict[str, Any]] = {}
        claims_by_id = {claim.id: claim for claim in claims}
        chunks_by_id = {chunk.id: chunk for chunk in chunks}

        for relation in relations:
            key = (relation.subject_entity_id, relation.predicate, relation.object_entity_id)
            source = entity_map[relation.subject_entity_id]
            target = entity_map[relation.object_entity_id]
            relationship_id = self._graphrag_relationship_id(*key)
            group = relationship_groups.setdefault(
                key,
                {
                    "id": relationship_id,
                    "source": source.name,
                    "target": target.name,
                    "predicate": relation.predicate,
                    "description_parts": [],
                    "weight": 0.0,
                    "text_unit_ids": set(),
                    "relation_ids": [],
                    "confidence": 0.0,
                },
            )
            evidence = self._relation_evidence_text(relation, claims_by_id, chunks_by_id)
            if evidence and evidence not in group["description_parts"]:
                group["description_parts"].append(evidence)
            group["weight"] += relation.confidence or 1.0
            group["confidence"] = max(group["confidence"], relation.confidence)
            group["text_unit_ids"].add(relation.evidence_chunk_id)
            group["relation_ids"].append(relation.id)
            relationship_ids_by_chunk.setdefault(relation.evidence_chunk_id, []).append(relationship_id)
            entity_text_units.setdefault(relation.subject_entity_id, set()).add(relation.evidence_chunk_id)
            entity_text_units.setdefault(relation.object_entity_id, set()).add(relation.evidence_chunk_id)
            entity_ids_by_chunk.setdefault(relation.evidence_chunk_id, set()).update(
                [relation.subject_entity_id, relation.object_entity_id]
            )

        for source_id, _predicate, target_id in relationship_groups:
            entity_degrees[source_id] = entity_degrees.get(source_id, 0) + 1
            entity_degrees[target_id] = entity_degrees.get(target_id, 0) + 1

        relationship_rows = []
        for (source_id, _predicate, target_id), group in sorted(
            relationship_groups.items(),
            key=lambda item: (item[1]["weight"], item[1]["confidence"]),
            reverse=True,
        ):
            description = self._summarize_graph_texts(group["description_parts"])
            relationship_rows.append({
                "id": group["id"],
                "source": group["source"],
                "target": group["target"],
                "predicate": group["predicate"],
                "description": description,
                "weight": round(float(group["weight"]), 6),
                "combined_degree": entity_degrees.get(source_id, 0) + entity_degrees.get(target_id, 0),
                "text_unit_ids": sorted(group["text_unit_ids"]),
                "relation_ids": group["relation_ids"],
                "confidence": group["confidence"],
            })

        entity_rows = []
        for entity in sorted(
            entities,
            key=lambda item: (
                len(entity_text_units.get(item.id, set())),
                entity_degrees.get(item.id, 0),
                item.confidence,
                item.name.lower(),
            ),
            reverse=True,
        ):
            text_unit_ids = sorted(entity_text_units.get(entity.id, set()))
            entity_rows.append({
                "id": entity.id,
                "title": entity.name,
                "type": entity.type,
                "description": self._entity_description(entity, entity_claims.get(entity.id, [])),
                "text_unit_ids": text_unit_ids,
                "frequency": len(text_unit_ids),
                "degree": entity_degrees.get(entity.id, 0),
                "aliases": entity.aliases,
                "doc_ids": [item for item in entity.doc_ids if item in document_ids],
                "confidence": entity.confidence,
            })

        document_rows = []
        chunks_by_doc: dict[str, list[str]] = {}
        for chunk in chunks:
            chunks_by_doc.setdefault(chunk.doc_id, []).append(chunk.id)
        for document in documents:
            document_rows.append({
                "id": document.id,
                "title": document.name,
                "text": document.content,
                "text_unit_ids": chunks_by_doc.get(document.id, []),
                "metadata": document.metadata,
                "source": document.source,
                "file_type": document.file_type,
            })

        covariate_rows = []
        for claim in claims:
            subject_id, object_id = self._claim_subject_object_ids(claim, entity_map)
            covariate_rows.append({
                "id": claim.id,
                "covariate_type": "claim",
                "type": "fact",
                "description": claim.text,
                "subject_id": subject_id,
                "object_id": object_id,
                "status": "TRUE",
                "start_date": "",
                "end_date": "",
                "source_text": claim.text,
                "text_unit_id": claim.chunk_id,
                "confidence": claim.confidence,
            })

        text_unit_rows = []
        for chunk in chunks:
            text_unit_rows.append({
                "id": chunk.id,
                "text": chunk.context_content or chunk.content,
                "n_tokens": len(_tokenize(chunk.context_content or chunk.content)),
                "document_id": chunk.doc_id,
                "entity_ids": sorted(entity_ids_by_chunk.get(chunk.id, set())),
                "relationship_ids": sorted(set(relationship_ids_by_chunk.get(chunk.id, []))),
                "covariate_ids": sorted(set(covariate_ids_by_chunk.get(chunk.id, []))),
                "section_path": chunk.section_path,
                "line_start": chunk.line_start,
                "line_end": chunk.line_end,
                "page": chunk.page,
            })

        return {
            "object": "graphrag_index",
            "documents": document_rows,
            "text_units": text_unit_rows,
            "entities": entity_rows,
            "relationships": relationship_rows,
            "covariates": covariate_rows,
            "communities": [],
            "community_reports": [],
            "stats": {
                "document_count": len(document_rows),
                "text_unit_count": len(text_unit_rows),
                "entity_count": len(entity_rows),
                "relationship_count": len(relationship_rows),
                "covariate_count": len(covariate_rows),
                "doc_id": doc_id or "",
                "min_confidence": min_confidence,
            },
        }

    @staticmethod
    def _graphrag_relationship_id(source_id: str, predicate: str, target_id: str) -> str:
        value = f"{source_id}:{predicate}:{target_id}"
        return f"grel_{hashlib.sha1(value.encode()).hexdigest()[:12]}"

    @staticmethod
    def _summarize_graph_texts(texts: list[str], limit: int = 420) -> str:
        seen: set[str] = set()
        parts: list[str] = []
        for text in texts:
            clean = re.sub(r"\s+", " ", text).strip()
            if not clean or clean in seen:
                continue
            parts.append(clean)
            seen.add(clean)
            if sum(len(part) for part in parts) >= limit:
                break
        summary = " ".join(parts).strip()
        return summary[:limit].rstrip()

    def _entity_description(self, entity: KnowledgeEntity, claims: list[str]) -> str:
        if claims:
            return self._summarize_graph_texts(claims)
        if entity.aliases:
            aliases = [alias for alias in entity.aliases if alias != entity.name]
            if aliases:
                return f"{entity.name} ({entity.type}); aliases: {', '.join(aliases[:5])}."
        return f"{entity.name} ({entity.type})."

    @staticmethod
    def _relation_evidence_text(
        relation: KnowledgeRelation,
        claims_by_id: dict[str, KnowledgeClaim],
        chunks_by_id: dict[str, KnowledgeChunk],
    ) -> str:
        claim = claims_by_id.get(relation.claim_id)
        if claim and claim.text:
            return claim.text
        chunk = chunks_by_id.get(relation.evidence_chunk_id)
        if chunk:
            return (chunk.context_content or chunk.content)[:360]
        return ""

    @staticmethod
    def _claim_subject_object_ids(
        claim: KnowledgeClaim,
        entity_map: dict[str, KnowledgeEntity],
    ) -> tuple[str, str]:
        entity_ids = [entity_id for entity_id in claim.entity_ids if entity_id in entity_map]
        subject_id = entity_map[entity_ids[0]].name if entity_ids else ""
        object_id = entity_map[entity_ids[1]].name if len(entity_ids) > 1 else ""
        return subject_id, object_id

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
            if chunk.chunk_type != "child":
                continue
            chunk_id = chunk.id
            content = chunk.retrieval_text or chunk.context_content or chunk.content
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

    def rebuild_semantic_index(self) -> dict[str, Any]:
        """Rebuild semantic side indexes from existing chunks."""
        self._write_entities([])
        self._write_mentions([])
        self._write_claims([])
        self._write_relations([])

        documents = {doc.id: doc for doc in self._read_documents()}
        chunks_by_doc: dict[str, list[dict[str, Any]]] = {}
        for chunk in self._read_chunks():
            if chunk.chunk_type != "parent":
                continue
            chunks_by_doc.setdefault(chunk.doc_id, []).append({
                "index": chunk.chunk_index,
                "content": chunk.semantic_text or chunk.context_content or chunk.content,
                "section_path": chunk.section_path,
                "start_char": chunk.start_char,
            })

        for doc_id, chunks in chunks_by_doc.items():
            doc = documents.get(doc_id)
            doc_name = doc.name if doc else doc_id
            ts = doc.created_at if doc else datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            self._index_chunks_semantic(doc_id, doc_name, chunks, ts)

        return {
            "entities": len(self._read_entities()),
            "claims": len(self._read_claims()),
            "relations": len(self._read_relations()),
            "mentions": len(self._read_mentions()),
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
                "chunk_type": "parent",
            }]

        if self._is_markdown(file_type, text):
            chunks = self._chunk_markdown_blocks(text, chunk_size, chunk_overlap, get_line_number)
            if chunks:
                return chunks

        paragraph_chunks = self._chunk_plain_text_blocks(text, chunk_size, get_line_number)
        if paragraph_chunks:
            return paragraph_chunks

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
                    "chunk_type": "parent",
                })
                index += 1

            start = end

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

    def _apply_chunk_text_views(
        self,
        chunks: list[dict[str, Any]],
        file_type: str,
    ) -> list[dict[str, Any]]:
        """Attach normalized text views used by retrieval, semantics, and context."""
        out: list[dict[str, Any]] = []
        for chunk in chunks:
            enriched = dict(chunk)
            raw = enriched.get("content", "")
            section_path = enriched.get("section_path", "")
            block_type = enriched.get("block_type", "text")
            if self._is_markdown(file_type, raw) or block_type in {"markdown", "code"}:
                views = self._preprocess_markdown_chunk(raw, section_path, block_type)
            elif file_type.lower() == "pdf" or block_type == "pdf_text":
                context = self._normalize_pdf_text(raw)
                retrieval = self._normalize_retrieval_text(context)
                views = {
                    "retrieval_text": retrieval,
                    "semantic_text": context,
                    "context_content": context,
                }
            else:
                context = self._normalize_plain_text(raw)
                views = {
                    "retrieval_text": self._normalize_retrieval_text(context),
                    "semantic_text": context,
                    "context_content": context,
                }
            enriched.update(views)
            out.append(enriched)
        return out

    def _preprocess_markdown_chunk(
        self,
        text: str,
        section_path: str = "",
        block_type: str = "markdown",
    ) -> dict[str, str]:
        text = self._strip_markdown_frontmatter(text)
        if block_type == "code":
            code_text = self._strip_code_fences(text)
            retrieval = self._normalize_code_for_retrieval(code_text)
            context = code_text.strip()
            semantic = f"Section: {section_path}\nCode identifiers: {retrieval}" if section_path else f"Code identifiers: {retrieval}"
            return {
                "retrieval_text": retrieval,
                "semantic_text": semantic.strip(),
                "context_content": context,
            }

        without_code = re.sub(
            r"(?s)(```|~~~).*?\1",
            lambda match: self._normalize_code_for_retrieval(self._strip_code_fences(match.group(0))),
            text,
        )
        retrieval = self._markdown_to_plain_text(without_code, include_urls=False)
        retrieval = self._normalize_retrieval_text(retrieval)
        context = self._markdown_to_plain_text(text, include_urls=True)
        context = self._normalize_plain_text(context)
        semantic = f"Section: {section_path}\n{context}" if section_path else context
        return {
            "retrieval_text": retrieval,
            "semantic_text": semantic.strip(),
            "context_content": context,
        }

    @staticmethod
    def _strip_markdown_frontmatter(text: str) -> str:
        return re.sub(r"\A---\s*\n.*?\n---\s*\n", "", text, flags=re.DOTALL)

    @staticmethod
    def _strip_code_fences(text: str) -> str:
        lines = text.strip().splitlines()
        if lines and lines[0].strip().startswith(("```", "~~~")):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith(("```", "~~~")):
            lines = lines[:-1]
        return "\n".join(lines)

    def _markdown_to_plain_text(self, text: str, include_urls: bool = False) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(
            r"(?s)(```|~~~).*?\1",
            lambda match: self._strip_code_fences(match.group(0)),
            text,
        )
        text = re.sub(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", r"\1", text)
        text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
        if include_urls:
            text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 \2", text)
        else:
            text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        text = re.sub(r"`([^`]+)`", r"\1", text)
        text = text.replace("**", "").replace("__", "")
        text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
        text = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"\1", text)
        text = re.sub(r"(?m)^\s{0,3}>\s?", "", text)
        text = re.sub(r"(?m)^\s*[-*+]\s+\[[ xX]\]\s+", "", text)
        text = re.sub(r"(?m)^\s*[-*+]\s+", "", text)
        text = re.sub(r"(?m)^\s*\d+[.)]\s+", "", text)
        text = re.sub(r"(?m)^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$", "", text)
        text = self._markdown_tables_to_rows(text)
        return text

    @staticmethod
    def _markdown_tables_to_rows(text: str) -> str:
        lines = text.splitlines()
        out: list[str] = []
        for line in lines:
            stripped = line.strip()
            if "|" not in stripped:
                out.append(line)
                continue
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            cells = [cell for cell in cells if cell]
            if cells:
                out.append("; ".join(cells))
        return "\n".join(out)

    @staticmethod
    def _normalize_code_for_retrieval(text: str) -> str:
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_./:-]*|\d+(?:\.\d+)?", text)
        return " ".join(tokens)

    @staticmethod
    def _normalize_plain_text(text: str) -> str:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    @staticmethod
    def _normalize_retrieval_text(text: str) -> str:
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", text)
        text = re.sub(r"[ \t\r\n]+", " ", text)
        return text.strip()

    def _ensure_chunk_text_views(self, chunk: KnowledgeChunk) -> KnowledgeChunk:
        if chunk.retrieval_text and chunk.semantic_text and chunk.context_content:
            return chunk
        if chunk.block_type == "pdf_text":
            file_type = "pdf"
        elif chunk.block_type in {"markdown", "code"}:
            file_type = "md"
        else:
            file_type = "txt"
        enriched = self._apply_chunk_text_views([asdict(chunk)], file_type)[0]
        chunk.retrieval_text = enriched.get("retrieval_text", "")
        chunk.semantic_text = enriched.get("semantic_text", "")
        chunk.context_content = enriched.get("context_content", "")
        return chunk

    def _chunk_plain_text_blocks(
        self,
        text: str,
        chunk_size: int,
        get_line_number: Any,
    ) -> list[dict[str, Any]]:
        """Chunk plain text by paragraph boundaries without parent overlap."""
        blocks: list[dict[str, Any]] = []
        for match in re.finditer(r"\S(?:.*?)(?=\n\s*\n|\Z)", text, flags=re.DOTALL):
            start = match.start()
            end = match.end()
            while end > start and text[end - 1].isspace():
                end -= 1
            if start < end:
                blocks.append({"start": start, "end": end})
        if not blocks:
            return []

        chunks: list[dict[str, Any]] = []
        current: list[dict[str, Any]] = []
        current_len = 0

        def append_chunk(start: int, end: int) -> None:
            content = text[start:end].strip()
            if not content:
                return
            chunks.append({
                "content": content,
                "index": len(chunks),
                "start_char": start,
                "end_char": end,
                "line_start": get_line_number(start),
                "line_end": get_line_number(end),
                "section_path": "",
                "block_type": "text",
                "chunk_type": "parent",
            })

        def emit_current() -> None:
            nonlocal current, current_len
            if not current:
                return
            append_chunk(current[0]["start"], current[-1]["end"])
            current = []
            current_len = 0

        for block in blocks:
            block_len = block["end"] - block["start"]
            if block_len > chunk_size:
                emit_current()
                for piece in self._split_large_plain_block(text, block, chunk_size):
                    append_chunk(piece["start"], piece["end"])
                continue

            if current and current_len >= chunk_size:
                emit_current()

            current.append(block)
            current_len += block_len
            if current_len >= chunk_size:
                emit_current()

        emit_current()
        return chunks

    def _split_large_plain_block(
        self,
        text: str,
        block: dict[str, int],
        chunk_size: int,
    ) -> list[dict[str, int]]:
        local = text[block["start"]:block["end"]]
        units = self._sentence_units(local)
        if not units:
            return [block]

        pieces: list[dict[str, int]] = []
        current: list[dict[str, Any]] = []
        current_len = 0

        def emit() -> None:
            nonlocal current, current_len
            if not current:
                return
            pieces.append({
                "start": block["start"] + current[0]["start"],
                "end": block["start"] + current[-1]["end"],
            })
            current = []
            current_len = 0

        for unit in units:
            unit_len = unit["end"] - unit["start"]
            if current and current_len >= chunk_size:
                emit()
            current.append(unit)
            current_len += unit_len
            if current_len >= chunk_size:
                emit()
        emit()
        return pieces

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
                    "chunk_type": "parent",
                })
            keep: list[dict[str, Any]] = []
            kept_len = 0
            if chunk_overlap > 0:
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
                        "chunk_type": "parent",
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
                    "chunk_type": "parent",
                })
            next_start = end - chunk_overlap
            start = end if chunk_overlap <= 0 or next_start <= start else next_start
        return chunks

    def _build_child_chunks(self, parent_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Split parent chunks into smaller retrieval chunks.

        Parent chunks are the units injected into context. Child chunks are the
        units indexed by dense embeddings and BM25 so retrieval stays precise.
        """
        if not parent_chunks:
            return []

        child_size = self.config.child_chunk_size if self.config else 120
        child_overlap = self.config.child_chunk_overlap if self.config else 20
        child_size = max(1, child_size)
        child_overlap = max(0, min(child_overlap, max(0, child_size - 1)))

        next_index = len(parent_chunks)
        children: list[dict[str, Any]] = []
        for parent in parent_chunks:
            content = parent.get("content", "")
            if not content:
                continue

            units = self._sentence_units(content)
            if not units:
                units = [{"text": content, "start": 0, "end": len(content)}]

            current: list[dict[str, Any]] = []
            current_len = 0
            child_index = 0

            def emit_current() -> None:
                nonlocal current, current_len, next_index, child_index
                if not current:
                    return
                start = current[0]["start"]
                end = current[-1]["end"]
                child_content = content[start:end].strip()
                if child_content:
                    children.append({
                        "content": child_content,
                        "index": next_index,
                        "parent_index": parent["index"],
                        "child_index": child_index,
                        "chunk_type": "child",
                        "summary": parent.get("summary", ""),
                        "start_char": parent["start_char"] + start,
                        "end_char": parent["start_char"] + end,
                        "line_start": parent.get("line_start", 1),
                        "line_end": parent.get("line_end", 1),
                        "page": parent.get("page"),
                        "section_path": parent.get("section_path", ""),
                        "block_type": parent.get("block_type", "text"),
                    })
                    next_index += 1
                    child_index += 1

                keep: list[dict[str, Any]] = []
                kept_len = 0
                if not (len(current) == 1 and current[0]["end"] - current[0]["start"] >= child_size):
                    for unit in reversed(current):
                        unit_len = unit["end"] - unit["start"]
                        if kept_len and kept_len + unit_len > child_overlap:
                            break
                        if unit_len > child_overlap and keep:
                            break
                        keep.insert(0, unit)
                        kept_len += unit_len
                        if kept_len >= child_overlap:
                            break
                current = keep
                current_len = kept_len

            for unit in units:
                unit_len = unit["end"] - unit["start"]
                if current and current_len + unit_len > child_size:
                    emit_current()
                current.append(unit)
                current_len += unit_len
                if unit_len >= child_size and len(current) == 1:
                    emit_current()

            emit_current()

        logger.debug(
            "KnowledgeStore: built {} child chunks from {} parent chunks",
            len(children),
            len(parent_chunks),
        )
        return children

    @staticmethod
    def _sentence_units(text: str) -> list[dict[str, Any]]:
        """Return sentence-like units with local character offsets."""
        units: list[dict[str, Any]] = []
        start = 0
        for match in re.finditer(r"[^.!?\n。！？；;]+(?:[.!?。！？；;]+|\n+|$)", text):
            raw = match.group(0)
            if not raw.strip():
                continue
            unit_start = match.start()
            unit_end = match.end()
            while unit_start < unit_end and text[unit_start].isspace():
                unit_start += 1
            while unit_end > unit_start and text[unit_end - 1].isspace():
                unit_end -= 1
            if unit_start < unit_end:
                units.append({
                    "text": text[unit_start:unit_end],
                    "start": unit_start,
                    "end": unit_end,
                })
            start = match.end()
        if start < len(text) and text[start:].strip():
            units.append({"text": text[start:].strip(), "start": start, "end": len(text)})
        return units

    def _extract_semantic_units(
        self,
        content: str,
        section_path: str,
        doc_name: str,
    ) -> dict[str, list[dict[str, Any]]]:
        mode = (self.config.semantic_extraction_mode if self.config else "rule").lower()
        if mode not in {"rule", "llm", "hybrid"}:
            mode = "rule"

        rule_units = self._extract_semantic_units_rule(content, section_path, doc_name)
        if mode == "rule":
            return self._validate_semantic_units(rule_units, content)

        llm_units = self._extract_semantic_units_llm(content, section_path, doc_name)
        if mode == "llm":
            return self._validate_semantic_units(llm_units or rule_units, content)

        merged = self._merge_semantic_units(rule_units, llm_units or {})
        return self._validate_semantic_units(merged, content)

    def _extract_semantic_units_rule(
        self,
        content: str,
        section_path: str,
        doc_name: str,
    ) -> dict[str, list[dict[str, Any]]]:
        entity_names = self._extract_entity_names(content)
        entity_names.extend(self._extract_structural_entity_names(section_path))
        entity_names.extend(self._extract_structural_entity_names(doc_name))

        claims = []
        relations = []
        for claim_text in self._extract_claims(content):
            claim_entity_names = self._extract_entity_names(claim_text)
            claims.append({
                "text": claim_text,
                "entity_names": claim_entity_names,
                "confidence": 0.5 + min(len(claim_entity_names), 4) * 0.05,
            })
            for raw_relation in self._extract_relations(claim_text):
                raw_relation["evidence"] = claim_text
                raw_relation["confidence"] = 0.65
                relations.append(raw_relation)

        return {
            "entities": [
                {
                    "name": name,
                    "type": self._infer_entity_type(name),
                    "aliases": [],
                    "confidence": 0.55,
                }
                for name in entity_names
            ],
            "claims": claims,
            "relations": relations,
        }

    def _extract_semantic_units_llm(
        self,
        content: str,
        section_path: str,
        doc_name: str,
    ) -> dict[str, list[dict[str, Any]]] | None:
        if not self.config_ref:
            logger.debug("KnowledgeStore: semantic LLM extraction skipped; no config_ref")
            return None

        agent_defaults = self.config_ref.agents.defaults
        model = agent_defaults.model
        provider_config = self.config_ref.get_provider(model)
        if not provider_config or not provider_config.api_key:
            logger.debug("KnowledgeStore: semantic LLM extraction skipped; no provider API key")
            return None

        try:
            import httpx
        except ImportError:
            logger.warning("KnowledgeStore: httpx not available for semantic LLM extraction")
            return None

        api_base = provider_config.api_base or self.config_ref.get_api_base(model) or "https://api.openai.com/v1"
        headers = {
            "Authorization": f"Bearer {provider_config.api_key}",
            "Content-Type": "application/json",
        }
        extra_headers = getattr(provider_config, "extra_headers", None)
        if extra_headers:
            headers.update(extra_headers)

        prompt = self._build_semantic_extraction_prompt(content, section_path, doc_name)
        try:
            with httpx.Client(timeout=self.config.semantic_llm_timeout if self.config else 30.0) as client:
                response = client.post(
                    f"{api_base}/chat/completions",
                    headers=headers,
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": self.config.semantic_llm_max_tokens if self.config else 1200,
                        "temperature": 0.1,
                        "response_format": {"type": "json_object"},
                    },
                )
                response.raise_for_status()
                result = response.json()
        except Exception as e:
            logger.warning("KnowledgeStore: semantic LLM extraction failed: {}", e)
            return None

        raw_content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        parsed = self._parse_json_object(raw_content)
        if not parsed:
            return None
        raw_entities = parsed.get("entities", parsed.get("e", []))
        raw_claims = parsed.get("claims", [])
        raw_relations = parsed.get("relations", parsed.get("r", []))
        return {
            "entities": raw_entities if isinstance(raw_entities, list) else [],
            "claims": raw_claims if isinstance(raw_claims, list) else [],
            "relations": raw_relations if isinstance(raw_relations, list) else [],
        }

    @staticmethod
    def _build_semantic_extraction_prompt(content: str, section_path: str, doc_name: str) -> str:
        return f"""You are a strict knowledge graph extraction engine.
Extract only KG-worthy entities and typed relations from the chunk.
Return compact JSON only: {{"e":[...],"r":[...]}}.

Rules:
- Entity types: person, organization, product, module, api, file, protocol, algorithm, technology, concept, business_object.
- Entities must be reusable named objects, terms, products, technologies, algorithms, modules, files, organizations, people, or business objects.
- Do not turn full sentences, marketing copy, feature descriptions, or verb phrases into entities.
- Do not extract greetings, filler words, narration, first-person phrases, teaching transitions, or casual commentary as entities.
- Bad entities: "大家好", "阿巴阿巴", "也就", "现在的大模型不", "而且用得比以前更多了", "我会一次性给大家讲清楚", "我们常说的幻觉", "这个问题".
- Good entities: "RAG", "GraphRAG", "BM25", "向量数据库", "知识图谱", "Self-RAG".
- Every relation must use one predicate from:
  is_a, part_of, contains, depends_on, requires, supports, used_for, causes, precedes, owned_by, located_in, similar_to, contradicts, defined_as.
- subject and object must be entity names.
- evidence must be a short exact excerpt from the chunk.
- Only output a relation when both endpoints are explicit entities in the evidence.
- Prefer fewer high-quality entities over many weak entities.
- Do not output claims; claims will be derived from relation evidence locally.

JSON schema:
{{
  "e": [
    {{"n": "RAG", "t": "technology", "a": ["Retrieval-Augmented Generation"], "c": 0.9}}
  ],
  "r": [
    {{"s": "RAG", "p": "depends_on", "o": "embeddings", "e": "RAG depends on embeddings.", "c": 0.85}}
  ]
}}

Document: {doc_name}
Section: {section_path}
Chunk:
{content[:4000]}
"""

    @staticmethod
    def _parse_json_object(text: str) -> dict[str, Any] | None:
        if not text:
            return None
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            try:
                from json_repair import repair_json

                data = json.loads(repair_json(text))
            except Exception:
                match = re.search(r"\{.*\}", text, flags=re.DOTALL)
                if not match:
                    return None
                try:
                    data = json.loads(match.group(0))
                except json.JSONDecodeError:
                    return None
        return data if isinstance(data, dict) else None

    def _merge_semantic_units(
        self,
        first: dict[str, list[dict[str, Any]]],
        second: dict[str, list[dict[str, Any]]],
    ) -> dict[str, list[dict[str, Any]]]:
        merged = {"entities": [], "claims": [], "relations": []}
        for key in merged:
            seen: set[str] = set()
            for source in (first, second):
                for item in source.get(key, []):
                    marker = json.dumps(item, sort_keys=True, ensure_ascii=False)
                    if marker in seen:
                        continue
                    merged[key].append(item)
                    seen.add(marker)
        return merged

    def _validate_semantic_units(
        self,
        units: dict[str, list[dict[str, Any]]],
        content: str,
    ) -> dict[str, list[dict[str, Any]]]:
        normalized_content = re.sub(r"\s+", " ", content).strip()
        entities: list[dict[str, Any]] = []
        entity_names: set[str] = set()
        for raw in units.get("entities", []):
            if isinstance(raw, str):
                raw = {"name": raw}
            if not isinstance(raw, dict):
                continue
            name = self._clean_entity_name(str(raw.get("name", raw.get("n", ""))))
            if not name:
                continue
            key = self._normalize_entity_name(name)
            if key in entity_names:
                continue
            raw_aliases = raw.get("aliases", raw.get("a", []))
            if not isinstance(raw_aliases, list):
                raw_aliases = []
            aliases = [
                alias
                for alias in (self._clean_entity_name(str(alias)) for alias in raw_aliases)
                if alias
            ]
            confidence = self._coerce_confidence(raw.get("confidence", raw.get("c")), 0.55)
            if confidence < 0.35:
                continue
            if not self._is_meaningful_entity_name(name):
                continue
            if not self._entity_has_text_evidence(name, aliases, normalized_content):
                continue
            entities.append({
                "name": name,
                "type": self._normalize_entity_type(str(raw.get("type", raw.get("t", "")))) or self._infer_entity_type(name),
                "aliases": aliases,
                "confidence": confidence,
            })
            entity_names.add(key)

        claims: list[dict[str, Any]] = []
        for raw in units.get("claims", []):
            if isinstance(raw, str):
                raw = {"text": raw}
            if not isinstance(raw, dict):
                continue
            text = re.sub(r"\s+", " ", str(raw.get("text", "")).strip())
            if not 12 <= len(text) <= 360:
                continue
            raw_entity_names = raw.get("entity_names", [])
            if not isinstance(raw_entity_names, list):
                raw_entity_names = []
            claim_entities = [
                name
                for name in (self._clean_entity_name(str(name)) for name in raw_entity_names)
                if (
                    name
                    and self._is_meaningful_entity_name(name)
                    and self._entity_has_text_evidence(name, [], text)
                )
            ]
            if not claim_entities:
                claim_entities = [
                    name
                    for name in self._extract_entity_names(text)
                    if self._is_meaningful_entity_name(name)
                ]
            claims.append({
                "text": text,
                "entity_names": claim_entities,
                "confidence": self._coerce_confidence(raw.get("confidence", raw.get("c")), 0.5),
            })

        relations: list[dict[str, Any]] = []
        content_for_evidence = re.sub(r"\s+", " ", content)
        for raw in units.get("relations", []):
            if not isinstance(raw, dict):
                continue
            subject = self._clean_entity_name(str(raw.get("subject", raw.get("s", ""))))
            obj = self._clean_entity_name(str(raw.get("object", raw.get("o", ""))))
            predicate = self._normalize_predicate(str(raw.get("predicate", raw.get("p", ""))))
            evidence = re.sub(r"\s+", " ", str(raw.get("evidence", raw.get("e", ""))).strip())
            if not subject or not obj or not predicate or subject == obj:
                continue
            if not self._is_meaningful_entity_name(subject) or not self._is_meaningful_entity_name(obj):
                continue
            if not self._relation_matches_ontology(subject, predicate, obj):
                continue
            if evidence and evidence not in content_for_evidence:
                continue
            evidence_scope = evidence or normalized_content
            if not self._entity_has_text_evidence(subject, [], evidence_scope):
                continue
            if not self._entity_has_text_evidence(obj, [], evidence_scope):
                continue
            relations.append({
                "subject": subject,
                "predicate": predicate,
                "object": obj,
                "evidence": evidence,
                "confidence": self._coerce_confidence(raw.get("confidence", raw.get("c")), 0.65),
            })

        seen_claim_text = {claim["text"] for claim in claims}
        for relation in relations:
            evidence = relation.get("evidence", "")
            if not evidence or evidence in seen_claim_text:
                continue
            claims.append({
                "text": evidence,
                "entity_names": [relation["subject"], relation["object"]],
                "confidence": relation.get("confidence", 0.65),
            })
            seen_claim_text.add(evidence)

        return {"entities": entities, "claims": claims, "relations": relations}

    def _index_chunks_semantic(
        self,
        doc_id: str,
        doc_name: str,
        chunks: list[dict[str, Any]],
        ts: str,
    ) -> None:
        """Build claim, entity, mention, and relation indexes for chunks.

        This is a deterministic first pass. LLM extraction can be added later
        without changing the storage contract.
        """
        try:
            existing_entities = {entity.id: entity for entity in self._read_entities()}
            existing_claim_ids = {claim.id for claim in self._read_claims()}
            existing_relation_ids = {relation.id for relation in self._read_relations()}
            existing_mention_ids = {mention.id for mention in self._read_mentions()}

            new_claims: list[KnowledgeClaim] = []
            new_relations: list[KnowledgeRelation] = []
            new_mentions: list[KnowledgeMention] = []

            def ensure_entity(
                name: str,
                source_doc_id: str,
                confidence: float = 0.5,
                entity_type: str | None = None,
                aliases: list[str] | None = None,
            ) -> KnowledgeEntity | None:
                clean_name = self._clean_entity_name(name)
                if not clean_name:
                    return None
                canonical = self._normalize_entity_name(clean_name)
                entity_id = self._entity_id(canonical)
                clean_aliases = [
                    alias
                    for alias in (self._clean_entity_name(alias) for alias in (aliases or []))
                    if alias and alias != clean_name
                ][:8]
                entity = existing_entities.get(entity_id)
                if entity is None:
                    entity = KnowledgeEntity(
                        id=entity_id,
                        name=clean_name,
                        canonical_name=canonical,
                        type=entity_type or self._infer_entity_type(clean_name),
                        aliases=[clean_name, *clean_aliases],
                        doc_ids=[source_doc_id],
                        created_at=ts,
                        confidence=confidence,
                    )
                    existing_entities[entity_id] = entity
                else:
                    for alias in [clean_name, *clean_aliases]:
                        if alias not in entity.aliases:
                            entity.aliases.append(alias)
                    if source_doc_id not in entity.doc_ids:
                        entity.doc_ids.append(source_doc_id)
                    entity.confidence = max(entity.confidence, confidence)
                return entity

            for chunk in chunks:
                chunk_id = f"chunk_{doc_id}_{chunk['index']}"
                content = chunk.get("semantic_text") or chunk.get("context_content") or chunk.get("content", "")
                section_path = chunk.get("section_path", "")
                semantic_units = self._extract_semantic_units(content, section_path, doc_name)

                for entity_spec in semantic_units["entities"]:
                    mention_text = ""
                    local_start = -1
                    for candidate in [entity_spec["name"], *entity_spec.get("aliases", [])]:
                        candidate = self._clean_entity_name(str(candidate))
                        if not candidate:
                            continue
                        local_start = content.find(candidate)
                        if local_start >= 0:
                            mention_text = candidate
                            break
                    if local_start < 0:
                        continue
                    entity = ensure_entity(
                        entity_spec["name"],
                        doc_id,
                        confidence=entity_spec.get("confidence", 0.55),
                        entity_type=entity_spec.get("type"),
                        aliases=entity_spec.get("aliases", []),
                    )
                    if entity:
                        mention_id = self._mention_id(entity.id, chunk_id, local_start)
                        if mention_id not in existing_mention_ids:
                            start_char = chunk.get("start_char", 0) + local_start
                            end_char = start_char + len(mention_text)
                            new_mentions.append(KnowledgeMention(
                                id=mention_id,
                                entity_id=entity.id,
                                chunk_id=chunk_id,
                                doc_id=doc_id,
                                text=mention_text,
                                start_char=start_char,
                                end_char=end_char,
                                confidence=entity.confidence,
                            ))
                            existing_mention_ids.add(mention_id)

                for claim_index, claim_spec in enumerate(semantic_units["claims"]):
                    claim_text = claim_spec["text"]
                    claim_entity_ids: list[str] = []
                    for entity_name in claim_spec.get("entity_names", []):
                        entity = ensure_entity(entity_name, doc_id, confidence=0.55)
                        if entity and entity.id not in claim_entity_ids:
                            claim_entity_ids.append(entity.id)

                    claim_id = self._claim_id(chunk_id, claim_index, claim_text)
                    if claim_id not in existing_claim_ids:
                        new_claims.append(KnowledgeClaim(
                            id=claim_id,
                            chunk_id=chunk_id,
                            doc_id=doc_id,
                            text=claim_text,
                            entity_ids=claim_entity_ids,
                            confidence=claim_spec.get("confidence", 0.5 + min(len(claim_entity_ids), 4) * 0.05),
                            created_at=ts,
                        ))
                        existing_claim_ids.add(claim_id)

                for raw_relation in semantic_units["relations"]:
                    subject = ensure_entity(raw_relation["subject"], doc_id, confidence=0.6)
                    obj = ensure_entity(raw_relation["object"], doc_id, confidence=0.6)
                    if not subject or not obj or subject.id == obj.id:
                        continue
                    predicate = self._normalize_predicate(raw_relation["predicate"])
                    if not predicate:
                        continue
                    relation_claim_id = ""
                    evidence = raw_relation.get("evidence", "")
                    for claim in new_claims:
                        if claim.chunk_id == chunk_id and (claim.text == evidence or evidence in claim.text):
                            relation_claim_id = claim.id
                            break
                    relation_id = self._relation_id(subject.id, predicate, obj.id, chunk_id)
                    if relation_id in existing_relation_ids:
                        continue
                    new_relations.append(KnowledgeRelation(
                        id=relation_id,
                        subject_entity_id=subject.id,
                        predicate=predicate,
                        object_entity_id=obj.id,
                        evidence_chunk_id=chunk_id,
                        doc_id=doc_id,
                        claim_id=relation_claim_id,
                        confidence=raw_relation.get("confidence", 0.65),
                        created_at=ts,
                    ))
                    existing_relation_ids.add(relation_id)

            self._write_entities(list(existing_entities.values()))
            self._append_jsonl(self.claims_file, new_claims)
            self._append_jsonl(self.mentions_file, new_mentions)
            self._append_jsonl(self.relations_file, new_relations)

            logger.debug(
                "KnowledgeStore: semantic index for doc '{}' added {} claims, {} mentions, {} relations",
                doc_name,
                len(new_claims),
                len(new_mentions),
                len(new_relations),
            )
        except Exception as e:
            logger.warning("KnowledgeStore: semantic indexing failed for doc '{}': {}", doc_name, e)

    def _query_semantic(
        self,
        query_text: str,
        top_k: int,
        category: str | None = None,
        tags: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Retrieve chunks through extracted entities, claims, and relations."""
        chunks = self._read_chunks()
        if not chunks:
            return []

        chunk_meta_map = {chunk.id: chunk for chunk in chunks}
        entities = {entity.id: entity for entity in self._read_entities()}
        claims = self._read_claims()
        relations = self._read_relations()
        mentions = self._read_mentions()
        if not entities and not claims:
            return []

        query_entities = {
            self._normalize_entity_name(name)
            for name in self._extract_entity_names(query_text)
            if self._normalize_entity_name(name)
        }
        query_terms = set(self._semantic_terms(query_text))

        matched_entity_ids: set[str] = set()
        for entity in entities.values():
            aliases = [entity.name, *entity.aliases, entity.canonical_name]
            alias_norms = {self._normalize_entity_name(alias) for alias in aliases if alias}
            if alias_norms.intersection(query_entities):
                matched_entity_ids.add(entity.id)
                continue
            for alias_norm in alias_norms:
                if len(alias_norm) >= 3 and alias_norm in self._normalize_entity_name(query_text):
                    matched_entity_ids.add(entity.id)
                    break

        chunk_scores: dict[str, float] = {}
        chunk_matches: dict[str, dict[str, list[str]]] = {}

        def add_score(chunk_id: str, score: float, key: str, value: str) -> None:
            meta = chunk_meta_map.get(chunk_id)
            if not meta:
                return
            if category and meta.category != category:
                return
            if tags and not set(meta.tags or []).intersection(set(tags)):
                return
            chunk_scores[chunk_id] = chunk_scores.get(chunk_id, 0.0) + score
            matches = chunk_matches.setdefault(
                chunk_id,
                {"entities": [], "claims": [], "relations": []},
            )
            if value and value not in matches[key]:
                matches[key].append(value)

        for mention in mentions:
            if mention.entity_id in matched_entity_ids:
                entity = entities.get(mention.entity_id)
                add_score(mention.chunk_id, 1.2, "entities", entity.name if entity else mention.text)

        for claim in claims:
            claim_terms = set(self._semantic_terms(claim.text))
            term_overlap = len(query_terms.intersection(claim_terms))
            entity_overlap = len(matched_entity_ids.intersection(set(claim.entity_ids)))
            if term_overlap or entity_overlap:
                score = min(term_overlap * 0.25, 1.5) + entity_overlap * 0.9 + claim.confidence
                add_score(claim.chunk_id, score, "claims", claim.text)

        for relation in relations:
            subject = entities.get(relation.subject_entity_id)
            obj = entities.get(relation.object_entity_id)
            relation_text = self._format_relation(subject, relation.predicate, obj)
            entity_hit = (
                relation.subject_entity_id in matched_entity_ids
                or relation.object_entity_id in matched_entity_ids
            )
            predicate_hit = relation.predicate in query_text or relation.predicate in query_terms
            if entity_hit or predicate_hit:
                score = relation.confidence + (1.2 if entity_hit else 0.0) + (0.5 if predicate_hit else 0.0)
                add_score(relation.evidence_chunk_id, score, "relations", relation_text)

        sorted_chunk_ids = sorted(chunk_scores, key=chunk_scores.get, reverse=True)
        results: list[dict[str, Any]] = []
        for rank, chunk_id in enumerate(sorted_chunk_ids[:top_k], 1):
            meta = chunk_meta_map[chunk_id]
            matches = chunk_matches.get(chunk_id, {})
            results.append({
                "id": chunk_id,
                "content": meta.context_content or meta.content,
                "raw_content": meta.content,
                "retrieval_text": meta.retrieval_text,
                "semantic_text": meta.semantic_text,
                "summary": meta.summary,
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
                "semantic_score": chunk_scores[chunk_id],
                "semantic_rank": rank,
                "matched_entities": matches.get("entities", [])[:5],
                "matched_claims": matches.get("claims", [])[:3],
                "matched_relations": matches.get("relations", [])[:3],
                "method": "semantic",
                "matched_methods": ["semantic"],
            })
        return results

    def _merge_semantic_results(
        self,
        base_results: list[dict[str, Any]],
        semantic_results: list[dict[str, Any]],
        top_k: int,
    ) -> list[dict[str, Any]]:
        if not semantic_results:
            return base_results[:top_k]
        if not base_results:
            return semantic_results[:top_k]

        rrf_k = self.config.rrf_k if self.config else 60
        scores: dict[str, float] = {}
        merged: dict[str, dict[str, Any]] = {}

        for rank, result in enumerate(base_results, 1):
            chunk_id = result["id"]
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (rrf_k + rank)
            merged[chunk_id] = dict(result)

        for rank, result in enumerate(semantic_results, 1):
            chunk_id = result["id"]
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.15 / (rrf_k + rank)
            target = merged.setdefault(chunk_id, dict(result))
            target["semantic_rank"] = rank
            target["semantic_score"] = result.get("semantic_score")
            target["matched_entities"] = result.get("matched_entities", [])
            target["matched_claims"] = result.get("matched_claims", [])
            target["matched_relations"] = result.get("matched_relations", [])
            methods = set(target.get("matched_methods") or [])
            methods.add("semantic")
            target["matched_methods"] = sorted(methods)
            target["method"] = "hybrid+semantic" if target.get("method") != "semantic" else "semantic"

        sorted_ids = sorted(scores, key=scores.get, reverse=True)
        out: list[dict[str, Any]] = []
        for chunk_id in sorted_ids[:top_k]:
            result = merged[chunk_id]
            result["semantic_fusion_score"] = scores[chunk_id]
            out.append(result)
        return out

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
                parent_id = (
                    f"chunk_{doc_id}_{chunk.get('parent_index', chunk['index'])}"
                    if chunk.get("chunk_type") == "child"
                    else chunk_id
                )
                chunk_ids.append(chunk_id)
                chunk_docs.append(chunk.get("retrieval_text") or chunk.get("context_content") or chunk["content"])
                chunk_metas.append({
                    "doc_id": doc_id,
                    "parent_id": parent_id,
                    "chunk_type": chunk.get("chunk_type", "child"),
                    "doc_name": doc_name,
                    "file_path": file_path,
                    "chunk_index": chunk["index"],
                    "child_index": chunk.get("child_index", 0),
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
                content = chunk.get("retrieval_text") or chunk.get("context_content") or chunk["content"]
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

    def _remove_semantic_for_doc(self, doc_id: str) -> None:
        """Remove semantic index records for a document."""
        claims = [claim for claim in self._read_claims() if claim.doc_id != doc_id]
        mentions = [mention for mention in self._read_mentions() if mention.doc_id != doc_id]
        relations = [relation for relation in self._read_relations() if relation.doc_id != doc_id]

        entities = [
            KnowledgeEntity(
                **{
                    **asdict(entity),
                    "doc_ids": [item for item in entity.doc_ids if item != doc_id],
                }
            )
            for entity in self._read_entities()
        ]
        entities = [entity for entity in entities if entity.doc_ids]

        self._write_claims(claims)
        self._write_mentions(mentions)
        self._write_relations(relations)
        self._write_entities(entities)

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
                        chunks.append(self._ensure_chunk_text_views(KnowledgeChunk(**data)))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return chunks

    def _read_entities(self) -> list[KnowledgeEntity]:
        return self._read_jsonl_dataclass(self.entities_file, KnowledgeEntity)

    def _read_mentions(self) -> list[KnowledgeMention]:
        return self._read_jsonl_dataclass(self.mentions_file, KnowledgeMention)

    def _read_claims(self) -> list[KnowledgeClaim]:
        return self._read_jsonl_dataclass(self.claims_file, KnowledgeClaim)

    def _read_relations(self) -> list[KnowledgeRelation]:
        return self._read_jsonl_dataclass(self.relations_file, KnowledgeRelation)

    def _read_jsonl_dataclass(self, path: Path, cls: Any) -> list[Any]:
        items: list[Any] = []
        try:
            field_names = set(cls.__dataclass_fields__.keys())
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        filtered = {key: value for key, value in data.items() if key in field_names}
                        items.append(cls(**filtered))
                    except (json.JSONDecodeError, TypeError):
                        continue
        except FileNotFoundError:
            pass
        return items

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

    def _write_entities(self, entities: list[KnowledgeEntity]) -> None:
        self._write_jsonl(self.entities_file, entities)

    def _write_mentions(self, mentions: list[KnowledgeMention]) -> None:
        self._write_jsonl(self.mentions_file, mentions)

    def _write_claims(self, claims: list[KnowledgeClaim]) -> None:
        self._write_jsonl(self.claims_file, claims)

    def _write_relations(self, relations: list[KnowledgeRelation]) -> None:
        self._write_jsonl(self.relations_file, relations)

    def _write_jsonl(self, path: Path, items: list[Any]) -> None:
        with open(path, "w", encoding="utf-8") as f:
            for item in items:
                f.write(json.dumps(asdict(item), ensure_ascii=False) + "\n")

    def _append_jsonl(self, path: Path, items: list[Any]) -> None:
        if not items:
            return
        with open(path, "a", encoding="utf-8") as f:
            for item in items:
                f.write(json.dumps(asdict(item), ensure_ascii=False) + "\n")

    def _next_cursor(self) -> int:
        """Read the current cursor counter and return next value."""
        if self._cursor_file.exists():
            try:
                return int(self._cursor_file.read_text(encoding="utf-8").strip()) + 1
            except (ValueError, OSError):
                pass
        return len(self._read_documents()) + 1

    @staticmethod
    def _entity_id(canonical_name: str) -> str:
        return f"ent_{hashlib.sha1(canonical_name.encode()).hexdigest()[:12]}"

    @staticmethod
    def _claim_id(chunk_id: str, index: int, text: str) -> str:
        value = f"{chunk_id}:{index}:{text}"
        return f"claim_{hashlib.sha1(value.encode()).hexdigest()[:12]}"

    @staticmethod
    def _relation_id(subject_id: str, predicate: str, object_id: str, chunk_id: str) -> str:
        value = f"{subject_id}:{predicate}:{object_id}:{chunk_id}"
        return f"rel_{hashlib.sha1(value.encode()).hexdigest()[:12]}"

    @staticmethod
    def _mention_id(entity_id: str, chunk_id: str, start_char: int) -> str:
        value = f"{entity_id}:{chunk_id}:{start_char}"
        return f"mention_{hashlib.sha1(value.encode()).hexdigest()[:12]}"

    @staticmethod
    def _normalize_entity_name(name: str) -> str:
        name = re.sub(r"\s+", " ", name.strip().lower())
        name = name.strip(" \t\r\n-_*`~:：,，.。;；()（）[]【】{}")
        return name

    def _entity_has_text_evidence(
        self,
        name: str,
        aliases: list[str],
        text: str,
    ) -> bool:
        if not text:
            return False
        text_norm = self._normalize_entity_name(text)
        compact_text = re.sub(r"\s+", "", text_norm)
        for value in [name, *aliases]:
            candidate = self._normalize_entity_name(value)
            if not candidate:
                continue
            if _SEMANTIC_CJK_RE.search(candidate) and re.sub(r"\s+", "", candidate) in compact_text:
                return True
            if not _SEMANTIC_CJK_RE.search(candidate):
                pattern = rf"(?<![A-Za-z0-9_]){re.escape(candidate)}(?![A-Za-z0-9_])"
                if re.search(pattern, text_norm, flags=re.IGNORECASE):
                    return True
        return False

    def _is_meaningful_entity_name(self, name: str) -> bool:
        clean = self._clean_entity_name(name)
        if not clean:
            return False

        normalized = self._normalize_entity_name(clean)
        compact = re.sub(r"\s+", "", normalized)
        if normalized in _ENTITY_STOPWORDS or compact in _ENTITY_NOISE_PHRASES:
            return False
        if re.fullmatch(r"(.{1,3})\1{1,}", compact):
            return False
        if _SEMANTIC_CJK_RE.search(clean):
            if any(compact.startswith(prefix) for prefix in _CJK_ENTITY_BAD_PREFIXES):
                return False
            if any(compact.endswith(suffix) for suffix in _CJK_ENTITY_BAD_SUFFIXES):
                return False
            if any(marker in compact for marker in _ENTITY_NOISE_MARKERS):
                return False
            if re.search(r"(什么|怎么|为什么|怎么办|是不是|有没有|能不能)", compact):
                return False
            if re.search(r"(更|最|很|非常|比较|已经|正在|不会|不是|不能|需要|应该|可以|可能|就是)", compact):
                return False
            if len(compact) <= 3 and compact in {"这个", "那个", "这种", "一种", "很多", "一些", "大家"}:
                return False
            if len(compact) >= 8 and not re.search(r"(RAG|BM25|LLM|API|SDK|SQL|KG|Graph|Agent|AI)", clean, flags=re.IGNORECASE):
                if not re.search(r"(图谱|模型|算法|数据库|向量|检索|索引|实体|关系|本体|产品|机构|模块|接口|协议|系统|框架|文档|知识库)$", compact):
                    return False
        else:
            words = normalized.split()
            if words and words[0] in {"i", "we", "you", "our", "your", "this", "that", "these", "those"}:
                return False
            if any(word in words for word in {"more", "less", "before", "after", "maybe", "actually", "because"}):
                return False
            if len(words) == 1 and not re.search(r"[a-z0-9]", normalized):
                return False
        return True

    def _relation_matches_ontology(self, subject: str, predicate: str, obj: str) -> bool:
        rules = _RELATION_ENDPOINT_TYPE_RULES.get(predicate)
        if not rules:
            return True
        subject_type = self._infer_entity_type(subject)
        object_type = self._infer_entity_type(obj)
        allowed_subjects, allowed_objects = rules
        return subject_type in allowed_subjects and object_type in allowed_objects

    def _clean_entity_name(self, name: str) -> str:
        name = re.sub(r"\s+", " ", name.strip())
        name = re.sub(r"^#{1,6}\s*", "", name)
        name = re.sub(r"^\d+[.)、]\s*", "", name)
        name = name.replace("**", "").replace("__", "").replace("`", "")
        name = name.strip(" \t\r\n-_*`~:：,，.。;；!?！？()（）[]【】{}<>")
        if not name or len(name) < 2 or len(name) > 48:
            return ""
        normalized = name.lower()
        if normalized in _ENTITY_STOPWORDS:
            return ""
        if normalized.isdigit():
            return ""
        if any(marker in normalized for marker in _ENTITY_ACTION_MARKERS):
            return ""
        if re.search(r"[。！？!?；;，,]\s*", name):
            return ""
        if re.search(r"\s[-–—]\s", name):
            return ""
        if _SEMANTIC_CJK_RE.search(name) and len(name) > 18:
            return ""
        if not _SEMANTIC_CJK_RE.search(name) and len(name.split()) > 6:
            return ""
        return name

    @staticmethod
    def _infer_entity_type(name: str) -> str:
        if name.isupper() and len(name) <= 8:
            return "acronym"
        if any(token in name.lower() for token in ("api", "sdk", "rag", "bm25", "llm", "http")):
            return "technology"
        if _SEMANTIC_CJK_RE.search(name):
            return "concept"
        return "proper_noun"

    def _extract_entity_names(self, text: str) -> list[str]:
        if not text:
            return []
        found: list[str] = []

        for match in _MARKDOWN_ENTITY_RE.finditer(text):
            clean = self._clean_entity_name(match.group(1) or match.group(2) or "")
            if clean and self._is_meaningful_entity_name(clean):
                found.append(clean)

        for match in _QUOTED_ENTITY_RE.finditer(text):
            clean = self._clean_entity_name(match.group(1))
            if clean and self._is_meaningful_entity_name(clean):
                found.append(clean)

        for match in _EN_ENTITY_RE.finditer(text):
            clean = self._clean_entity_name(match.group(0))
            if clean and self._is_meaningful_entity_name(clean):
                found.append(clean)

        for raw_relation in self._extract_relations(text):
            for key in ("subject", "object"):
                clean = self._clean_entity_name(raw_relation[key])
                if clean and self._is_meaningful_entity_name(clean):
                    found.append(clean)

        deduped: list[str] = []
        seen: set[str] = set()
        for name in found:
            key = self._normalize_entity_name(name)
            if key and key not in seen:
                deduped.append(name)
                seen.add(key)
        return deduped[:40]

    def _extract_structural_entity_names(self, text: str) -> list[str]:
        if not text:
            return []
        found: list[str] = []
        for part in re.split(r">\s*|[/\\|]", text):
            clean = self._clean_entity_name(part)
            if clean:
                found.append(clean)
        return found[:12]

    def _extract_claims(self, text: str) -> list[str]:
        claims: list[str] = []
        for part in _CLAIM_SPLIT_RE.split(text):
            claim = re.sub(r"\s+", " ", part.strip())
            if 12 <= len(claim) <= 320:
                claims.append(claim)
        if not claims and 12 <= len(text.strip()) <= 320:
            claims.append(re.sub(r"\s+", " ", text.strip()))
        return claims[:20]

    def _extract_relations(self, text: str) -> list[dict[str, str]]:
        relations: list[dict[str, str]] = []
        compact = re.sub(r"\s+", " ", text.strip())
        if not compact:
            return relations
        for predicate, pattern in _RELATION_PATTERNS:
            for match in re.finditer(pattern, compact, flags=re.IGNORECASE):
                subject = self._clean_relation_endpoint(match.group(1))
                obj = self._clean_relation_endpoint(match.group(2))
                if subject and obj:
                    relations.append({
                        "subject": subject,
                        "predicate": predicate,
                        "object": obj,
                    })
        return relations[:8]

    def _clean_relation_endpoint(self, text: str) -> str:
        text = re.split(r"[。！？.!?；;\n]", text, maxsplit=1)[0]
        text = re.sub(r"^(因此|所以|其中|并且|同时|而且|the|a|an)\s*", "", text.strip(), flags=re.IGNORECASE)
        pieces = re.split(r"[,，、:：]", text)
        if pieces:
            text = pieces[-1].strip() if len(pieces[-1].strip()) >= 2 else pieces[0].strip()
        words = text.split()
        if len(words) > 8 and not _SEMANTIC_CJK_RE.search(text):
            text = " ".join(words[-8:])
        if _SEMANTIC_CJK_RE.search(text) and len(text) > 30:
            text = text[-30:]
        return self._clean_entity_name(text)

    @staticmethod
    def _normalize_entity_type(value: str) -> str:
        value = value.strip().lower()
        allowed = {
            "person",
            "organization",
            "product",
            "technology",
            "module",
            "api",
            "file",
            "protocol",
            "algorithm",
            "concept",
            "business_object",
            "proper_noun",
            "acronym",
        }
        return value if value in allowed else ""

    @staticmethod
    def _normalize_predicate(value: str) -> str:
        value = value.strip().lower().replace("-", "_").replace(" ", "_")
        value = _PREDICATE_ALIASES.get(value, value)
        return value if value in _ALLOWED_RELATION_PREDICATES else ""

    @staticmethod
    def _coerce_confidence(value: Any, default: float) -> float:
        try:
            confidence = float(value)
        except (TypeError, ValueError):
            confidence = default
        return max(0.0, min(1.0, confidence))

    @staticmethod
    def _semantic_terms(text: str) -> list[str]:
        terms = [term.lower() for term in re.findall(r"[A-Za-z0-9_./+-]{2,}", text)]
        cjk_chars = "".join(ch for ch in text if _SEMANTIC_CJK_RE.match(ch))
        for size in (2, 3):
            for i in range(max(0, len(cjk_chars) - size + 1)):
                terms.append(cjk_chars[i:i + size])
        return terms

    @staticmethod
    def _format_relation(
        subject: KnowledgeEntity | None,
        predicate: str,
        obj: KnowledgeEntity | None,
    ) -> str:
        subject_name = subject.name if subject else "unknown"
        object_name = obj.name if obj else "unknown"
        return f"{subject_name} -[{predicate}]-> {object_name}"
