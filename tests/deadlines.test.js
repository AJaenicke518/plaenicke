import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseICS } from '../js/ics.js';
import { addDays } from '../js/timegrid.js';
import { merge, SCHEMA_VERSION } from '../js/merge.js';
import { makeItem } from '../js/items.js';
import {
  isTrackableTitle, courseCode, deadlineTitle, deriveDeadlines, DEADLINE_ID_PREFIX,
  planDeadlineImport, trackedCopyIds, hideTrackedCopies,
} from '../js/deadlines.js';

const FIXTURE = parseICS(readFileSync(new URL('./fixtures/brightspace-shape.ics', import.meta.url), 'utf8'));

test('fixture check: the synthetic feed parses with nothing skipped', () => {
  assert.equal(FIXTURE.skipped.length, 0);
  assert.equal(FIXTURE.events.length, 8);
});

test('isTrackableTitle: Due and revisions due, any case; nothing else', () => {
  for (const t of ['HW 4.7 - Due', 'TEST #2 - Due', 'IA 4.5 revisions due', 'IA 4.3 Revisions Due', 'Due', 'Essay due ']) {
    assert.equal(isTrackableTitle(t), true, t);
  }
  for (const t of ['PHYS 2100 3.1 Practice Solutions - Available', 'Standard Exam 5', 'Online Class', 'Overdue', 'Due dates explained', '']) {
    assert.equal(isTrackableTitle(t), false, t);
  }
});

