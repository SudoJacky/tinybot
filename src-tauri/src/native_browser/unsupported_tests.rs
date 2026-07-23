use super::*;

#[test]
fn unsupported_platform_reports_fail_closed_capabilities() {
    let capabilities = UnsupportedBrowserRuntime::platform_unsupported().capabilities();

    assert!(!capabilities.session_snapshot.available);
    assert_eq!(
        capabilities.session_snapshot.reason_code.as_deref(),
        Some("platform_unsupported")
    );
}

#[cfg(windows)]
#[test]
fn disabled_windows_feature_reports_fail_closed_capabilities() {
    let capabilities = UnsupportedBrowserRuntime::feature_disabled().capabilities();

    assert!(!capabilities.session_snapshot.available);
    assert_eq!(
        capabilities.session_snapshot.reason_code.as_deref(),
        Some("feature_disabled")
    );
}
