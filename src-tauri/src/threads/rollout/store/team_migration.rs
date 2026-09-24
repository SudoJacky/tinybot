//! One-time relocation before any recorder or projection is opened.
use super::*;
use std::io::{BufRead, BufReader};

pub(crate) fn migrate_team_conversations(data_root: &Path) -> Result<usize, String> {
    let marker = data_root.join("team-conversations-v1.migrated");
    if marker.try_exists().map_err(|e| e.to_string())? {
        return Ok(0);
    }
    let mut records = Vec::new();
    for directory in ["threads", "archived_threads"] {
        let root = data_root.join(directory);
        let mut paths = vec![];
        collect_thread_log_paths(&root, &root, &mut paths).map_err(|e| e.message)?;
        for path in paths {
            let mut reader =
                BufReader::new(compression::open_rollout_reader(&path).map_err(|e| e.message)?);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("Read migration header {}: {e}", path.display()))?;
            let header: ThreadLogLine = serde_json::from_str(&line)
                .map_err(|e| format!("Invalid conversation header {}: {e}", path.display()))?;
            let ThreadLogItem::SessionMeta(meta) = header.item else {
                return Err(format!("Missing conversation metadata: {}", path.display()));
            };
            records.push((directory, path, meta));
        }
    }
    let mut owners = HashMap::<String, String>::new();
    for (_, _, meta) in &records {
        if meta.source == "team" {
            let id = crate::teams::run_id_from_thread(&meta.thread_id)
                .ok_or_else(|| format!("Invalid Team conversation identity {}", meta.thread_id))?;
            owners.insert(meta.thread_id.clone(), id);
        }
    }
    loop {
        let before = owners.len();
        for (_, _, meta) in &records {
            if let Some(run) = meta
                .parent_thread_id
                .as_ref()
                .and_then(|p| owners.get(p))
                .cloned()
            {
                owners.insert(meta.thread_id.clone(), run);
            }
        }
        if owners.len() == before {
            break;
        }
    }
    let mut moves = vec![];
    for (directory, logical, meta) in records {
        let Some(run) = owners.get(&meta.thread_id) else {
            continue;
        };
        let relative = logical
            .strip_prefix(data_root.join(directory))
            .map_err(|e| e.to_string())?;
        let target = data_root
            .join("team-runs")
            .join(run)
            .join("conversations")
            .join(directory)
            .join(relative);
        let compressed = compression::is_rollout_compressed(&logical).map_err(|e| e.message)?;
        let source = if compressed {
            compression::compressed_rollout_path(&logical).map_err(|e| e.message)?
        } else {
            logical
        };
        let target = if compressed {
            compression::compressed_rollout_path(&target).map_err(|e| e.message)?
        } else {
            target
        };
        if target.try_exists().map_err(|e| e.to_string())? {
            return Err(format!(
                "Team conversation migration target already exists: {}",
                target.display()
            ));
        }
        moves.push((source, target));
    }
    for (source, target) in &moves {
        fs::create_dir_all(
            target
                .parent()
                .ok_or("Missing Team conversation directory")?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(source, target).map_err(|e| {
            format!(
                "Move Team conversation {} to {}: {e}",
                source.display(),
                target.display()
            )
        })?;
    }
    fs::create_dir_all(data_root).map_err(|e| e.to_string())?;
    fs::write(&marker, b"1\n").map_err(|e| e.to_string())?;
    eprintln!("team_conversations_migrated files={}", moves.len());
    Ok(moves.len())
}
