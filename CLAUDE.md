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
- **`deserializeItems` tolerates `date: null` as of V6, and that is DELIBERATE DEAD CODE.** Nothing creates an undated record: `makeItem` still refuses a falsy date, the Worker's schema still requires a `date` string, and an idea carries its capture date with `type === 'idea'` as the only unscheduled discriminator. The tolerance shipped early so a future version can adopt real nulls with it already deployed on both devices, instead of gating a user-visible feature on a rollout executed by hand. The filter still rejects `undefined`, numbers, objects and booleans — **do not loosen it to `!= null`.** What the old drop actually cost, verified end-to-end and not reasoned: not deletion (`merge()` is a monotone union for items and a deserializer drop writes no tombstone) but *local invisibility*, plus one genuinely destructive path — `linkui.js`'s `readLocal()` uses `loadItems()`, so a device whose content all dropped classifies itself as **empty** and the adoption flow can auto-bootstrap over it with no dialog. The tolerance closes that path for undated records; the classifier is still the thing to reckon with for any future loader filter.
- **`''` is a third date state, and it behaves like neither.** It passes `typeof x === 'string'`, is falsy, and is exactly what a cleared `<input type="date">` yields. `makeItem`'s guard is `if (!fields.date) throw` — a falsy check, not a null check. Relaxing it to a null check lets a cleared date box create a record that renders as `"null — …"` and sorts nowhere.
- **The app has an EDIT PATH as of V6** — the To-do checkbox, confined to the boolean `done`. It bumps `updatedAt`, deliberately: `unionById`'s ties go to remote, so a toggle that did not bump would be silently reverted by the next sync. The price is that `applyTombstones` can resurrect an item deleted on another device before the tick synced, which costs a reappearing, re-deletable calendar entry rather than data. `js/merge.js`'s header carries both horns in full. **The next editable field re-opens all of it** — the reasoning holds only while the field is a boolean and the same id is almost never rewritten on both devices.
- **Ownership (spec § 5.5):** `sync.js` never writes items or feeds. It hands merged state to an injected `applyState`; `app.js` owns `plaenicke.items`, `feeds.js` owns `plaenicke.feeds`. Note the two keys are protected by *different* invariants — items by sole ownership (app.js writes from a module-scope snapshot), feeds by read-immediately-before-write. Adding a writer to the wrong one fails silently.
- **`schemaVersion` is 1 and `merge()` throws on anything else.** Adding a new *array* to the synced blob is a real change — but the danger is code surface (new `merge()` branches, `toWire()` entries, tombstone kinds), **not** silent truncation. Bumping the version makes an un-updated device *throw* and apply nothing: a loud, fail-closed halt. Don't repeat the older claim that it "merges while ignoring the array and pushes the data back missing" — that only holds if you add the array *without* bumping.
- **Adding a new *field* to items is safe on the sync path, but `makeItem` will silently drop it.** `deserializeItems` and `unionById` pass records through whole; `makeItem` (`js/items.js`) rebuilds from a **thirteen-key** whitelist (V6 added `done` and `notes`). A field added to the model but not to `makeItem` is discarded at creation and everything downstream looks fine.
- **`js/preview.js` keeps a SECOND copy of the type list**, and it lives in a different deploy unit from the Worker's `type` enum. A type the model can return that `preview.js` does not know renders a `<select>` with no option selected — the browser shows the first option while the draft still holds the real value, and the first `change` event writes the wrong type into the record for good. `tests/preview.test.js` pins the two together; `general` is deliberately client-only. **Ship the client before the Worker.**

## Sync is not yet proven in the real world

As of **2026-08-20**, no part of the client sync has ever run in a browser or against real D1. Every test injects a `fetchImpl` and a fake `localStorage`; the convergence simulation drives `merge.js` directly with no CAS, no interleaving, no serialization and no crypto round trip. The suite is thorough, but "the tests pass" is weaker evidence here than it looks. *(Delete this section once a real two-device link has been done.)*

**A broken sync used to be completely silent.** V6 step 0 added an app-shell indicator (`#sync-indicator` in `index.html`) that lights on a corrupt stored code, a stuck adoption, or a `lastError`. Two things to know about it:

- **It has its own id, not the settings panel's `#sync-status`.** Two elements cannot share an id; `getElementById` returns one and the other silently never updates. `renderSyncStatus()` paints both, each by its own id.
- **It is painted at `app.js` module load, and that call is load-bearing.** `runSync` returns *before* its `try/finally` whenever `!isLinked() || isAdoptionPending()` — exactly the two states the indicator exists for. Do not "simplify" by painting from that early return instead: `tests/apply.test.js` anchors app.js's "never union silently" guard on `renderSyncStatus` *not* running there.

The indicator still only reports what `plaenicke.syncState` knows. After any sync change, verify both devices actually show the same thing — don't infer success from the absence of an error.

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
