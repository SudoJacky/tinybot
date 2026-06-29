export type TemplateRegistry = Record<string, string>;

export type TemplateVariables = Record<string, unknown>;

export class MissingTemplateError extends Error {
  constructor(name: string) {
    super(`Missing template: ${name}`);
    this.name = "MissingTemplateError";
  }
}

export function renderTemplate(
  name: string,
  options: {
    templates: TemplateRegistry;
    variables?: TemplateVariables;
    strip?: boolean;
  },
): string {
  const rendered = renderTemplateBody(templateSource(name, options.templates), {
    templates: options.templates,
    variables: options.variables ?? {},
  });
  return options.strip ? rendered.trimEnd() : rendered;
}

function renderTemplateBody(
  source: string,
  context: {
    templates: TemplateRegistry;
    variables: TemplateVariables;
  },
): string {
  const rawBlocks: string[] = [];
  const rawProtected = source.replace(/\{% raw %\}([\s\S]*?)\{% endraw %\}/g, (_match, content: string) => {
    const index = rawBlocks.push(content) - 1;
    return `@@TINYBOT_RAW_${index}@@`;
  });
  const rendered = renderLines(rawProtected.split(/\r?\n/), context)
    .replace(/@@TINYBOT_RAW_(\d+)@@/g, (_match, index: string) => rawBlocks[Number(index)] ?? "");
  return rendered;
}

function renderLines(
  lines: string[],
  context: {
    templates: TemplateRegistry;
    variables: TemplateVariables;
  },
): string {
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const statement = blockStatement(line);
    if (statement?.kind === "if") {
      const collected = collectIfBlock(lines, index);
      output.push(renderIfBlock(collected.branches, context));
      index = collected.endIndex;
      continue;
    }
    if (statement?.kind === "for") {
      const collected = collectBalancedBlock(lines, index, "for", "endfor");
      output.push(renderForBlock(statement, collected.body, context));
      index = collected.endIndex;
      continue;
    }
    if (statement?.kind === "include") {
      output.push(renderTemplateBody(templateSource(statement.name, context.templates), context));
      continue;
    }
    output.push(renderInline(line, context));
  }
  return output.join("\n");
}

function renderInline(
  line: string,
  context: {
    templates: TemplateRegistry;
    variables: TemplateVariables;
  },
): string {
  return line
    .replace(/\{% include ['"]([^'"]+)['"] %\}/g, (_match, name: string) =>
      renderTemplateBody(templateSource(name, context.templates), context).trimEnd())
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) =>
      stringifyValue(evaluateExpression(expression, context.variables)));
}

type BlockStatement =
  | { kind: "if"; expression: string }
  | { kind: "elif"; expression: string }
  | { kind: "else" }
  | { kind: "endif" }
  | { kind: "for"; itemName: string; collectionExpression: string }
  | { kind: "endfor" }
  | { kind: "include"; name: string };

function blockStatement(line: string): BlockStatement | undefined {
  const trimmed = line.trim();
  let match = trimmed.match(/^\{% if (.+) %\}$/);
  if (match) {
    return { kind: "if", expression: match[1] };
  }
  match = trimmed.match(/^\{% elif (.+) %\}$/);
  if (match) {
    return { kind: "elif", expression: match[1] };
  }
  if (trimmed === "{% else %}") {
    return { kind: "else" };
  }
  if (trimmed === "{% endif %}") {
    return { kind: "endif" };
  }
  match = trimmed.match(/^\{% for ([A-Za-z_][A-Za-z0-9_]*) in (.+) %\}$/);
  if (match) {
    return { kind: "for", itemName: match[1], collectionExpression: match[2] };
  }
  if (trimmed === "{% endfor %}") {
    return { kind: "endfor" };
  }
  match = trimmed.match(/^\{% include ['"]([^'"]+)['"] %\}$/);
  if (match) {
    return { kind: "include", name: match[1] };
  }
  return undefined;
}

function collectIfBlock(lines: string[], startIndex: number): {
  branches: Array<{ expression?: string; body: string[] }>;
  endIndex: number;
} {
  const start = blockStatement(lines[startIndex]);
  if (!start || start.kind !== "if") {
    throw new Error("collectIfBlock requires an if statement");
  }
  const branches: Array<{ expression?: string; body: string[] }> = [{ expression: start.expression, body: [] }];
  let depth = 0;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const statement = blockStatement(lines[index]);
    if (statement?.kind === "if" || statement?.kind === "for") {
      depth += 1;
      branches[branches.length - 1].body.push(lines[index]);
      continue;
    }
    if ((statement?.kind === "endif" || statement?.kind === "endfor") && depth > 0) {
      depth -= 1;
      branches[branches.length - 1].body.push(lines[index]);
      continue;
    }
    if (depth === 0 && statement?.kind === "elif") {
      branches.push({ expression: statement.expression, body: [] });
      continue;
    }
    if (depth === 0 && statement?.kind === "else") {
      branches.push({ body: [] });
      continue;
    }
    if (depth === 0 && statement?.kind === "endif") {
      return { branches, endIndex: index };
    }
    branches[branches.length - 1].body.push(lines[index]);
  }
  throw new Error("Unclosed if block");
}

function collectBalancedBlock(
  lines: string[],
  startIndex: number,
  startKind: "for",
  endKind: "endfor",
): { body: string[]; endIndex: number } {
  const body: string[] = [];
  let depth = 0;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const statement = blockStatement(lines[index]);
    if (statement?.kind === startKind) {
      depth += 1;
      body.push(lines[index]);
      continue;
    }
    if (statement?.kind === endKind) {
      if (depth === 0) {
        return { body, endIndex: index };
      }
      depth -= 1;
      body.push(lines[index]);
      continue;
    }
    body.push(lines[index]);
  }
  throw new Error(`Unclosed ${startKind} block`);
}

function renderIfBlock(
  branches: Array<{ expression?: string; body: string[] }>,
  context: {
    templates: TemplateRegistry;
    variables: TemplateVariables;
  },
): string {
  const selected = branches.find((branch) =>
    branch.expression === undefined || isTruthy(evaluateExpression(branch.expression, context.variables)));
  return selected ? renderLines(selected.body, context) : "";
}

function renderForBlock(
  statement: Extract<BlockStatement, { kind: "for" }>,
  body: string[],
  context: {
    templates: TemplateRegistry;
    variables: TemplateVariables;
  },
): string {
  const collection = evaluateExpression(statement.collectionExpression, context.variables);
  if (!Array.isArray(collection)) {
    return "";
  }
  return collection
    .map((item) =>
      renderLines(body, {
        templates: context.templates,
        variables: { ...context.variables, [statement.itemName]: item },
      }))
    .filter((part) => part.length > 0)
    .join("\n");
}

function evaluateExpression(expression: string, variables: TemplateVariables): unknown {
  const trimmed = expression.trim();
  const equality = trimmed.match(/^(.+?)\s*==\s*(['"])(.*?)\2$/);
  if (equality) {
    return evaluateExpression(equality[1], variables) === equality[3];
  }
  const inequality = trimmed.match(/^(.+?)\s*!=\s*(['"])(.*?)\2$/);
  if (inequality) {
    return evaluateExpression(inequality[1], variables) !== inequality[3];
  }
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return resolvePath(variables, trimmed);
}

function resolvePath(variables: TemplateVariables, path: string): unknown {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = variables;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function templateSource(name: string, templates: TemplateRegistry): string {
  const source = templates[name];
  if (source === undefined) {
    throw new MissingTemplateError(name);
  }
  return source;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
