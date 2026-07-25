use super::*;

#[test]
fn update_plan_arguments_are_trimmed_and_typed() {
    let args = parse_update_plan_args(
            r#"{"explanation":"  Adjusted order  ","plan":[{"step":"  Inspect code  ","status":"in_progress"},{"step":"Run tests","status":"pending"}]}"#,
        )
        .expect("valid update_plan arguments should parse");

    assert_eq!(args.explanation.as_deref(), Some("Adjusted order"));
    assert_eq!(args.plan[0].step, "Inspect code");
    assert_eq!(
        args.plan[0].status,
        super::super::AgentPlanStepStatus::InProgress
    );
}

#[test]
fn update_plan_rejects_invalid_execution_state() {
    for (arguments, expected) in [
        (
            r#"{"plan":[{"step":"One","status":"pending"}]}"#,
            "exactly one in_progress",
        ),
        (
            r#"{"plan":[{"step":"One","status":"in_progress"},{"step":"Two","status":"in_progress"}]}"#,
            "at most one step",
        ),
        (
            r#"{"plan":[{"step":"One","status":"in_progress"},{"step":"One","status":"pending"}]}"#,
            "duplicate step",
        ),
        (r#"{"plan":[],"ignored":true}"#, "unknown field"),
    ] {
        let error = parse_update_plan_args(arguments)
            .expect_err("invalid update_plan arguments should fail visibly");
        assert!(
            error.contains(expected),
            "expected `{expected}` in `{error}`"
        );
    }
}
