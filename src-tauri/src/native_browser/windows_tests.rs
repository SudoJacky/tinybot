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
    completion.mark_completed();
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
fn child_webview_labels_are_capability_isolated() {
    assert_eq!(safe_label("browser/tab:1"), "browser-tab-1");
}

#[test]
fn injected_scripts_are_narrow_and_privacy_bounded() {
    assert!(DIRECT_INPUT_SCRIPT.contains("event.isTrusted"));
    assert!(DIRECT_INPUT_SCRIPT.contains(DIRECT_INPUT_MESSAGE));
    assert!(!DIRECT_INPUT_SCRIPT.contains("__TAURI__"));
    assert!(OBSERVE_SCRIPT.contains("const limit = 500"));
    assert!(OBSERVE_SCRIPT.contains("parts.length < 8"));
    assert!(OBSERVE_SCRIPT.contains("slice(0, 160)"));
    assert!(OBSERVE_SCRIPT.contains("inputType === 'password'"));
    assert!(OBSERVE_SCRIPT.contains("cc-|one-time-code"));
    assert!(OBSERVE_SCRIPT.contains("sensitive ? ''"));
}
