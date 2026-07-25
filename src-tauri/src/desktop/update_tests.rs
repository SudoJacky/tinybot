use super::{require_clean_shutdown, update_diagnostic_line};

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
fn installation_gate_accepts_clean_shutdown() {
    assert_eq!(require_clean_shutdown(Ok(())), Ok(()));
}

#[test]
fn installation_gate_rejects_failed_shutdown_with_cause() {
    let error = require_clean_shutdown(Err("worker drain timed out".to_string()))
        .expect_err("failed cleanup must abort installation");

    assert!(error.contains("installation aborted"));
    assert!(error.contains("worker drain timed out"));
}
