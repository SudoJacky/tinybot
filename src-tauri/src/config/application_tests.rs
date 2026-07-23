use super::*;

#[test]
fn directory_config_path_reports_structured_load_error() {
    let root =
        std::env::temp_dir().join(format!("tinybot-config-application-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("fixture directory should create");
    let application = ConfigApplication::new(root.clone(), serde_json::json!({}));

    let error = application
        .editor_snapshot()
        .expect_err("directory config path should fail to load");

    assert_eq!(error.code, ConfigApplicationErrorCode::LoadConfigStore);
    assert_eq!(error.config_path, root);
    assert!(!error.message.is_empty());
    std::fs::remove_dir_all(&error.config_path).expect("fixture directory should clean up");
}
