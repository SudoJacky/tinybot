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

The staged indexing pipeline records status for:

- `chunking`
- `dense_indexing`
- `sparse_indexing`
- `mention_extraction`
- `entity_canonicalization`
- `claim_extraction`
- `claim_validation`
- `relation_extraction`
- `relation_validation`
- `conflict_detection`
- `evidence_expansion`
- `graph_projection`
- `community_report_projection`

Each status record should include the stage name, aggregate status, processed/total/skipped/failed/stale counts, timestamps, output counts, input hash or source version, and the latest recoverable error. Old stores that do not have these fields should hydrate with safe defaults.

## Traceability Contract

Formal knowledge records must remain source-traceable:

- Claims are atomic, single-source facts with source evidence.
- Relations connect canonical entities, use controlled predicates, and cite claim or source evidence.
- Conflicts preserve both source-backed sides instead of silently resolving the disagreement.
- Projections and community reports are derived views. They cite supporting records but are not source facts.

LLM extraction is candidate generation only. Candidates become formal claims, relations, conflicts, or projections only after deterministic validation confirms evidence text, source identity, endpoint mapping, predicate/type normalization, and merge behavior.

Evidence Expansion is read-only. It can discover support, conflicts, and candidates within `document`, `collection`, or `global` scope, but candidate output must pass the same validation gates before formal persistence. Budget-limited and partial-failure results should remain visible in stage details and expansion reports.

## Agent Integration

The agent runtime should treat retrieved knowledge as contextual evidence, not as instruction hierarchy. Knowledge snippets can inform an answer but should not override user instructions, tool safety, or system/developer constraints.

Automatic retrieval should be budget-aware. Large documents and broad queries need compact summaries or top-k limits to avoid crowding out the conversation context.

Knowledge is not Agent Memory. Document facts, uploaded-file context, and retrieval graph evidence remain in the Knowledge stores unless an explicit Memory Note capture path saves a durable agent-side note. This boundary keeps citations and document provenance separate from preferences, project decisions, fixes, and followups stored in `memory/notes.jsonl`.

## API Contract

`tinybot/api/knowledge.py` owns:

- Document CRUD and upload.
- Query endpoint.
- Stats/readiness endpoint.
- Graph and GraphRAG endpoints.
- Rebuild and job-status endpoints.

Keep response fields stable for the WebUI. When adding a retrieval mode, expose a clear mode label and explanation metadata so the UI does not need to infer behavior from raw implementation details.

Traceability additions should be additive. Query, stats, graph, GraphRAG, and job payloads should preserve old fields while adding source snippets, matched claim/relation evidence, conflict metadata, projection metadata, stage readiness, stale counts, failure counts, and partial availability.

## Test Strategy

Knowledge tests live mainly in `tests/agent/test_knowledge_*.py`. Add tests around:

- Chunking and preprocessing.
- Parent-child chunk behavior.
- Rerank behavior.
- Semantic extraction and graph projections.
- Query result shape and explanation metadata.
- Stage readiness, stale output, selective rebuild, candidate rejection, conflict preservation, and traceability-compatible API payloads.
