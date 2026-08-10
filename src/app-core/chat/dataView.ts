export const DATA_VIEW_SCHEMA_VERSION = "tinybot.data_view.v1" as const;

export type DataViewColumnType = "category" | "string" | "number" | "date" | "datetime" | "boolean";
export type DataViewNumberFormat = "number" | "integer" | "compact" | "percent" | "currency";
export type DataViewCell = string | number | boolean | null;

export type DataViewColumn = {
  key: string;
  label: string;
  type: DataViewColumnType;
  format?: DataViewNumberFormat;
  currency?: string;
  unit?: string;
  fractionDigits?: number;
};

export type DataViewRow = {
  id: string;
  values: Record<string, DataViewCell>;
  sourceIds?: string[];
};

export type DataViewMetric = {
  field: string;
  comparisonField?: string;
  direction?: "higher_is_better" | "lower_is_better" | "neutral";
};

export type DataViewSeries = {
  field: string;
  mark: "line" | "bar" | "area";
  axis?: "left" | "right";
};

export type DataViewView =
  | { kind: "metrics"; items: DataViewMetric[] }
  | { kind: "table"; fields?: string[]; defaultSort?: { field: string; direction: "asc" | "desc" } }
  | { kind: "cartesian"; x: string; series: DataViewSeries[]; stack?: "none" | "normal" }
  | { kind: "waterfall"; category: string; value: string; totalField?: string };

export type DataViewSource = {
  id: string;
  kind: "url" | "file" | "user_input";
  title: string;
  uri?: string;
  locator?: string;
  publishedAt?: string;
};

