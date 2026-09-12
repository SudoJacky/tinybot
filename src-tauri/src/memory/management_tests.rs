use super::*;
use crate::memory::MemoryMutation;

fn create(content: &str) -> MemoryMutation {
    MemoryMutation::Create {
        scope: MemoryScope::User,
        path: None,
        content: content.to_string(),
    }
}

#[test]
fn workspace_paths_are_canonicalized_and_existing_scopes_remain_editable() {
    let fixture = MemoryFixture::new("manual-paths");
    let workspace = fixture.root.join("other");
    fs::create_dir_all(&workspace).unwrap();
    let canonical = normalized_workspace_path(&workspace).unwrap();
    let first = fixture
        .store
        .mutate_memory(
            0,
            &MemoryMutation::Create {
                scope: MemoryScope::Workspace,
                path: Some(workspace.join(".").to_string_lossy().into_owned()),
                content: "Original.".to_string(),
            },
        )
        .unwrap();
    assert_eq!(
        first.entries[0].record.path.as_deref(),
        Some(canonical.as_str())
    );
    // Only remove the empty test directory; its persisted scope is still manageable.
    fs::remove_dir(&workspace).unwrap();
    let edited = fixture
        .store
        .mutate_memory(
            first.revision,
            &MemoryMutation::Update {
                id: first.entries[0].record.id,
                scope: MemoryScope::Workspace,
                path: Some(canonical),
                content: "Corrected.".to_string(),
            },
        )
        .unwrap();
    assert_eq!(edited.entries[0].record.content, "Corrected.");
}

#[test]
fn manual_memory_crud_preserves_scope_and_protection_after_reopening() {
    let fixture = MemoryFixture::new("manual-crud");
    let first = fixture
        .store
        .mutate_memory(0, &create("Prefers concise answers."))
        .unwrap();
    let id = first.entries[0].record.id;
    assert!(first.entries[0].user_managed);
    let changed = fixture
        .store
        .mutate_memory(
            first.revision,
            &MemoryMutation::Update {
                id,
                scope: MemoryScope::Workspace,
                path: Some(fixture.workspace_path.clone()),
                content: "Uses Rust.".to_string(),
            },
        )
        .unwrap();
    assert!(fixture
        .store
        .render_thread_snapshot(&fixture.workspace_path)
        .unwrap()
        .contains("Uses Rust."));
    let other = fixture.root.join("other");
    fs::create_dir_all(&other).unwrap();
    assert!(fixture
        .store
        .render_thread_snapshot(&normalized_workspace_path(&other).unwrap())
        .unwrap()
        .is_empty());
    let reopened = MemoryStore::new(&fixture.root.join(".tinybot"));
    assert!(reopened.management_snapshot().unwrap().entries[0].user_managed);
    let deleted = reopened
        .mutate_memory(changed.revision, &MemoryMutation::Delete { ids: vec![id] })
        .unwrap();
    assert!(deleted.entries.is_empty());
    let next = reopened
        .mutate_memory(deleted.revision, &create("New memory."))
        .unwrap();
    assert!(next.entries[0].record.id > id);
}

#[test]
fn manual_mutations_reject_stale_revisions_and_roll_back_invalid_batches() {
    let fixture = MemoryFixture::new("manual-conflicts");
    let first = fixture
        .store
        .mutate_memory(0, &create("Original."))
        .unwrap();
    assert!(fixture
        .store
        .mutate_memory(0, &create("Stale."))
        .unwrap_err()
        .contains("Memory changed"));
    let id = first.entries[0].record.id;
    for ids in [vec![id, id], vec![id, id + 100], vec![]] {
        assert!(fixture
            .store
            .mutate_memory(first.revision, &MemoryMutation::Delete { ids })
            .is_err());
        assert_eq!(
            fixture.store.management_snapshot().unwrap().revision,
            first.revision
        );
        assert_eq!(
            fixture.store.active_memories().unwrap()[0].content,
            "Original."
        );
    }
    for content in ["", "one\ntwo"] {
        assert!(fixture
            .store
            .mutate_memory(first.revision, &create(content))
            .is_err());
    }
    assert!(fixture
        .store
        .mutate_memory(
            first.revision,
            &MemoryMutation::Create {
                scope: MemoryScope::Workspace,
                path: Some("relative".to_string()),
                content: "Invalid.".to_string(),
            }
        )
        .is_err());
}

#[test]
fn user_edits_invalidate_in_flight_consolidation_and_remain_protected() {
    let fixture = MemoryFixture::new("manual-consolidation");
    fixture.extract(
        "thread",
        "turn",
        vec![ExtractedMemory {
            scope: MemoryScope::User,
            content: "Original.".to_string(),
        }],
    );
    let old_input = fixture.store.phase2_input().unwrap().unwrap();
    let first = fixture
        .store
        .mutate_memory(0, &create("User correction."))
        .unwrap();
    let diff = SelectionDiff {
        add: vec![],
        update: vec![],
        remove: vec![],
    };
    assert!(fixture
        .store
        .apply_selection_diff(&old_input, &diff)
        .unwrap_err()
        .contains("Memory changed"));
    let input = fixture.store.phase2_input().unwrap().unwrap();
    let id = first.entries[0].record.id;
    assert!(input.protected_ids.contains(&id));
    assert!(fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                update: vec![SelectionUpdate {
                    id,
                    content: "Automatic overwrite.".to_string()
                }],
                ..diff.clone()
            }
        )
        .unwrap_err()
        .contains("user-managed"));
    assert!(fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                remove: vec![id],
                ..diff.clone()
            }
        )
        .unwrap_err()
        .contains("user-managed"));
    fixture.store.apply_selection_diff(&input, &diff).unwrap();
    assert_eq!(
        fixture.store.active_memories().unwrap()[0].content,
        "User correction."
    );
}

#[test]
fn automatically_created_memories_can_be_edited_and_then_become_protected() {
    let fixture = MemoryFixture::new("auto-to-manual");
    fixture.extract(
        "thread",
        "turn",
        vec![ExtractedMemory {
            scope: MemoryScope::User,
            content: "Automatic.".to_string(),
        }],
    );
    let input = fixture.store.phase2_input().unwrap().unwrap();
    fixture
        .store
        .apply_selection_diff(
            &input,
            &SelectionDiff {
                add: vec![SelectionAdd {
                    scope: MemoryScope::User,
                    path: None,
                    content: "Automatic.".to_string(),
                }],
                update: vec![],
                remove: vec![],
            },
        )
        .unwrap();
    let current = fixture.store.management_snapshot().unwrap();
    assert_eq!(current.revision, 1);
    assert!(!current.entries[0].user_managed);
    assert!(fixture
        .store
        .mutate_memory(0, &create("Stale browser."))
        .is_err());
    let edited = fixture
        .store
        .mutate_memory(
            current.revision,
            &MemoryMutation::Update {
                id: current.entries[0].record.id,
                scope: MemoryScope::User,
                path: None,
                content: "Corrected.".to_string(),
            },
        )
        .unwrap();
    assert!(edited.entries[0].user_managed);
}
