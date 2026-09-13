use chrono::{Datelike, Days, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Schedule {
    #[serde(default)]
    pub repeat: Repeat,
    pub start_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Repeat {
    #[default]
    Manual,
    Once,
    Daily,
    Weekdays,
    Weekly,
}

impl Schedule {
    pub fn first(&self) -> Result<Option<u64>, String> {
        if self.repeat == Repeat::Manual {
            return Ok(None);
        }
        let start = self.start_at_ms.ok_or("Schedule start time is required")?;
        let date = i64::try_from(start)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .ok_or("Invalid schedule start time")?
            .with_timezone(&Local);
        if self.repeat == Repeat::Weekdays && date.weekday().number_from_monday() > 5 {
            return self.after(start);
        }
        Ok(Some(start))
    }

    // Recurrences follow this desktop's local wall clock. On a DST gap, skip
    // that nonexistent occurrence; on a repeated clock time, use the first one.
    pub fn after(&self, now: u64) -> Result<Option<u64>, String> {
        if matches!(self.repeat, Repeat::Manual | Repeat::Once) {
            return Ok(None);
        }
        let start = self.start_at_ms.ok_or("Schedule start time is required")?;
        let origin = i64::try_from(start)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .ok_or("Invalid schedule start time")?
            .with_timezone(&Local);
        let current = i64::try_from(now)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .ok_or("Invalid current time")?
            .with_timezone(&Local);
        let date = current.date_naive().max(origin.date_naive());
        for offset in 0..15 {
            let day = date
                .checked_add_days(Days::new(offset))
                .ok_or("Schedule date overflow")?;
            if self.repeat == Repeat::Weekdays && day.weekday().number_from_monday() > 5 {
                continue;
            }
            if self.repeat == Repeat::Weekly && day.weekday() != origin.weekday() {
                continue;
            }
            if let Some(next) = Local
                .from_local_datetime(&day.and_time(origin.time()))
                .earliest()
            {
                let timestamp = next.with_timezone(&Utc).timestamp_millis() as u64;
                if timestamp > now && timestamp >= start {
                    return Ok(Some(timestamp));
                }
            }
        }
        Err("Cannot resolve the next local schedule occurrence".into())
    }
}