export type DataViewDocument = {
  schemaVersion: typeof DATA_VIEW_SCHEMA_VERSION;
  title: string;
  insight: string;
  dataset: { columns: DataViewColumn[]; rows: DataViewRow[] };
  view: DataViewView;
  provenance: {
    status: "sourced" | "user_provided" | "unsourced";
    asOf?: string;
    sources: DataViewSource[];
    methodology?: string;
    caveats: string[];
  };
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const COLUMN_TYPES = new Set<DataViewColumnType>(["category", "string", "number", "date", "datetime", "boolean"]);
const NUMBER_FORMATS = new Set<DataViewNumberFormat>(["number", "integer", "compact", "percent", "currency"]);

export function parseDataViewDocument(value: unknown): DataViewDocument {
  const root = objectValue(value, "data view");
  if (root.schemaVersion !== DATA_VIEW_SCHEMA_VERSION) {
    throw new Error(`Unsupported data view schema: ${stringValue(root.schemaVersion) || "missing"}.`);
  }
  const title = requiredText(root.title, "title", 160);
  const insight = requiredText(root.insight, "insight", 500);
  const dataset = objectValue(root.dataset, "dataset");
  const rawColumns = arrayValue(dataset.columns, "dataset.columns", 1, 20);
  const rawRows = arrayValue(dataset.rows, "dataset.rows", 1, 1_000);
  const columns = rawColumns.map(parseColumn);
  assertUnique(columns.map((column) => column.key), "column key");
  const columnsByKey = new Map(columns.map((column) => [column.key, column]));
  const provenance = parseProvenance(root.provenance);
  const sourceIds = new Set(provenance.sources.map((source) => source.id));
  const rows = rawRows.map((row) => parseRow(row, columnsByKey, sourceIds));
  assertUnique(rows.map((row) => row.id), "row id");
  const view = parseView(root.view, columnsByKey);
  return {
    schemaVersion: DATA_VIEW_SCHEMA_VERSION,
    title,
    insight,
    dataset: { columns, rows },
    view,
    provenance,
  };
}

function parseColumn(value: unknown): DataViewColumn {
  const raw = objectValue(value, "column");
  const key = identifierValue(raw.key, "column key");
  const label = requiredText(raw.label, `column ${key} label`, 120);
  const type = stringValue(raw.type) as DataViewColumnType;
  if (!COLUMN_TYPES.has(type)) {
    throw new Error(`Column ${key} has unsupported type.`);
  }
  const format = stringValue(raw.format) as DataViewNumberFormat | "";
  if (format && !NUMBER_FORMATS.has(format)) {
    throw new Error(`Column ${key} has unsupported number format.`);
  }
  const fractionDigits = isAbsent(raw.fractionDigits) ? undefined : numberValue(raw.fractionDigits, `${key}.fractionDigits`);
  if (fractionDigits !== undefined && (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 4)) {
    throw new Error(`Column ${key} fractionDigits is invalid.`);
  }
  if (type !== "number" && (format || !isAbsent(raw.currency) || !isAbsent(raw.unit) || fractionDigits !== undefined)) {
    throw new Error(`Non-number column ${key} contains numeric formatting.`);
  }
  const currency = optionalText(raw.currency, 3);
  if (format === "currency" && !/^[A-Z]{3}$/.test(currency ?? "")) {
    throw new Error(`Currency column ${key} requires an uppercase ISO code.`);
  }
  return {
    key,
    label,
    type,
    ...(format ? { format } : {}),
    ...(currency ? { currency } : {}),
    ...(optionalText(raw.unit, 64) ? { unit: optionalText(raw.unit, 64) } : {}),
    ...(fractionDigits !== undefined ? { fractionDigits } : {}),
  };
}

function parseRow(
  value: unknown,
  columns: Map<string, DataViewColumn>,
  sourceIds: Set<string>,
): DataViewRow {
  const raw = objectValue(value, "row");
  const id = identifierValue(raw.id, "row id");
  const rawValues = objectValue(raw.values, `row ${id} values`);
  const values: Record<string, DataViewCell> = {};
  for (const [key, cell] of Object.entries(rawValues)) {
    const column = columns.get(key);
    if (!column) {
      throw new Error(`Row ${id} contains unknown field ${key}.`);
    }
    if (!validCell(column.type, cell)) {
      throw new Error(`Row ${id} field ${key} does not match its declared type.`);
    }
    values[key] = cell as DataViewCell;
  }
  const rowSourceIds = raw.sourceIds === undefined
    ? undefined
    : arrayValue(raw.sourceIds, `row ${id} sourceIds`, 0, 64).map((sourceId) => identifierValue(sourceId, "source id"));
  if (rowSourceIds?.some((sourceId) => !sourceIds.has(sourceId))) {
    throw new Error(`Row ${id} references an unknown source.`);
  }
  return { id, values, ...(rowSourceIds?.length ? { sourceIds: rowSourceIds } : {}) };
}

function parseView(value: unknown, columns: Map<string, DataViewColumn>): DataViewView {
  const raw = objectValue(value, "view");
  const kind = stringValue(raw.kind);
  if (kind === "metrics") {
    const items = arrayValue(raw.items, "view.items", 1, 6).map((value) => {
      const item = objectValue(value, "metric item");
      const field = numericField(item.field, columns);
      const comparisonField = isAbsent(item.comparisonField) ? undefined : numericField(item.comparisonField, columns);
      const direction = stringValue(item.direction) as DataViewMetric["direction"] | "";
      if (direction && !["higher_is_better", "lower_is_better", "neutral"].includes(direction)) {
        throw new Error(`Metric ${field} has invalid direction.`);
      }
      return { field, ...(comparisonField ? { comparisonField } : {}), ...(direction ? { direction } : {}) };
    });
    return { kind, items };
  }
  if (kind === "table") {
    const fields = raw.fields === undefined
      ? undefined
      : arrayValue(raw.fields, "view.fields", 0, 20).map((field) => knownField(field, columns));
    const defaultSort = isAbsent(raw.defaultSort) ? undefined : objectValue(raw.defaultSort, "view.defaultSort");
    const direction = stringValue(defaultSort?.direction);
    if (defaultSort && !["asc", "desc"].includes(direction)) {
      throw new Error("Table defaultSort direction is invalid.");
    }
    return {
      kind,
      ...(fields?.length ? { fields } : {}),
      ...(defaultSort ? { defaultSort: { field: knownField(defaultSort.field, columns), direction: direction as "asc" | "desc" } } : {}),
    };
  }
  if (kind === "cartesian") {
    const x = knownField(raw.x, columns);
    if (!new Set(["category", "string", "date", "datetime"]).has(columns.get(x)!.type)) {
      throw new Error(`Cartesian x field ${x} has an incompatible type.`);
    }
    const series = arrayValue(raw.series, "view.series", 1, 6).map((value) => {
      const item = objectValue(value, "series");
      const field = numericField(item.field, columns);
      const mark = stringValue(item.mark) as DataViewSeries["mark"];
      const axis = stringValue(item.axis) as DataViewSeries["axis"] | "";
      if (!new Set(["line", "bar", "area"]).has(mark)) {
        throw new Error(`Series ${field} has unsupported mark.`);
      }
      if (axis && !new Set(["left", "right"]).has(axis)) {
        throw new Error(`Series ${field} has unsupported axis.`);
      }
      return { field, mark, ...(axis ? { axis } : {}) };
    });
    const stack = stringValue(raw.stack) as "none" | "normal" | "";
    if (stack && !["none", "normal"].includes(stack)) {
      throw new Error("Cartesian stack is invalid.");
    }
    return { kind, x, series, ...(stack ? { stack } : {}) };
  }
  if (kind === "waterfall") {
    const category = knownField(raw.category, columns);
    const categoryType = columns.get(category)!.type;
    if (categoryType !== "category" && categoryType !== "string") {
      throw new Error(`Waterfall category ${category} has an incompatible type.`);
    }
    const totalField = isAbsent(raw.totalField) ? undefined : knownField(raw.totalField, columns);
    if (totalField && columns.get(totalField)!.type !== "boolean") {
      throw new Error(`Waterfall total field ${totalField} must be boolean.`);
    }
    return { kind, category, value: numericField(raw.value, columns), ...(totalField ? { totalField } : {}) };
  }
  throw new Error(`Unsupported data view kind: ${kind || "missing"}.`);
}

function parseProvenance(value: unknown): DataViewDocument["provenance"] {
  const raw = objectValue(value, "provenance");
  const status = stringValue(raw.status) as DataViewDocument["provenance"]["status"];
  if (!new Set(["sourced", "user_provided", "unsourced"]).has(status)) {
    throw new Error("Data view provenance status is invalid.");
  }
  const sources = raw.sources === undefined
    ? []
    : arrayValue(raw.sources, "provenance.sources", 0, 64).map((value) => {
      const source = objectValue(value, "source");
      const kind = stringValue(source.kind) as DataViewSource["kind"];
      if (!new Set(["url", "file", "user_input"]).has(kind)) {
        throw new Error("Data view source kind is invalid.");
      }
      const uri = optionalText(source.uri, 2_048);
      if (kind === "url" && (!uri || !/^https?:\/\//i.test(uri))) {
        throw new Error("URL source requires an http or https URI.");
      }
      return {
        id: identifierValue(source.id, "source id"),
        kind,
        title: requiredText(source.title, "source title", 240),
        ...(uri ? { uri } : {}),
        ...(optionalText(source.locator, 500) ? { locator: optionalText(source.locator, 500) } : {}),
        ...(optionalText(source.publishedAt, 64) ? { publishedAt: optionalText(source.publishedAt, 64) } : {}),
      };
    });
  assertUnique(sources.map((source) => source.id), "source id");
  if (status === "sourced" && sources.length === 0) {
    throw new Error("Sourced data view has no sources.");
  }
  const caveats = raw.caveats === undefined
    ? []
    : arrayValue(raw.caveats, "provenance.caveats", 0, 64).map((item) => requiredText(item, "caveat", 1_000));
  return {
    status,
    sources,
    ...(optionalText(raw.asOf, 64) ? { asOf: optionalText(raw.asOf, 64) } : {}),
    ...(optionalText(raw.methodology, 2_000) ? { methodology: optionalText(raw.methodology, 2_000) } : {}),
    caveats,
  };
}

export function dataViewToCsv(document: DataViewDocument): string {
  const columns = document.dataset.columns;
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of document.dataset.rows) {
    lines.push(columns.map((column) => csvCell(row.values[column.key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export function formatDataViewCell(column: DataViewColumn, value: DataViewCell | undefined, locale?: string): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (column.type !== "number" || typeof value !== "number") {
    if (column.type === "boolean") {
      return value ? "Yes" : "No";
    }
    return String(value);
  }
  const maximumFractionDigits = column.fractionDigits ?? (column.format === "integer" ? 0 : 2);
  let formatted: string;
  if (column.format === "percent") {
    formatted = `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)}%`;
  } else if (column.format === "currency" && column.currency) {
    formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: column.currency,
      maximumFractionDigits,
    }).format(value);
  } else {
    formatted = new Intl.NumberFormat(locale, {
      ...(column.format === "compact" ? { notation: "compact" as const } : {}),
      maximumFractionDigits,
    }).format(value);
  }
  return column.unit ? `${formatted} ${column.unit}` : formatted;
}

function csvCell(value: DataViewCell | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function validCell(type: DataViewColumnType, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (typeof value !== "string") {
    return false;
  }
  if (type === "date") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  }
  if (type === "datetime") {
    return !Number.isNaN(Date.parse(value));
  }
  return true;
}

function knownField(value: unknown, columns: Map<string, DataViewColumn>): string {
  const field = identifierValue(value, "view field");
  if (!columns.has(field)) {
    throw new Error(`View references unknown field ${field}.`);
  }
  return field;
}

function numericField(value: unknown, columns: Map<string, DataViewColumn>): string {
  const field = knownField(value, columns);
  if (columns.get(field)!.type !== "number") {
    throw new Error(`View field ${field} must be numeric.`);
  }
  return field;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} items.`);
  }
  return value;
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = stringValue(value).trim();
  if (!text || [...text].length > max) {
    throw new Error(`${label} must contain between 1 and ${max} characters.`);
  }
  return text;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (isAbsent(value)) {
    return undefined;
  }
  const text = requiredText(value, "text", max);
  return text || undefined;
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function identifierValue(value: unknown, label: string): string {
  const identifier = stringValue(value);
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`${label} is invalid.`);
  }
  return identifier;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}.`);
  }
}
