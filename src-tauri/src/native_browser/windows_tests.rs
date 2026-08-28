use super::*;

#[test]
fn profile_paths_must_stay_under_root() {
    let root = PathBuf::from(r"C:\tinybot\browser-profiles");
    assert!(ensure_profile_path(&root, &root.join("profile-a")).is_ok());
    assert!(ensure_profile_path(&root, &PathBuf::from(r"C:\tinybot\outside")).is_err());
}

#[tokio::test]
async fn navigation_completion_waits_for_a_new_finished_revision() {
    let completion = Arc::new(NavigationCompletion::default());
    let baseline = completion.revision();
    let waiter = tokio::spawn({
        let completion = completion.clone();
        async move { completion.wait_after(baseline).await }
    });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    completion.mark_completed("about:blank");
    waiter.await.unwrap().unwrap();
}

#[tokio::test]
async fn initial_navigation_completion_ignores_the_bootstrap_page() {
    let completion = Arc::new(NavigationCompletion::default());
    let baseline = completion.revision();
    let waiter = tokio::spawn({
        let completion = completion.clone();
        async move { completion.wait_for_non_blank_after(baseline).await }
    });
    completion.mark_completed("about:blank");
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());

    completion.mark_completed("https://example.com/");
    waiter.await.unwrap().unwrap();
}

#[tokio::test]
async fn profile_directory_cleanup_is_idempotent() {
    let path = std::env::temp_dir().join(format!(
        "tinybot-browser-profile-cleanup-{}",
        std::process::id()
    ));
    tokio::fs::create_dir_all(path.join("nested"))
        .await
        .unwrap();
    tokio::fs::write(path.join("nested/state"), b"fixture")
        .await
        .unwrap();

    remove_profile_directory(&path).await.unwrap();
    remove_profile_directory(&path).await.unwrap();

    assert!(!path.exists());
}

#[test]
fn child_webview_labels_replace_reserved_characters() {
    assert_eq!(safe_label("browser/tab:1"), "browser-tab-1");
}

#[test]
fn injected_script_source_keeps_reviewed_privacy_guards() {
    assert!(DIRECT_INPUT_SCRIPT.contains("event.isTrusted"));
    assert!(DIRECT_INPUT_SCRIPT.contains(DIRECT_INPUT_MESSAGE));
    assert!(DIRECT_INPUT_SCRIPT.contains(CONTENT_DIRTY_MESSAGE));
    assert!(DIRECT_INPUT_SCRIPT.contains("setTimeout"));
    assert!(DIRECT_INPUT_SCRIPT.contains("addEventListener('click'"));
    assert!(DIRECT_INPUT_SCRIPT.contains("addEventListener('keyup'"));
    assert!(!DIRECT_INPUT_SCRIPT.contains("addEventListener('pointerdown'"));
    assert!(!DIRECT_INPUT_SCRIPT.contains("addEventListener('keydown'"));
    assert!(DIRECT_INPUT_SCRIPT.contains("MutationObserver"));
    assert!(!DIRECT_INPUT_SCRIPT.contains("__TAURI__"));
    assert!(OBSERVE_SCRIPT.contains("const limit = 500"));
    assert!(OBSERVE_SCRIPT.contains("parts.length < 8"));
    assert!(OBSERVE_SCRIPT.contains("slice(0, 160)"));
    assert!(OBSERVE_SCRIPT.contains("const maxPageTextChars = 1000000"));
    assert!(OBSERVE_SCRIPT.contains("main, article, [role=\"main\"]"));
    assert!(OBSERVE_SCRIPT.contains("pageTextRevision"));
    assert!(!OBSERVE_SCRIPT.contains("pageText: normalizedPageText"));
    assert!(OBSERVE_SCRIPT.contains("inputType === 'password'"));
    assert!(OBSERVE_SCRIPT.contains("cc-|one-time-code"));
    assert!(OBSERVE_SCRIPT.contains("sensitive ? ''"));
    assert!(OBSERVE_SCRIPT.contains("element.closest?.('a[href]')"));
    assert!(OBSERVE_SCRIPT.contains("anchor.target"));
    assert!(OBSERVE_SCRIPT.contains("opensNewWindow"));
}

#[test]
fn page_text_script_source_includes_requested_bounds() {
    let script = page_text_script(64_000, 8_000);

    assert!(script.contains("const maxPageTextChars = 1000000"));
    assert!(script.contains("const requestedOffset = 64000"));
    assert!(script.contains("const requestedChars = 8000"));
    assert!(script.contains("nextTextOffset"));
    assert!(script.contains("sourceTruncated"));
    assert!(script.contains("pageTextHash"));
}

#[test]
fn observed_link_urls_are_absolute_and_embeddable() {
    assert_eq!(
        safe_observed_href(Some("https://agentskills.io/specification".to_string())),
        Some("https://agentskills.io/specification".to_string())
    );
    assert_eq!(
        safe_observed_href(Some("javascript:alert(1)".to_string())),
        None
    );
    assert_eq!(
        safe_observed_href(Some("mailto:test@example.com".to_string())),
        None
    );
}
