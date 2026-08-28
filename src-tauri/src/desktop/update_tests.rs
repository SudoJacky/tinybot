use super::{
    available_snapshot_from_parts, require_clean_shutdown, update_diagnostic_line,
    DesktopUpdatePhase,
};

#[test]
fn update_diagnostic_records_version_selection() {
    let line = update_diagnostic_line("update_available", Some("0.1.0"), Some("0.2.0"), None)
        .expect("update diagnostic should serialize");
    let value: serde_json::Value =
        serde_json::from_str(&line).expect("update diagnostic should be JSON");

    assert_eq!(value["event"], "update_available");
    assert_eq!(value["current_version"], "0.1.0");
    assert_eq!(value["available_version"], "0.2.0");
    assert!(value.get("detail").is_none());
}

#[test]
fn installation_gate_rejects_failed_shutdown_with_cause() {
    let error = require_clean_shutdown(Err("worker drain timed out".to_string()))
        .expect_err("failed cleanup must abort installation");

    assert!(error.contains("installation aborted"));
    assert!(error.contains("worker drain timed out"));
}

#[test]
fn available_snapshot_keeps_release_and_custom_display_notes_separate() {
    let snapshot = available_snapshot_from_parts(
        "0.1.3",
        "0.2.0",
        Some("  Fixed the browser lifecycle.  ".to_string()),
        Some("2026-08-02T12:00:00Z".to_string()),
        &serde_json::json!({
            "display_notes": "  Back up important work before installing.  "
        }),
    );

    assert_eq!(snapshot.phase, DesktopUpdatePhase::Available);
    assert_eq!(snapshot.current_version, "0.1.3");
    assert_eq!(snapshot.available_version.as_deref(), Some("0.2.0"));
    assert_eq!(
        snapshot.release_notes.as_deref(),
        Some("Fixed the browser lifecycle.")
    );
    assert_eq!(
        snapshot.display_notes.as_deref(),
        Some("Back up important work before installing.")
    );
    assert_eq!(
        snapshot.published_at.as_deref(),
        Some("2026-08-02T12:00:00Z")
    );
}

#[test]
fn blank_update_notes_are_not_exposed_to_the_renderer() {
    let snapshot = available_snapshot_from_parts(
        "0.1.3",
        "0.2.0",
        Some("  ".to_string()),
        None,
        &serde_json::json!({ "displayNotes": "\n" }),
    );

    assert_eq!(snapshot.release_notes, None);
    assert_eq!(snapshot.display_notes, None);
}
