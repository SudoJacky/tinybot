use super::WindowsTerminalOutputNormalizer;

#[test]
fn removes_split_cursor_queries_and_counts_responses() {
    let mut normalizer = WindowsTerminalOutputNormalizer::default();
    let first = normalizer.normalize(b"before\x1b[");
    assert_eq!(first.output, b"before");
    assert_eq!(first.cursor_position_queries, 0);

    let second = normalizer.normalize(b"6nafter\x1b[6n");
    assert_eq!(second.output, b"after");
    assert_eq!(second.cursor_position_queries, 2);

    let _ = normalizer.normalize(b"tail\x1b[");
    assert_eq!(normalizer.finish(), b"\x1b[");
}
