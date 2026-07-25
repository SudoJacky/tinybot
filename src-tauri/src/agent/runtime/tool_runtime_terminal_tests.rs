use super::*;

#[test]
fn lower_model_order_failure_replaces_a_faster_later_failure() {
    let terminal = ToolBatchTerminal::new();

    assert!(terminal.try_claim_failure(2));
    assert!(terminal.try_claim_failure(0));
    assert!(!terminal.try_claim_failure(1));
    assert_eq!(terminal.skip_outcome_for(0), None);
    assert_eq!(
        terminal.skip_outcome_for(1),
        Some(ToolBatchTerminalOutcome::Failed)
    );
    assert_eq!(
        terminal.skip_outcome_for(2),
        Some(ToolBatchTerminalOutcome::Failed)
    );
    assert_eq!(terminal.outcome(), Some(ToolBatchTerminalOutcome::Failed));
}
