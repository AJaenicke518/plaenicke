import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument } from './fake-dom.js';
import { renderWeekView } from '../js/weekview.js';

globalThis.document = makeFakeDocument();

// The column head name comes from the date, not from a fixed Sun..Sat index,
// so a Monday-start week reads Mon..Sun (R1 Task 3).
function heads(weekStartISO) {
  const container = document.createElement('div');
  renderWeekView(container, weekStartISO, {}, '2026-12-02', { onSelectDay() {} });
  return container.children.map((col) => {
    const head = col.children[0];
    return { name: head.textContent, day: head.children[0].textContent };
  });
}

test('week view: a Sunday-start week reads Sun..Sat, first column the Sunday', () => {
  const h = heads('2026-11-29');
  assert.deepEqual(h.map((x) => x.name), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.equal(h[0].day, '29');
});

test('week view: a Monday-start week reads Mon..Sun, first column the Monday', () => {
  const h = heads('2026-11-30');
  assert.deepEqual(h.map((x) => x.name), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(h[0].day, '30');
  assert.equal(h[6].day, '6');
});
