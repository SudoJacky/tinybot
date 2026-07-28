use super::{
    ExtractedMemory, MemoryRecord, MemoryScope, Phase2Input, SelectionDiff,
    MEMORY_SNAPSHOT_MAX_CHARS,
};
use crate::storage::atomic::{write_text_atomic, AtomicWriteOptions};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const PHASE2_WATERMARK_KEY: &str = "phase2_fragment_watermark";
const MEMORY_CONTENT_MAX_CHARS: usize = 2_000;

#[derive(Clone, Debug)]
pub(crate) struct MemoryStore {
    database_path: PathBuf,
    markdown_path: PathBuf,
}

impl MemoryStore {
    pub(crate) fn for_workspace(workspace_root: &Path) -> Self {
        #[cfg(not(test))]
        let data_root = crate::config::application::tinybot_data_root();
        #[cfg(test)]
        let data_root = workspace_root.join(".tinybot");
        #[cfg(not(test))]
        let _ = workspace_root;
        Self {
            database_path: data_root.join("state").join("memory.sqlite"),
            markdown_path: data_root.join("memory").join("raw_memories.md"),
        }
    }

    pub(crate) fn initialize(&self) -> Result<(), String> {
        let _ = self.open()?;
        Ok(())
    }

    pub(crate) fn enqueue_turn(
        &self,
        thread_store_path: &str,
        thread_id: &str,
        turn_id: &str,
        workspace_path: &str,
    ) -> Result<(), String> {
        validate_workspace_path(thread_store_path)?;
        validate_identity("thread id", thread_id)?;
        validate_identity("turn id", turn_id)?;
        validate_workspace_path(workspace_path)?;
        let connection = self.open()?;
        connection
            .execute(
                "INSERT OR IGNORE INTO pending_memory_turns \
                 (thread_store_path, thread_id, turn_id, workspace_path) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![thread_store_path, thread_id, turn_id, workspace_path],
            )
            .map_err(memory_db_error)?;
        Ok(())
    }

    pub(crate) fn pending_turns(
        &self,
        thread_store_path: &str,
        limit: usize,
    ) -> Result<Vec<PendingMemoryTurn>, String> {
        validate_workspace_path(thread_store_path)?;
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT thread_store_path, thread_id, turn_id, workspace_path \
                 FROM pending_memory_turns WHERE thread_store_path = ?1 \
                 ORDER BY rowid LIMIT ?2",
            )
            .map_err(memory_db_error)?;
        let rows = statement
            .query_map(
                params![thread_store_path, i64::try_from(limit).unwrap_or(i64::MAX)],
                |row| {
                    Ok(PendingMemoryTurn {
                        thread_store_path: row.get(0)?,
                        thread_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        workspace_path: row.get(3)?,
                    })
                },
            )
            .map_err(memory_db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(memory_db_error)
    }

    pub(crate) fn complete_extraction(
        &self,
        pending: &PendingMemoryTurn,
        memories: &[ExtractedMemory],
    ) -> Result<usize, String> {
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(memory_db_error)?;
        let still_pending = transaction
            .query_row(
                "SELECT 1 FROM pending_memory_turns \
                 WHERE thread_store_path = ?1 AND thread_id = ?2 AND turn_id = ?3",
                params![
                    pending.thread_store_path,
                    pending.thread_id,
                    pending.turn_id
                ],
                |_row| Ok(()),
            )
            .optional()
            .map_err(memory_db_error)?
            .is_some();
        if !still_pending {
            return Ok(0);
        }

        let inserted_processed = transaction
            .execute(
                "INSERT OR IGNORE INTO processed_memory_turns \
                 (thread_store_path, thread_id, turn_id) VALUES (?1, ?2, ?3)",
                params![
                    pending.thread_store_path,
                    pending.thread_id,
                    pending.turn_id
                ],
            )
            .map_err(memory_db_error)?;
        let mut inserted_fragments = 0;
        if inserted_processed == 1 {
            for memory in memories {
                let content = normalized_memory_content(&memory.content)?;
                let path = match memory.scope {
                    MemoryScope::User => None,
                    MemoryScope::Workspace => Some(pending.workspace_path.as_str()),
                };
                transaction
                    .execute(
                        "INSERT INTO memory_fragments (scope, path, content) \
                         VALUES (?1, ?2, ?3)",
                        params![memory.scope.as_str(), path, content],
                    )
                    .map_err(memory_db_error)?;
                inserted_fragments += 1;
            }
        }
        transaction
            .execute(
                "DELETE FROM pending_memory_turns \
                 WHERE thread_store_path = ?1 AND thread_id = ?2 AND turn_id = ?3",
                params![
                    pending.thread_store_path,
                    pending.thread_id,
                    pending.turn_id
                ],
            )
            .map_err(memory_db_error)?;
        transaction.commit().map_err(memory_db_error)?;
        Ok(inserted_fragments)
    }

