use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
use crate::worker_protocol::{WorkerProtocolError, WorkerRequest};
use crate::worker_rpc::protocol::parse_params;
use crate::worker_storage::{
    read_jsonl_strict, read_jsonl_strict_with_lines, write_jsonl_atomic, AtomicWriteOptions,
    WorkerStorageError,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Debug)]
pub(crate) struct WorkerMemoryRpc {
    workspace_root: PathBuf,
    policy: CapabilityPolicy,
}

impl WorkerMemoryRpc {
    pub(crate) fn new(workspace_root: PathBuf, policy: CapabilityPolicy) -> Self {
        Self {
            workspace_root,
            policy,
        }
    }

    pub(crate) fn search_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.search(parse_params(request)?)
    }

    pub(crate) fn recall_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.recall(parse_params(request)?)
    }

    pub(crate) fn dream_run_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.dream_run(parse_params(request)?)
    }

    pub(crate) fn dream_pending_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.dream_pending(parse_params(request)?)
    }

    pub(crate) fn dream_apply_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.dream_apply(parse_params(request)?)
    }

    pub(crate) fn dream_log_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.dream_log(parse_params(request)?)
    }

    pub(crate) fn dream_restore_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.dream_restore(parse_params(request)?)
    }

    pub(crate) fn capture_evidence_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.capture_evidence(parse_params(request)?)
    }

    pub(crate) fn list_evidence_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.list_evidence(parse_params(request)?)
    }

    pub(crate) fn save_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.save(parse_params(request)?)
    }

    pub(crate) fn trace_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.trace(parse_params(request)?)
    }

    pub(crate) fn reject_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.reject(parse_params(request)?)
    }

    pub(crate) fn supersede_from_request(
        &self,
        request: &WorkerRequest,
    ) -> Result<Value, WorkerProtocolError> {
        self.supersede(parse_params(request)?)
    }

    fn search(
        &self,
        params: MemorySearchParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let limit = params.limit.unwrap_or(10).min(50);
        if limit == 0 {
            return Ok(serde_json::json!({ "notes": [] }));
        }
        let note_type =
            validate_optional_memory_value("note_type", params.note_type, MEMORY_NOTE_TYPES)?;
        let scope = validate_optional_memory_value("scope", params.scope, MEMORY_NOTE_SCOPES)?;
        let status = validate_optional_memory_value("status", params.status, MEMORY_NOTE_STATUSES)?;
        let query = params.query.unwrap_or_default();
        let query_terms = memory_query_terms(&query);

        let mut notes: Vec<Value> = self
            .read_notes_with_lines()?
            .into_iter()
            .map(|(note, line)| annotate_memory_note_location(note, line))
            .filter(|note| memory_note_matches(note, "type", note_type.as_deref()))
            .filter(|note| memory_note_matches(note, "scope", scope.as_deref()))
            .filter(|note| memory_note_matches(note, "status", status.as_deref()))
            .filter(|note| query_terms.is_empty() || memory_note_matches_query(note, &query_terms))
            .collect();
        notes.sort_by(|left, right| {
            memory_note_score(right, &query_terms)
                .partial_cmp(&memory_note_score(left, &query_terms))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        notes.truncate(limit);
        Ok(serde_json::json!({ "notes": notes }))
    }

    fn recall(
        &self,
        params: MemoryRecallParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let search_result = self.search(MemorySearchParams {
            query: Some(params.query),
            note_type: None,
            scope: None,
            status: Some("active".to_string()),
            limit: Some(params.max_notes.unwrap_or(6).min(20)),
        })?;
        let notes = search_result
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let context = render_memory_recall_context(&notes, params.max_chars.unwrap_or(1600));
        let references: Vec<Value> = notes.iter().map(memory_recall_reference).collect();
        Ok(serde_json::json!({
            "context": context,
            "notes": notes,
            "references": references
        }))
    }

    pub(crate) fn rebuild_index(
        &self,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        Ok(serde_json::json!({
            "available": false,
            "rebuilt": false,
            "indexed": 0,
            "backend": null,
            "reason": "vector memory index is not available in the native runtime"
        }))
    }

    pub(crate) fn refresh_views(
        &self,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let notes = self.read_notes()?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({
            "views_refreshed": true,
            "note_count": notes.len(),
            "view_files": MEMORY_VIEW_TITLES
                .iter()
                .map(|(view_file, _)| *view_file)
                .collect::<Vec<_>>()
        }))
    }

    pub(crate) fn migrate_legacy_notes(
        &self,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let mut notes = self.read_notes()?;
        let timestamp = memory_timestamp();
        let mut migrated = Vec::new();
        for (source_file, note_type) in [
            ("memory/MEMORY.md", "project"),
            ("USER.md", "preference"),
            ("SOUL.md", "instruction"),
        ] {
            let path = self.workspace_root.join(source_file);
            let content = fs::read_to_string(path).unwrap_or_default();
            if content.trim().is_empty() {
                continue;
            }
            let scope = default_memory_scope(note_type);
            let source = serde_json::json!({
                "capture_origin": "migration",
                "source_file": source_file
            });
            for item in parse_legacy_memory_markdown(&content) {
                let note_id = generate_memory_note_id(note_type, scope, &item, &source);
                let note = serde_json::json!({
                    "id": note_id,
                    "scope": scope,
                    "type": note_type,
                    "status": "active",
                    "content": item,
                    "priority": 0.4,
                    "confidence": 0.45,
                    "sources": [source.clone()],
                    "created_at": timestamp,
                    "updated_at": timestamp,
                    "tags": ["legacy-migration"]
                });
                notes.retain(|existing| existing.get("id") != note.get("id"));
                notes.push(note.clone());
                migrated.push(note);
            }
        }
        if !migrated.is_empty() {
            self.write_notes(&notes)?;
        }
        Ok(serde_json::json!({
            "migrated_count": migrated.len(),
            "notes": migrated
        }))
    }

    fn dream_run(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let _session_id = params.session_id.as_deref();
        let _sha = params.sha.as_deref();
        let evidence_cursor = self.last_evidence_cursor();
        let pending_evidence = self.pending_conversation_evidence(evidence_cursor, 50)?;
        if !pending_evidence.is_empty() {
            let pending_count = pending_evidence.len();
            let extraction = self.extract_dream_notes_from_evidence(&pending_evidence)?;
            let content = if extraction.captured_notes > 0 {
                format!(
                    "Dream captured {} memory note(s) from {pending_count} conversation evidence record(s).",
                    extraction.captured_notes
                )
            } else {
                format!(
                    "Dream deferred {pending_count} conversation evidence record(s) for provider-backed memory extraction."
                )
            };
            return Ok(memory_dream_result_with_metadata(
                &content,
                true,
                serde_json::json!({
                    "changed": extraction.captured_notes > 0,
                    "deferred": extraction.captured_notes == 0,
                    "pending_evidence": pending_count,
                    "captured_notes": extraction.captured_notes,
                    "skipped_evidence": extraction.skipped_evidence,
                    "last_evidence_cursor": extraction.last_evidence_cursor
                }),
            ));
        }

        let pending_legacy_history = self.pending_legacy_history(50)?;
        if !pending_legacy_history.is_empty() {
            let pending_count = pending_legacy_history.len();
            let extraction =
                self.extract_dream_notes_from_legacy_history(&pending_legacy_history)?;
            let content = if extraction.captured_notes > 0 {
                format!(
                    "Dream captured {} memory note(s) from {pending_count} legacy history record(s).",
                    extraction.captured_notes
                )
            } else {
                format!(
                    "Dream deferred {pending_count} legacy history record(s) for provider-backed memory extraction."
                )
            };
            return Ok(memory_dream_result_with_metadata(
                &content,
                true,
                serde_json::json!({
                    "changed": extraction.captured_notes > 0,
                    "deferred": extraction.captured_notes == 0,
                    "pending_evidence": 0,
                    "pending_legacy_history": pending_count,
                    "captured_notes": extraction.captured_notes,
                    "skipped_history": extraction.skipped_history,
                    "last_dream_cursor": extraction.last_dream_cursor
                }),
            ));
        }

        Ok(memory_dream_result_with_metadata(
            "Dream: nothing to process.",
            true,
            serde_json::json!({
                "changed": false,
                "pending_evidence": 0
            }),
        ))
    }

    fn dream_pending(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let _session_id = params.session_id.as_deref();
        let evidence_cursor = self.last_evidence_cursor();
        let pending_evidence = self.pending_conversation_evidence(evidence_cursor, 50)?;
        if !pending_evidence.is_empty() {
            return Ok(memory_dream_pending_batch(
                "conversation_evidence",
                pending_evidence,
                Some(evidence_cursor),
                self.dream_memory_context()?,
            ));
        }

        let pending_legacy_history = self.pending_legacy_history(50)?;
        if !pending_legacy_history.is_empty() {
            return Ok(memory_dream_pending_batch(
                "legacy_history",
                pending_legacy_history,
                Some(self.last_dream_cursor()),
                self.dream_memory_context()?,
            ));
        }

        Ok(serde_json::json!({
            "kind": "none",
            "records": [],
            "pending_evidence": 0,
            "pending_legacy_history": 0,
            "last_evidence_cursor": evidence_cursor,
            "last_dream_cursor": self.last_dream_cursor(),
            "memory_context": self.dream_memory_context()?
        }))
    }

    fn dream_apply(
        &self,
        params: MemoryDreamApplyParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let kind = validate_memory_value(
            "dream_apply kind",
            &params.kind,
            &["conversation_evidence", "legacy_history"],
        )?;
        let cursor_start = params
            .cursor_start
            .ok_or_else(|| invalid_memory_request("Dream apply cursor_start is required"))?;
        let cursor_end = params
            .cursor_end
            .ok_or_else(|| invalid_memory_request("Dream apply cursor_end is required"))?;
        if cursor_end < cursor_start {
            return Err(invalid_memory_request(
                "Dream apply cursor_end must be greater than or equal to cursor_start",
            ));
        }

        let mut notes = self.read_notes()?;
        let timestamp = memory_timestamp();
        let mut applied_notes = 0usize;
        for note_params in params.notes {
            let action = note_params
                .action
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .unwrap_or_else(|| "save".to_string());
            if action == "skip" {
                continue;
            }
            let mut source = serde_json::json!({
                "capture_origin": "dream",
                "history_start_cursor": cursor_start,
                "history_end_cursor": cursor_end
            });
            if kind == "conversation_evidence" {
                let evidence_ids: Vec<String> = note_params
                    .evidence_ids
                    .as_deref()
                    .or(params.evidence_ids.as_deref())
                    .unwrap_or(&[])
                    .iter()
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty())
                    .collect();
                if !evidence_ids.is_empty() {
                    source["evidence_ids"] = serde_json::json!(evidence_ids);
                }
            }
            if let Some(session_id) = params
                .session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                source["session_key"] = Value::String(session_id.to_string());
            }

            if action == "reject" {
                let note_id =
                    required_memory_note_id(note_params.target_note_id.as_deref().unwrap_or(""))?;
                let note = find_note_mut(&mut notes, note_id)?;
                note["status"] = Value::String("rejected".to_string());
                note["updated_at"] = Value::String(timestamp.clone());
                ensure_json_object_field(note, "metadata");
                note["metadata"]["extractor"] = Value::String("ts_provider_dream".to_string());
                if let Some(reason) = note_params
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                {
                    note["metadata"]["rejected_reason"] = Value::String(reason.to_string());
                }
                applied_notes += 1;
                continue;
            }

            let content = note_params.content.trim();
            if content.is_empty() {
                continue;
            }
            let note_type = validate_memory_value(
                "note_type",
                note_params.note_type.as_deref().unwrap_or("project"),
                MEMORY_NOTE_TYPES,
            )?;
            let scope = note_params
                .scope
                .as_deref()
                .map(|value| validate_memory_value("scope", value, MEMORY_NOTE_SCOPES))
                .transpose()?
                .unwrap_or_else(|| default_memory_scope(note_type));
            let priority = validate_memory_score("priority", note_params.priority.unwrap_or(0.6))?;
            let confidence =
                validate_memory_score("confidence", note_params.confidence.unwrap_or(0.6))?;
            let mut metadata = match note_params.metadata {
                Some(value) if value.is_object() => value,
                Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
                None => serde_json::json!({}),
            };
            if let Some(object) = metadata.as_object_mut() {
                object.insert(
                    "extractor".to_string(),
                    Value::String("ts_provider_dream".to_string()),
                );
                if kind == "legacy_history" {
                    object.insert("legacy_history".to_string(), Value::Bool(true));
                }
            }
            let tags: Vec<String> = note_params
                .tags
                .unwrap_or_default()
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .collect();
            let note_id = generate_memory_note_id(note_type, scope, content, &source);
            let mut note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": priority,
                "confidence": confidence,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": metadata
            });
            if !tags.is_empty() {
                note["tags"] = serde_json::json!(tags);
            }
            if action == "supersede" {
                let target_note_id =
                    required_memory_note_id(note_params.target_note_id.as_deref().unwrap_or(""))?;
                let replacement_id = note_id.clone();
                let old_note_exists = notes.iter().any(|existing| {
                    existing.get("id").and_then(Value::as_str) == Some(target_note_id)
                });
                if !old_note_exists {
                    return Err(invalid_memory_request(format!(
                        "Memory Note not found: {target_note_id}"
                    )));
                }
                note["supersedes"] = serde_json::json!([target_note_id]);
                notes.retain(|existing| existing.get("id") != note.get("id"));
                notes.push(note);
                let old_note = find_note_mut(&mut notes, target_note_id)?;
                old_note["status"] = Value::String("superseded".to_string());
                old_note["superseded_by"] = Value::String(replacement_id);
                old_note["updated_at"] = Value::String(memory_timestamp());
                applied_notes += 1;
                continue;
            }
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            applied_notes += 1;
        }

        if applied_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
        }
        if kind == "conversation_evidence" {
            self.write_evidence_cursor(cursor_end)?;
            Ok(serde_json::json!({
                "changed": applied_notes > 0,
                "applied_notes": applied_notes,
                "last_evidence_cursor": self.last_evidence_cursor()
            }))
        } else {
            self.write_dream_cursor(cursor_end)?;
            Ok(serde_json::json!({
                "changed": applied_notes > 0,
                "applied_notes": applied_notes,
                "last_dream_cursor": self.last_dream_cursor()
            }))
        }
    }

    fn extract_dream_notes_from_evidence(
        &self,
        evidence: &[Value],
    ) -> Result<DreamExtractionResult, crate::worker_protocol::WorkerProtocolError> {
        let mut notes = self.read_notes()?;
        let mut captured_notes = 0usize;
        let mut skipped_evidence = 0usize;
        let mut last_evidence_cursor = self.last_evidence_cursor();
        let timestamp = memory_timestamp();

        for record in evidence {
            let cursor = record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(last_evidence_cursor);
            last_evidence_cursor = last_evidence_cursor.max(cursor);

            let Some(content) = dream_note_content(record) else {
                skipped_evidence += 1;
                continue;
            };
            let note_type = dream_note_type(&content);
            let scope = default_memory_scope(note_type);
            let evidence_id = record
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("unknown");
            let mut source = serde_json::json!({
                "capture_origin": "dream",
                "evidence_ids": [evidence_id],
                "history_start_cursor": cursor,
                "history_end_cursor": cursor
            });
            if let Some(session_key) = record
                .get("session_key")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                source["session_key"] = Value::String(session_key.to_string());
            }
            if let Some(turn_id) = record
                .get("turn_id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                source["turn_id"] = Value::String(turn_id.to_string());
            }

            let note_id = generate_memory_note_id(note_type, scope, &content, &source);
            let note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": 0.6,
                "confidence": 0.6,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": {
                    "extractor": "native_dream_heuristic"
                }
            });
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            captured_notes += 1;
        }

        if captured_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
            self.write_evidence_cursor(last_evidence_cursor)?;
        } else {
            last_evidence_cursor = self.last_evidence_cursor();
        }
        Ok(DreamExtractionResult {
            captured_notes,
            skipped_evidence,
            last_evidence_cursor,
        })
    }

    fn extract_dream_notes_from_legacy_history(
        &self,
        history: &[Value],
    ) -> Result<DreamLegacyExtractionResult, crate::worker_protocol::WorkerProtocolError> {
        let mut notes = self.read_notes()?;
        let mut captured_notes = 0usize;
        let mut skipped_history = 0usize;
        let mut last_dream_cursor = self.last_dream_cursor();
        let timestamp = memory_timestamp();

        for record in history {
            let cursor = record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(last_dream_cursor);
            last_dream_cursor = last_dream_cursor.max(cursor);

            let content = record
                .get("content")
                .and_then(Value::as_str)
                .and_then(dream_memory_text);
            let Some(content) = content else {
                skipped_history += 1;
                continue;
            };
            let note_type = dream_note_type(&content);
            let scope = default_memory_scope(note_type);
            let source = serde_json::json!({
                "capture_origin": "dream",
                "history_start_cursor": cursor,
                "history_end_cursor": cursor
            });
            let note_id = generate_memory_note_id(note_type, scope, &content, &source);
            let note = serde_json::json!({
                "id": note_id,
                "scope": scope,
                "type": note_type,
                "status": "active",
                "content": content,
                "priority": 0.6,
                "confidence": 0.6,
                "sources": [source],
                "created_at": timestamp,
                "updated_at": timestamp,
                "metadata": {
                    "extractor": "native_dream_heuristic",
                    "legacy_history": true
                }
            });
            notes.retain(|existing| existing.get("id") != note.get("id"));
            notes.push(note);
            captured_notes += 1;
        }

        if captured_notes > 0 {
            self.write_notes(&notes)?;
            self.refresh_memory_views(&notes)?;
            self.write_dream_cursor(last_dream_cursor)?;
        } else {
            last_dream_cursor = self.last_dream_cursor();
        }
        Ok(DreamLegacyExtractionResult {
            captured_notes,
            skipped_history,
            last_dream_cursor,
        })
    }

    fn dream_log(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let _session_id = params.session_id.as_deref();
        if !self.dream_git_initialized() {
            if self.last_dream_cursor() == 0 {
                return Ok(memory_dream_unavailable(
                    "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle.",
                ));
            }
            return Ok(memory_dream_unavailable(
                "Dream history is not available because memory versioning is not initialized.",
            ));
        }

        let content = match params.sha.as_deref().map(str::trim).filter(|sha| !sha.is_empty()) {
            Some(sha) => match self.dream_show_commit_diff(sha, 20) {
                Some((commit, diff)) => dream_log_content(&commit, &diff, Some(sha)),
                None => format!(
                    "Couldn't find Dream change `{sha}`.\n\nUse `/dream-restore` to list recent versions, or `/dream-log` to inspect the latest one."
                ),
            },
            None => {
                let commits = self.dream_log_commits(1);
                match commits.first() {
                    Some(commit) => {
                        let diff = self.dream_commit_diff(commit);
                        dream_log_content(commit, &diff, None)
                    }
                    None => "Dream memory has no saved versions yet.".to_string(),
                }
            }
        };
        Ok(memory_dream_result(&content, true))
    }

    fn dream_restore(
        &self,
        params: MemoryDreamParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let _session_id = params.session_id.as_deref();
        if !self.dream_git_initialized() {
            return Ok(memory_dream_unavailable(
                "Dream history is not available because memory versioning is not initialized.",
            ));
        }

        let content = match params
            .sha
            .as_deref()
            .map(str::trim)
            .filter(|sha| !sha.is_empty())
        {
            Some(sha) => {
                let changed_files = self
                    .dream_show_commit_diff(sha, 20)
                    .map(|(_, diff)| format_dream_changed_files(&diff))
                    .unwrap_or_else(|| "the tracked memory files".to_string());
                match self.dream_revert_commit(sha) {
                    Some(new_sha) => format!(
                        "Restored Dream memory to the state before `{sha}`.\n\n- New safety commit: `{new_sha}`\n- Restored files: {changed_files}\n\nUse `/dream-log {new_sha}` to inspect the restore diff."
                    ),
                    None => format!(
                        "Couldn't restore Dream change `{sha}`.\n\nIt may not exist, or it may be the first saved version with no earlier state to restore."
                    ),
                }
            }
            None => {
                let commits = self.dream_log_commits(10);
                if commits.is_empty() {
                    "Dream memory has no saved versions to restore yet.".to_string()
                } else {
                    dream_restore_list_content(&commits)
                }
            }
        };
        Ok(memory_dream_result(&content, true))
    }

    fn capture_evidence(
        &self,
        params: MemoryCaptureEvidenceParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let session_key = params.session_key.trim();
        if session_key.is_empty() {
            return Err(invalid_memory_request("session_key is required"));
        }
        let mut evidence_messages = Vec::new();
        for (offset, message) in params.messages.iter().enumerate() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let content = conversation_evidence_text(message);
            if content.trim().is_empty() {
                continue;
            }
            evidence_messages.push((
                params.start_index.unwrap_or(0) + offset,
                role.to_string(),
                content,
                message
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(memory_timestamp),
            ));
        }
        if evidence_messages.is_empty() {
            return Ok(serde_json::json!({ "evidence": [] }));
        }
        let turn_id = generate_conversation_turn_id(session_key, &evidence_messages);
        let existing_ids = self.read_conversation_evidence_ids()?;
        let mut known_ids = existing_ids;
        let mut written = Vec::new();
        for (message_index, role, content, timestamp) in evidence_messages {
            let evidence_id = generate_conversation_evidence_id(
                session_key,
                &turn_id,
                &role,
                &content,
                message_index,
            );
            if known_ids.contains(&evidence_id) {
                continue;
            }
            let cursor = self.next_evidence_cursor()?;
            let record = serde_json::json!({
                "id": evidence_id,
                "turn_id": turn_id,
                "session_key": session_key,
                "role": role,
                "content": content,
                "timestamp": timestamp,
                "message_index": message_index,
                "cursor": cursor
            });
            self.append_conversation_evidence_record(&record)?;
            self.write_evidence_sequence(cursor)?;
            known_ids.insert(record["id"].as_str().unwrap_or_default().to_string());
            written.push(record);
        }
        Ok(serde_json::json!({ "evidence": written }))
    }

    fn list_evidence(
        &self,
        params: MemoryListEvidenceParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let mut evidence = self.read_conversation_evidence_records()?;
        if let Some(session_key) = params.session_key {
            evidence.retain(|record| {
                record.get("session_key").and_then(Value::as_str) == Some(session_key.as_str())
            });
        }
        if let Some(since_cursor) = params.since_cursor {
            evidence.retain(|record| {
                record
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .is_some_and(|cursor| cursor > since_cursor as u64)
            });
        }
        evidence.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor
                .cmp(&right_cursor)
                .then_with(|| {
                    left.get("timestamp")
                        .and_then(Value::as_str)
                        .cmp(&right.get("timestamp").and_then(Value::as_str))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
        if let Some(limit) = params.limit {
            evidence.truncate(limit);
        }
        Ok(serde_json::json!({ "evidence": evidence }))
    }

    fn save(
        &self,
        params: MemorySaveParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let content = params.content.trim();
        if content.is_empty() {
            return Err(invalid_memory_request("Memory Note content is required"));
        }
        let note_type = validate_memory_value("note_type", &params.note_type, MEMORY_NOTE_TYPES)?;
        let scope = params
            .scope
            .as_deref()
            .map(|value| validate_memory_value("scope", value, MEMORY_NOTE_SCOPES))
            .transpose()?
            .map(str::to_string)
            .unwrap_or_else(|| default_memory_scope(note_type).to_string());
        let priority = validate_memory_score("priority", params.priority.unwrap_or(0.5))?;
        let confidence = validate_memory_score("confidence", params.confidence.unwrap_or(0.5))?;
        let metadata = match params.metadata {
            Some(value) if value.is_object() => value,
            Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
            None => serde_json::json!({}),
        };
        let tags: Vec<String> = params
            .tags
            .unwrap_or_default()
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        let mut source = serde_json::json!({ "capture_origin": "explicit" });
        if let Some(session_id) = params.session_id.filter(|value| !value.trim().is_empty()) {
            source["session_key"] = Value::String(session_id);
        }
        if let Some(message_start) = params.message_start {
            source["message_start"] = serde_json::json!(message_start);
        }
        if let Some(message_end) = params.message_end {
            source["message_end"] = serde_json::json!(message_end);
        }
        let timestamp = memory_timestamp();
        let note_id = generate_memory_note_id(note_type, &scope, content, &source);
        let mut note = serde_json::json!({
            "id": note_id,
            "scope": scope,
            "type": note_type,
            "status": "active",
            "content": content,
            "priority": priority,
            "confidence": confidence,
            "sources": [source],
            "created_at": timestamp,
            "updated_at": timestamp
        });
        if !tags.is_empty() {
            note["tags"] = serde_json::json!(tags);
        }
        if metadata
            .as_object()
            .is_some_and(|object| !object.is_empty())
        {
            note["metadata"] = metadata;
        }

        let mut notes = self.read_notes()?;
        notes.retain(|existing| existing.get("id") != note.get("id"));
        notes.push(note.clone());
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({ "note": note }))
    }

    fn trace(
        &self,
        params: MemoryNoteIdParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryRead)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let (note, line) = self.find_note_with_line(note_id)?;
        Ok(serde_json::json!({
            "note": note,
            "locations": memory_note_locations(&note, line)
        }))
    }

    fn reject(
        &self,
        params: MemoryRejectParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let mut notes = self.read_notes()?;
        let timestamp = memory_timestamp();
        let note = find_note_mut(&mut notes, note_id)?;
        note["status"] = Value::String("rejected".to_string());
        note["updated_at"] = Value::String(timestamp);
        if let Some(reason) = params.reason.filter(|reason| !reason.trim().is_empty()) {
            ensure_json_object_field(note, "metadata");
            note["metadata"]["rejected_reason"] = Value::String(reason);
        }
        let rejected = note.clone();
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({
            "note": rejected,
            "views_refreshed": true
        }))
    }

    fn supersede(
        &self,
        params: MemorySupersedeParams,
    ) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        self.require(WorkerCapability::MemoryWrite)?;
        let note_id = required_memory_note_id(&params.note_id)?;
        let replacement_content = params.replacement_content.trim();
        if replacement_content.is_empty() {
            return Err(invalid_memory_request(
                "Replacement Memory Note content is required",
            ));
        }
        let mut notes = self.read_notes()?;
        let old_note = notes
            .iter()
            .find(|note| note.get("id").and_then(Value::as_str) == Some(note_id))
            .cloned()
            .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))?;
        let note_type = match params.note_type {
            Some(note_type) => {
                validate_memory_value("note_type", &note_type, MEMORY_NOTE_TYPES)?.to_string()
            }
            None => old_note
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("project")
                .to_string(),
        };
        let scope = match params.scope {
            Some(scope) => validate_memory_value("scope", &scope, MEMORY_NOTE_SCOPES)?.to_string(),
            None => old_note
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or_else(|| default_memory_scope(&note_type))
                .to_string(),
        };
        let priority = validate_memory_score(
            "priority",
            params
                .priority
                .or_else(|| old_note.get("priority").and_then(Value::as_f64))
                .unwrap_or(0.5),
        )?;
        let confidence = validate_memory_score(
            "confidence",
            params
                .confidence
                .or_else(|| old_note.get("confidence").and_then(Value::as_f64))
                .unwrap_or(0.5),
        )?;
        let metadata = match params.metadata {
            Some(value) if value.is_object() => value,
            Some(_) => return Err(invalid_memory_request("metadata must be a JSON object")),
            None => old_note
                .get("metadata")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        };
        let tags = params.tags.unwrap_or_else(|| {
            old_note
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        });
        let tags: Vec<String> = tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        let mut source = serde_json::json!({ "capture_origin": "explicit" });
        if let Some(session_id) = params.session_id.filter(|value| !value.trim().is_empty()) {
            source["session_key"] = Value::String(session_id);
        }
        if let Some(message_start) = params.message_start {
            source["message_start"] = serde_json::json!(message_start);
        }
        if let Some(message_end) = params.message_end {
            source["message_end"] = serde_json::json!(message_end);
        }
        let timestamp = memory_timestamp();
        let replacement_id =
            generate_memory_note_id(&note_type, &scope, replacement_content, &source);
        let mut replacement = serde_json::json!({
            "id": replacement_id,
            "scope": scope,
            "type": note_type,
            "status": "active",
            "content": replacement_content,
            "priority": priority,
            "confidence": confidence,
            "sources": [source],
            "created_at": timestamp,
            "updated_at": timestamp,
            "supersedes": [note_id]
        });
        if !tags.is_empty() {
            replacement["tags"] = serde_json::json!(tags);
        }
        if metadata
            .as_object()
            .is_some_and(|object| !object.is_empty())
        {
            replacement["metadata"] = metadata;
        }
        notes.retain(|existing| existing.get("id") != replacement.get("id"));
        notes.push(replacement.clone());
        let old_note = find_note_mut(&mut notes, note_id)?;
        old_note["status"] = Value::String("superseded".to_string());
        old_note["superseded_by"] = replacement["id"].clone();
        old_note["updated_at"] = Value::String(memory_timestamp());
        let old_note = old_note.clone();
        self.write_notes(&notes)?;
        self.refresh_memory_views(&notes)?;
        Ok(serde_json::json!({
            "old_note": old_note,
            "note": replacement,
            "views_refreshed": true
        }))
    }

    fn require(
        &self,
        capability: WorkerCapability,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        if self.policy.allows(&capability) {
            return Ok(());
        }
        Err(crate::worker_protocol::WorkerProtocolError::new(
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied,
            "worker capability denied",
            serde_json::json!({ "capability": capability }),
            false,
            crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
        ))
    }

    fn notes_path(&self) -> PathBuf {
        self.workspace_root.join("memory").join("notes.jsonl")
    }

    fn dream_memory_context(&self) -> Result<Value, crate::worker_protocol::WorkerProtocolError> {
        let notes = self.read_notes()?;
        Ok(serde_json::json!({
            "current_notes": format_dream_current_notes(&notes),
            "current_memory": self.read_memory_text("memory/MEMORY.md", "(empty)")?,
            "current_soul": self.read_memory_text("SOUL.md", "(empty)")?,
            "current_user": self.read_memory_text("USER.md", "(empty)")?,
        }))
    }

    fn read_memory_text(
        &self,
        relative_path: &str,
        default_value: &str,
    ) -> Result<String, crate::worker_protocol::WorkerProtocolError> {
        match fs::read_to_string(self.workspace_root.join(relative_path)) {
            Ok(contents) => Ok(contents),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(default_value.to_string())
            }
            Err(error) => Err(memory_io_error(error)),
        }
    }

    fn dream_git_initialized(&self) -> bool {
        self.workspace_root.join(".git").is_dir()
    }

    fn last_dream_cursor(&self) -> usize {
        let path = self.workspace_root.join("memory").join(".dream_cursor");
        fs::read_to_string(path)
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0)
    }

    fn write_dream_cursor(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.workspace_root.join("memory").join(".dream_cursor");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
    }

    fn dream_log_commits(&self, max_entries: usize) -> Vec<DreamCommitInfo> {
        if max_entries == 0 {
            return vec![];
        }
        let max_entries = max_entries.to_string();
        let output = self.git_output(&[
            "log",
            "-n",
            &max_entries,
            "--date=format:%Y-%m-%d %H:%M",
            "--format=%H%x1f%cd%x1f%s%x1e",
        ]);
        output
            .unwrap_or_default()
            .split('\x1e')
            .filter_map(|record| {
                let record = record.trim();
                if record.is_empty() {
                    return None;
                }
                let mut parts = record.splitn(3, '\x1f');
                let sha = parts.next()?.trim();
                let timestamp = parts.next()?.trim();
                let message = parts.next().unwrap_or_default().trim();
                Some(DreamCommitInfo {
                    sha: sha.chars().take(8).collect(),
                    full_sha: sha.to_string(),
                    message: message.to_string(),
                    timestamp: timestamp.to_string(),
                })
            })
            .collect()
    }

    fn dream_show_commit_diff(
        &self,
        short_sha: &str,
        max_entries: usize,
    ) -> Option<(DreamCommitInfo, String)> {
        self.dream_log_commits(max_entries)
            .into_iter()
            .find(|commit| commit.sha.starts_with(short_sha))
            .map(|commit| {
                let diff = self.dream_commit_diff(&commit);
                (commit, diff)
            })
    }

    fn dream_commit_diff(&self, commit: &DreamCommitInfo) -> String {
        let parents = self
            .git_output(&["rev-list", "--parents", "-n", "1", &commit.full_sha])
            .unwrap_or_default();
        let mut parts = parents.split_whitespace();
        let Some(_commit_sha) = parts.next() else {
            return String::new();
        };
        let Some(parent_sha) = parts.next() else {
            return String::new();
        };
        self.git_output(&[
            "diff",
            "--no-color",
            parent_sha,
            &commit.full_sha,
            "--",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ])
        .unwrap_or_default()
    }

    fn dream_revert_commit(&self, short_sha: &str) -> Option<String> {
        let commit = self
            .dream_log_commits(20)
            .into_iter()
            .find(|commit| commit.sha.starts_with(short_sha))?;
        let parents = self
            .git_output(&["rev-list", "--parents", "-n", "1", &commit.full_sha])
            .unwrap_or_default();
        let mut parts = parents.split_whitespace();
        let _commit_sha = parts.next()?;
        let parent_sha = parts.next()?;
        let parent_sha = parent_sha.to_string();

        let mut restored = 0;
        for path in DREAM_TRACKED_MEMORY_FILES {
            let spec = format!("{parent_sha}:{path}");
            let Some(contents) = self.git_output_bytes(&["show", &spec]) else {
                continue;
            };
            let destination = self.workspace_root.join(path);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).ok()?;
            }
            fs::write(destination, contents).ok()?;
            restored += 1;
        }
        if restored == 0 {
            return None;
        }
        self.git_status(&[
            "add",
            "--",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ])?;
        if self
            .git_status(&["diff", "--cached", "--quiet", "--"])
            .is_some()
        {
            return None;
        }
        self.git_status(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            &format!("revert: undo {short_sha}"),
        ])?;
        self.git_output(&["rev-parse", "--short=8", "HEAD"])
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
    }

    fn git_output(&self, args: &[&str]) -> Option<String> {
        self.git_output_bytes(args)
            .map(|output| String::from_utf8_lossy(&output).into_owned())
    }

    fn git_output_bytes(&self, args: &[&str]) -> Option<Vec<u8>> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.workspace_root)
            .args(args)
            .output()
            .ok()?;
        output.status.success().then_some(output.stdout)
    }

    fn git_status(&self, args: &[&str]) -> Option<()> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.workspace_root)
            .args(args)
            .output()
            .ok()?;
        output.status.success().then_some(())
    }

    fn read_notes(&self) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        Ok(self
            .read_notes_with_lines()?
            .into_iter()
            .map(|(note, _line)| note)
            .collect())
    }

    fn read_notes_with_lines(
        &self,
    ) -> Result<Vec<(Value, usize)>, crate::worker_protocol::WorkerProtocolError> {
        let path = self.notes_path();
        Ok(read_jsonl_strict_with_lines::<Value>(&path)
            .map_err(memory_storage_error)?
            .into_iter()
            .filter(|(value, _line)| value.is_object())
            .collect())
    }

    fn find_note_with_line(
        &self,
        note_id: &str,
    ) -> Result<(Value, usize), crate::worker_protocol::WorkerProtocolError> {
        self.read_notes_with_lines()?
            .into_iter()
            .find(|(note, _line)| note.get("id").and_then(Value::as_str) == Some(note_id))
            .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))
    }

    fn write_notes(
        &self,
        notes: &[Value],
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        write_jsonl_atomic(&self.notes_path(), notes, AtomicWriteOptions::default())
            .map_err(memory_storage_error)
    }

    fn refresh_memory_views(
        &self,
        notes: &[Value],
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        for (view_file, title) in MEMORY_VIEW_TITLES {
            let rendered = render_memory_view_section(title, notes, view_file);
            let path = self.workspace_root.join(view_file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(memory_io_error)?;
            }
            let existing =
                fs::read_to_string(&path).unwrap_or_else(|_| default_memory_view(view_file));
            let updated = replace_managed_memory_view(&existing, title, &rendered);
            fs::write(path, updated).map_err(memory_io_error)?;
        }
        Ok(())
    }

    fn evidence_sequence_path(&self) -> PathBuf {
        self.workspace_root
            .join("memory")
            .join(".evidence_sequence")
    }

    fn evidence_cursor_path(&self) -> PathBuf {
        self.workspace_root.join("memory").join(".evidence_cursor")
    }

    fn write_evidence_cursor(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.evidence_cursor_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
    }

    fn conversations_dir(&self) -> PathBuf {
        self.workspace_root.join("memory").join("conversations")
    }

    fn conversation_evidence_path(&self, timestamp: &str) -> PathBuf {
        self.conversations_dir()
            .join(format!("{}.jsonl", conversation_evidence_date(timestamp)))
    }

    fn read_conversation_evidence_ids(
        &self,
    ) -> Result<std::collections::HashSet<String>, crate::worker_protocol::WorkerProtocolError>
    {
        let mut ids = std::collections::HashSet::new();
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            for value in read_jsonl_strict::<Value>(&path).map_err(memory_storage_error)? {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    ids.insert(id.to_string());
                }
            }
        }
        Ok(ids)
    }

    fn read_conversation_evidence_records(
        &self,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let mut records = Vec::new();
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            for value in read_jsonl_strict::<Value>(&path).map_err(memory_storage_error)? {
                if value.is_object() {
                    records.push(value);
                }
            }
        }
        Ok(records)
    }

    fn pending_conversation_evidence(
        &self,
        since_cursor: usize,
        limit: usize,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let mut evidence = self.read_conversation_evidence_records()?;
        evidence.retain(|record| {
            record
                .get("cursor")
                .and_then(Value::as_u64)
                .is_some_and(|cursor| cursor > since_cursor as u64)
        });
        evidence.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor
                .cmp(&right_cursor)
                .then_with(|| {
                    left.get("timestamp")
                        .and_then(Value::as_str)
                        .cmp(&right.get("timestamp").and_then(Value::as_str))
                })
                .then_with(|| {
                    left.get("id")
                        .and_then(Value::as_str)
                        .cmp(&right.get("id").and_then(Value::as_str))
                })
        });
        evidence.truncate(limit);
        Ok(evidence)
    }

    fn next_evidence_cursor(&self) -> Result<usize, crate::worker_protocol::WorkerProtocolError> {
        let sequence_path = self.evidence_sequence_path();
        if let Ok(contents) = fs::read_to_string(&sequence_path) {
            if let Ok(value) = contents.trim().parse::<usize>() {
                return Ok(value + 1);
            }
        }
        Ok(self.max_evidence_cursor()? + 1)
    }

    fn max_evidence_cursor(&self) -> Result<usize, crate::worker_protocol::WorkerProtocolError> {
        let mut max_cursor = 0;
        let conversations_dir = self.conversations_dir();
        let entries = match fs::read_dir(&conversations_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(memory_io_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(memory_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            for value in read_jsonl_strict::<Value>(&path).map_err(memory_storage_error)? {
                if let Some(cursor) = value.get("cursor").and_then(Value::as_u64) {
                    max_cursor = max_cursor.max(cursor as usize);
                }
            }
        }
        Ok(max_cursor)
    }

    fn last_evidence_cursor(&self) -> usize {
        fs::read_to_string(self.evidence_cursor_path())
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0)
    }

    fn pending_legacy_history(
        &self,
        limit: usize,
    ) -> Result<Vec<Value>, crate::worker_protocol::WorkerProtocolError> {
        let path = self.workspace_root.join("memory").join("history.jsonl");
        let since_cursor = self.last_dream_cursor() as u64;
        let mut history = read_jsonl_strict::<Value>(&path)
            .map_err(memory_storage_error)?
            .into_iter()
            .filter(|value| {
                value
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .is_some_and(|cursor| cursor > since_cursor)
            })
            .collect::<Vec<_>>();
        history.sort_by(|left, right| {
            let left_cursor = left.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let right_cursor = right.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            left_cursor.cmp(&right_cursor).then_with(|| {
                left.get("timestamp")
                    .and_then(Value::as_str)
                    .cmp(&right.get("timestamp").and_then(Value::as_str))
            })
        });
        history.truncate(limit);
        Ok(history)
    }

    fn append_conversation_evidence_record(
        &self,
        record: &Value,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = self.conversation_evidence_path(timestamp);
        let mut records = read_jsonl_strict::<Value>(&path).map_err(memory_storage_error)?;
        records.push(record.clone());
        write_jsonl_atomic(&path, &records, AtomicWriteOptions::default())
            .map_err(memory_storage_error)
    }

    fn write_evidence_sequence(
        &self,
        cursor: usize,
    ) -> Result<(), crate::worker_protocol::WorkerProtocolError> {
        let path = self.evidence_sequence_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(memory_io_error)?;
        }
        fs::write(path, cursor.to_string()).map_err(memory_io_error)
    }
}

