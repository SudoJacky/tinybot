export function castJsonSchemaValue(value: unknown, schema: Record<string, unknown>): unknown {
  const schemaType = resolveJsonSchemaType(schema.type);
  if (schemaType === "object") {
    const objectValue = asRecord(value);
    if (!objectValue) {
      return value;
    }
    const properties = asRecord(schema.properties) ?? {};
    return Object.fromEntries(
      Object.entries(objectValue).map(([key, childValue]) => {
        const childSchema = asRecord(properties[key]);
        return [key, childSchema ? castJsonSchemaValue(childValue, childSchema) : childValue];
      }),
    );
  }
  if (typeof value === "string" && schemaType === "integer") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }
  if (typeof value === "string" && schemaType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof value === "string" && schemaType === "boolean") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no") {
      return false;
    }
  }
  if (Array.isArray(value) && schemaType === "array") {
    const itemSchema = asRecord(schema.items);
    return itemSchema ? value.map((item) => castJsonSchemaValue(item, itemSchema)) : value;
  }
  if (schemaType === "string" && value !== null && value !== undefined) {
    return String(value);
  }
  return value;
}

export function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path = ""): string[] {
  const rawType = schema.type;
  const nullable = (Array.isArray(rawType) && rawType.includes("null")) || schema.nullable === true;
  const schemaType = resolveJsonSchemaType(rawType);
  const label = path || "parameter";

  if (nullable && value === null) {
    return [];
  }
  const typeError = validateJsonSchemaType(value, schemaType, label);
  if (typeError) {
    return [typeError];
  }

  const errors: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${label} must be one of ${formatJsonSchemaEnum(schema.enum)}`);
  }
  if ((schemaType === "integer" || schemaType === "number") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${label} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${label} must be <= ${schema.maximum}`);
    }
  }
  if (schemaType === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${label} must be at least ${schema.minLength} chars`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${label} must be at most ${schema.maxLength} chars`);
    }
  }
  if (schemaType === "object") {
    const objectValue = asRecord(value) ?? {};
    const properties = asRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in objectValue)) {
        errors.push(`missing required ${subpath(path, key)}`);
      }
    }
    for (const [key, childValue] of Object.entries(objectValue)) {
      const childSchema = asRecord(properties[key]);
      if (childSchema) {
        errors.push(...validateJsonSchemaValue(childValue, childSchema, subpath(path, key)));
      }
    }
  }
  if (schemaType === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${label} must have at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${label} must be at most ${schema.maxItems} items`);
    }
    const itemSchema = asRecord(schema.items);
    if (itemSchema) {
      for (let index = 0; index < value.length; index += 1) {
        errors.push(...validateJsonSchemaValue(value[index], itemSchema, arrayPath(path, index)));
      }
    }
  }
  return errors;
}

export function resolveJsonSchemaType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return typeof value === "string" ? value : undefined;
}

function validateJsonSchemaType(value: unknown, schemaType: string | undefined, label: string): string | undefined {
  if (schemaType === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    return `${label} should be integer`;
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return `${label} should be number`;
  }
  if (schemaType === "string" && typeof value !== "string") {
    return `${label} should be string`;
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    return `${label} should be boolean`;
  }
  if (schemaType === "object" && !asRecord(value)) {
    return `${label} should be object`;
  }
  if (schemaType === "array" && !Array.isArray(value)) {
    return `${label} should be array`;
  }
  return undefined;
}

function subpath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function arrayPath(path: string, index: number): string {
  return path ? `${path}[${index}]` : `[${index}]`;
}

function formatJsonSchemaEnum(values: unknown[]): string {
  return `[${values.map((value) => typeof value === "string" ? `'${value}'` : String(value)).join(", ")}]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
