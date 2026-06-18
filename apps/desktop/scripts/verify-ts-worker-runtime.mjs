import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workerRoot = path.resolve("workers/ts-agent-worker");
const sourceRoot = path.join(workerRoot, "src");
const importPattern = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g;
const parameterPropertyPattern = /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w+/gs;
const allowedImportExtensions = /\.(ts|js|json|node)$/;
const workerReadyTimeoutMs = 15_000;

const sourceFiles = await collectRuntimeSourceFiles(sourceRoot);
const issues = [];

for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  collectExtensionlessRuntimeImports(file, source, issues);
  collectUnsupportedParameterProperties(file, source, issues);
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(issue);
  }
  process.exit(1);
}

await verifyWorkerStarts();

async function collectRuntimeSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRuntimeSourceFiles(entryPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectExtensionlessRuntimeImports(file, source, issues) {
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!allowedImportExtensions.test(specifier) && !specifier.endsWith("/")) {
      issues.push(`${relativeFile(file)}: relative runtime import must include an extension: ${specifier}`);
    }
  }
}

function collectUnsupportedParameterProperties(file, source, issues) {
  for (const match of source.matchAll(parameterPropertyPattern)) {
    issues.push(`${relativeFile(file)}: constructor parameter properties are unsupported by Node strip-only TypeScript`);
  }
}

function relativeFile(file) {
  return path.relative(process.cwd(), file).replaceAll(path.sep, "/");
}

function verifyWorkerStarts() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["src/index.ts"], {
      cwd: workerRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ts-agent-worker did not report ready within ${workerReadyTimeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, workerReadyTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("[ts-agent-worker] ready")) {
        clearTimeout(timer);
        child.kill();
        resolve();
      }
    });
    child.on("exit", (code, signal) => {
      if (stderr.includes("[ts-agent-worker] ready")) {
        return;
      }
      clearTimeout(timer);
      reject(new Error(`ts-agent-worker exited before ready code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
