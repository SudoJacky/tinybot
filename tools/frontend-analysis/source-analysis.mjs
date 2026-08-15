import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { analysisConfig, ROOT_DIR } from "./config.mjs";
import { toPosixPath, toRepoPath, walkFiles } from "./utils.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const BRANCH_NODE_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

export function analyzeSource(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? ROOT_DIR);
  const config = options.config ?? analysisConfig.source;
  const sourceFiles = config.roots
    .flatMap((root) => walkFiles(path.join(rootDir, root)))
    .filter(isSourceFile)
    .sort((left, right) => left.localeCompare(right));
  const sourceFileSet = new Set(sourceFiles.map((file) => path.resolve(file)));
  const files = sourceFiles.map((file) => analyzeFile(rootDir, file, sourceFileSet, config));
  const productionFiles = files.filter((file) => !file.test && !file.declaration);
  const productionPaths = new Set(productionFiles.map((file) => file.path));
  const graph = new Map(productionFiles.map((file) => [
    file.path,
    file.relativeImports.filter((dependency) => productionPaths.has(dependency)),
  ]));
  const cycles = findCycles(graph);
  const reachable = findReachable(graph, config.entrypoints.map(toPosixPath));
  const inboundCounts = new Map([...graph.keys()].map((file) => [file, 0]));
  for (const dependencies of graph.values()) {
    for (const dependency of dependencies) {
      inboundCounts.set(dependency, (inboundCounts.get(dependency) ?? 0) + 1);
    }
  }

  const withGraphMetrics = productionFiles.map((file) => ({
    ...file,
    fanIn: inboundCounts.get(file.path) ?? 0,
    fanOut: graph.get(file.path)?.length ?? 0,
  }));
  const externalDependencies = countExternalDependencies(files);
  const unreachableCandidates = [...graph.keys()]
    .filter((file) => !reachable.has(file))
    .sort();

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totals: {
      files: files.length,
      productionFiles: productionFiles.length,
      testFiles: files.filter((file) => file.test).length,
      productionLines: sum(withGraphMetrics, "lines"),
      productionBranchPoints: sum(withGraphMetrics, "branchPoints"),
      cycles: cycles.length,
      unreachableCandidates: unreachableCandidates.length,
    },
    thresholds: {
      largeFileWarningLines: config.largeFileWarningLines,
      branchWarningPoints: config.branchWarningPoints,
    },
    hotspots: {
      largeFiles: withGraphMetrics
        .filter((file) => file.lines >= config.largeFileWarningLines)
        .sort(descending("lines"))
        .map(sourceFileSummary),
      branchHeavyFiles: withGraphMetrics
        .filter((file) => file.branchPoints >= config.branchWarningPoints)
        .sort(descending("branchPoints"))
        .map(sourceFileSummary),
      highestFanIn: [...withGraphMetrics].sort(descending("fanIn")).slice(0, 15).map(sourceFileSummary),
      highestFanOut: [...withGraphMetrics].sort(descending("fanOut")).slice(0, 15).map(sourceFileSummary),
    },
    cycles,
    unreachableCandidates,
    heavyImports: files
      .flatMap((file) => file.heavyImports.map((dependency) => ({ file: file.path, dependency })))
      .sort((left, right) => left.file.localeCompare(right.file) || left.dependency.localeCompare(right.dependency)),
    externalDependencies,
    files: withGraphMetrics.map(sourceFileSummary).sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function analyzeFile(rootDir, file, sourceFileSet, config) {
  const contents = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const relativeImports = new Set();
  const externalImports = new Set();
  let branchPoints = 0;
  let useEffectCalls = 0;
  let useLayoutEffectCalls = 0;
  let memoizationCalls = 0;
  let lazyImports = 0;

  function visit(node) {
    if (BRANCH_NODE_KINDS.has(node.kind) || isLogicalBranch(node)) {
      branchPoints += 1;
    }
    if (ts.isCallExpression(node)) {
      const callName = node.expression.getText(sourceFile);
      if (callName === "useEffect" || callName.endsWith(".useEffect")) {
        useEffectCalls += 1;
      } else if (callName === "useLayoutEffect" || callName.endsWith(".useLayoutEffect")) {
        useLayoutEffectCalls += 1;
      } else if (["memo", "useMemo", "useCallback"].some((name) => callName === name || callName.endsWith(`.${name}`))) {
        memoizationCalls += 1;
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        lazyImports += 1;
      }
    }
    const specifier = moduleSpecifier(node);
    if (specifier) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeImport(file, specifier, sourceFileSet);
        if (resolved) {
          relativeImports.add(toRepoPath(rootDir, resolved));
        }
      } else {
        externalImports.add(packageName(specifier));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const pathName = toRepoPath(rootDir, file);
  return {
    path: pathName,
    lines: contents === "" ? 0 : contents.split(/\r?\n/).length,
    bytes: Buffer.byteLength(contents),
    branchPoints,
    useEffectCalls,
    useLayoutEffectCalls,
    memoizationCalls,
    lazyImports,
    fanIn: 0,
    fanOut: relativeImports.size,
    test: /(?:^|\/)test(?:s)?\//i.test(pathName) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(pathName),
    declaration: file.endsWith(".d.ts"),
    relativeImports: [...relativeImports].sort(),
    externalImports: [...externalImports].sort(),
    heavyImports: [...externalImports].filter((dependency) => config.heavyDependencies.includes(dependency)).sort(),
  };
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file)) && !file.endsWith(".d.ts");
}

function moduleSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
    return node.arguments[0].text;
  }
  if (ts.isNewExpression(node) && node.expression.getText() === "URL" && node.arguments?.length && ts.isStringLiteral(node.arguments[0])) {
    return node.arguments[0].text;
  }
  return null;
}

function isLogicalBranch(node) {
  return ts.isBinaryExpression(node)
    && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(node.operatorToken.kind);
}

function resolveRelativeImport(importer, specifier, sourceFileSet) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(unresolved);
  const withoutJavaScriptExtension = [".js", ".jsx", ".mjs", ".cjs"].includes(extension)
    ? unresolved.slice(0, -extension.length)
    : unresolved;
  const candidates = [
    unresolved,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((candidateExtension) => `${withoutJavaScriptExtension}${candidateExtension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((candidateExtension) => path.join(unresolved, `index${candidateExtension}`)),
  ];
  return candidates.find((candidate) => sourceFileSet.has(path.resolve(candidate))) ?? null;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function countExternalDependencies(files) {
  const counts = new Map();
  for (const file of files) {
    for (const dependency of file.externalImports) {
      counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([dependency, importingFiles]) => ({ dependency, importingFiles }))
    .sort((left, right) => right.importingFiles - left.importingFiles || left.dependency.localeCompare(right.dependency));
}

function findReachable(graph, entrypoints) {
  const reachable = new Set();
  const pending = entrypoints.filter((entrypoint) => graph.has(entrypoint));
  while (pending.length) {
    const current = pending.pop();
    if (!current || reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return reachable;
}

function findCycles(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(dependency)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) {
      return;
    }
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    const selfCycle = component.length === 1 && (graph.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfCycle) {
      cycles.push(component.sort());
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
}

function sourceFileSummary(file) {
  return {
    path: file.path,
    lines: file.lines,
    bytes: file.bytes,
    branchPoints: file.branchPoints,
    fanIn: file.fanIn,
    fanOut: file.fanOut,
    useEffectCalls: file.useEffectCalls,
    useLayoutEffectCalls: file.useLayoutEffectCalls,
    memoizationCalls: file.memoizationCalls,
    lazyImports: file.lazyImports,
  };
}

function descending(field) {
  return (left, right) => right[field] - left[field] || left.path.localeCompare(right.path);
}

function sum(files, field) {
  return files.reduce((total, file) => total + file[field], 0);
}
