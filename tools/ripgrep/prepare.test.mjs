import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetFor, verifyArchive } from './prepare.mjs';

test('maps build targets to pinned upstream archives', () => {
  assert.equal(assetFor('x86_64-pc-windows-msvc').name, 'ripgrep-15.2.0-x86_64-pc-windows-msvc.zip');
  assert.equal(assetFor('x86_64-unknown-linux-gnu').name, 'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz');
  assert.throws(() => assetFor('unknown'), /Unsupported/);
});

test('rejects modified archives before extraction', () => {
  const bytes = Buffer.from('fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  verifyArchive(bytes, digest);
  assert.throws(() => verifyArchive(Buffer.from('changed'), digest), /SHA-256 mismatch/);
});
