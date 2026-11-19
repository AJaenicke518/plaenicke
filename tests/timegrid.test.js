import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesOf, formatTime, formatTimeRange, addDays, startOfWeek,
  bucketDayItems, layoutDayBlocks, weekLabel, weekdayNames, hourLabel } from '../js/timegrid.js';

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

// The Week header. A week inside one year needs no year; a week across New
// Year's names both, or "12/27 – 01/02" reads as running backwards.
test('weekLabel omits the year inside one year and names both across a year boundary', () => {
  assert.equal(weekLabel('2026-10-18', '2026-10-24'), '10/18 – 10/24');
  assert.equal(weekLabel('2026-11-29', '2026-12-05'), '11/29 – 12/05', 'a month boundary is not a year boundary');
  assert.equal(weekLabel('2026-12-27', '2027-01-02'), '12/27/2026 – 01/02/2027');
});

test('formatTime 24h is zero-padded HH:MM', () => {
  assert.equal(formatTime('00:00', '24h'), '00:00');
  assert.equal(formatTime('07:05', '24h'), '07:05');
  assert.equal(formatTime('12:00', '24h'), '12:00');
  assert.equal(formatTime('23:59', '24h'), '23:59');
});

test('formatTime 12h is unchanged, explicit or default', () => {
  assert.equal(formatTime('00:00'), '12:00 AM');
  assert.equal(formatTime('12:00'), '12:00 PM');
  assert.equal(formatTime('00:00', '12h'), '12:00 AM');
  assert.equal(formatTime('13:05', '12h'), '1:05 PM');
});

test('formatTimeRange 24h has no period suffix', () => {
  assert.equal(formatTimeRange('07:00', '09:15', '24h'), '07:00–09:15');
  assert.equal(formatTimeRange('11:00', '13:00', '24h'), '11:00–13:00');
  assert.equal(formatTimeRange('07:00', '09:15'), '7:00–9:15 AM');
});

test('startOfWeek with a Monday start', () => {
  assert.equal(startOfWeek('2026-11-18', 'mon'), '2026-11-16');
  assert.equal(startOfWeek('2026-11-22', 'mon'), '2026-11-16'); // Sunday goes back 6
  assert.equal(startOfWeek('2026-11-16', 'mon'), '2026-11-16');
  assert.equal(startOfWeek('2027-01-01', 'mon'), '2026-12-28');
  assert.equal(startOfWeek('2026-11-22', 'sun'), '2026-11-22');
  assert.equal(startOfWeek('2026-11-18'), '2026-11-15');
});

test('a Monday-start week across New Year shows both years in its label', () => {
  const s = startOfWeek('2027-01-01', 'mon');
  assert.equal(weekLabel(s, addDays(s, 6)), '12/28/2026 – 01/03/2027');
});

test('weekdayNames', () => {
  assert.deepEqual(weekdayNames('mon'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(weekdayNames('sun'), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.equal(weekdayNames()[0], 'Sun');
});

test('hourLabel', () => {
  assert.equal(hourLabel(0), '12 AM');
  assert.equal(hourLabel(7), '7 AM');
  assert.equal(hourLabel(12), '12 PM');
  assert.equal(hourLabel(13), '1 PM');
  assert.equal(hourLabel(0, '24h'), '00');
  assert.equal(hourLabel(7, '24h'), '07');
  assert.equal(hourLabel(13, '24h'), '13');
});
