use super::*;

#[test]
fn navigation_policy_accepts_only_http_and_blank() {
    assert_eq!(safe_browser_url("example.com").unwrap().scheme(), "https");
    assert!(safe_browser_url("http://localhost:1420").is_ok());
    assert!(safe_browser_url("about:blank").is_ok());
    for denied in [
        "file:///c:/secret",
        "javascript:alert(1)",
        "data:text/html,x",
        "tauri://localhost",
    ] {
        assert!(
            safe_browser_url(denied).is_err(),
            "{denied} should be denied"
        );
    }
}

#[test]
fn diagnostic_url_redacts_sensitive_components() {
    assert_eq!(
        redact_browser_url("https://user:pass@example.com/path?q=secret#fragment").as_deref(),
        Some("https://example.com/path")
    );
}

#[test]
fn capability_decisions_do_not_overstate_protected_operations() {
    let capabilities = available_windows_capabilities();
    assert!(capabilities.session_snapshot.available);
    assert!(capabilities.direct_input.available);
    assert!(capabilities.real_capture.available);
    assert!(capabilities.semantic_observation.available);
    assert!(capabilities.agent_interaction.available);
    assert!(capabilities.popups.available);
    assert!(!capabilities.downloads.available);
    assert_eq!(
        capabilities.downloads.reason_code.as_deref(),
        Some("download_contract_unavailable")
    );
    assert!(!capabilities.uploads.available);

    let unsupported = unsupported_capabilities("platform_unavailable", "not supported");
    assert!(!unsupported.session_snapshot.available);
    assert!(!unsupported.agent_interaction.available);
}

#[test]
fn navigation_policy_distinguishes_confirmable_external_protocols() {
    assert_eq!(
        navigation_policy(&url::Url::parse("mailto:hello@example.com").unwrap()),
        BrowserNavigationPolicy::ExternalCandidate
    );
    assert_eq!(
        navigation_policy(&url::Url::parse("file:///c:/secret").unwrap()),
        BrowserNavigationPolicy::Denied
    );
    assert!(external_protocol_url("ms-teams://meeting/123").is_ok());
    assert!(external_protocol_url("javascript:alert(1)").is_err());
}
