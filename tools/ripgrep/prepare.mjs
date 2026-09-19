import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '15.2.0';
const ASSETS = {
  'x86_64-pc-windows-msvc': ['zip', '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'],
  'aarch64-pc-windows-msvc': ['zip', 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f'],
  'x86_64-apple-darwin': ['tar.gz', 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1'],
  'aarch64-apple-darwin': ['tar.gz', '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4'],
  'x86_64-unknown-linux-gnu': ['tar.gz', '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c', 'x86_64-unknown-linux-musl'],
  'aarch64-unknown-linux-gnu': ['tar.gz', 'a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d'],
};

export function assetFor(target) {
  const asset = ASSETS[target];
  if (!asset) throw new Error(`Unsupported ripgrep target: ${target}`);
  const [extension, sha256, sourceTarget = target] = asset;
  const stem = `ripgrep-${VERSION}-${sourceTarget}`;
  return { stem, name: `${stem}.${extension}`, sha256 };
}

export function verifyArchive(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`ripgrep SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

async function copyIfChanged(source, destination) {
  const bytes = await readFile(source);
  try {
    if (bytes.equals(await readFile(destination))) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(destination, bytes);
}

async function prepare(target) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const { stem, name, sha256 } = assetFor(target);
  const cache = join(root, 'src-tauri', 'target', 'ripgrep-cache');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, name);
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`ripgrep download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, sha256);
    await writeFile(archive, bytes);
  }
  verifyArchive(bytes, sha256);
  const temp = await mkdtemp(join(cache, 'extract-'));
  try {
    // Windows ships bsdtar, which also reads the upstream ZIP archives.
    execFileSync('tar', ['-xf', archive, '-C', temp], { stdio: 'pipe', windowsHide: true });
    const binary = target.includes('windows') ? 'rg.exe' : 'rg';
    const binDir = join(root, 'src-tauri', 'binaries');
    const licenses = join(root, 'src-tauri', 'resources', 'ripgrep');
    await mkdir(binDir, { recursive: true });
    await mkdir(licenses, { recursive: true });
    const destination = join(binDir, `tinybot-rg-${target}${target.includes('windows') ? '.exe' : ''}`);
    await copyIfChanged(join(temp, stem, binary), destination);
    await chmod(destination, 0o755);
    for (const file of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
      await copyIfChanged(join(temp, stem, file), join(licenses, file));
    }
    console.log(`Prepared ripgrep ${VERSION} for ${target}: ${destination}`);
    console.log(`Archive: ${bytes.length} bytes; executable: ${(await readFile(destination)).length} bytes`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE
    || execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8', windowsHide: true }).trim();
  await prepare(target);
}
