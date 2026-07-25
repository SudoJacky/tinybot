use super::*;

#[test]
fn unix_epoch_converts_to_utc() {
    assert_eq!(unix_seconds_to_utc(0), (1970, 1, 1, 0, 0, 0));
}