#[derive(Deserialize)]
struct MemorySearchParams {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryRecallParams {
    #[serde(default)]
    query: String,
    #[serde(default)]
    max_notes: Option<usize>,
    #[serde(default)]
    max_chars: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryDreamParams {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Clone, Debug)]
struct DreamCommitInfo {
    sha: String,
    full_sha: String,
    message: String,
    timestamp: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DreamExtractionResult {
    captured_notes: usize,
    skipped_evidence: usize,
    last_evidence_cursor: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DreamLegacyExtractionResult {
    captured_notes: usize,
    skipped_history: usize,
    last_dream_cursor: usize,
}

#[derive(Deserialize)]
struct MemoryCaptureEvidenceParams {
    session_key: String,
    #[serde(default)]
    start_index: Option<usize>,
    #[serde(default)]
    messages: Vec<Value>,
}

#[derive(Deserialize)]
struct MemoryListEvidenceParams {
    #[serde(default)]
    since_cursor: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    session_key: Option<String>,
}

#[derive(Deserialize)]
struct MemoryNoteIdParams {
    note_id: String,
}

#[derive(Deserialize)]
struct MemoryRejectParams {
    note_id: String,
    #[serde(default)]
    reason: Option<String>,
}

const MEMORY_NOTE_TYPES: &[&str] = &[
    "preference",
    "instruction",
    "project",
    "decision",
    "fix",
    "followup",
];
const MEMORY_NOTE_SCOPES: &[&str] = &["user", "assistant", "project", "session"];
const MEMORY_NOTE_STATUSES: &[&str] = &["active", "superseded", "rejected"];
const MEMORY_VIEW_TITLES: &[(&str, &str)] = &[
    ("memory/MEMORY.md", "Project Memory Notes"),
    ("USER.md", "User Memory Notes"),
    ("SOUL.md", "Assistant Memory Notes"),
];
const DREAM_TRACKED_MEMORY_FILES: &[&str] = &[
    "SOUL.md",
    "USER.md",
    "memory/MEMORY.md",
    "memory/notes.jsonl",
];

fn invalid_memory_request(
    message: impl Into<String>,
) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({ "method": "memory" }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn memory_dream_unavailable(content: &str) -> Value {
    memory_dream_result(content, false)
}

fn memory_dream_result(content: &str, available: bool) -> Value {
    memory_dream_result_with_metadata(content, available, serde_json::json!({}))
}

fn memory_dream_result_with_metadata(
    content: &str,
    available: bool,
    extra_metadata: Value,
) -> Value {
    let mut metadata = serde_json::json!({
        "render_as": "text",
        "available": available
    });
    if let (Some(base), Some(extra)) = (metadata.as_object_mut(), extra_metadata.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    serde_json::json!({
        "content": content,
        "metadata": metadata
    })
}

fn memory_dream_pending_batch(
    kind: &str,
    records: Vec<Value>,
    last_cursor: Option<usize>,
    memory_context: Value,
) -> Value {
    let cursors: Vec<usize> = records
        .iter()
        .filter_map(|record| {
            record
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|cursor| cursor as usize)
        })
        .collect();
    let cursor_start = cursors.iter().min().copied().unwrap_or(0);
    let cursor_end = cursors.iter().max().copied().unwrap_or(cursor_start);
    let evidence_ids: Vec<String> = records
        .iter()
        .filter_map(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
        .collect();
    serde_json::json!({
        "kind": kind,
        "records": records,
        "pending_evidence": if kind == "conversation_evidence" { cursors.len() } else { 0 },
        "pending_legacy_history": if kind == "legacy_history" { cursors.len() } else { 0 },
        "cursor_start": cursor_start,
        "cursor_end": cursor_end,
        "last_cursor": last_cursor.unwrap_or(0),
        "evidence_ids": evidence_ids,
        "memory_context": memory_context
    })
}

fn format_dream_current_notes(notes: &[Value]) -> String {
    let mut active_notes = notes
        .iter()
        .filter(|note| {
            note.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active")
                == "active"
        })
        .collect::<Vec<_>>();
    active_notes.sort_by(|left, right| {
        let left_key = (
            left.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active"),
            left.get("type")
                .and_then(Value::as_str)
                .unwrap_or("project"),
            left.get("content").and_then(Value::as_str).unwrap_or(""),
        );
        let right_key = (
            right
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("active"),
            right
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("project"),
            right.get("content").and_then(Value::as_str).unwrap_or(""),
        );
        left_key.cmp(&right_key)
    });
    if active_notes.is_empty() {
        return "(no Memory Notes)".to_string();
    }
    active_notes
        .into_iter()
        .map(|note| {
            format!(
                "- id={} status={} scope={} type={} priority={} confidence={}: {}",
                note.get("id").and_then(Value::as_str).unwrap_or("unknown"),
                note.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("active"),
                note.get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("project"),
                note.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("project"),
                format_memory_number(note.get("priority").and_then(Value::as_f64).unwrap_or(0.5)),
                format_memory_number(
                    note.get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.5)
                ),
                note.get("content").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn dream_note_content(record: &Value) -> Option<String> {
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if role != "user" && role != "assistant" {
        return None;
    }
    record
        .get("content")
        .and_then(Value::as_str)
        .and_then(dream_memory_text)
}

fn dream_memory_text(content: &str) -> Option<String> {
    let content = content
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if content.len() < 8 || content.len() > 2_000 {
        return None;
    }
    let lower = content.to_ascii_lowercase();
    let has_memory_intent = [
        "remember",
        "persist",
        "save this",
        "keep this",
        "note that",
        "preference",
        "prefer",
        "decided",
        "decision",
        "follow up",
        "follow-up",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    has_memory_intent.then_some(content)
}

fn dream_note_type(content: &str) -> &'static str {
    let lower = content.to_ascii_lowercase();
    if lower.contains("prefer") || lower.contains("preference") {
        "preference"
    } else if lower.contains("decided") || lower.contains("decision") {
        "decision"
    } else if lower.contains("fix") || lower.contains("bug") || lower.contains("regression") {
        "fix"
    } else if lower.contains("follow up") || lower.contains("follow-up") || lower.contains("todo") {
        "followup"
    } else {
        "project"
    }
}

fn dream_log_content(commit: &DreamCommitInfo, diff: &str, requested_sha: Option<&str>) -> String {
    let mut lines = vec![
        "## Dream Update".to_string(),
        String::new(),
        if requested_sha.is_some() {
            "Here is the selected Dream memory change.".to_string()
        } else {
            "Here is the latest Dream memory change.".to_string()
        },
        String::new(),
        format!("- Commit: `{}`", commit.sha),
        format!("- Time: {}", commit.timestamp),
        format!("- Changed files: {}", format_dream_changed_files(diff)),
    ];
    if diff.trim().is_empty() {
        lines.extend([
            String::new(),
            "Dream recorded this version, but there is no file diff to display.".to_string(),
        ]);
    } else {
        lines.extend([
            String::new(),
            format!("Use `/dream-restore {}` to undo this change.", commit.sha),
            String::new(),
            "```diff".to_string(),
            diff.trim_end().to_string(),
            "```".to_string(),
        ]);
    }
    lines.join("\n")
}

fn dream_restore_list_content(commits: &[DreamCommitInfo]) -> String {
    let mut lines = vec![
        "## Dream Restore".to_string(),
        String::new(),
        "Choose a Dream memory version to restore. Latest first:".to_string(),
        String::new(),
    ];
    for commit in commits {
        let summary = commit.message.lines().next().unwrap_or_default();
        lines.push(format!(
            "- `{}` {} - {}",
            commit.sha, commit.timestamp, summary
        ));
    }
    lines.extend([
        String::new(),
        "Preview a version with `/dream-log <sha>` before restoring it.".to_string(),
        "Restore a version with `/dream-restore <sha>`.".to_string(),
    ]);
    lines.join("\n")
}

fn format_dream_changed_files(diff: &str) -> String {
    let files = extract_dream_changed_files(diff);
    if files.is_empty() {
        return "No tracked memory files changed.".to_string();
    }
    files
        .into_iter()
        .map(|path| format!("`{path}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn extract_dream_changed_files(diff: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in diff.lines() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let _diff = parts.next();
        let _git = parts.next();
        let _left = parts.next();
        let Some(right) = parts.next() else {
            continue;
        };
        let path = right.strip_prefix("b/").unwrap_or(right).to_string();
        if !files.contains(&path) {
            files.push(path);
        }
    }
    files
}

fn required_memory_note_id(
    note_id: &str,
) -> Result<&str, crate::worker_protocol::WorkerProtocolError> {
    let note_id = note_id.trim();
    if note_id.is_empty() {
        return Err(invalid_memory_request("Memory Note id is required"));
    }
    Ok(note_id)
}

fn find_note_mut<'a>(
    notes: &'a mut [Value],
    note_id: &str,
) -> Result<&'a mut Value, crate::worker_protocol::WorkerProtocolError> {
    notes
        .iter_mut()
        .find(|note| note.get("id").and_then(Value::as_str) == Some(note_id))
        .ok_or_else(|| invalid_memory_request(format!("Memory Note not found: {note_id}")))
}

fn ensure_json_object_field(note: &mut Value, field: &str) {
    if !note.get(field).is_some_and(Value::is_object) {
        note[field] = serde_json::json!({});
    }
}

fn memory_note_locations(note: &Value, line: usize) -> Value {
    let view_file = note
        .get("type")
        .and_then(Value::as_str)
        .map(memory_note_view_file)
        .unwrap_or("memory/MEMORY.md");
    serde_json::json!({
        "file": "memory/notes.jsonl",
        "line": line,
        "view_file": view_file
    })
}

fn memory_recall_reference(note: &Value) -> Value {
    let mut reference = serde_json::json!({
        "note_id": note.get("id").cloned().unwrap_or(Value::Null),
        "scope": note.get("scope").cloned().unwrap_or(Value::String("project".to_string())),
        "type": note.get("type").cloned().unwrap_or(Value::String("project".to_string())),
        "status": note.get("status").cloned().unwrap_or(Value::String("active".to_string())),
        "content": note.get("content").cloned().unwrap_or(Value::String(String::new())),
        "priority": note.get("priority").cloned().unwrap_or(serde_json::json!(0.5)),
        "confidence": note.get("confidence").cloned().unwrap_or(serde_json::json!(0.5)),
        "tags": note.get("tags").cloned().unwrap_or(serde_json::json!([])),
        "metadata": note.get("metadata").cloned().unwrap_or(serde_json::json!({})),
    });
    for key in ["file", "line", "view_file", "view_line"] {
        if let Some(value) = note.get(key) {
            reference[key] = value.clone();
        }
    }
    let evidence_ids = memory_note_evidence_ids(note);
    if !evidence_ids.is_empty() {
        reference["evidence_ids"] = serde_json::json!(evidence_ids);
    }
    reference
}

fn render_memory_recall_context(notes: &[Value], max_chars: usize) -> String {
    if notes.is_empty() || max_chars == 0 {
        return String::new();
    }
    let mut lines = vec![
        "---".to_string(),
        "[MEMORY RECALL]".to_string(),
        String::new(),
        "Active Memory Notes selected for this request. Keep this separate from Experience and Knowledge Base context.".to_string(),
        String::new(),
    ];
    for note in notes {
        lines.push(format_memory_recall_note(note));
    }
    lines.push("---".to_string());
    truncate_memory_context(&lines.join("\n"), max_chars)
}

fn format_memory_recall_note(note: &Value) -> String {
    let content = note.get("content").and_then(Value::as_str).unwrap_or("");
    let id = note.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let scope = note
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("project");
    let note_type = note
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("project");
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    let tags = note
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .map(|value| format!("; tags: {value}"))
        .unwrap_or_default();
    format!(
        "- {content} (id: {id}; scope: {scope}; type: {note_type}; priority: {}; confidence: {}{tags})",
        format_memory_number(priority),
        format_memory_number(confidence)
    )
}

fn truncate_memory_context(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars.saturating_sub(3)).collect();
    truncated.push_str("...");
    truncated
}

fn memory_note_evidence_ids(note: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(sources) = note.get("sources").and_then(Value::as_array) {
        for source in sources {
            if let Some(evidence_ids) = source.get("evidence_ids").and_then(Value::as_array) {
                for evidence_id in evidence_ids {
                    if let Some(evidence_id) = evidence_id.as_str() {
                        ids.push(evidence_id.to_string());
                    }
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn conversation_evidence_text(message: &Value) -> String {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
        return String::new();
    }
    if role == "assistant" && message.get("tool_calls").is_some_and(Value::is_array) {
        return String::new();
    }
    match message.get("content") {
        Some(Value::String(content)) => strip_think_tags(content).trim().to_string(),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                let Some(block) = block.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            let text = strip_think_tags(text).trim().to_string();
                            if !text.is_empty() {
                                parts.push(text);
                            }
                        }
                    }
                    Some("image_url") => parts.push("[media omitted]".to_string()),
                    _ => {}
                }
            }
            parts.join("\n").trim().to_string()
        }
        _ => String::new(),
    }
}

fn strip_think_tags(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    loop {
        let Some(start) = rest.find("<think>") else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let after_start = &rest[start + "<think>".len()..];
        if let Some(end) = after_start.find("</think>") {
            rest = &after_start[end + "</think>".len()..];
        } else {
            break;
        }
    }
    output
}

fn generate_conversation_turn_id(
    session_key: &str,
    messages: &[(usize, String, String, String)],
) -> String {
    let mut payload = String::new();
    payload.push_str(session_key);
    for (message_index, role, content, _) in messages {
        payload.push('|');
        payload.push_str(&message_index.to_string());
        payload.push(':');
        payload.push_str(role);
        payload.push(':');
        payload.push_str(content);
    }
    format!("turn_{:016x}", stable_memory_hash(&payload))
}

fn generate_conversation_evidence_id(
    session_key: &str,
    turn_id: &str,
    role: &str,
    content: &str,
    message_index: usize,
) -> String {
    format!(
        "ev_{:016x}",
        stable_memory_hash(&format!(
            "{session_key}|{turn_id}|{role}|{content}|{message_index}"
        ))
    )
}

fn stable_memory_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn conversation_evidence_date(timestamp: &str) -> String {
    let candidate = timestamp.get(..10).unwrap_or_default();
    if is_iso_date(candidate) {
        candidate.to_string()
    } else {
        memory_timestamp_date()
    }
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn memory_timestamp_date() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or_default();
    // Civil date conversion based on Howard Hinnant's days_from_civil inverse.
    let z = days as i64 + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{year:04}-{m:02}-{d:02}")
}

#[derive(Deserialize)]
struct MemorySaveParams {
    #[serde(default)]
    session_id: Option<String>,
    content: String,
    note_type: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    message_start: Option<usize>,
    #[serde(default)]
    message_end: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryDreamApplyParams {
    #[serde(default)]
    session_id: Option<String>,
    kind: String,
    #[serde(default)]
    cursor_start: Option<usize>,
    #[serde(default)]
    cursor_end: Option<usize>,
    #[serde(default)]
    evidence_ids: Option<Vec<String>>,
    #[serde(default)]
    notes: Vec<MemoryDreamApplyNoteParams>,
}

#[derive(Deserialize)]
struct MemoryDreamApplyNoteParams {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    target_note_id: Option<String>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    evidence_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct MemorySupersedeParams {
    note_id: String,
    replacement_content: String,
    #[serde(default)]
    note_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    priority: Option<f64>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    message_start: Option<usize>,
    #[serde(default)]
    message_end: Option<usize>,
}

fn memory_io_error(error: std::io::Error) -> crate::worker_protocol::WorkerProtocolError {
    crate::worker_protocol::WorkerProtocolError::new(
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError,
        "memory note store I/O failed",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn memory_storage_error(error: WorkerStorageError) -> crate::worker_protocol::WorkerProtocolError {
    let code = if matches!(error, WorkerStorageError::Io { .. }) {
        crate::worker_protocol::WorkerProtocolErrorCode::WorkerError
    } else {
        crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
    };
    crate::worker_protocol::WorkerProtocolError::new(
        code,
        "memory JSONL store failed",
        serde_json::json!({ "error": error.to_string() }),
        false,
        crate::worker_protocol::WorkerProtocolErrorSource::RustCore,
    )
}

fn validate_memory_value<'a>(
    field: &str,
    value: &'a str,
    allowed: &[&str],
) -> Result<&'a str, crate::worker_protocol::WorkerProtocolError> {
    if allowed.contains(&value) {
        return Ok(value);
    }
    Err(invalid_memory_request(format!(
        "Invalid Memory Note {field}: {value:?}. Allowed: {}",
        allowed.join(", ")
    )))
}

fn validate_optional_memory_value(
    field: &str,
    value: Option<String>,
    allowed: &[&str],
) -> Result<Option<String>, crate::worker_protocol::WorkerProtocolError> {
    match value.filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(Some(
            validate_memory_value(field, &value, allowed)?.to_string(),
        )),
        None => Ok(None),
    }
}

fn validate_memory_score(
    field: &str,
    value: f64,
) -> Result<f64, crate::worker_protocol::WorkerProtocolError> {
    if (0.0..=1.0).contains(&value) {
        return Ok(value);
    }
    Err(invalid_memory_request(format!(
        "{field} must be between 0 and 1"
    )))
}

fn default_memory_scope(note_type: &str) -> &'static str {
    match note_type {
        "preference" => "user",
        "instruction" => "assistant",
        _ => "project",
    }
}

fn parse_legacy_memory_markdown(content: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut in_fence = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with("```") {
            flush_legacy_memory_paragraph(&mut items, &mut paragraph);
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if line.is_empty() {
            flush_legacy_memory_paragraph(&mut items, &mut paragraph);
            continue;
        }
        if line.starts_with('#') {
            flush_legacy_memory_paragraph(&mut items, &mut paragraph);
            continue;
        }
        if let Some(text) = legacy_bullet_text(line) {
            flush_legacy_memory_paragraph(&mut items, &mut paragraph);
            if !text.is_empty() {
                items.push(text);
            }
            continue;
        }
        paragraph.push(line.to_string());
    }

    flush_legacy_memory_paragraph(&mut items, &mut paragraph);
    items
}

fn flush_legacy_memory_paragraph(items: &mut Vec<String>, paragraph: &mut Vec<String>) {
    if paragraph.is_empty() {
        return;
    }
    let text = paragraph.join(" ").trim().to_string();
    if !text.is_empty() {
        items.push(text);
    }
    paragraph.clear();
}

fn legacy_bullet_text(line: &str) -> Option<String> {
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest.trim().to_string());
        }
    }

    let mut digit_end = 0usize;
    for (index, character) in line.char_indices() {
        if character.is_ascii_digit() {
            digit_end = index + character.len_utf8();
            continue;
        }
        break;
    }
    if digit_end == 0 {
        return None;
    }
    let rest = &line[digit_end..];
    let marker = rest.chars().next()?;
    if marker != '.' && marker != ')' {
        return None;
    }
    let after_marker = &rest[marker.len_utf8()..];
    if !after_marker.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    Some(after_marker.trim().to_string())
}

fn memory_query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn memory_note_matches(note: &Value, key: &str, expected: Option<&str>) -> bool {
    expected.is_none_or(|expected| note.get(key).and_then(Value::as_str) == Some(expected))
}

fn memory_note_matches_query(note: &Value, query_terms: &[String]) -> bool {
    let haystack = memory_note_search_text(note);
    query_terms.iter().all(|term| haystack.contains(term))
}

fn memory_note_score(note: &Value, query_terms: &[String]) -> f64 {
    let haystack = memory_note_search_text(note);
    let query_score = query_terms
        .iter()
        .filter(|term| haystack.contains(term.as_str()))
        .count() as f64;
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    query_score + priority + confidence
}

fn memory_note_search_text(note: &Value) -> String {
    let mut fields = vec![];
    for key in ["id", "scope", "type", "status", "content"] {
        if let Some(value) = note.get(key).and_then(Value::as_str) {
            fields.push(value.to_ascii_lowercase());
        }
    }
    if let Some(tags) = note.get("tags").and_then(Value::as_array) {
        for tag in tags {
            if let Some(value) = tag.as_str() {
                fields.push(value.to_ascii_lowercase());
            }
        }
    }
    fields.join(" ")
}

fn annotate_memory_note_location(mut note: Value, line: usize) -> Value {
    note["file"] = Value::String("memory/notes.jsonl".to_string());
    note["line"] = serde_json::json!(line);
    if let Some(note_type) = note.get("type").and_then(Value::as_str) {
        note["view_file"] = Value::String(memory_note_view_file(note_type).to_string());
    }
    note
}

fn memory_note_view_file(note_type: &str) -> &'static str {
    match note_type {
        "preference" => "USER.md",
        "instruction" => "SOUL.md",
        _ => "memory/MEMORY.md",
    }
}

fn memory_note_view_file_for_note(note: &Value) -> &'static str {
    match note.get("scope").and_then(Value::as_str) {
        Some("user") => "USER.md",
        Some("assistant") => "SOUL.md",
        Some("project" | "session") => "memory/MEMORY.md",
        _ => note
            .get("type")
            .and_then(Value::as_str)
            .map(memory_note_view_file)
            .unwrap_or("memory/MEMORY.md"),
    }
}

