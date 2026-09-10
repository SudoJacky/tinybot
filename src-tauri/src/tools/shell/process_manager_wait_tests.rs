use super::{ShellProcessRecord, ValidatedShellStart};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn running_record() -> Arc<ShellProcessRecord> {
    ShellProcessRecord::new(
        "wait-test".to_string(),
        None,
        &ValidatedShellStart {
            command: String::new(),
            working_dir: PathBuf::from("."),
            working_dir_display: ".".to_string(),
            tty: false,
            yield_time_ms: 0,
            rows: 24,
            cols: 80,
            owner_id: None,
            tool_call_id: None,
            cancellation: None,
        },
    )
}

#[test]
fn terminal_wait_rechecks_the_deadline_after_timer_wakeups() {
    let record = running_record();
    for attempt in 0..32 {
        let timeout = Duration::from_millis(125);
        let started = Instant::now();
        assert!(!record.wait_for_terminal(timeout));
        let elapsed = started.elapsed();
        assert!(
            elapsed >= timeout,
            "attempt {attempt}: {elapsed:?} < {timeout:?}"
        );
        assert!(record.is_running());
    }
}

#[test]
fn output_wait_rechecks_the_deadline_after_timer_wakeups() {
    let record = running_record();
    for attempt in 0..32 {
        let timeout = Duration::from_millis(125);
        let started = Instant::now();
        let output = record.wait_for_output(0, timeout);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= timeout,
            "attempt {attempt}: {elapsed:?} < {timeout:?}"
        );
        assert!(output.running);
        assert!(output.output.is_empty());
    }
}
