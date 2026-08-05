import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, toWire, emptyState } from '../js/merge.js';

// Two devices, a shared compare-and-swap row, randomised local operations.
// Operations and syncs are DECOUPLED — a device may accumulate several edits
// before it pushes — because that is the only way the two devices are ever
// concurrently divergent, and convergence is meaningless without divergence.
test('two devices converge and stop pushing', () => {
  let seed = 987654321;
  // Math.imul, not `*`. See defect 1 above.
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
  const NOW = new Date('2026-09-01T00:00:00.000Z');
  let tieTrials = 0; // coverage counter — see the assertion after the loop
  let divergentTrials = 0; // ditto: trials that entered quiesce genuinely divergent

  for (let trial = 0; trial < 100; trial += 1) {
    const server = { version: 0, wire: emptyState() };
    const devices = [emptyState(), emptyState()];
    const colours = ['#111', '#222'];
    // The oracle: latest create and latest delete per record over the WHOLE op
    // log, computed independently of anything merge.js does. A record is alive
    // at the fixed point iff it was created at or after it was last deleted —
    // applyTombstones drops on `deletedAt > updatedAt`, so a tie survives.
    // Timestamps below are non-decreasing, which is what makes a plain max
    // correct here: a later local write can never destroy a newer version.
    const created = new Map();
    const deleted = new Map();
    const bump = (m, k, v) => { if (!m.has(k) || v > m.get(k)) m.set(k, v); };
    let sawTie = false;

    const sync = (d) => {
      const before = devices[d];
      const remote = server.wire;
      // Tie coverage, measured WHERE THE TIE RULE FIRES: local and remote both
      // hold this id, stamped at the same instant, with different content
      // (`by`). That is the only state in which unionById's `>=` differs from
      // `>`. DEVIATION from the plan text, which put this predicate in the op
      // loop as "device d overwrites a foreign record at the current instant";
      // that state is structurally unreachable, so the coverage assertion
      // failed on unmutated source. Measured over the plan's exact draw order:
      // the op-loop predicate fired 0 times in 1600 steps, and so did its
      // precondition (device d holding ANY foreign record stamped at the
      // current quantum, for any id and any op) — a device only acquires
      // foreign records via sync(d), sync(d) runs only after d's own op, and
      // the quantum is 2 steps wide with one actor per step, so the pull can
      // never precede the write inside one quantum. The tie itself is real and
      // frequent: 23 events across 20 of 100 trials, seen here.
      for (const list of ['items', 'feeds']) {
        for (const mine of before[list]) {
          const theirs = remote[list].find((r) => r.id === mine.id);
          if (theirs && theirs.updatedAt === mine.updatedAt && theirs.by !== mine.by) sawTie = true;
        }
      }
      const merged = merge(before, remote, NOW);
      // pickFeed must carry a KNOWN feed's per-device colour through the merge.
      // Dropping it hands storage.js a feed whose color is undefined, and
      // deserializeFeeds drops any feed whose color is not a string — the
      // defect that would have destroyed every calendar subscription, and the
      // one the first draft of this test could not see.
      for (const f of merged.feeds) {
        const prior = before.feeds.find((p) => p.id === f.id);
        if (prior) {
          assert.equal(f.color, prior.color,
            `trial ${trial}: merge lost a known feed's per-device colour`);
        }
      }
      // Give each device its own per-device fields, as feeds.js would.
      devices[d] = { ...merged, feeds: merged.feeds.map((f) => ({ ...f, color: colours[d], hidden: d === 1 })) };
      const wire = toWire(devices[d]);
      if (JSON.stringify(wire) !== JSON.stringify(toWire(remote))) {
        server.version += 1;
        server.wire = wire;
        return true;
      }
      return false;
    };

    // 32 steps / 8 ids / quantum 4 / sync 1-in-6, rather than the plan's
    // 16 / 4 / 2 / 1-in-3. Measured over 14 configurations: this one leaves
    // 99 of 100 trials divergent at quiesce entry (was 84), raises the tie
    // coverage below to 23 trials (was 20), and roughly doubles the state at
    // the fixed point (3.7 items, 3.7 feeds, 10.1 tombstones per trial).
    for (let step = 0; step < 32; step += 1) {
      const d = rnd(2);
      // Non-decreasing, with a deliberately COARSE quantum so consecutive steps
      // share a timestamp. Ties on the same id from two devices are where the
      // tie rules live (unionById `>=` goes remote; collapse breaks by id), and
      // a tie broken the wrong way makes the devices push at each other forever.
      const at = new Date(Date.UTC(2026, 7, 1) + Math.floor(step / 4) * 3600000).toISOString();
      const atMs = Date.parse(at);
      const id = `r${rnd(8)}`;
      const op = rnd(4);
      // `by` makes the two devices' writes for the same id at the same instant
      // DISTINGUISHABLE. Without it every record is byte-identical and the tie
      // rules are unobservable. toWire keeps it; dedupeState's key ignores it.
      if (op === 0) {
        devices[d] = { ...devices[d], items: [...devices[d].items.filter((i) => i.id !== id), { id, title: 'shared title', date: '2026-08-05', time: null, updatedAt: at, by: d }] };
        bump(created, `item:${id}`, atMs);
      } else if (op === 1) {
        devices[d] = { ...devices[d], tombstones: [...devices[d].tombstones.filter((t) => !(t.id === id && t.kind === 'item')), { id, kind: 'item', deletedAt: at }] };
        bump(deleted, `item:${id}`, atMs);
      } else if (op === 2) {
        devices[d] = { ...devices[d], feeds: [...devices[d].feeds.filter((f) => f.id !== id), { id, url: `https://cal.example/${id}.ics`, name: id, color: colours[d], hidden: false, updatedAt: at, by: d }] };
        bump(created, `feed:${id}`, atMs);
      } else {
        // Feed DELETION, and it is the reason this op exists. Without it no
        // feed tombstone is ever written, and `merge` dropping applyTombstones
        // on the feed side survives the whole battery (measured: 1 pass,
        // 0 fail). It is the side that matters more: applyRemoteFeeds deletes
        // and re-tombstones every local feed absent from its argument, and a
        // feed deletion propagated wrongly destroys a subscription whose URL
        // is a capability token the app never re-displays. `alive()` needs no
        // change — it is already generic over the kind prefix.
        devices[d] = { ...devices[d], tombstones: [...devices[d].tombstones.filter((t) => !(t.id === id && t.kind === 'feed')), { id, kind: 'feed', deletedAt: at }] };
        bump(deleted, `feed:${id}`, atMs);
      }
      if (rnd(6) === 0) sync(d); // sync only SOMETIMES — see defect 2 above
    }

    // Quiesce: no more local operations, just sync until nobody pushes. NOT
    // `sync(0) || sync(1)` — that short-circuits past device 1.
    let rounds = 0;
    for (;;) {
      const a = sync(0);
      const b = sync(1);
      if (!a && !b) break;
      rounds += 1;
      assert.ok(rounds < 50, `trial ${trial}: never reached a fixed point — devices push at each other forever`);
    }
    if (sawTie) tieTrials += 1;
    if (rounds > 0) divergentTrials += 1;

    const w0 = toWire(devices[0]);
    assert.deepEqual(w0, toWire(devices[1]), `trial ${trial}: devices diverged`);
    assert.deepEqual(w0, toWire(server.wire), `trial ${trial}: devices agree but the server holds something else`);

    // Against the OP LOG, not against what a device just pushed. Every item
    // carries the same title/date/time, so a dedupe leaking into the sync path
    // collapses them all and this comparison fails.
    const alive = (kind) => [...created]
      .filter(([k]) => k.startsWith(`${kind}:`))
      .filter(([k, c]) => !(deleted.has(k) && deleted.get(k) > c))
      .map(([k]) => k.slice(kind.length + 1)).sort();
    assert.deepEqual(w0.items.map((i) => i.id).sort(), alive('item'), `trial ${trial}: item set does not match the op log`);
    assert.deepEqual(w0.feeds.map((f) => f.id).sort(), alive('feed'), `trial ${trial}: feed set does not match the op log`);
  }

  // Coverage, not behaviour: if no trial ever produced a same-id/same-instant
  // write from both devices, the tie rules were never exercised and the
  // ties-go-remote mutant would pass for want of a scenario, not for merit.
  assert.ok(tieTrials > 0, 'no trial exercised a cross-device timestamp tie — the tie rules are untested');

  // The POSITIVE case of the fixed-point assertion above. `rounds < 50` only
  // ever fires on a mutant that never converges; on healthy source it needs a
  // witness that the quiesce loop runs at all, or defect 2 (every op followed
  // immediately by a sync, so the devices are never concurrently divergent and
  // the loop body executes zero times) silently returns. Measured here: 99 of
  // 100 trials enter quiesce divergent.
  //
  // WHY THERE IS NO `rounds >= 2` ASSERTION: with two devices and a fixed
  // quiesce order, more than one round is STRUCTURALLY IMPOSSIBLE, so such an
  // assertion could only ever be satisfied by a contrived scenario. sync(0)
  // publishes S1 = merge(D0, S0); sync(1) then publishes S2 = merge(D1, S1),
  // which is the union of everything either device holds. The next sync(0)
  // computes merge(S1, S2), and that is S2 in wire form — unionById keeps every
  // id from both and `>=` re-picks S2's version of any shared id; every
  // tombstone that suppressed a record in S2 is itself in S2 and suppresses it
  // again; pickFeed only restores color/hidden, which toWire strips. So
  // device 0 absorbs and does not push, device 1 sees no change, and the loop
  // breaks at rounds === 1. Generally: the LAST device in a pass always
  // publishes the global union, so the following pass is always a no-op.
  // rounds >= 2 needs a new local write or a failed CAS after the union is
  // published, and quiesce models neither (see the known limits in the ledger).
  // Confirmed empirically across 14 configurations, up to 64 steps / 12 ids
  // with syncing disabled entirely during the op loop (100/100 trials fully
  // divergent, ~5.9 items + 5.3 feeds + 17.7 tombstones accumulated
  // independently): the round histogram is {1: 100}. Never once a 2.
  assert.ok(divergentTrials > 0,
    'no trial entered quiesce divergent — operations and syncs have re-coupled and convergence is untested');
});
