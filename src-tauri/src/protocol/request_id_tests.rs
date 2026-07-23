use super::*;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

#[test]
fn generator_returns_unique_correlation_keys_across_threads() {
    let generator = Arc::new(WorkerRequestIdGenerator::with_run_prefix("same-ms"));
    let keys = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for _ in 0..8 {
        let generator = Arc::clone(&generator);
        let keys = Arc::clone(&keys);
        handles.push(std::thread::spawn(move || {
            for _ in 0..32 {
                let correlation = generator.next();
                keys.lock().expect("keys mutex should lock").push((
                    correlation.id("agent-turn"),
                    correlation.trace_id("agent-turn"),
                ));
            }
        }));
    }

    for handle in handles {
        handle.join().expect("request id worker should finish");
    }

    let keys = keys.lock().expect("keys mutex should lock");
    let ids = keys
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<BTreeSet<_>>();
    let trace_ids = keys
        .iter()
        .map(|(_, trace_id)| trace_id.clone())
        .collect::<BTreeSet<_>>();

    assert_eq!(keys.len(), 256);
    assert_eq!(ids.len(), keys.len());
    assert_eq!(trace_ids.len(), keys.len());
}
