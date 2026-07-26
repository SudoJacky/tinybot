use super::finish_native_agent_turn;

#[test]
fn continuation_turn_reports_both_runtime_and_flush_failures() {
    let error = finish_native_agent_turn::<()>(
        Err("runtime failed".to_string()),
        Err("flush failed".to_string()),
        "native agent continuation",
    )
    .expect_err("both failures should be reported");

    assert_eq!(
        error,
        "native agent continuation failed: runtime failed; trace persistence flush failed: \
             flush failed"
    );
}
