import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesOf, formatTime, formatTimeRange, addDays, startOfWeek,
  bucketDayItems, layoutDayBlocks } from '../js/timegrid.js';

test('minutesOf converts HH:MM to minutes since midnight', () => {
  assert.equal(minutesOf('00:00'), 0);
  assert.equal(minutesOf('14:30'), 870);
  assert.equal(minutesOf('23:59'), 1439);
});

test('formatTime renders 12-hour times', () => {
  assert.equal(formatTime('09:05'), '9:05 AM');
  assert.equal(formatTime('14:30'), '2:30 PM');
  assert.equal(formatTime('00:30'), '12:30 AM');
  assert.equal(formatTime('12:30'), '12:30 PM');
});

test('formatTimeRange shares the period when equal, shows both when not', () => {
  assert.equal(formatTimeRange('14:00', '15:00'), '2:00–3:00 PM');
  assert.equal(formatTimeRange('11:00', '13:00'), '11:00 AM–1:00 PM');
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
});

test('startOfWeek returns the Sunday of the week', () => {
  assert.equal(startOfWeek('2026-08-05'), '2026-08-02'); // Wed -> Sun
  assert.equal(startOfWeek('2026-08-02'), '2026-08-02'); // Sun -> itself
});

test('bucketDayItems splits untimed from time-sorted timed', () => {
  const items = [
    { id: 'b', time: '15:00' }, { id: 'u' }, { id: 'a', time: '09:00' },
  ];
  const { untimed, timed } = bucketDayItems(items);
  assert.deepEqual(untimed.map(i => i.id), ['u']);
  assert.deepEqual(timed.map(i => i.id), ['a', 'b']);
});

test('layoutDayBlocks: non-overlapping items each get full width', () => {
  const rows = layoutDayBlocks([
    { id: 'a', time: '09:00', endTime: '10:00' },
    { id: 'b', time: '10:00', endTime: '11:00' },
  ]);
  assert.deepEqual(rows.map(r => [r.item.id, r.col, r.cols, r.pinned]),
    [['a', 0, 1, false], ['b', 0, 1, false]]);
  assert.equal(rows[0].startMin, 540);
  assert.equal(rows[0].endMin, 600);
});

test('layoutDayBlocks: overlapping items split the width', () => {
  const rows = layoutDayBlocks([
    { id: 'a', time: '09:00', endTime: '11:00' },
    { id: 'b', time: '10:00', endTime: '12:00' },
  ]);
  assert.deepEqual(rows.map(r => [r.item.id, r.col, r.cols]), [['a', 0, 2], ['b', 1, 2]]);
});

test('layoutDayBlocks: no endTime pins a default-duration chip', () => {
  const rows = layoutDayBlocks([{ id: 'a', time: '09:00' }]);
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].endMin, 570); // 09:00 + 30min default
});

test('layoutDayBlocks clamps a late pin to midnight', () => {
  const rows = layoutDayBlocks([{ id: 'a', time: '23:59' }]); // "due at midnight" case
  assert.equal(rows[0].endMin, 1440);
});
