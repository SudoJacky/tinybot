use super::strip_browser_capture_data;

#[test]
fn browser_capture_bytes_are_not_returned_to_the_model_context() {
    let mut result = serde_json::json!({
        "capture": { "captureId": "capture-1", "dataUrl": "data:image/png;base64,AAAA" },
        "snapshot": {
            "data": {
                "tabs": [{ "captures": [{ "captureId": "capture-1", "dataUrl": "data:image/png;base64,BBBB" }] }]
            }
        }
    });

    strip_browser_capture_data(&mut result);

    assert_eq!(result["capture"]["captureId"], "capture-1");
    assert!(result["capture"].get("dataUrl").is_none());
    assert!(result["snapshot"]["data"]["tabs"][0]["captures"][0]
        .get("dataUrl")
        .is_none());
}
