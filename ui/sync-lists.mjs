// Refresh public/lists/ from xi-tools' canonical set — the same files the model
// viewer bakes (`<XI_TOOLS_DIR>/mv/lists/`, maintained by `xi mv update`, which
// rewrites manifest.json at the end of every run).
//
// The release workflow does this from xi-tools' main branch on every build, so
// this is for working against a local xi-tools checkout: bake what you just
// generated, without pushing it first.
//
// Every file is checked against the manifest that arrives with it. A manifest
// that disagrees with its own files would ship a binary claiming hashes it does
// not have, and every client would re-download every list on every boot.
//
//   npm run sync-lists            # uses XI_TOOLS_DIR, else ../../xi-tools
//   npm run sync-lists -- D:\xi-tools
import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = process.argv[2] || process.env.XI_TOOLS_DIR || path.resolve(here, '../../xi-tools');
const src = path.join(toolsDir, 'mv', 'lists');
const dest = path.join(here, 'public', 'lists');

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'));
} catch {
  console.error(`Could not read ${path.join(src, 'manifest.json')}\n`
    + 'Pass the xi-tools root as an argument or set XI_TOOLS_DIR.');
  process.exit(1);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Verify at the source, before anything here is touched: a half-copied set is
// worse than an old one.
const bad = [];
for (const [name, want] of Object.entries(manifest.files || {})) {
  let buf;
  try {
    buf = readFileSync(path.join(src, name));
  } catch {
    bad.push(`${name}: missing`);
    continue;
  }
  if (buf.length !== want.bytes) bad.push(`${name}: ${buf.length} bytes, manifest says ${want.bytes}`);
  else if (sha256(buf) !== want.sha256) bad.push(`${name}: sha256 does not match the manifest`);
}
if (bad.length) {
  console.error(`${src} does not match its own manifest:\n  ${bad.join('\n  ')}\n`
    + 'Re-run `xi mv update` in xi-tools, which rewrites manifest.json.');
  process.exit(1);
}

// Copy the manifest too — src-tauri/src/lists.rs includes it as the record of
// what this build ships, and the two must describe the same bytes.
const names = readdirSync(src).filter((f) => f.endsWith('.json'));
for (const name of names) copyFileSync(path.join(src, name), path.join(dest, name));

const total = Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0);
console.log(`Baked ${names.length} files (${(total / 1e6).toFixed(1)} MB) from ${src}`);
console.log(`xi-tools generated them ${manifest.generated || '(unstamped)'}`);

// A list in the folder that the manifest does not cover is dead weight in the
// bundle: nothing will ever refresh it, because sync only walks the manifest.
const orphans = names.filter((n) => n !== 'manifest.json' && !manifest.files[n]);
if (orphans.length) console.warn(`Not in the manifest, so never updated: ${orphans.join(', ')}`);

// Left as a warning rather than a failure: the working copy is what Vite bundles
// and what lists.rs hashes, so a stray CRLF here breaks verification on every
// client. .gitattributes pins these to LF; this catches an editor that did not.
const crlf = names.filter((n) => readFileSync(path.join(dest, n)).includes('\r\n'));
if (crlf.length) console.warn(`WARNING: CRLF line endings in ${crlf.join(', ')} — these must stay LF.`);

if (!statSync(dest).isDirectory()) process.exit(1);