test('courseCode: letters and number from the first (XXXX-NNNN…) group', () => {
  assert.equal(courseCode('Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234');
  assert.equal(courseCode('Fall 2026 Introduction to Electricity and Magnetism (PHYS-2100-02/03)'), 'PHYS 2100');
  assert.equal(courseCode('Fall 2026 Design and Manufacturing (MECH-2100)'), 'MECH 2100');
  assert.equal(courseCode('University Hall 1000 (Fall 2026 Sport, Race and Society (CLST-1300-01/02))'), 'CLST 1300');
  assert.equal(courseCode('Calculus Knowledge Survey 2026-2027'), null);
  assert.equal(courseCode(null), null);
});

test('deadlineTitle: course prefix, trailing "- Due" dropped, "revisions due" kept', () => {
  assert.equal(deadlineTitle('HW 4.7 - Due', 'Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234 · HW 4.7');
  assert.equal(deadlineTitle('IA 4.5 Revisions Due', 'Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234 · IA 4.5 Revisions Due');
  assert.equal(deadlineTitle('Survey - Due', 'Calculus Knowledge Survey 2026-2027'), 'Survey');
  assert.equal(deadlineTitle('Due', null), 'Due');
});

test('deriveDeadlines: trackable singles from the start date, in LA time, keyed bs-<uid>', () => {
  const got = deriveDeadlines(FIXTURE.events, '2026-10-15', '2026-10-15');
  assert.deepEqual([...got.keys()].sort(), [
    'bs-1000-101@brightspace.lmu.edu', // MATH HW, after the 2026-11-01 DST change
    'bs-1000-102@brightspace.lmu.edu', // PHYS HW, same title, before it
    'bs-1000-103@brightspace.lmu.edu', // all-day revisions due
    'bs-1000-108@brightspace.lmu.edu', // no course code
  ]);
  // 1000-107 is before the start date; 104 Available, 105 exam, 106 repeating.
  assert.deepEqual(got.get('bs-1000-101@brightspace.lmu.edu'),
    { uid: '1000-101@brightspace.lmu.edu', title: 'MATH 234 · HW 4.7', date: '2026-11-02', time: '23:59' });
  assert.deepEqual(got.get('bs-1000-102@brightspace.lmu.edu'),
    { uid: '1000-102@brightspace.lmu.edu', title: 'PHYS 2100 · HW 4.7', date: '2026-10-30', time: '23:59' });
  assert.deepEqual(got.get('bs-1000-103@brightspace.lmu.edu'),
    { uid: '1000-103@brightspace.lmu.edu', title: 'MATH 234 · IA 4.5 Revisions Due', date: '2026-11-05', time: null });
  assert.equal(got.get('bs-1000-108@brightspace.lmu.edu').title, 'Survey');
});

test('deriveDeadlines: the start date is inclusive and an empty or missing list gives nothing', () => {
  assert.ok(deriveDeadlines(FIXTURE.events, '2026-11-05', '2026-11-05').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`));
  assert.equal(deriveDeadlines(FIXTURE.events, '2026-11-06', '2026-11-06').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`), false);
  assert.equal(deriveDeadlines([], '2026-10-01', '2026-10-01').size, 0);
  assert.equal(deriveDeadlines(undefined, '2026-10-01', '2026-10-01').size, 0);
});

test('deriveDeadlines: a repeating event with a trackable title is never a single deadline', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:9-1@brightspace.example',
    'SUMMARY:Weekly Quiz - Due',
    'DTSTART:20261103T075900Z',
    'DTEND:20261103T075900Z',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const { events, skipped } = parseICS(ics);
  assert.equal(skipped.length, 0);
  assert.equal(events.length, 1);
  assert.equal(deriveDeadlines(events, '2026-10-15', '2026-10-15').size, 0);
});

const FROM = '2026-10-15';
const feed = (o = {}) => ({ id: 'f1', url: 'https://x/f.ics', name: 'BS', color: 'c', hidden: false,
  updatedAt: '2026-10-15T00:00:00.000Z', trackDeadlines: { from: FROM }, ...o });
const entry = (events) => ({ fetchedAt: '2026-10-30T12:00:00.000Z', events, skipped: [] });
const ev = (uid, title, value, o = {}) => ({ uid, title, form: 'UTC', dtstart: { value, tzid: null },
  dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
  location: 'Fall 2026 Calculus III (MATH-234-01/02)', ...o });
const own = (id, o = {}) => ({ id, title: 'MATH 234 · HW 1', date: '2026-11-02', time: '23:59', endTime: null,
  createdAt: '2026-10-20', updatedAt: '2026-10-20T00:00:00.000Z', type: 'due', project: null, subject: null,
  category: null, done: false, notes: null, ...o });
const plan = (o) => planDeadlineImport({ feeds: [feed()], prevCache: {}, cache: {}, items: [], tombstones: [],
  failedFeedIds: new Set(), pendingIds: new Set(), todayISO: '2026-10-30', ...o });
const HW1 = ev('u1', 'HW 1 - Due', '20261103T075900Z'); // 2026-11-02 23:59 LA

test('plan: a new trackable event is created as a Deadline record', () => {
  const p = plan({ cache: { f1: entry([HW1]) } });
  assert.deepEqual(p.create, [{ id: 'bs-u1', title: 'MATH 234 · HW 1', date: '2026-11-02', time: '23:59' }]);
  assert.deepEqual([p.update, p.remove, p.held, p.note], [[], [], [], null]);
});

test('plan: no tracking feed, no work (tracking off keeps items: nothing is removed)', () => {
  const p = plan({ feeds: [feed({ trackDeadlines: null })], cache: { f1: entry([]) }, items: [own('bs-u1')] });
  assert.deepEqual([p.create, p.update, p.remove, p.held], [[], [], [], []]);
});

test('plan: a tombstoned or pending-delete id is never re-created or edited', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const tomb = plan({ cache: { f1: entry([HW1]) }, tombstones: [{ id: 'bs-u1', kind: 'item', deletedAt: '2026-10-29T00:00:00.000Z' }] });
  assert.deepEqual(tomb.create, []);
  const pend = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) }, items: [own('bs-u1')], pendingIds: new Set(['bs-u1']) });
  assert.deepEqual([pend.create, pend.update, pend.remove], [[], [], []]);
});

test('plan: Brightspace moved the due date -> only date patched; done/notes/type never in a patch', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z'); // 2026-11-03 23:59
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) },
    items: [own('bs-u1', { done: true, notes: 'mine', type: 'task' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { date: '2026-11-03' } }]);
});

