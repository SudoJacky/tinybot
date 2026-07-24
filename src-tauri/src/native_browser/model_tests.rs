use super::*;

#[test]
fn surface_rect_rejects_invalid_geometry() {
    assert!(BrowserSurfaceRect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 100.0,
        device_scale: 1.0,
    }
    .validate()
    .is_err());
}

#[test]
fn browser_ids_reject_blank_values() {
    assert!(BrowserProfileId::new("  ").is_err());
    assert_eq!(BrowserTabId("tab-1".to_string()).as_str(), "tab-1");
}

#[test]
fn lifecycle_state_machines_accept_progress_and_reject_regressions() {
    assert_eq!(
        BrowserSessionLifecycle::Creating
            .transition_to(BrowserSessionLifecycle::Ready)
            .unwrap(),
        BrowserSessionLifecycle::Ready
    );
    assert!(BrowserSessionLifecycle::Ready
        .transition_to(BrowserSessionLifecycle::Creating)
        .is_err());
    assert!(BrowserTabLifecycle::Crashed
        .transition_to(BrowserTabLifecycle::Creating)
        .is_ok());
    assert!(BrowserSurfaceLifecycle::Visible
        .transition_to(BrowserSurfaceLifecycle::Detached)
        .is_err());
    assert!(BrowserRendererLifecycle::Failed
        .transition_to(BrowserRendererLifecycle::Restarting)
        .is_ok());
    assert!(BrowserCommandStatus::Dispatched
        .transition_to(BrowserCommandStatus::Completed)
        .is_ok());
    assert!(BrowserCommandStatus::Completed
        .transition_to(BrowserCommandStatus::Dispatched)
        .is_err());
}
