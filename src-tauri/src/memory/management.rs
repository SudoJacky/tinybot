use super::*;
use crate::memory::{MemoryEntry, MemoryManagementSnapshot, MemoryMutation};

pub(super) fn protected_ids(connection: &Connection) -> Result<Vec<i64>, String> {
    let mut statement = connection
        .prepare("SELECT memory_id FROM user_managed_memories ORDER BY memory_id")
        .map_err(memory_db_error)?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(memory_db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(memory_db_error)
}

pub(super) fn check_revision(connection: &Connection, expected: i64) -> Result<(), String> {
    let current = state_value(connection, MEMORY_REVISION_KEY)?;
    if current != expected {
        return Err(format!("Memory changed since it was loaded (expected revision {expected}, current {current}). Reload memory before trying again."));
    }
    Ok(())
}

pub(super) fn advance_revision(connection: &Connection) -> Result<(), String> {
    connection.execute(
        "INSERT INTO memory_state (key, value) VALUES (?1, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1",
        [MEMORY_REVISION_KEY],
    ).map_err(memory_db_error)?;
    Ok(())
}

fn snapshot(connection: &Connection) -> Result<MemoryManagementSnapshot, String> {
    let revision = state_value(connection, MEMORY_REVISION_KEY)?;
    let protected = protected_ids(connection)?
        .into_iter()
        .collect::<HashSet<_>>();
    let entries = query_memories(
        connection,
        "SELECT id, scope, path, content FROM memories ORDER BY scope, path, content, id",
        [],
    )?
    .into_iter()
    .map(|record| MemoryEntry {
        user_managed: protected.contains(&record.id),
        record,
    })
    .collect();
    Ok(MemoryManagementSnapshot { revision, entries })
}

fn normalized_scope_path(
    connection: &Connection,
    scope: MemoryScope,
    path: &Option<String>,
) -> Result<Option<String>, String> {
    match (scope, path) {
        (MemoryScope::User, None) => Ok(None),
        (MemoryScope::Workspace, Some(path)) => {
            validate_workspace_path(path)?;
            // Existing scopes remain editable even after their folder is removed.
            let known = connection
                .query_row(
                    "SELECT 1 FROM memories WHERE path = ?1 LIMIT 1",
                    [path],
                    |_| Ok(()),
                )
                .optional()
                .map_err(memory_db_error)?
                .is_some();
            if known {
                Ok(Some(path.clone()))
            } else {
                normalized_workspace_path(Path::new(path)).map(Some)
            }
        }
        _ => Err(
            "User memory must have no workspace path; workspace memory requires an absolute path."
                .to_string(),
        ),
    }
}

impl MemoryStore {
    pub(crate) fn management_snapshot(&self) -> Result<MemoryManagementSnapshot, String> {
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(memory_db_error)?;
        snapshot(&transaction)
    }

    pub(crate) fn mutate_memory(
        &self,
        expected_revision: i64,
        mutation: &MemoryMutation,
    ) -> Result<MemoryManagementSnapshot, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(memory_db_error)?;
        check_revision(&transaction, expected_revision)?;
        match mutation {
            MemoryMutation::Create {
                scope,
                path,
                content,
            }
            | MemoryMutation::Update {
                scope,
                path,
                content,
                ..
            } => {
                let path = normalized_scope_path(&transaction, *scope, path)?;
                let content = normalized_memory_content(content)?;
                let id = match mutation {
                    MemoryMutation::Update { id, .. } => {
                        let changed = transaction.execute("UPDATE memories SET scope = ?1, path = ?2, content = ?3 WHERE id = ?4",
                            params![scope.as_str(), path, content, id]).map_err(memory_db_error)?;
                        if changed != 1 {
                            return Err(format!("Memory {id} no longer exists. Reload memory."));
                        }
                        *id
                    }
                    _ => {
                        transaction
                            .execute(
                                "INSERT INTO memories (scope, path, content) VALUES (?1, ?2, ?3)",
                                params![scope.as_str(), path, content],
                            )
                            .map_err(memory_db_error)?;
                        transaction.last_insert_rowid()
                    }
                };
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO user_managed_memories (memory_id) VALUES (?1)",
                        [id],
                    )
                    .map_err(memory_db_error)?;
            }
            MemoryMutation::Delete { ids } => {
                if ids.is_empty() || ids.iter().copied().collect::<HashSet<_>>().len() != ids.len()
                {
                    return Err("Select one or more distinct memories to delete.".to_string());
                }
                for id in ids {
                    if transaction
                        .execute("DELETE FROM memories WHERE id = ?1", [id])
                        .map_err(memory_db_error)?
                        != 1
                    {
                        return Err(format!("Memory {id} no longer exists. No memories were deleted; reload memory."));
                    }
                }
            }
        }
        advance_revision(&transaction)?;
        let result = snapshot(&transaction)?;
        transaction.commit().map_err(memory_db_error)?;
        Ok(result)
    }
}
