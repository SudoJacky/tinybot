#[cfg(target_os = "windows")]
use super::decode_available_windows_code_page;
use super::HeadTailOutput;

#[test]
fn retains_utf8_characters_split_across_reader_chunks() {
    let mut output = HeadTailOutput::new();
    output.append("stdout", &[0xe4, 0xb8]);
    assert_eq!(output.snapshot_after(0).cursor, 0);

    output.append("stdout", &[0xad]);
    let snapshot = output.snapshot_after(0);
    assert_eq!(snapshot.chunks.len(), 1);
    assert_eq!(snapshot.chunks[0].content, "中");
}

#[test]
fn head_tail_boundaries_do_not_split_utf8_characters() {
    let mut output = HeadTailOutput::new();
    output.append("stdout", &vec![b'x'; super::OUTPUT_HEAD_BYTES - 1]);
    output.append("stdout", "中".as_bytes());
    output.append("stdout", b"z");

    let snapshot = output.snapshot_after(0);
    let rendered = snapshot
        .chunks
        .iter()
        .map(|chunk| chunk.content.as_str())
        .collect::<String>();
    assert!(rendered.ends_with("中z"));
    assert!(!rendered.contains('�'));
}

#[cfg(target_os = "windows")]
#[test]
fn retains_windows_dbcs_characters_split_across_reader_chunks() {
    let (_, pending) = decode_available_windows_code_page(&[0xce], 936);
    assert_eq!(pending, [0xce]);

    let mut combined = pending;
    combined.push(0xc4);
    let (decoded, pending) = decode_available_windows_code_page(&combined, 936);
    assert!(pending.is_empty());
    assert_eq!(String::from_utf8(decoded).unwrap(), "文");
}