    pub(crate) fn phase2_input(&self) -> Result<Option<Phase2Input>, String> {
        let connection = self.open()?;
        let watermark = state_value(&connection, PHASE2_WATERMARK_KEY)?;
        let through_fragment_id = connection
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM memory_fragments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(memory_db_error)?;
        if through_fragment_id <= watermark {
            return Ok(None);
        }
        let fragments = query_memories(
            &connection,
            "SELECT id, scope, path, content FROM memory_fragments \
             WHERE id > ?1 AND id <= ?2 ORDER BY id",
            params![watermark, through_fragment_id],
        )?;
        let affected_user_scope = fragments
            .iter()
            .any(|memory| memory.scope == MemoryScope::User);
        let affected_workspace_paths = fragments
            .iter()
            .filter_map(|memory| memory.path.as_deref())
            .collect::<HashSet<_>>();
        let active = query_memories(
            &connection,
            "SELECT id, scope, path, content FROM memories ORDER BY id",
            [],
        )?
        .into_iter()
        .filter(|memory| match memory.scope {
            MemoryScope::User => affected_user_scope,
            MemoryScope::Workspace => memory
                .path
                .as_deref()
                .is_some_and(|path| affected_workspace_paths.contains(path)),
        })
        .collect();
        Ok(Some(Phase2Input {
            watermark,
            through_fragment_id,
            active,
            fragments,
        }))
    }

    pub(crate) fn apply_selection_diff(
        &self,
        input: &Phase2Input,
        diff: &SelectionDiff,
    ) -> Result<bool, String> {
        validate_selection_diff(input, diff)?;
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(memory_db_error)?;
        let current_watermark = state_value(&transaction, PHASE2_WATERMARK_KEY)?;
        if current_watermark != input.watermark {
            return Err(format!(
                "memory Selection Diff is stale: expected watermark {}, found {}",
                input.watermark, current_watermark
            ));
        }

        let mut changed = false;
        for add in &diff.add {
            let content = normalized_memory_content(&add.content)?;
            changed |= transaction
                .execute(
                    "INSERT INTO memories (scope, path, content) VALUES (?1, ?2, ?3)",
                    params![add.scope.as_str(), add.path, content],
                )
                .map_err(memory_db_error)?
                == 1;
        }
        for update in &diff.update {
            let content = normalized_memory_content(&update.content)?;
            changed |= transaction
                .execute(
                    "UPDATE memories SET content = ?1 WHERE id = ?2 AND content <> ?1",
                    params![content, update.id],
                )
                .map_err(memory_db_error)?
                == 1;
        }
        for id in &diff.remove {
            changed |= transaction
                .execute("DELETE FROM memories WHERE id = ?1", [id])
                .map_err(memory_db_error)?
                == 1;
        }
        transaction
            .execute(
                "INSERT INTO memory_state (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![PHASE2_WATERMARK_KEY, input.through_fragment_id],
            )
            .map_err(memory_db_error)?;
        transaction.commit().map_err(memory_db_error)?;
        Ok(changed)
    }

    pub(crate) fn render_thread_snapshot(&self, workspace_path: &str) -> Result<String, String> {
        validate_workspace_path(workspace_path)?;
        let connection = self.open()?;
        let memories = query_memories(
            &connection,
            "SELECT id, scope, path, content FROM memories \
             WHERE scope = 'user' OR (scope = 'workspace' AND path = ?1) \
             ORDER BY CASE scope WHEN 'user' THEN 0 ELSE 1 END, content, id",
            [workspace_path],
        )?;
        Ok(render_prompt_memories(&memories))
    }

