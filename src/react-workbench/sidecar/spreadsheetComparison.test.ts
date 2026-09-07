import { describe, expect, it } from "vitest";
import { compareSpreadsheetValues } from "./spreadsheetComparison";

describe("spreadsheet value comparison", () => {
  it("preserves addresses, whitespace and value types and reports added or removed sheets", () => {
    const result = compareSpreadsheetValues([
      { sheet: "Budget", data: [[], [null, 10, " trimmed ", false]] }, { sheet: "Removed", data: [[9]] },
    ], [
      { sheet: "Budget", data: [[], [null, "10", "trimmed", false]] }, { sheet: "Added", data: [] },
    ]);
    expect(result).toEqual({ changes: [
      { address: "Budget!B2", before: "10", after: '"10"' },
      { address: "Budget!C2", before: '" trimmed "', after: '"trimmed"' },
      { address: "Removed!A1", before: "9", after: "" },
    ], total: 3, addedSheets: ["Added"], removedSheets: ["Removed"] });
  });
  it("bounds displayed changes without understating the total", () => {
    const result = compareSpreadsheetValues([], [{ sheet: "Data", data: [Array.from({ length: 250 }, (_, i) => i)] }]);
    expect(result.total).toBe(250);
    expect(result.changes).toHaveLength(200);
    expect(result.changes[26].address).toBe("Data!AA1");
  });
  it("compares dates by value and empty cells consistently", () => {
    expect(compareSpreadsheetValues([{ sheet: "Data", data: [[new Date("2026-01-01"), null]] }], [{ sheet: "Data", data: [[new Date("2026-01-01")]] }]).total).toBe(0);
  });
});
