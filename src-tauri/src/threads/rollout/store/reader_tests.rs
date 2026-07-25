use super::*;
use crate::threads::rollout::format::{EventKind, EventMsg};
use crate::threads::rollout::store::{ThreadLogItem, ThreadLogLine, ThreadMeta};
use std::path::PathBuf;

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "tinybot-thread-log-reader-{name}-{}",
        std::process::id()
    ))
}

fn valid_line() -> ThreadLogLine {
    ThreadLogLine {
        timestamp: "2026-07-08T10:12:30Z".to_string(),
        ordinal: None,
        item: ThreadLogItem::SessionMeta(ThreadMeta {
            schema_version: crate::threads::rollout::store::THREAD_LOG_SCHEMA_VERSION,
            thread_id: "thread-a".to_string(),
            session_id: Some("session-a".to_string()),
            created_at: "2026-07-08T10:12:30Z".to_string(),
            cwd: String::new(),
            source: "desktop".to_string(),
            model_provider: None,
            model: None,
            base_instructions: None,
            history_mode: Some("default".to_string()),
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: Some("Tinybot Desktop".to_string()),
        }),
    }
}

#[test]
fn reader_surfaces_invalid_json_line_number() {
    let path = temp_path("invalid-json");
    let valid = serde_json::to_string(&valid_line()).unwrap();
    fs::write(&path, format!("{valid}\nnot-json\n")).unwrap();

    let error = read_thread_lines(&path).unwrap_err();

    assert!(error.message.contains("invalid thread log JSON at line 2"));
    assert_eq!(error.details["line"], 2);
    let _ = fs::remove_file(path);
}

#[test]
fn reader_rejects_blank_lines() {
    let path = temp_path("blank-line");
    let valid = serde_json::to_string(&valid_line()).unwrap();
    fs::write(&path, format!("{valid}\n   \n")).unwrap();

    let error = read_thread_lines(&path).unwrap_err();

    assert!(error.message.contains("blank thread log line"));
    assert_eq!(error.details["line"], 2);
    let _ = fs::remove_file(path);
}

#[test]
fn reader_rejects_missing_ordinal_after_numbered_records() {
    let path = temp_path("missing-ordinal");
    let mut first = valid_line();
    first.ordinal = Some(0);
    let second = ThreadLogLine {
        timestamp: "2026-07-08T10:13:30Z".to_string(),
        ordinal: None,
        item: ThreadLogItem::EventMsg(EventMsg::new(EventKind::TurnStarted, serde_json::json!({}))),
    };
    fs::write(
        &path,
        format!(
            "{}\n{}\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        ),
    )
    .unwrap();

    let error = read_thread_lines(&path).unwrap_err();

    assert!(error.message.contains("missing an ordinal"));
    assert_eq!(error.details["line"], 2);
    let _ = fs::remove_file(path);
}

#[test]
fn reader_accepts_legacy_prefix_followed_by_numbered_records() {
    let path = temp_path("legacy-prefix");
    let first = valid_line();
    let second = ThreadLogLine {
        timestamp: "2026-07-08T10:13:30Z".to_string(),
        ordinal: Some(1),
        item: ThreadLogItem::EventMsg(EventMsg::new(EventKind::TurnStarted, serde_json::json!({}))),
    };
    fs::write(
        &path,
        format!(
            "{}\n{}\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&second).unwrap()
        ),
    )
    .unwrap();

    assert_eq!(read_thread_lines(&path).unwrap().len(), 2);
    let _ = fs::remove_file(path);
}

#[test]
fn discovery_reader_skips_bad_rows_but_full_replay_remains_strict() {
    let path = temp_path("discovery-bad-row");
    let mut first = valid_line();
    first.ordinal = Some(0);
    let third = ThreadLogLine {
        timestamp: "2026-07-08T10:13:30Z".to_string(),
        ordinal: Some(2),
        item: ThreadLogItem::EventMsg(EventMsg::new(
            EventKind::UserMessage,
            serde_json::json!({"content": "discoverable"}),
        )),
    };
    fs::write(
        &path,
        format!(
            "{}\nnot-json\n{}\n",
            serde_json::to_string(&first).unwrap(),
            serde_json::to_string(&third).unwrap()
        ),
    )
    .unwrap();

    assert!(read_thread_lines(&path).is_err());
    let scan = read_thread_lines_for_discovery(&path).unwrap();
    assert_eq!(scan.lines.len(), 2);
    assert_eq!(scan.diagnostics.len(), 1);
    assert!(scan.diagnostics[0].contains("line 2"));
    let _ = fs::remove_file(path);
}
