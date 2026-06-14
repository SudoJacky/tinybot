import { describe, expect, test } from "vitest";

import { formatKnowledgeQueryResults, normalizeKnowledgeQueryResults } from "./knowledgeFormatting.ts";

describe("knowledgeFormatting", () => {
  test("formats Python-compatible traceability sections after source content", () => {
    const results = normalizeKnowledgeQueryResults([
      {
        id: "chunk-1",
        doc_name: "Traceability Notes",
        file_path: "docs/trace.md",
        line_start: 4,
        line_end: 9,
        content: "Traceable knowledge keeps citations attached to retrieved context.",
        method: "hybrid",
        source_snippets: [
          { text: "Original source sentence.", doc_name: "trace.md", line_start: 4, line_end: 5 },
        ],
        matched_claims: ["Citations must stay with retrieved context."],
        matched_claim_evidence: [
          { evidence_text: "Claim evidence sentence.", source: { doc_name: "trace.md", line_start: 6 } },
        ],
        matched_relations: ["Traceability supports retrieval"],
        matched_relation_evidence: [
          { text: "Relation evidence sentence.", doc_name: "trace.md", page: 2 },
        ],
        conflict_metadata: [
          { conflict_type: "contradiction", evidence_text: "Conflicting source sentence." },
        ],
        projection_metadata: [
          { title: "Traceability cluster", projection_type: "community_report" },
        ],
      },
    ]);

    const formatted = formatKnowledgeQueryResults(results);

    expect(formatted).toContain("## Knowledge Results");
    expect(formatted).toContain("Traceable knowledge keeps citations attached to retrieved context.");
    expect(formatted).toContain("**Source snippets**:");
    expect(formatted).toContain("- Original source sentence. (trace.md L4-5)");
    expect(formatted).toContain("**Claims**:");
    expect(formatted).toContain("- Citations must stay with retrieved context.");
    expect(formatted).toContain("- Evidence: Claim evidence sentence. (trace.md L6-6)");
    expect(formatted).toContain("**Relations**:");
    expect(formatted).toContain("- Traceability supports retrieval");
    expect(formatted).toContain("- Evidence: Relation evidence sentence. (trace.md p.2)");
    expect(formatted).toContain("**Conflicts**:");
    expect(formatted).toContain("- contradiction: Conflicting source sentence.");
    expect(formatted).toContain("**Derived projections**:");
    expect(formatted).toContain("- Traceability cluster (community_report)");
    expect(formatted.indexOf("**Source snippets**:")).toBeLessThan(formatted.indexOf("**Claims**:"));
    expect(formatted.indexOf("**Claims**:")).toBeLessThan(formatted.indexOf("**Relations**:"));
    expect(formatted.indexOf("**Relations**:")).toBeLessThan(formatted.indexOf("**Conflicts**:"));
    expect(formatted.indexOf("**Conflicts**:")).toBeLessThan(formatted.indexOf("**Derived projections**:"));
  });
});