fn default_memory_view(view_file: &str) -> String {
    match view_file {
        "USER.md" => {
            "# User Profile\n\n## User Memory Notes\n\n(No active Memory Notes.)\n".to_string()
        }
        "SOUL.md" => {
            "# Assistant Profile\n\n## Assistant Memory Notes\n\n(No active Memory Notes.)\n"
                .to_string()
        }
        _ => "# Long-term Memory\n\n## Project Memory Notes\n\n(No active Memory Notes.)\n"
            .to_string(),
    }
}

fn render_memory_view_section(title: &str, notes: &[Value], view_file: &str) -> String {
    let active_notes: Vec<&Value> = notes
        .iter()
        .filter(|note| {
            note.get("status")
                .and_then(Value::as_str)
                .unwrap_or("active")
                == "active"
        })
        .filter(|note| memory_note_view_file_for_note(note) == view_file)
        .collect();
    let mut lines = vec![
        format!("## {title}"),
        String::new(),
        "Edit durable memory through Memory Note operations instead of changing this section directly.".to_string(),
        String::new(),
    ];
    if active_notes.is_empty() {
        lines.push("(No active Memory Notes.)".to_string());
        return format!("{}\n", lines.join("\n"));
    }
    for note_type in MEMORY_NOTE_TYPES {
        let typed_notes: Vec<&Value> = active_notes
            .iter()
            .copied()
            .filter(|note| note.get("type").and_then(Value::as_str) == Some(*note_type))
            .collect();
        if typed_notes.is_empty() {
            continue;
        }
        lines.push(format!("### {}", memory_note_type_heading(note_type)));
        lines.push(String::new());
        for note in typed_notes {
            lines.push(render_memory_view_note(note));
        }
        lines.push(String::new());
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    format!("{}\n", lines.join("\n"))
}

fn render_memory_view_note(note: &Value) -> String {
    let id = note.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let content = note.get("content").and_then(Value::as_str).unwrap_or("");
    let priority = note.get("priority").and_then(Value::as_f64).unwrap_or(0.5);
    let confidence = note
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    let tags = note
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .filter(|tags| !tags.is_empty())
        .map(|tags| format!(" tags={tags}"))
        .unwrap_or_default();
    format!(
        "- [{id}] {content} priority={} confidence={}{}",
        format_memory_number(priority),
        format_memory_number(confidence),
        tags
    )
}

fn memory_note_type_heading(note_type: &str) -> String {
    let mut chars = note_type.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Memory".to_string(),
    }
}

