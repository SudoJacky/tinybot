# Knowledge and RAG

The knowledge subsystem stores user-provided documents, builds retrieval indexes, and exposes document, query, and graph APIs. Its design goal is to provide useful context to the agent while keeping retrieval explainable to users and debuggable by maintainers.

## Ownership

| Concern | Module |
| --- | --- |
| Knowledge store and retrieval logic | `tinybot/agent/knowledge.py` |
| Agent session integration | `tinybot/agent/session_knowledge.py` |
| Knowledge tools | `tinybot/agent/tools/knowledge.py` |
| HTTP routes | `tinybot/api/knowledge.py` |
| Vector support | `tinybot/agent/vector_store.py` |
| Config schema | `tinybot/config/schema.py` |
| WebUI presentation | `webui/assets/src/legacy/app.js`, knowledge CSS/components |

## Retrieval Model

Knowledge supports several retrieval signals:

- Dense vector retrieval for semantic similarity.
- Sparse/BM25-like keyword matching.
- Optional rerank for result ordering.
- Semantic extraction of entities, claims, and relationships.
- GraphRAG projections such as entity-local, community/global, and drift-style search.

The retrieval layer should return enough metadata for explanation: source document, section or chunk, score/confidence, retrieval method, matched entities, and raw details when useful.

## Indexing and Jobs

Document upload and rebuild operations can trigger work that is too slow for a synchronous UI interaction. The API exposes job status so the WebUI can show progress and readiness. New indexing steps should integrate with this job/status model rather than blocking the request path.

## Agent Integration

The agent runtime should treat retrieved knowledge as contextual evidence, not as instruction hierarchy. Knowledge snippets can inform an answer but should not override user instructions, tool safety, or system/developer constraints.

Automatic retrieval should be budget-aware. Large documents and broad queries need compact summaries or top-k limits to avoid crowding out the conversation context.

## API Contract

`tinybot/api/knowledge.py` owns:

- Document CRUD and upload.
- Query endpoint.
- Stats/readiness endpoint.
- Graph and GraphRAG endpoints.
- Rebuild and job-status endpoints.

Keep response fields stable for the WebUI. When adding a retrieval mode, expose a clear mode label and explanation metadata so the UI does not need to infer behavior from raw implementation details.

## Test Strategy

Knowledge tests live mainly in `tests/agent/test_knowledge_*.py`. Add tests around:

- Chunking and preprocessing.
- Parent-child chunk behavior.
- Rerank behavior.
- Semantic extraction and graph projections.
- Query result shape and explanation metadata.
