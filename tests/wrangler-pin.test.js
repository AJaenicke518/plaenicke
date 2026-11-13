// The wrangler CLI is pinned in exactly one place: worker/package.json's
// `wrangler` script (CLAUDE.md "Deploying"). The release runbook calls
// `npm run wrangler -- …`; an unpinned `npx wrangler` in the docs, or a script
// that drifts to @latest, would silently unpin a production release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('worker/package.json pins wrangler to an exact version', () => {
  const pkg = JSON.parse(read('worker/package.json'));
  assert.match(pkg.scripts?.wrangler ?? '', /^npx --yes wrangler@\d+\.\d+\.\d+$/);
});

test('the runbook docs never call an unpinned npx wrangler', () => {
  for (const p of ['CLAUDE.md', 'docs/admin.md', 'worker/README.md']) {
    const hits = read(p).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /npx wrangler(?!@\d)/.test(l));
    assert.deepEqual(hits, [], `${p} has an unpinned npx wrangler call`);
  }
});
