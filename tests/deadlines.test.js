import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseICS } from '../js/ics.js';
import {
  isTrackableTitle, courseCode, deadlineTitle, deriveDeadlines, DEADLINE_ID_PREFIX,
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
  const got = deriveDeadlines(FIXTURE.events, '2026-10-15');
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
  assert.ok(deriveDeadlines(FIXTURE.events, '2026-11-05').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`));
  assert.equal(deriveDeadlines(FIXTURE.events, '2026-11-06').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`), false);
  assert.equal(deriveDeadlines([], '2026-10-01').size, 0);
  assert.equal(deriveDeadlines(undefined, '2026-10-01').size, 0);
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
  assert.equal(deriveDeadlines(events, '2026-10-15').size, 0);
});