test('plan: edits stick — item differs but Brightspace did not change -> no patch', () => {
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([HW1]) },
    items: [own('bs-u1', { title: 'Calc HW 1', date: '2026-11-01' })] });
  assert.deepEqual(p.update, []);
});

test('plan: Brightspace changes only the date -> Alex\'s custom title is kept', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) },
    items: [own('bs-u1', { title: 'Calc HW 1' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { date: '2026-11-03' } }]);
});

test('plan: no previous cache entry -> no patch (the device that saw the change applies it)', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const p = plan({ cache: { f1: entry([moved]) }, items: [own('bs-u1')] });
  assert.deepEqual(p.update, []);
});

test('plan: a time change clears an end time Alex set, so the edit validates', () => {
  const earlier = ev('u1', 'HW 1 - Due', '20261102T190000Z'); // 2026-11-02 11:00
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([earlier]) },
    items: [own('bs-u1', { time: '23:00', endTime: '23:30' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { time: '11:00', endTime: null } }]);
});

test('plan: a deadline gone from the feed is removed (future only, at most 3)', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('bs-gone', { date: '2026-11-05' })] });
  assert.deepEqual(p.remove, ['bs-gone']);
});

test('plan: past deadlines are never auto-removed', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('bs-old', { date: '2026-10-29' })] });
  assert.deepEqual(p.remove, []);
});

test('plan: a failed or quota-dropped refresh removes nothing', () => {
  const items = [own('bs-u1'), own('bs-gone', { date: '2026-11-05' })];
  assert.deepEqual(plan({ cache: { f1: entry([HW1]) }, items, failedFeedIds: new Set(['f1']) }).remove, []);
  assert.deepEqual(plan({ cache: { f1: { ...entry([HW1]), quotaDropped: true } }, items }).remove, []);
  assert.deepEqual(plan({ cache: {}, items }).remove, []);
});

test('plan: one tracking feed failing while another refreshes removes nothing', () => {
  // Kills the `|| !allOk` mutation: with one feed, the empty-result guard also
  // blocks removal, so only a second, healthy feed exposes a missing guard.
  const feeds = [feed(), feed({ id: 'f2' })];
  const items = [own('bs-u1'), own('bs-u2', { date: '2026-11-04' })];
  const f2Events = [ev('u2', 'HW 2 - Due', '20261105T075900Z')];
  const failed = plan({ feeds, cache: { f1: entry([HW1]), f2: entry(f2Events) }, items, failedFeedIds: new Set(['f2']) });
  assert.deepEqual([failed.remove, failed.held, failed.note], [[], [], null]);
  const dropped = plan({ feeds, cache: { f1: entry([HW1]), f2: { ...entry(f2Events), quotaDropped: true } }, items });
  assert.deepEqual([dropped.remove, dropped.held, dropped.note], [[], [], null]);
});

test('plan: an empty feed, or one with no trackable event, removes nothing and says so', () => {
  const items = [own('bs-a', { date: '2026-11-05' })];
  const empty = plan({ cache: { f1: entry([]) }, items });
  assert.deepEqual(empty.remove, []);
  assert.equal(empty.note, 'Brightspace returned no deadlines — none removed');
  const noneTrackable = plan({ cache: { f1: entry([ev('x', 'Standard Exam 5', '20261106T170000Z')]) }, items });
  assert.deepEqual(noneTrackable.remove, []);
  assert.equal(noneTrackable.note, 'Brightspace returned no deadlines — none removed');
});

test('plan: one tracking feed empty or with nothing trackable removes nothing, even if another is healthy', () => {
  // § 4.2 is checked per feed: a healthy f1 must not vouch for an empty f2.
  const feeds = [feed(), feed({ id: 'f2' })];
  const items = [own('bs-u1'), own('bs-f2a', { date: '2026-11-05' }), own('bs-f2b', { date: '2026-11-06' })];
  const empty = plan({ feeds, cache: { f1: entry([HW1]), f2: entry([]) }, items });
  assert.deepEqual([empty.remove, empty.held, empty.note], [[], [], 'Brightspace returned no deadlines — none removed']);
  const examOnly = plan({ feeds, cache: { f1: entry([HW1]), f2: entry([ev('x', 'Exam', '20261106T170000Z')]) }, items });
  assert.deepEqual([examOnly.remove, examOnly.held, examOnly.note], [[], [], 'Brightspace returned no deadlines — none removed']);
  // Creates for the healthy feed still proceed.
  const fresh = plan({ feeds, cache: { f1: entry([HW1]), f2: entry([]) }, items: [own('bs-f2a', { date: '2026-11-05' })] });
  assert.deepEqual(fresh.create.map((c) => c.id), ['bs-u1']);
  assert.deepEqual(fresh.remove, []);
});

