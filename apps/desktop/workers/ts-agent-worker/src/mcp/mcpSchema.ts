import type { JsonSchema } from "./mcpTypes.ts";

export function normalizeMcpJsonSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }

  let normalized: JsonSchema = { ...schema };
  const rawType = normalized.type;
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter((item) => item !== "null");
    if (rawType.includes("null") && nonNull.length === 1) {
      normalized.type = nonNull[0];
      normalized.nullable = true;
    }
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const nullableBranch = extractNullableBranch(normalized[key]);
    if (nullableBranch) {
      const { [key]: _removed, ...withoutUnion } = normalized;
      normalized = {
        ...withoutUnion,
        ...nullableBranch,
        nullable: true,
      };
      break;
    }
  }

  if (isRecord(normalized.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([name, value]) => [
        name,
        isRecord(value) ? normalizeMcpJsonSchema(value) : value,
      ]),
    );
  }

  if (isRecord(normalized.items)) {
    normalized.items = normalizeMcpJsonSchema(normalized.items);
  }

  if (normalized.type === "object") {
    normalized.properties = isRecord(normalized.properties) ? normalized.properties : {};
    normalized.required = Array.isArray(normalized.required) ? normalized.required : [];
  }

  return normalized;
}

function extractNullableBranch(value: unknown): JsonSchema | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const nonNull: JsonSchema[] = [];
  let sawNull = false;
  for (const option of value) {
    if (!isRecord(option)) {
      return null;
    }
    if (option.type === "null") {
      sawNull = true;
      continue;
    }
    nonNull.push(option);
  }
  return sawNull && nonNull.length === 1 ? nonNull[0] : null;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
