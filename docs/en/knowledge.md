# Knowledge Base

The knowledge base lets Tinybot answer questions using your curated materials. It is ideal for situations with many references that you may ask repeatedly, such as product manuals, project docs, policy workflows, meeting minutes, and FAQs.

## Difference from normal chat

Normal chat relies only on the current conversation and the model’s pre-trained knowledge. The knowledge base splits and indexes your documents, retrieves relevant chunks when you ask a question, and passes them to the model for answer generation.

| Scenario | Suggested to use knowledge base |
|------|------------------|
| One-off temporary question | Not necessary |
| Summarizing a short newly pasted text | Not necessary; paste directly |
| Frequent questions on the same document set | Suggested |
| Internal policies or product manuals | Suggested |
| Long-lived technical docs | Suggested |

## Enable the knowledge base

Enable it in configuration:

```json
{
  "knowledge": {
    "enabled": true,
    "autoRetrieve": true,
    "maxChunks": 5,
    "retrievalMode": "hybrid"
  }
}
```

It can also be enabled in the web UI settings panel.

## Add materials

Recommended to add through the web UI:

1. Start `uv run tinybot gateway`
2. Open `http://127.0.0.1:18790`
3. Open the knowledge panel on the right
4. Add text, Markdown, or supported uploaded files
5. Wait for indexing to complete

The current web session also supports temporary uploads of `txt`, `md`, and `pdf` files for session-local QA.

## Ask questions

When asking, make clear you want retrieval from the knowledge base:

```text
Based on the product docs in the knowledge base, explain the onboarding flow for a new user account.
```

```text
Only use the PDF I uploaded and summarize its risk points.
```

If you find a response that did not reference materials, ask directly:

```text
Please re-retrieve the knowledge base and show which document content the answer came from.
```

## Retrieval settings

| Setting | Beginner recommendation | Meaning |
|------|----------|------|
| `autoRetrieve` | On | Automatically search the knowledge base for each question |
| `maxChunks` | 5 | Number of returned document chunks |
| `retrievalMode` | `hybrid` | Use semantic and keyword retrieval together |
| `rerankEnabled` | Off first | Requires additional service; turn on only if search quality is poor |

If your documents have many exact terms, IDs, and interface names, keyword retrieval is important. If user queries are phrased differently from the source docs, semantic retrieval becomes more important. `hybrid` combines both and is suitable for most cases.

## Source evidence and knowledge graph

New indexing keeps interpretable information: documents, chunks, raw evidence, page/line references, extraction method, confidence, and graph signals such as `claim`, `relation`, `conflict`, and `projection`. The answer view and graph panel prefer original source snippets; graph, community report, and summaries are derived views and should not replace original evidence.

In default low-cost mode, Tinybot prefers hybrid retrieval and rule-based semantic extraction. LLM extraction, entity-guided second-pass extraction, evidence expansion, and LLM community reports must be explicitly enabled in configuration.

## High-quality mode

If you need a more complete, inspectable graph, enable in stages:

1. Set `semanticExtractionMode` to `llm` or `hybrid` so the model generates candidate entities, claims, and relations.
2. Set `llmExtractionStrategy` to `entity_guided` so the model uses known entities to add claims and relations.
3. Enable `evidenceExpansionEnabled`, starting with `document` scope.
4. Tune `evidenceExpansionMaxQueries`, `evidenceExpansionMaxLlmCalls`, `evidenceExpansionMaxTokens`, timeout, and concurrency for cost control.

LLM output does not become authoritative facts directly. Candidate items must map back to source snippets and pass validation before entering claim/relation/conflict records.

## Partial indexing and conflicts

Indexing status includes retrieval-ready, claim-ready, relation-ready, partially expanded evidence, graph-ready, failed, and expired states. Even when graph building is incomplete, completed retrieval chunks can still be used for answers. After document updates, graph or community reports may become expired and require rebuilding.

When materials conflict, Tinybot keeps both sides and their sources rather than hiding one side automatically. For important conclusions, ask it to list raw evidence and conflict explanations.

## Material preparation tips

For better retrieval:

- Keep one topic per document.
- Use clear headings such as “Refund process”, “Deployment steps”, “API authentication”.
- Avoid putting large unrelated content in one document.
- Reindex after document updates.
- Use the knowledge base for long-lived reference materials; use session uploads for temporary files.

## The knowledge base is not omniscient

The knowledge base increases accuracy for “use my materials,” but it does not guarantee every answer is perfectly correct. For critical conclusions, ask Tinybot to list evidence sources or quote source snippets.

Recommended prompt:

```text
Please answer based on the knowledge base and list key source excerpts used.
```

## Common issues

### Tinybot did not use my documents

Check:

1. `knowledge.enabled` is `true`
2. `autoRetrieve` is enabled
3. Documents are fully indexed
4. The question matches document content
5. Whether reindexing is required

### Search results are inaccurate

Try:

1. Ask a more specific question
2. Increase `maxChunks`
3. Use `hybrid` retrieval
4. Split long documents
5. Enable reranking

### When to skip knowledge base

If you only need Tinybot to read a few current files, directly provide file paths:

```text
Please read docs/quickstart.md and point out issues.
```

## Next steps

- [Web UI](webui.md): manage the knowledge base in the browser
- [Tool features](tools.md): distinguish file reading from web search
- [Skills](skills.md): turn recurring Q&A flows into skills