test('plan: more than 3 removals are held, not applied', () => {
  const gone = ['a', 'b', 'c', 'd'].map((k) => own(`bs-${k}`, { date: '2026-11-05' }));
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), ...gone] });
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.held, ['bs-a', 'bs-b', 'bs-c', 'bs-d']);
  assert.equal(p.note, '4 deadlines disappeared from Brightspace — not removed');
  const three = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), ...gone.slice(0, 3)] });
  assert.deepEqual(three.remove, ['bs-a', 'bs-b', 'bs-c']);
});

test('plan: with two tracking feeds, an id listed by either is kept', () => {
  const p = plan({
    feeds: [feed(), feed({ id: 'f2' })],
    cache: { f1: entry([HW1]), f2: entry([ev('u2', 'HW 2 - Due', '20261105T075900Z')]) },
    items: [own('bs-u1'), own('bs-u2', { date: '2026-11-04' })],
  });
  assert.deepEqual(p.remove, []);
});

test('plan: own items without the bs- prefix are never touched', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('typed-1', { date: '2026-11-05' })] });
  assert.deepEqual(p.remove, []);
});

test('trackedCopyIds + hideTrackedCopies: a tracked deadline\'s feed copy is dropped, others kept', () => {
  const hidden = trackedCopyIds([own('bs-u1'), own('typed-1')], [{ id: 'bs-u9', kind: 'item', deletedAt: 'x' }, { id: 'f', kind: 'feed', deletedAt: 'x' }]);
  assert.deepEqual([...hidden].sort(), ['bs-u1', 'bs-u9']);
  const inst = (feedId, uid) => ({ id: `${feedId}:${uid}`, feedId, uid });
  const out = hideTrackedCopies(
    [inst('f1', 'u1'), inst('f1', 'u9'), inst('f1', 'u2'), inst('f3', 'u1')],
    [feed(), feed({ id: 'f3', trackDeadlines: null })],
    hidden,
  );
  assert.deepEqual(out.map((i) => i.id), ['f1:u2', 'f3:u1']);
});

test('deriveDeadlines: the horizon runs from today once today passes the start date', () => {
  const late = ev('late', 'Final - Due', `${addDays(FROM, 500).replaceAll('-', '')}T200000Z`);
  const todayLater = addDays(FROM, 450);
  assert.ok(deriveDeadlines([late], FROM, todayLater).has('bs-late'));
  assert.equal(deriveDeadlines([late], FROM, FROM).has('bs-late'), false);
});

test('two devices importing the same feed converge to one item; the second writes nothing', () => {
  const cache = { f1: entry([HW1]) };
  const build = (p, stamp) => p.create.map((c) => makeItem({ ...c, type: 'due' }, { id: c.id, createdAt: '2026-10-30', updatedAt: stamp }));
  const a = build(plan({ cache }), '2026-10-30T10:00:00.000Z');
  const b = build(plan({ cache }), '2026-10-30T10:00:05.000Z');
  assert.equal(a.length, 1);
  const st = (items) => ({ schemaVersion: SCHEMA_VERSION, items, feeds: [], tombstones: [] });
  const merged = merge(st(a), st(b), new Date('2026-10-30T10:01:00.000Z'));
  assert.equal(merged.items.filter((it) => it.id === 'bs-u1').length, 1);
  const again = plan({ prevCache: cache, cache, items: merged.items });
  assert.deepEqual([again.create, again.update, again.remove], [[], [], []]);
});
