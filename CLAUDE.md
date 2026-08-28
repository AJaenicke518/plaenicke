# plaenicke

A personal calendar/to-do PWA. Vanilla ES modules — **no framework, no build step, no bundler.** Static files on GitHub Pages, with a Cloudflare Worker (+ D1) for smart-add, an ICS proxy, and device sync. Single user.

## Running tests

- **`npm test` is `node --test` with no arguments and it RECURSES.** The root count already includes `worker/`'s tests — don't add them together.
- **`node --test tests/` runs ZERO tests** and reports one spurious failure. It looks like it worked. Never use it.
- **Node 22 has no `localStorage`.** Any storage-touching test must call `installFakeLocalStorage()` from `tests/fake-localstorage.js`.
- A literal U+0001 in a Bash heredoc is rejected as a control character. Use Python. (`js/merge.js` uses one as a dedupe field separator.)

## Deploying

- **There is no CI workflow. GitHub Pages serves `main` directly, so merging to `main` IS the deploy.** Treat a merge as a production release.
- The Worker deploys separately via `wrangler`. Expect **~20s of edge propagation** — the first smoke test after a deploy can hit the old version and look like a broken release.

## Before you touch sync

Read `.superpowers/sdd/2026-08-02-plaenicke-v5-plan3-client-sync/progress.md` first. It is ~500 lines and it is the honest record of how V5 was built. The three facts that should change how you work:

- **Nine times**, a per-task review found a defect in the *plan's own prescribed code* — text a devil's advocate had already cleared.
- **Four times**, a fix for a genuine finding introduced a **worse** defect than the one it cured. Two of those would have destroyed data.
- Every one was caught by a **different agent executing the code**, never by reading it. Reading finds shape errors; running finds real ones. Mutation-test claims rather than trusting a green suite — several tests here have passed under implementations that were badly wrong.

**`.superpowers/` is gitignored.** The ledger is local-only and is not backed up by pushing.

## Invariants that have already caused near-misses

- **Feed URLs are unrecoverable.** They're capability tokens, never re-displayed after a calendar is added. Any code path that can delete a feed can permanently destroy a subscription the user cannot type back in. One shipped fix would have wiped every subscription; it was caught by reproduction, not review.
- **`deserializeItems` filters on `typeof it.date === 'string'`** — an item with `date: null` is **silently dropped on load**. Note what this does and does not do, because the obvious guess is wrong: it does **not** propagate the deletion. `merge()` is a monotone union for items and a deserializer drop writes no tombstone, so the account keeps the record and re-supplies it on the next sync (verified end-to-end 2026-08-22, not reasoned). What it actually causes is *local invisibility* plus one genuinely destructive path — `linkui.js`'s `readLocal()` uses `loadItems()`, so a device whose content is undated classifies itself as **empty** and the adoption flow can auto-bootstrap over it with no dialog. Any feature adding undated records must reckon with the adoption classifier, not just the loader.
- **Ownership (spec § 5.5):** `sync.js` never writes items or feeds. It hands merged state to an injected `applyState`; `app.js` owns `plaenicke.items`, `feeds.js` owns `plaenicke.feeds`. Note the two keys are protected by *different* invariants — items by sole ownership (app.js writes from a module-scope snapshot), feeds by read-immediately-before-write. Adding a writer to the wrong one fails silently.
- **`schemaVersion` is 1 and `merge()` throws on anything else.** Adding a new *array* to the synced blob is a real change — but the danger is code surface (new `merge()` branches, `toWire()` entries, tombstone kinds), **not** silent truncation. Bumping the version makes an un-updated device *throw* and apply nothing: a loud, fail-closed halt. Don't repeat the older claim that it "merges while ignoring the array and pushes the data back missing" — that only holds if you add the array *without* bumping.
- **Adding a new *field* to items is safe on the sync path, but `makeItem` will silently drop it.** `deserializeItems` and `unionById` pass records through whole; `js/items.js:17-29` rebuilds from an eleven-key whitelist. A field added to the model but not to `makeItem` is discarded at creation and everything downstream looks fine.

## Sync has now run for real — once

**2026-08-28: a real two-device link was completed** (laptop + iPhone, against production D1). That retires the standing "none of this has ever run outside a test" warning: the crypto round trip, the CAS protocol, serialization and adoption have all executed at least once against real infrastructure.

Do not over-read it. One successful link exercises the happy path. It does **not** exercise a CAS conflict, a 409 retry, clock skew between the two devices, quota exhaustion, or a revoked token — and `tests/convergence.test.js` still cannot see any of those (it drives `merge.js` directly: no CAS, no interleaving, no serialization, no crypto). "The tests pass" remains weaker evidence here than it looks.

**A broken sync is still silent**, and this is the property that has not changed. A revoked token, a corrupt stored link code, or a stuck adoption all present as an app that works perfectly and quietly stops agreeing with the other device. After any sync change, verify both devices actually show the same thing — don't infer success from the absence of an error. (V6 adds a shell indicator for exactly this; until V6 is merged, the only signal is inside the Settings panel.)

## Where things live

| What | Where |
|---|---|
| Punchlist (deferred work, ~60 open) | `~/punchlists/punchlist-plaenicke.md` |
| V5 sync design | `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md` |
| V5 execution ledger | `.superpowers/sdd/2026-08-02-plaenicke-v5-plan3-client-sync/progress.md` |
| Session handoffs | `~/handoffs/plaenicke/` — `/handoff read` |
| Worker admin secret | `~/.plaenicke-admin-secret`, chmod 600 — **the only copy** |

## Device linking

A raw 43-character token from `POST /admin/device` is correct **only for the first device**. `linkWithCode` branches on decoded byte length: 32 bytes means *bootstrap*, so it mints a fresh `encKey` and silently starts a new, empty account. To add a second device, compose an **86-character code** on an already-linked device via Settings → Sync → *Link another device*. Full procedure in spec § 4.1.

`encKey` never touches the server and a device never re-displays its own code, so **the codes in the devices' `localStorage` are the account's only decryption credential.** There is no reset.
