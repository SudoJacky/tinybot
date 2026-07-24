use super::*;

#[test]
fn snapshot_aggregates_bounded_metric_names_without_dynamic_labels() {
    let metrics = AgentRuntimeMetrics::isolated();
    metrics.increment("turn.started");
    metrics.increment_by("recovery.orphaned_turns.interrupted", 2);
    metrics.record_duration_ms("turn.durationMs", 10);
    metrics.record_duration_ms("turn.durationMs", 30);
    metrics.set_gauge("context.tokens.after", 42);

    let snapshot = metrics.snapshot();

    assert_eq!(snapshot["counters"]["turn.started"], 1);
    assert_eq!(
        snapshot["counters"]["recovery.orphaned_turns.interrupted"],
        2
    );
    assert_eq!(snapshot["durations"]["turn.durationMs"]["count"], 2);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["totalMs"], 40);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["maxMs"], 30);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["averageMs"], 20.0);
    assert_eq!(snapshot["gauges"]["context.tokens.after"], 42);
}