    pub(crate) fn write_latest_markdown(&self) -> Result<bool, String> {
        let connection = self.open()?;
        let memories = query_memories(
            &connection,
            "SELECT id, scope, path, content FROM memories \
             ORDER BY CASE scope WHEN 'user' THEN 0 ELSE 1 END, path, content, id",
            [],
        )?;
        let rendered = render_all_memories(&memories);
        let existing = match fs::read_to_string(&self.markdown_path) {
            Ok(existing) => Some(existing),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(format!(
                    "failed to read memory Markdown `{}`: {error}",
                    self.markdown_path.display()
                ))
            }
        };
        if existing.as_deref() == Some(rendered.as_str()) {
            return Ok(false);
        }
        write_text_atomic(
            &self.markdown_path,
            &rendered,
            AtomicWriteOptions::default(),
        )
        .map_err(|error| error.to_string())?;
        Ok(true)
    }

    #[cfg(test)]
    pub(crate) fn database_path(&self) -> &Path {
        &self.database_path
    }

    #[cfg(test)]
    pub(crate) fn markdown_path(&self) -> &Path {
        &self.markdown_path
    }

    fn open(&self) -> Result<Connection, String> {
        let parent = self
            .database_path
            .parent()
            .ok_or_else(|| "memory database path has no parent directory".to_string())?;
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create memory database directory `{}`: {error}",
                parent.display()
            )
        })?;
        let connection = Connection::open(&self.database_path).map_err(memory_db_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(memory_db_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS memory_fragments (
                     id      INTEGER PRIMARY KEY AUTOINCREMENT,
                     scope   TEXT NOT NULL CHECK (scope IN ('user', 'workspace')),
                     path    TEXT,
                     content TEXT NOT NULL CHECK (length(trim(content)) > 0),
                     CHECK (
                         (scope = 'user' AND path IS NULL) OR
                         (scope = 'workspace' AND path IS NOT NULL AND length(path) > 0)
                     )
                 );
                 CREATE TABLE IF NOT EXISTS memories (
                     id      INTEGER PRIMARY KEY AUTOINCREMENT,
                     scope   TEXT NOT NULL CHECK (scope IN ('user', 'workspace')),
                     path    TEXT,
                     content TEXT NOT NULL CHECK (length(trim(content)) > 0),
                     CHECK (
                         (scope = 'user' AND path IS NULL) OR
                         (scope = 'workspace' AND path IS NOT NULL AND length(path) > 0)
                     )
                 );
                 CREATE TABLE IF NOT EXISTS pending_memory_turns (
                     thread_store_path TEXT NOT NULL,
                     thread_id         TEXT NOT NULL,
                     turn_id           TEXT NOT NULL,
                     workspace_path    TEXT NOT NULL,
                     PRIMARY KEY (thread_store_path, thread_id, turn_id)
                 );
                 CREATE TABLE IF NOT EXISTS processed_memory_turns (
                     thread_store_path TEXT NOT NULL,
                     thread_id         TEXT NOT NULL,
                     turn_id           TEXT NOT NULL,
                     PRIMARY KEY (thread_store_path, thread_id, turn_id)
                 );
                 CREATE TABLE IF NOT EXISTS memory_state (
                     key   TEXT PRIMARY KEY,
                     value INTEGER NOT NULL
                 );",
            )
            .map_err(memory_db_error)?;
        Ok(connection)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingMemoryTurn {
    pub(crate) thread_store_path: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) workspace_path: String,
}

pub(crate) fn normalized_workspace_path(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err(format!(
            "memory workspace path must be absolute: `{}`",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        format!(
            "failed to canonicalize memory workspace path `{}`: {error}",
            path.display()
        )
    })?;
    let rendered = canonical.display().to_string();
    #[cfg(windows)]
    let rendered = normalize_windows_verbatim_path(&rendered);
    validate_workspace_path(&rendered)?;
    Ok(rendered)
}

#[cfg(windows)]
fn normalize_windows_verbatim_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