fn format_memory_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn replace_managed_memory_view(existing: &str, title: &str, rendered: &str) -> String {
    let heading = format!("## {title}");
    if let Some(start) = existing.find(&heading) {
        let after_heading = &existing[start + heading.len()..];
        let end = after_heading
            .find("\n## ")
            .map(|offset| start + heading.len() + offset)
            .unwrap_or(existing.len());
        let prefix = existing[..start].trim_end();
        let suffix = existing[end..].trim_start();
        let mut parts = vec![];
        if !prefix.is_empty() {
            parts.push(prefix.to_string());
        }
        parts.push(rendered.trim_end().to_string());
        if !suffix.is_empty() {
            parts.push(suffix.to_string());
        }
        return format!("{}\n", parts.join("\n\n"));
    }
    if existing.trim().is_empty() {
        return rendered.to_string();
    }
    format!("{}\n\n{}", existing.trim_end(), rendered)
}

fn generate_memory_note_id(note_type: &str, scope: &str, content: &str, source: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    note_type.hash(&mut hasher);
    scope.hash(&mut hasher);
    content.hash(&mut hasher);
    source.to_string().hash(&mut hasher);
    format!("mem_{:016x}", hasher.finish())
}

fn memory_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{seconds}")
}
#[cfg(test)]
mod tests {
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::WorkerRequest;
    use crate::worker_rpc::WorkerRpcRouter;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static WORKSPACE_FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn dispatches_memory_save_and_search_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "session_id": "session-1",
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff", "communication"],
                "metadata": { "source": "desktop" },
                "message_start": 3,
                "message_end": 4
            }),
        );

        let save_response = router.dispatch(&save_request);
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let search_request = WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.search",
            json!({
                "query": "handoff",
                "note_type": "preference",
                "status": "active",
                "limit": 5
            }),
        );

        let search_response = router.dispatch(&search_request);
        let mut expected_search_note = saved_note.clone();
        expected_search_note["file"] = json!("memory/notes.jsonl");
        expected_search_note["line"] = json!(1);
        expected_search_note["view_file"] = json!("USER.md");

        assert_eq!(saved_note["scope"], "user");
        assert_eq!(saved_note["type"], "preference");
        assert_eq!(saved_note["status"], "active");
        assert_eq!(
            saved_note["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(saved_note["priority"], 0.8);
        assert_eq!(saved_note["confidence"], 0.7);
        assert_eq!(saved_note["tags"], json!(["handoff", "communication"]));
        assert_eq!(saved_note["metadata"], json!({ "source": "desktop" }));
        assert_eq!(
            saved_note["sources"],
            json!([
                {
                    "capture_origin": "explicit",
                    "session_key": "session-1",
                    "message_start": 3,
                    "message_end": 4
                }
            ])
        );
        assert_eq!(
            search_response.result,
            Some(json!({ "notes": [expected_search_note] }))
        );
        assert!(save_response.error.is_none());
        assert!(search_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("User prefers concise implementation handoffs."));
    }

    #[test]
    fn memory_search_rejects_invalid_notes_jsonl_line() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\nnot-json\n",
                json!({
                    "id": "note-1",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers concise handoffs.",
                    "priority": 0.8,
                    "confidence": 0.7,
                    "sources": []
                })
            ),
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-search",
            "trace-1",
            "memory.search",
            json!({ "query": "handoffs" }),
        ));

        let error = response
            .error
            .expect("invalid notes JSONL should fail the request");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "memory JSONL store failed");
        assert!(error.details["error"]
            .as_str()
            .unwrap_or_default()
            .contains("line 2"));
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_memory_recall_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let saved_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let note_id = saved_note["id"]
            .as_str()
            .expect("saved note should have id");

        let recall_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.recall",
            json!({
                "query": "handoff",
                "max_notes": 6,
                "max_chars": 1600
            }),
        ));

        let result = recall_response
            .result
            .as_ref()
            .expect("memory.recall should return result");
        assert_eq!(recall_response.error, None);
        assert!(result["context"]
            .as_str()
            .expect("context should be a string")
            .contains("[MEMORY RECALL]"));
        assert_eq!(result["notes"][0]["id"], note_id);
        assert_eq!(result["references"][0]["note_id"], note_id);
        assert_eq!(
            result["references"][0]["content"],
            "User prefers concise implementation handoffs."
        );
        assert_eq!(result["references"][0]["view_file"], "USER.md");
    }

    #[test]
    fn dispatches_memory_dream_log_for_latest_git_memory_commit() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({}),
        ));
        let result = response.result.expect("dream log should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream log content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Update"));
        assert!(content.contains("Here is the latest Dream memory change."));
        assert!(content.contains("- Changed files: `memory/MEMORY.md`"));
        assert!(content.contains("Use `/dream-restore "));
        assert!(content.contains("```diff"));
        assert!(content.contains("+Dream captured a durable fact."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_lists_recent_commits() {
        let fixture = dream_git_fixture();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore-list",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("## Dream Restore"));
        assert!(content.contains("Choose a Dream memory version to restore. Latest first:"));
        assert!(content.contains("dream: 2026-06-12, 1 change(s)"));
        assert!(content.contains("Preview a version with `/dream-log <sha>` before restoring it."));
        assert!(content.contains("Restore a version with `/dream-restore <sha>`."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_restore_reverts_selected_commit() {
        let fixture = dream_git_fixture();
        let sha = fixture.git_stdout(&["rev-parse", "--short=8", "HEAD"]);
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({ "sha": sha.trim() }),
        ));
        let result = response
            .result
            .expect("dream restore should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream restore content should be text");

        assert!(response.error.is_none());
        assert!(content.contains("Restored Dream memory to the state before"));
        assert!(content.contains("- New safety commit: `"));
        assert!(content.contains("- Restored files: `memory/MEMORY.md`"));
        assert_eq!(fixture.read("memory/MEMORY.md"), "Initial memory\n");
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
    }

    #[test]
    fn dispatches_memory_dream_run_reports_nothing_to_process_without_pending_evidence() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "Remember that I prefer workspace command policies.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(content
            .contains("Dream captured 1 memory note(s) from 1 conversation evidence record(s)."));
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["last_evidence_cursor"], json!(3));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "3");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\"]"));
        assert!(notes.contains("Remember that I prefer workspace command policies."));
    }

    #[test]
    fn dispatches_memory_dream_run_extracts_pending_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "User prefers concise progress updates."
                }),
                json!({
                    "cursor": 4,
                    "timestamp": "2026-06-12 03:01",
                    "content": "Short exchange with no durable memory."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");
        let content = result
            .get("content")
            .and_then(Value::as_str)
            .expect("dream run content should be text");

        assert!(response.error.is_none());
        assert!(
            content.contains("Dream captured 1 memory note(s) from 2 legacy history record(s).")
        );
        assert_eq!(result["metadata"]["render_as"], json!("text"));
        assert_eq!(result["metadata"]["available"], json!(true));
        assert_eq!(result["metadata"]["changed"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(2));
        assert_eq!(result["metadata"]["captured_notes"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(result["metadata"]["last_dream_cursor"], json!(4));
        assert_eq!(fixture.read("memory/.dream_cursor"), "4");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":3"));
        assert!(notes.contains("User prefers concise progress updates."));
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_conversation_evidence() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_evidence"], json!(1));
        assert_eq!(result["metadata"]["skipped_evidence"], json!(1));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_run_defers_non_explicit_legacy_history() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/history.jsonl",
            &format!(
                "{}\n",
                json!({
                    "cursor": 3,
                    "timestamp": "2026-06-12 03:00",
                    "content": "We discussed the desktop runtime behavior."
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({}),
        ));
        let result = response.result.expect("dream run should return content");

        assert!(response.error.is_none());
        assert_eq!(result["metadata"]["changed"], json!(false));
        assert_eq!(result["metadata"]["deferred"], json!(true));
        assert_eq!(result["metadata"]["pending_legacy_history"], json!(1));
        assert_eq!(result["metadata"]["skipped_history"], json!(1));
        assert_eq!(fixture.read("memory/.dream_cursor"), "2");
    }

    #[test]
    fn dispatches_memory_dream_pending_returns_deferred_conversation_evidence_batch() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "note_user_pref",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers compact migration slices.",
                    "priority": 0.8,
                    "confidence": 0.9,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/MEMORY.md", "Project memory view\n");
        fixture.write("SOUL.md", "Assistant memory view\n");
        fixture.write("USER.md", "User memory view\n");
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-pending",
            "trace-1",
            "memory.dream_pending",
            json!({}),
        ));
        let result = response
            .result
            .expect("dream pending should return a batch");

        assert!(response.error.is_none());
        assert_eq!(result["kind"], json!("conversation_evidence"));
        assert_eq!(result["pending_evidence"], json!(1));
        assert_eq!(result["cursor_start"], json!(3));
        assert_eq!(result["cursor_end"], json!(3));
        assert_eq!(result["evidence_ids"], json!(["ev_1"]));
        assert_eq!(
            result["records"][0]["content"],
            json!("We discussed the desktop runtime behavior.")
        );
        assert!(result["memory_context"]["current_notes"]
            .as_str()
            .unwrap_or_default()
            .contains("id=note_user_pref status=active scope=user type=preference"));
        assert_eq!(
            result["memory_context"]["current_memory"],
            json!("Project memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_soul"],
            json!("Assistant memory view\n")
        );
        assert_eq!(
            result["memory_context"]["current_user"],
            json!("User memory view\n")
        );
    }

    #[test]
    fn memory_dream_pending_rejects_invalid_conversation_jsonl_line() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/conversations/2026-06-12.jsonl",
            &format!(
                "{}\nnot-json\n",
                json!({
                    "id": "ev_1",
                    "turn_id": "turn_1",
                    "session_key": "desktop:session-1",
                    "role": "user",
                    "content": "We discussed the desktop runtime behavior.",
                    "timestamp": "2026-06-12T03:00:00Z",
                    "message_index": 1,
                    "cursor": 3
                })
            ),
        );
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-pending",
            "trace-1",
            "memory.dream_pending",
            json!({}),
        ));

        let error = response
            .error
            .expect("invalid conversation JSONL should fail the request");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::InvalidProtocol
        );
        assert_eq!(error.message, "memory JSONL store failed");
        assert!(error.details["error"]
            .as_str()
            .unwrap_or_default()
            .contains("line 2"));
        assert!(response.result.is_none());
    }

    #[test]
    fn dispatches_memory_dream_apply_writes_provider_notes_with_dream_source_and_advances_cursor() {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/.evidence_cursor", "2");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "conversation_evidence",
                "session_id": "desktop:session-1",
                "cursor_start": 3,
                "cursor_end": 5,
                "evidence_ids": ["ev_1", "ev_2"],
                "notes": [{
                    "content": "User wants desktop runtime migration slices to stay reasonably sized.",
                    "note_type": "preference",
                    "scope": "user",
                    "priority": 0.7,
                    "confidence": 0.8,
                    "tags": ["migration"],
                    "metadata": { "source": "provider" }
                }]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(1));
        assert_eq!(result["last_evidence_cursor"], json!(5));
        assert_eq!(fixture.read("memory/.evidence_cursor"), "5");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"evidence_ids\":[\"ev_1\",\"ev_2\"]"));
        assert!(notes.contains("\"history_start_cursor\":3"));
        assert!(notes.contains("\"history_end_cursor\":5"));
        assert!(notes.contains("\"extractor\":\"ts_provider_dream\""));
        assert!(
            notes.contains("User wants desktop runtime migration slices to stay reasonably sized.")
        );
    }

    #[test]
    fn dispatches_memory_dream_apply_rejects_and_supersedes_provider_operations() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/notes.jsonl",
            &format!(
                "{}\n{}\n",
                json!({
                    "id": "note_reject",
                    "scope": "project",
                    "type": "project",
                    "status": "active",
                    "content": "Temporary runtime discussion should be durable.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                }),
                json!({
                    "id": "note_old",
                    "scope": "user",
                    "type": "preference",
                    "status": "active",
                    "content": "User prefers very tiny migration commits.",
                    "priority": 0.5,
                    "confidence": 0.5,
                    "sources": [{ "capture_origin": "explicit" }],
                    "created_at": "2026-06-13T00:00:00Z",
                    "updated_at": "2026-06-13T00:00:00Z"
                })
            ),
        );
        fixture.write("memory/.dream_cursor", "3");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-apply",
            "trace-1",
            "memory.dream_apply",
            json!({
                "kind": "legacy_history",
                "cursor_start": 4,
                "cursor_end": 6,
                "notes": [
                    {
                        "action": "reject",
                        "target_note_id": "note_reject",
                        "metadata": { "reason": "provider correction" }
                    },
                    {
                        "action": "supersede",
                        "target_note_id": "note_old",
                        "content": "User prefers reasonably sized migration slices.",
                        "note_type": "preference",
                        "scope": "user",
                        "priority": 0.8,
                        "confidence": 0.9,
                        "tags": ["dream"]
                    }
                ]
            }),
        ));
        let result = response.result.expect("dream apply should return result");

        assert!(response.error.is_none());
        assert_eq!(result["applied_notes"], json!(2));
        assert_eq!(result["last_dream_cursor"], json!(6));
        assert_eq!(fixture.read("memory/.dream_cursor"), "6");
        let notes = fixture.read("memory/notes.jsonl");
        assert!(notes.contains("\"id\":\"note_reject\""));
        assert!(notes.contains("\"status\":\"rejected\""));
        assert!(notes.contains("\"id\":\"note_old\""));
        assert!(notes.contains("\"status\":\"superseded\""));
        assert!(notes.contains("\"supersedes\":[\"note_old\"]"));
        assert!(notes.contains("\"capture_origin\":\"dream\""));
        assert!(notes.contains("\"history_start_cursor\":4"));
        assert!(notes.contains("\"history_end_cursor\":6"));
        assert!(notes.contains("User prefers reasonably sized migration slices."));
    }

    #[test]
    fn dispatches_memory_dream_command_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let run_response = router.dispatch(&WorkerRequest::new(
            "req-run",
            "trace-1",
            "memory.dream_run",
            json!({ "session_id": "session-1" }),
        ));
        let log_response = router.dispatch(&WorkerRequest::new(
            "req-log",
            "trace-1",
            "memory.dream_log",
            json!({ "sha": "abc123" }),
        ));
        let restore_response = router.dispatch(&WorkerRequest::new(
            "req-restore",
            "trace-1",
            "memory.dream_restore",
            json!({}),
        ));

        assert_eq!(
            run_response.result,
            Some(json!({
                "content": "Dream: nothing to process.",
                "metadata": {
                    "render_as": "text",
                    "available": true,
                    "changed": false,
                    "pending_evidence": 0
                }
            }))
        );
        assert_eq!(
            log_response.result,
            Some(json!({
                "content": "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert_eq!(
            restore_response.result,
            Some(json!({
                "content": "Dream history is not available because memory versioning is not initialized.",
                "metadata": { "render_as": "text", "available": false }
            }))
        );
        assert!(run_response.error.is_none());
        assert!(log_response.error.is_none());
        assert!(restore_response.error.is_none());
    }

    #[test]
    fn dispatches_memory_capture_evidence_request() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.capture_evidence",
            json!({
                "session_key": "desktop:session-1",
                "start_index": 7,
                "messages": [
                    { "role": "user", "content": "Remember this migration note.", "timestamp": "2026-06-12T03:00:00Z" },
                    { "role": "assistant", "content": "Captured.", "timestamp": "2026-06-12T03:00:01Z" },
                    { "role": "assistant", "content": "", "tool_calls": [{ "id": "call-1" }] },
                    { "role": "tool", "content": "ignored" }
                ]
            }),
        ));

        let result = response
            .result
            .as_ref()
            .expect("memory.capture_evidence should return result");
        assert_eq!(response.error, None);
        assert_eq!(result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(result["evidence"][0]["session_key"], "desktop:session-1");
        assert_eq!(result["evidence"][0]["role"], "user");
        assert_eq!(
            result["evidence"][0]["content"],
            "Remember this migration note."
        );
        assert_eq!(result["evidence"][0]["message_index"], 7);
        assert_eq!(result["evidence"][0]["cursor"], 1);
        assert_eq!(result["evidence"][1]["role"], "assistant");
        assert_eq!(result["evidence"][1]["message_index"], 8);
        assert_eq!(result["evidence"][1]["cursor"], 2);
        assert!(fixture
            .read("memory/conversations/2026-06-12.jsonl")
            .contains("Remember this migration note."));
        assert_eq!(fixture.read("memory/.evidence_sequence").trim(), "2");

        let list_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.list_evidence",
            json!({ "session_key": "desktop:session-1", "limit": 10 }),
        ));
        let list_result = list_response
            .result
            .as_ref()
            .expect("memory.list_evidence should return result");
        assert_eq!(list_response.error, None);
        assert_eq!(list_result["evidence"].as_array().unwrap().len(), 2);
        assert_eq!(list_result["evidence"][0]["cursor"], 1);
        assert_eq!(list_result["evidence"][1]["cursor"], 2);
    }

    #[test]
    fn dispatches_memory_trace_reject_and_supersede_requests() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use npm test for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.6,
                "confidence": 0.65,
                "tags": ["testing"]
            }),
        ));
        let old_note = save_response
            .result
            .as_ref()
            .expect("memory.save should return result")["note"]
            .clone();
        let old_note_id = old_note["id"].as_str().expect("saved note should have id");

        let trace_response = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.trace",
            json!({ "note_id": old_note_id }),
        ));
        let supersede_response = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.supersede",
            json!({
                "note_id": old_note_id,
                "replacement_content": "Use vitest for TS worker tests.",
                "note_type": "instruction",
                "scope": "assistant",
                "priority": 0.8,
                "confidence": 0.9,
                "tags": ["testing", "typescript"],
                "metadata": { "reason": "TS worker tests run in Vitest" },
                "session_id": "session-1",
                "message_start": 5,
                "message_end": 6
            }),
        ));
        let replacement_id = supersede_response
            .result
            .as_ref()
            .expect("memory.supersede should return result")["note"]["id"]
            .as_str()
            .expect("replacement note should have id")
            .to_string();
        let reject_response = router.dispatch(&WorkerRequest::new(
            "req-4",
            "trace-1",
            "memory.reject",
            json!({ "note_id": replacement_id }),
        ));

        assert_eq!(
            trace_response.result.as_ref().unwrap()["note"]["id"],
            old_note_id
        );
        assert_eq!(
            trace_response.result.as_ref().unwrap()["locations"],
            json!({
                "file": "memory/notes.jsonl",
                "line": 1,
                "view_file": "SOUL.md"
            })
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["status"],
            "superseded"
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["old_note"]["superseded_by"],
            replacement_id
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["supersedes"],
            json!([old_note_id])
        );
        assert_eq!(
            supersede_response.result.as_ref().unwrap()["note"]["sources"],
            json!([{
                "capture_origin": "explicit",
                "session_key": "session-1",
                "message_start": 5,
                "message_end": 6
            }])
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["note"]["status"],
            "rejected"
        );
        assert_eq!(
            reject_response.result.as_ref().unwrap()["views_refreshed"],
            true
        );
        assert!(trace_response.error.is_none());
        assert!(supersede_response.error.is_none());
        assert!(reject_response.error.is_none());
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"superseded\""));
        assert!(fixture
            .read("memory/notes.jsonl")
            .contains("\"status\":\"rejected\""));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use npm test for TS worker tests."));
        assert!(!fixture
            .read("SOUL.md")
            .contains("Use vitest for TS worker tests."));
    }

    #[test]
    fn dispatches_memory_rebuild_index_as_unavailable_noop() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead]),
        );
        let response = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.rebuild_index",
            json!({}),
        ));

        assert_eq!(
            response.result,
            Some(json!({
                "available": false,
                "rebuilt": false,
                "indexed": 0,
                "backend": null,
                "reason": "vector memory index is not available in the native runtime"
            }))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn dispatches_memory_refresh_views_from_canonical_notes() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );
        let save_response = router.dispatch(&WorkerRequest::new(
            "req-save",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        assert!(save_response.error.is_none());
        fixture.write(
            "USER.md",
            "# User Profile\n\nKeep this unmanaged note.\n\n## User Memory Notes\n\n(Stale managed content.)\n\n*Edit unmanaged sections for manual profile details.*\n",
        );

        let refresh_response = router.dispatch(&WorkerRequest::new(
            "req-refresh",
            "trace-1",
            "memory.refresh_views",
            json!({}),
        ));

        let user_view = fixture.read("USER.md");
        assert_eq!(
            refresh_response.result,
            Some(json!({
                "views_refreshed": true,
                "note_count": 1,
                "view_files": ["memory/MEMORY.md", "USER.md", "SOUL.md"]
            }))
        );
        assert!(refresh_response.error.is_none());
        assert!(user_view.contains("Keep this unmanaged note."));
        assert!(user_view.contains("### Preference"));
        assert!(user_view.contains("User prefers concise implementation handoffs."));
        assert!(!user_view.contains("Stale managed content"));
    }

    #[test]
    fn dispatches_memory_legacy_migration_without_rewriting_markdown_views() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "memory/MEMORY.md",
            "# Memory\n\n- Project uses source-linked swarm wording.\n\nKeep maintainer docs separate.",
        );
        fixture.write("USER.md", "- User prefers uv commands.");
        fixture.write(
            "SOUL.md",
            "## Soul\n\nAvoid vendor API names in tinybot surfaces.",
        );
        let original_memory = fixture.read("memory/MEMORY.md");
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryRead, WorkerCapability::MemoryWrite]),
        );

        let first_response = router.dispatch(&WorkerRequest::new(
            "req-migrate-1",
            "trace-1",
            "memory.migrate_legacy_notes",
            json!({}),
        ));
        let second_response = router.dispatch(&WorkerRequest::new(
            "req-migrate-2",
            "trace-1",
            "memory.migrate_legacy_notes",
            json!({}),
        ));
        let search_response = router.dispatch(&WorkerRequest::new(
            "req-search",
            "trace-1",
            "memory.search",
            json!({ "query": "legacy-migration", "limit": 10 }),
        ));

        let first_notes = first_response
            .result
            .as_ref()
            .expect("memory.migrate_legacy_notes should return result")["notes"]
            .as_array()
            .expect("migrated notes should be an array")
            .clone();
        let second_notes = second_response
            .result
            .as_ref()
            .expect("second memory.migrate_legacy_notes should return result")["notes"]
            .as_array()
            .expect("second migrated notes should be an array")
            .clone();
        let stored_notes = search_response
            .result
            .as_ref()
            .expect("memory.search should return result")["notes"]
            .as_array()
            .expect("stored notes should be an array")
            .clone();

        assert_eq!(first_notes.len(), 4);
        assert_eq!(second_notes.len(), 4);
        assert_eq!(stored_notes.len(), 4);
        assert_eq!(fixture.read("memory/MEMORY.md"), original_memory);
        assert!(first_notes
            .iter()
            .all(|note| note["priority"] == json!(0.4)));
        assert!(first_notes
            .iter()
            .all(|note| note["confidence"] == json!(0.45)));
        assert!(first_notes.iter().all(|note| note["status"] == "active"));
        assert!(first_notes
            .iter()
            .all(|note| note["tags"] == json!(["legacy-migration"])));
        assert_eq!(
            first_notes
                .iter()
                .map(|note| note["sources"][0]["source_file"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["memory/MEMORY.md", "USER.md", "SOUL.md"])
        );
        assert_eq!(
            first_notes
                .iter()
                .map(|note| note["id"].clone())
                .collect::<Vec<_>>(),
            second_notes
                .iter()
                .map(|note| note["id"].clone())
                .collect::<Vec<_>>()
        );
        assert!(first_response.error.is_none());
        assert!(second_response.error.is_none());
        assert!(search_response.error.is_none());
    }

    #[test]
    fn memory_search_respects_read_capability() {
        let fixture = WorkspaceFixture::new();
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::default(),
        );
        let request = WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.search",
            json!({ "query": "handoff" }),
        );

        let response = router.dispatch(&request);

        let error = response.error.expect("response should contain error");
        assert_eq!(
            error.code,
            crate::worker_protocol::WorkerProtocolErrorCode::CapabilityDenied
        );
        assert_eq!(error.details["capability"], "memory.read");
        assert!(response.result.is_none());
    }

    #[test]
    fn memory_save_refreshes_managed_memory_views() {
        let fixture = WorkspaceFixture::new();
        fixture.write(
            "USER.md",
            "# User Profile\n\nKeep this unmanaged note.\n\n## User Memory Notes\n\n(Old managed content.)\n\n*Edit unmanaged sections for manual profile details.*\n",
        );
        fixture.write(
            "SOUL.md",
            "# Assistant Profile\n\n## Assistant Memory Notes\n\n(Old assistant managed content.)\n",
        );
        fixture.write(
            "memory/MEMORY.md",
            "# Long-term Memory\n\n## Project Memory Notes\n\n(Old project managed content.)\n",
        );
        let mut router = WorkerRpcRouter::new(
            fixture.root.clone(),
            json!({}),
            vec![],
            20,
            CapabilityPolicy::new([WorkerCapability::MemoryWrite]),
        );

        let preference = router.dispatch(&WorkerRequest::new(
            "req-1",
            "trace-1",
            "memory.save",
            json!({
                "content": "User prefers concise implementation handoffs.",
                "note_type": "preference",
                "priority": 0.8,
                "confidence": 0.7,
                "tags": ["handoff"]
            }),
        ));
        let instruction = router.dispatch(&WorkerRequest::new(
            "req-2",
            "trace-1",
            "memory.save",
            json!({
                "content": "Speak directly and avoid vague claims.",
                "note_type": "instruction"
            }),
        ));
        let project = router.dispatch(&WorkerRequest::new(
            "req-3",
            "trace-1",
            "memory.save",
            json!({
                "content": "Use the TS worker for experimental agent runs.",
                "note_type": "decision"
            }),
        ));

        let user_view = fixture.read("USER.md");
        let soul_view = fixture.read("SOUL.md");
        let project_view = fixture.read("memory/MEMORY.md");

        assert!(preference.error.is_none());
        assert!(instruction.error.is_none());
        assert!(project.error.is_none());
        assert!(user_view.contains("# User Profile"));
        assert!(user_view.contains("Keep this unmanaged note."));
        assert!(user_view.contains("## User Memory Notes"));
        assert!(user_view.contains("### Preference"));
        assert!(user_view.contains("User prefers concise implementation handoffs."));
        assert!(user_view.contains("tags=handoff"));
        assert!(!user_view.contains("Old managed content"));
        assert!(soul_view.contains("## Assistant Memory Notes"));
        assert!(soul_view.contains("### Instruction"));
        assert!(soul_view.contains("Speak directly and avoid vague claims."));
        assert!(project_view.contains("## Project Memory Notes"));
        assert!(project_view.contains("### Decision"));
        assert!(project_view.contains("Use the TS worker for experimental agent runs."));
    }

    fn dream_git_fixture() -> WorkspaceFixture {
        let fixture = WorkspaceFixture::new();
        fixture.write("memory/MEMORY.md", "Initial memory\n");
        fixture.write("USER.md", "");
        fixture.write("SOUL.md", "");
        fixture.write("memory/notes.jsonl", "");
        fixture.git(&["init"]);
        fixture.git(&[
            "add",
            "SOUL.md",
            "USER.md",
            "memory/MEMORY.md",
            "memory/notes.jsonl",
        ]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "init: tinybot memory store",
        ]);
        fixture.write(
            "memory/MEMORY.md",
            "Initial memory\nDream captured a durable fact.\n",
        );
        fixture.git(&["add", "memory/MEMORY.md"]);
        fixture.git(&[
            "-c",
            "user.name=tinybot",
            "-c",
            "user.email=tinybot@dream",
            "commit",
            "-m",
            "dream: 2026-06-12, 1 change(s)",
        ]);
        fixture
    }

    struct WorkspaceFixture {
        root: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let counter = WORKSPACE_FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "tinybot-worker-memory-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock should be after unix epoch")
                    .as_nanos(),
                counter
            ));
            std::fs::create_dir_all(&root).expect("workspace fixture should create");
            Self { root }
        }

        fn write(&self, relative_path: &str, contents: &str) {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent should create");
            }
            std::fs::write(path, contents).expect("fixture file should write");
        }

        fn read(&self, relative_path: &str) -> String {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::read_to_string(path).expect("fixture file should read")
        }

        fn git(&self, args: &[&str]) {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        }

        fn git_stdout(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args(args)
                .output()
                .expect("git command should run");
            assert!(
                output.status.success(),
                "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
                args,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
