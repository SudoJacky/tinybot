type Cell = boolean | Date | number | string | null | undefined;
export type ComparisonSheet = { sheet: string; data: Cell[][] };
export type CellChange = { address: string; before: string; after: string };
export type SpreadsheetComparison = { changes: CellChange[]; total: number; addedSheets: string[]; removedSheets: string[] };

export function compareSpreadsheetValues(before: ComparisonSheet[], after: ComparisonSheet[]): SpreadsheetComparison {
  const previous = new Map(before.map((sheet) => [sheet.sheet, sheet.data]));
  const current = new Map(after.map((sheet) => [sheet.sheet, sheet.data]));
  const result: SpreadsheetComparison = { changes: [], total: 0, addedSheets: [...current.keys()].filter((name) => !previous.has(name)), removedSheets: [...previous.keys()].filter((name) => !current.has(name)) };
  let visited = 0;
  for (const sheet of new Set([...previous.keys(), ...current.keys()])) {
    const left = previous.get(sheet) ?? [];
    const right = current.get(sheet) ?? [];
    for (let row = 0; row < Math.max(left.length, right.length); row++) {
      const a = left[row] ?? [];
      const b = right[row] ?? [];
      for (let column = 0; column < Math.max(a.length, b.length); column++) {
        if (++visited > 1_000_000) throw new Error("Workbook exceeds the one-million-cell comparison limit.");
        const oldValue = formatCell(a[column]);
        const newValue = formatCell(b[column]);
        if (oldValue === newValue) continue;
        result.total++;
        if (result.changes.length < 200) result.changes.push({ address: `${sheet}!${columnName(column)}${row + 1}`, before: oldValue, after: newValue });
      }
    }
  }
  return result;
}

export async function readSpreadsheetComparison(before: Uint8Array, after: Uint8Array): Promise<SpreadsheetComparison> {
  const { default: readWorkbook } = await import("read-excel-file/browser");
  const options = { trim: false };
  const left = await readWorkbook(new Uint8Array(before).buffer, options);
  const right = await readWorkbook(new Uint8Array(after).buffer, options);
  return compareSpreadsheetValues(left as ComparisonSheet[], right as ComparisonSheet[]);
}

function formatCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}
function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}