fn query_memories<P>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<MemoryRecord>, String>
where
    P: rusqlite::Params,
{
    let mut statement = connection.prepare(sql).map_err(memory_db_error)?;
    let rows = statement
        .query_map(params, |row| {
            let scope = row.get::<_, String>(1)?;
            Ok((
                row.get::<_, i64>(0)?,
                scope,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(memory_db_error)?;
    rows.map(|row| {
        let (id, scope, path, content) = row.map_err(memory_db_error)?;
        Ok(MemoryRecord {
            id,
            scope: MemoryScope::from_db(&scope)?,
            path,
            content,
        })
    })
    .collect()
}

fn state_value(connection: &Connection, key: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT value FROM memory_state WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or_default())
        .map_err(memory_db_error)
}

fn validate_selection_diff(input: &Phase2Input, diff: &SelectionDiff) -> Result<(), String> {
    let has_user_fragment = input
        .fragments
        .iter()
        .any(|memory| memory.scope == MemoryScope::User);
    let fragment_workspace_paths = input
        .fragments
        .iter()
        .filter_map(|memory| memory.path.clone())
        .collect::<HashSet<_>>();
    let active_ids = input
        .active
        .iter()
        .filter(|memory| match memory.scope {
            MemoryScope::User => has_user_fragment,
            MemoryScope::Workspace => memory
                .path
                .as_ref()
                .is_some_and(|path| fragment_workspace_paths.contains(path)),
        })
        .map(|memory| memory.id)
        .collect::<HashSet<_>>();
    let mut referenced_ids = HashSet::new();

    for add in &diff.add {
        normalized_memory_content(&add.content)?;
        match add.scope {
            MemoryScope::User if add.path.is_some() => {
                return Err("user memory additions must use a null path".to_string())
            }
            MemoryScope::User if !has_user_fragment => {
                return Err("user memory additions require a new user-scoped fragment".to_string())
            }
            MemoryScope::User => {}
            MemoryScope::Workspace => {
                let path = add
                    .path
                    .as_deref()
                    .ok_or_else(|| "workspace memory additions require a path".to_string())?;
                validate_workspace_path(path)?;
                if !fragment_workspace_paths.contains(path) {
                    return Err(format!(
                        "workspace memory addition references unknown path `{path}`"
                    ));
                }
            }
        }
    }
    for update in &diff.update {
        normalized_memory_content(&update.content)?;
        if !active_ids.contains(&update.id) {
            return Err(format!(
                "memory Selection Diff update references unknown id {}",
                update.id
            ));
        }
        if !referenced_ids.insert(update.id) {
            return Err(format!(
                "memory Selection Diff references id {} more than once",
                update.id
            ));
        }
    }
    for id in &diff.remove {
        if !active_ids.contains(id) {
            return Err(format!(
                "memory Selection Diff remove references unknown id {id}"
            ));
        }
        if !referenced_ids.insert(*id) {
            return Err(format!(
                "memory Selection Diff references id {id} more than once"
            ));
        }
    }
    Ok(())
}

fn normalized_memory_content(content: &str) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("memory content must not be empty".to_string());
    }
    if content.chars().count() > MEMORY_CONTENT_MAX_CHARS {
        return Err(format!(
            "memory content exceeds the {MEMORY_CONTENT_MAX_CHARS}-character limit"
        ));
    }
    if content.contains('\r') || content.contains('\n') {
        return Err("memory content must be a single line".to_string());
    }
    Ok(content.to_string())
}

fn validate_identity(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

fn validate_workspace_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || !Path::new(path).is_absolute() {
        Err(format!(
            "memory workspace path must be a non-empty absolute path: `{path}`"
        ))
    } else {
        Ok(())
    }
}

fn render_prompt_memories(memories: &[MemoryRecord]) -> String {
    if memories.is_empty() {
        return String::new();
    }
    let mut rendered = String::new();
    let user = memories
        .iter()
        .filter(|memory| memory.scope == MemoryScope::User)
        .collect::<Vec<_>>();
    let workspace = memories
        .iter()
        .filter(|memory| memory.scope == MemoryScope::Workspace)
        .collect::<Vec<_>>();
    append_memory_section(&mut rendered, "User memory", user);
    append_memory_section(&mut rendered, "Workspace memory", workspace);
    truncate_snapshot(rendered)
}

fn render_all_memories(memories: &[MemoryRecord]) -> String {
    let mut rendered = String::from("# Long-term memory\n\n");
    let user = memories
        .iter()
        .filter(|memory| memory.scope == MemoryScope::User)
        .collect::<Vec<_>>();
    append_memory_section(&mut rendered, "User memory", user);

    let mut workspaces = BTreeMap::<String, Vec<&MemoryRecord>>::new();
    for memory in memories
        .iter()
        .filter(|memory| memory.scope == MemoryScope::Workspace)
    {
        if let Some(path) = memory.path.as_ref() {
            workspaces.entry(path.clone()).or_default().push(memory);
        }
    }
    for (path, entries) in workspaces {
        rendered.push_str("## Workspace: `");
        rendered.push_str(&path.replace('`', "\\`"));
        rendered.push_str("`\n\n");
        for memory in entries {
            rendered.push_str("- ");
            rendered.push_str(&memory.content);
            rendered.push('\n');
        }
        rendered.push('\n');
    }
    if memories.is_empty() {
        rendered.push_str("_No active memories._\n");
    }
    rendered
}

fn append_memory_section(rendered: &mut String, title: &str, memories: Vec<&MemoryRecord>) {
    if memories.is_empty() {
        return;
    }
    rendered.push_str("## ");
    rendered.push_str(title);
    rendered.push_str("\n\n");
    for memory in memories {
        rendered.push_str("- ");
        rendered.push_str(&memory.content);
        rendered.push('\n');
    }
    rendered.push('\n');
}

fn truncate_snapshot(rendered: String) -> String {
    if rendered.chars().count() <= MEMORY_SNAPSHOT_MAX_CHARS {
        return rendered;
    }
    let suffix = "\n_Additional memories omitted._\n";
    let retained = MEMORY_SNAPSHOT_MAX_CHARS.saturating_sub(suffix.chars().count());
    let mut truncated = rendered.chars().take(retained).collect::<String>();
    truncated.push_str(suffix);
    truncated
}

fn memory_db_error(error: rusqlite::Error) -> String {
    format!("memory SQLite operation failed: {error}")
}
