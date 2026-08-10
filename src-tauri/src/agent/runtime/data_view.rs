use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const DATA_VIEW_SCHEMA_VERSION: &str = "tinybot.data_view.v1";
const DATA_VIEW_MIME_TYPE: &str = "application/vnd.tinybot.data-view+json;version=1";
const MAX_ARTIFACT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DataViewDocument {
    schema_version: String,
    title: String,
    insight: String,
    dataset: DataViewDataset,
    view: DataView,
    provenance: DataViewProvenance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewDataset {
    columns: Vec<DataViewColumn>,
    rows: Vec<DataViewRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewColumn {
    key: String,
    label: String,
    #[serde(rename = "type")]
    kind: DataViewColumnType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<DataViewNumberFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fraction_digits: Option<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewColumnType {
    Category,
    String,
    Number,
    Date,
    Datetime,
    Boolean,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewNumberFormat {
    Number,
    Integer,
    Compact,
    Percent,
    Currency,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewRow {
    id: String,
    values: Map<String, Value>,
    #[serde(default)]
    source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum DataView {
    Metrics {
        items: Vec<DataViewMetric>,
    },
    Table {
        #[serde(default)]
        fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_sort: Option<DataViewSort>,
    },
    Cartesian {
        x: String,
        series: Vec<DataViewSeries>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack: Option<DataViewStack>,
    },
    Waterfall {
        category: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_field: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewMetric {
    field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comparison_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    direction: Option<DataViewMetricDirection>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewMetricDirection {
    HigherIsBetter,
    LowerIsBetter,
    Neutral,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewSort {
    field: String,
    direction: DataViewSortDirection,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewSeries {
    field: String,
    mark: DataViewMark,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    axis: Option<DataViewAxis>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewMark {
    Line,
    Bar,
    Area,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewAxis {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewStack {
    None,
    Normal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewProvenance {
    status: DataViewProvenanceStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    as_of: Option<String>,
    #[serde(default)]
    sources: Vec<DataViewSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    methodology: Option<String>,
    #[serde(default)]
    caveats: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewProvenanceStatus {
    Sourced,
    UserProvided,
    Unsourced,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataViewSource {
    id: String,
    kind: DataViewSourceKind,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    locator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DataViewSourceKind {
    Url,
    File,
    UserInput,
}

pub(super) struct PublishedDataView {
    pub artifact: Value,
    pub artifact_id: String,
    pub byte_size: usize,
    pub column_count: usize,
    pub row_count: usize,
    pub title: String,
    pub warnings: Vec<String>,
}

pub(super) fn publish_data_view(
    arguments: &Map<String, Value>,
    turn_id: &str,
    tool_call_id: &str,
) -> Result<PublishedDataView, String> {
    let schema_version = arguments
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if schema_version != DATA_VIEW_SCHEMA_VERSION {
        return Err(format!(
            "data_view_schema_unsupported: schemaVersion must be `{DATA_VIEW_SCHEMA_VERSION}`"
        ));
    }
    let document: DataViewDocument = serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|error| format!("data_view_invalid_shape: {error}"))?;
    validate_document(&document)?;

    let content = serde_json::to_value(&document)
        .map_err(|error| format!("data_view_invalid_shape: failed to serialize view: {error}"))?;
    let byte_size = serde_json::to_vec(&content)
        .map_err(|error| format!("data_view_invalid_shape: failed to size view: {error}"))?
        .len();
    if byte_size > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "data_view_limit_exceeded: serialized content is {byte_size} bytes; maximum is {MAX_ARTIFACT_BYTES}"
        ));
    }

    let artifact_id = artifact_id(turn_id, tool_call_id);
    let warnings = validation_warnings(&document);
    let artifact = serde_json::json!({
        "id": artifact_id,
        "kind": "data_view",
        "mimeType": DATA_VIEW_MIME_TYPE,
        "title": document.title,
        "preview": document.insight,
        "sizeBytes": byte_size,
        "status": "available",
        "content": content,
        "warnings": warnings,
    });
    Ok(PublishedDataView {
        artifact,
        artifact_id,
        byte_size,
        column_count: document.dataset.columns.len(),
        row_count: document.dataset.rows.len(),
        title: document.title,
        warnings,
    })
}

fn artifact_id(turn_id: &str, tool_call_id: &str) -> String {
    let digest = Sha256::digest(format!("{turn_id}:{tool_call_id}"));
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("dv_{suffix}")
}

fn validate_document(document: &DataViewDocument) -> Result<(), String> {
    validate_text("title", &document.title, 1, 160)?;
    validate_text("insight", &document.insight, 1, 500)?;
    validate_limit("columns", document.dataset.columns.len(), 1, 20)?;
    validate_limit("rows", document.dataset.rows.len(), 1, 1_000)?;
    validate_limit("sources", document.provenance.sources.len(), 0, 64)?;

    let mut columns = HashMap::new();
    for column in &document.dataset.columns {
        validate_identifier("column key", &column.key)?;
        validate_text("column label", &column.label, 1, 120)?;
        if columns.insert(column.key.as_str(), column).is_some() {
            return Err(format!(
                "data_view_invalid_shape: duplicate column key `{}`",
                column.key
            ));
        }
        if column.fraction_digits.is_some_and(|digits| digits > 4) {
            return Err(format!(
                "data_view_invalid_shape: column `{}` fractionDigits must be between 0 and 4",
                column.key
            ));
        }
        if column.kind != DataViewColumnType::Number
            && (column.format.is_some()
                || column.currency.is_some()
                || column.unit.is_some()
                || column.fraction_digits.is_some())
        {
            return Err(format!(
                "data_view_invalid_shape: non-number column `{}` cannot declare numeric formatting",
                column.key
            ));
        }
        if column.format == Some(DataViewNumberFormat::Currency) {
            let valid_currency = column.currency.as_deref().is_some_and(|currency| {
                currency.len() == 3
                    && currency
                        .bytes()
                        .all(|character| character.is_ascii_uppercase())
            });
            if !valid_currency {
                return Err(format!(
                    "data_view_invalid_shape: currency column `{}` requires a three-letter uppercase currency code",
                    column.key
                ));
            }
        } else if column.currency.is_some() {
            return Err(format!(
                "data_view_invalid_shape: column `{}` declares currency without currency format",
                column.key
            ));
        }
    }

    let mut source_ids = HashSet::new();
    for source in &document.provenance.sources {
        validate_identifier("source id", &source.id)?;
        validate_text("source title", &source.title, 1, 240)?;
        if !source_ids.insert(source.id.as_str()) {
            return Err(format!(
                "data_view_invalid_shape: duplicate source id `{}`",
                source.id
            ));
        }
        if source.kind == DataViewSourceKind::Url {
            let uri = source.uri.as_deref().ok_or_else(|| {
                format!(
                    "data_view_invalid_shape: URL source `{}` requires uri",
                    source.id
                )
            })?;
            let parsed = url::Url::parse(uri).map_err(|error| {
                format!(
                    "data_view_invalid_shape: source `{}` has invalid URL: {error}",
                    source.id
                )
            })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(format!(
                    "data_view_invalid_shape: source `{}` URL must use http or https",
                    source.id
                ));
            }
        }
    }
    if document.provenance.status == DataViewProvenanceStatus::Sourced
        && document.provenance.sources.is_empty()
    {
        return Err(
            "data_view_invalid_shape: sourced provenance requires at least one source".to_string(),
        );
    }

    let mut row_ids = HashSet::new();
    for row in &document.dataset.rows {
        validate_identifier("row id", &row.id)?;
        if !row_ids.insert(row.id.as_str()) {
            return Err(format!(
                "data_view_invalid_shape: duplicate row id `{}`",
                row.id
            ));
        }
        for (key, value) in &row.values {
            let column = columns.get(key.as_str()).ok_or_else(|| {
                format!("data_view_unknown_field: row `{}` contains `{key}`", row.id)
            })?;
            validate_cell_value(&row.id, column, value)?;
        }
        for source_id in &row.source_ids {
            if !source_ids.contains(source_id.as_str()) {
                return Err(format!(
                    "data_view_unknown_source: row `{}` references `{source_id}`",
                    row.id
                ));
            }
        }
    }
    validate_view(&document.view, &columns)
}

fn validate_view(view: &DataView, columns: &HashMap<&str, &DataViewColumn>) -> Result<(), String> {
    match view {
        DataView::Metrics { items } => {
            validate_limit("metric items", items.len(), 1, 6)?;
            for item in items {
                require_column_type(columns, &item.field, &[DataViewColumnType::Number])?;
                if let Some(field) = item.comparison_field.as_deref() {
                    require_column_type(columns, field, &[DataViewColumnType::Number])?;
                }
            }
        }
        DataView::Table {
            fields,
            default_sort,
        } => {
            let mut seen = HashSet::new();
            for field in fields {
                require_column(columns, field)?;
                if !seen.insert(field) {
                    return Err(format!(
                        "data_view_invalid_encoding: table field `{field}` is repeated"
                    ));
                }
            }
            if let Some(sort) = default_sort {
                require_column(columns, &sort.field)?;
            }
        }
        DataView::Cartesian { x, series, stack } => {
            require_column_type(
                columns,
                x,
                &[
                    DataViewColumnType::Category,
                    DataViewColumnType::String,
                    DataViewColumnType::Date,
                    DataViewColumnType::Datetime,
                ],
            )?;
            validate_limit("cartesian series", series.len(), 1, 6)?;
            for item in series {
                require_column_type(columns, &item.field, &[DataViewColumnType::Number])?;
            }
            let right_series = series
                .iter()
                .filter(|item| item.axis == Some(DataViewAxis::Right))
                .collect::<Vec<_>>();
            if !right_series.is_empty() {
                if series.len() > 2 {
                    return Err(
                        "data_view_invalid_encoding: a right axis is allowed only with at most two series"
                            .to_string(),
                    );
                }
                let left = series
                    .iter()
                    .find(|item| item.axis != Some(DataViewAxis::Right))
                    .ok_or_else(|| {
                        "data_view_invalid_encoding: a right axis requires a left-axis series"
                            .to_string()
                    })?;
                let left_column = columns[left.field.as_str()];
                let right_column = columns[right_series[0].field.as_str()];
                if left_column.format == right_column.format
                    && left_column.unit == right_column.unit
                    && left_column.currency == right_column.currency
                {
                    return Err(
                        "data_view_invalid_encoding: right axis must use a different unit or format"
                            .to_string(),
                    );
                }
            }
            if *stack == Some(DataViewStack::Normal) {
                if series.iter().any(|item| item.mark == DataViewMark::Line)
                    || series
                        .iter()
                        .map(|item| item.axis.unwrap_or(DataViewAxis::Left))
                        .collect::<HashSet<_>>()
                        .len()
                        != 1
                {
                    return Err(
                        "data_view_invalid_encoding: stacked series must be bar or area marks on one axis"
                            .to_string(),
                    );
                }
            }
        }
        DataView::Waterfall {
            category,
            value,
            total_field,
        } => {
            require_column_type(
                columns,
                category,
                &[DataViewColumnType::Category, DataViewColumnType::String],
            )?;
            require_column_type(columns, value, &[DataViewColumnType::Number])?;
            if let Some(field) = total_field.as_deref() {
                require_column_type(columns, field, &[DataViewColumnType::Boolean])?;
            }
        }
    }
    Ok(())
}

fn require_column<'a>(
    columns: &'a HashMap<&str, &DataViewColumn>,
    field: &str,
) -> Result<&'a DataViewColumn, String> {
    columns
        .get(field)
        .copied()
        .ok_or_else(|| format!("data_view_unknown_field: view references `{field}`"))
}

fn require_column_type(
    columns: &HashMap<&str, &DataViewColumn>,
    field: &str,
    allowed: &[DataViewColumnType],
) -> Result<(), String> {
    let column = require_column(columns, field)?;
    if !allowed.contains(&column.kind) {
        return Err(format!(
            "data_view_invalid_encoding: `{field}` has an incompatible column type"
        ));
    }
    Ok(())
}

fn validate_cell_value(row_id: &str, column: &DataViewColumn, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let valid = match column.kind {
        DataViewColumnType::Category | DataViewColumnType::String => value.is_string(),
        DataViewColumnType::Number => value.is_number(),
        DataViewColumnType::Boolean => value.is_boolean(),
        DataViewColumnType::Date => value.as_str().is_some_and(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok() && value.len() == 10
        }),
        DataViewColumnType::Datetime => value
            .as_str()
            .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_ok()),
    };
    if !valid {
        return Err(format!(
            "data_view_type_mismatch: row `{row_id}` field `{}` does not match its declared type",
            column.key
        ));
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    let mut characters = value.chars();
    let valid_first = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_');
    let valid_rest = characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-'));
    if !valid_first || !valid_rest {
        return Err(format!(
            "data_view_invalid_shape: {label} `{value}` is not a valid identifier"
        ));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let length = value.trim().chars().count();
    if length < min || length > max {
        return Err(format!(
            "data_view_invalid_shape: {label} must contain between {min} and {max} characters"
        ));
    }
    Ok(())
}

fn validate_limit(label: &str, count: usize, min: usize, max: usize) -> Result<(), String> {
    if count < min || count > max {
        return Err(format!(
            "data_view_limit_exceeded: {label} count must be between {min} and {max}; received {count}"
        ));
    }
    Ok(())
}

fn validation_warnings(document: &DataViewDocument) -> Vec<String> {
    let mut warnings = Vec::new();
    if document.provenance.status == DataViewProvenanceStatus::Unsourced {
        warnings.push("unsourced_data".to_string());
    }
    if document.provenance.sources.len() > 1
        && document
            .dataset
            .rows
            .iter()
            .all(|row| row.source_ids.is_empty())
    {
        warnings.push("no_row_level_source_mapping".to_string());
    }
    if matches!(&document.view, DataView::Cartesian { series, .. } if series.len() > 4) {
        warnings.push("many_series".to_string());
    }
    if normalized_comparison_text(&document.title) == normalized_comparison_text(&document.insight)
    {
        warnings.push("title_repeats_insight".to_string());
    }
    warnings
}

fn normalized_comparison_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_view() -> Map<String, Value> {
        json!({
            "schemaVersion": "tinybot.data_view.v1",
            "title": "Revenue and growth",
            "insight": "Revenue rose while growth slowed.",
            "dataset": {
                "columns": [
                    { "key": "period", "label": "Period", "type": "category" },
                    { "key": "revenue", "label": "Revenue", "type": "number", "format": "currency", "currency": "USD", "unit": "million", "fractionDigits": 0 },
                    { "key": "growth", "label": "Growth", "type": "number", "format": "percent", "fractionDigits": 1 }
                ],
                "rows": [
                    { "id": "fy24", "values": { "period": "FY2024", "revenue": 391035, "growth": 9.4 }, "sourceIds": ["filing"] },
                    { "id": "fy25", "values": { "period": "FY2025", "revenue": 403155, "growth": 3.1 }, "sourceIds": ["filing"] }
                ]
            },
            "view": {
                "kind": "cartesian",
                "x": "period",
                "series": [
                    { "field": "revenue", "mark": "bar", "axis": "left" },
                    { "field": "growth", "mark": "line", "axis": "right" }
                ],
                "stack": "none"
            },
            "provenance": {
                "status": "sourced",
                "asOf": "2025-09-27",
                "sources": [{ "id": "filing", "kind": "url", "title": "FY2025 Form 10-K", "uri": "https://example.com/filing" }],
                "methodology": "Reported annual revenue.",
                "caveats": []
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn publishes_a_valid_mixed_chart() {
        let published = publish_data_view(&valid_view(), "turn-1", "call-1").unwrap();
        assert!(published.artifact_id.starts_with("dv_"));
        assert_eq!(published.column_count, 3);
        assert_eq!(published.row_count, 2);
        assert_eq!(published.artifact["kind"], "data_view");
        assert_eq!(published.artifact["content"]["view"]["kind"], "cartesian");
        assert!(published.warnings.is_empty());
    }

    #[test]
    fn omits_absent_optional_fields_from_published_content() {
        let mut input = Value::Object(valid_view());
        input["view"] = json!({
            "kind": "metrics",
            "items": [{ "field": "growth" }]
        });
        input["provenance"].as_object_mut().unwrap().remove("asOf");
        input["provenance"]
            .as_object_mut()
            .unwrap()
            .remove("methodology");

        let published = publish_data_view(
            input.as_object().unwrap(),
            "turn-optional-fields",
            "call-optional-fields",
        )
        .unwrap();
        let first_column = published.artifact["content"]["dataset"]["columns"][0]
            .as_object()
            .unwrap();
        assert!(!first_column.contains_key("format"));
        assert!(!first_column.contains_key("currency"));
        assert!(!first_column.contains_key("unit"));
        assert!(!first_column.contains_key("fractionDigits"));
        let metric = published.artifact["content"]["view"]["items"][0]
            .as_object()
            .unwrap();
        assert!(!metric.contains_key("comparisonField"));
        assert!(!metric.contains_key("direction"));
        let provenance = published.artifact["content"]["provenance"]
            .as_object()
            .unwrap();
        assert!(!provenance.contains_key("asOf"));
        assert!(!provenance.contains_key("methodology"));
    }

    #[test]
    fn rejects_unknown_row_fields_without_creating_an_artifact() {
        let mut input = Value::Object(valid_view());
        input["dataset"]["rows"][0]["values"]["invented"] = json!(42);
        let error = publish_data_view(input.as_object().unwrap(), "turn-1", "call-unknown-field")
            .err()
            .expect("invalid view must fail");
        assert!(error.starts_with("data_view_unknown_field:"));
    }

    #[test]
    fn warns_when_provenance_is_unsourced() {
        let mut input = Value::Object(valid_view());
        input["provenance"]["status"] = json!("unsourced");
        input["provenance"]["sources"] = json!([]);
        for row in input["dataset"]["rows"].as_array_mut().unwrap() {
            row.as_object_mut().unwrap().remove("sourceIds");
        }
        let published =
            publish_data_view(input.as_object().unwrap(), "turn-1", "call-unsourced").unwrap();
        assert_eq!(published.warnings, vec!["unsourced_data"]);
    }
}
