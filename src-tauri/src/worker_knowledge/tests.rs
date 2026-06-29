#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn existing_knowledge_jsonl_fixture_loads_documents_and_chunks() {
        let root = temp_workspace_root("existing-knowledge-store");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let knowledge_dir = root.join("knowledge");
        std::fs::create_dir_all(&knowledge_dir).unwrap();
        write_jsonl_fixture_line(
            &knowledge_dir.join("documents.jsonl"),
            json!({
                "id": "doc-existing",
                "name": "Existing Rust Split Guide",
                "file_path": "knowledge/files/doc-existing.md",
                "original_path": "docs/local/2026-06-23-Rust-split-guide.md",
                "source": "manual_upload",
                "file_type": "md",
                "content": "# Existing Guide\n\nDeterministic bridge maintenance.",
                "created_at": "2026-06-23T08:00:00Z",
                "chunk_count": 1,
                "category": "maintenance",
                "tags": ["rust", "worker"],
                "metadata": { "source": "pre-storage-refactor" }
            }),
        );
        write_jsonl_fixture_line(
            &knowledge_dir.join("chunks.jsonl"),
            json!({
                "id": "chunk-doc-existing-0",
                "doc_id": "doc-existing",
                "parent_id": "chunk-doc-existing-0",
                "chunk_type": "parent",
                "content": "Deterministic bridge maintenance keeps old knowledge readable.",
                "retrieval_text": "Deterministic bridge maintenance keeps old knowledge readable.",
                "semantic_text": "Deterministic bridge maintenance keeps old knowledge readable.",
                "context_content": "Deterministic bridge maintenance keeps old knowledge readable.",
                "summary": "",
                "chunk_index": 0,
                "child_index": 0,
                "start_char": 0,
                "end_char": 65,
                "line_start": 1,
                "line_end": 1,
                "created_at": "2026-06-23T08:00:00Z",
                "doc_name": "Existing Rust Split Guide",
                "file_path": "knowledge/files/doc-existing.md",
                "category": "maintenance",
                "tags": ["rust", "worker"],
                "section_path": "Existing Guide",
                "section_id": "section-doc-existing-0",
                "section_title": "Existing Guide",
                "parent_section_id": "section-root",
                "section_ordinal": 0,
                "block_type": "text"
            }),
        );

        let rpc = WorkerKnowledgeRpc::new(
            root,
            CapabilityPolicy::new([WorkerCapability::KnowledgeRead]),
        );

        let documents = rpc
            .list_documents(KnowledgeListDocumentsParams {
                category: None,
                limit: None,
            })
            .expect("existing knowledge documents should load");
        assert_eq!(documents.documents.len(), 1);
        assert_eq!(documents.documents[0].id, "doc-existing");
        assert_eq!(
            documents.documents[0].metadata["source"],
            "pre-storage-refactor"
        );

        let results = rpc
            .query(KnowledgeQueryParams {
                query: "deterministic bridge".to_string(),
                category: None,
                tags: None,
                limit: Some(5),
                include_structure_context: None,
                include_graph_context: Some(false),
                graph_relation_filters: None,
                graph_max_hops: None,
                graph_min_confidence: None,
                graph_max_added_chunks: None,
            })
            .expect("existing knowledge chunks should load");
        assert_eq!(results.results.len(), 1);
        assert_eq!(results.results[0].doc_id, "doc-existing");
        assert_eq!(results.results[0].section_title, "Existing Guide");
    }

    #[test]
    fn multi_file_update_restores_existing_jsonl_files_after_failure() {
        let root = temp_workspace_root("restore-existing-jsonl");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("first.jsonl");
        let second = root.join("second.jsonl");
        std::fs::write(&first, "old-first\n").unwrap();
        std::fs::write(&second, "old-second\n").unwrap();

        let error = run_knowledge_jsonl_update(&[&first, &second], || {
            std::fs::write(&first, "new-first\n").unwrap();
            std::fs::write(&second, "new-second\n").unwrap();
            Err(invalid_knowledge_request("forced failure"))
        })
        .expect_err("failing multi-file update should return an error");

        assert_eq!(std::fs::read_to_string(&first).unwrap(), "old-first\n");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "old-second\n");
        assert!(!first.with_file_name("first.jsonl.bak").exists());
        assert!(!second.with_file_name("second.jsonl.bak").exists());
        assert_eq!(error.message, "knowledge multi-file update failed");
        assert_eq!(error.details["recovery"]["status"], "restored");
    }

    #[test]
    fn multi_file_update_removes_new_jsonl_files_after_failure() {
        let root = temp_workspace_root("restore-new-jsonl");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("first.jsonl");
        let second = root.join("second.jsonl");

        let error = run_knowledge_jsonl_update(&[&first, &second], || {
            std::fs::write(&first, "new-first\n").unwrap();
            Err(invalid_knowledge_request("forced failure"))
        })
        .expect_err("failing multi-file update should return an error");

        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(error.message, "knowledge multi-file update failed");
        assert_eq!(error.details["recovery"]["status"], "restored");
    }

    fn write_jsonl_fixture_line(path: &Path, value: Value) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let line = serde_json::to_string(&value).unwrap();
        std::fs::write(path, format!("{line}\n")).unwrap();
    }

    fn temp_workspace_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-knowledge-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    struct TempWorkspaceCleanup(PathBuf);

    impl Drop for TempWorkspaceCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
