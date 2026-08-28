use super::*;

#[test]
fn unix_seconds_convert_across_calendar_boundaries() {
    let cases = [
        (0, (1970, 1, 1, 0, 0, 0)),
        (86_400, (1970, 1, 2, 0, 0, 0)),
        (951_868_799, (2000, 2, 29, 23, 59, 59)),
        (951_868_800, (2000, 3, 1, 0, 0, 0)),
        (4_107_542_399, (2100, 2, 28, 23, 59, 59)),
        (4_107_542_400, (2100, 3, 1, 0, 0, 0)),
    ];

    for (seconds, expected) in cases {
        assert_eq!(unix_seconds_to_utc(seconds), expected, "seconds={seconds}");
    }
}
