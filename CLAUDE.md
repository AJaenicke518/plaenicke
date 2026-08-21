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
- **`deserializeItems` filters on `typeof it.date === 'string'`** — an item with `date: null` is **silently dropped**, and a device that drops it then pushes the deletion to every other device. Any feature adding undated records must land on all devices *before* the first undated record is created.
- **Ownership (spec § 5.5):** `sync.js` never writes items or feeds. It hands merged state to an injected `applyState`; `app.js` owns `plaenicke.items`, `feeds.js` owns `plaenicke.feeds`. Note the two keys are protected by *different* invariants — items by sole ownership (app.js writes from a module-scope snapshot), feeds by read-immediately-before-write. Adding a writer to the wrong one fails silently.
- **`schemaVersion` is 1 and `merge()` throws on anything else.** Adding a new *array* to the synced blob needs a real migration — an un-updated device merges while ignoring it and pushes the data back missing. Adding a new *field* to items is safe: `deserializeItems` passes records through whole rather than rebuilding from a whitelist.

## Sync is not yet proven in the real world

As of **2026-08-20**, no part of the client sync has ever run in a browser or against real D1. Every test injects a `fetchImpl` and a fake `localStorage`; the convergence simulation drives `merge.js` directly with no CAS, no interleaving, no serialization and no crypto round trip. The suite is thorough, but "the tests pass" is weaker evidence here than it looks. *(Delete this section once a real two-device link has been done.)*

**A broken sync is silent.** There is no sync indicator anywhere outside the Settings panel, so a revoked token, a corrupt stored link code, or a stuck adoption all present as an app that works perfectly and quietly stops agreeing with the other device. After any sync change, verify both devices actually show the same thing — don't infer success from the absence of an error.

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
