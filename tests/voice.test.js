import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVoiceSupported, listen, composeText, errorKind, REFUSED_ERRORS,
} from '../js/voice.js';

// js/voice.js's listen() (home-screen spec § 3) against a fake
// SpeechRecognition. The fake records every instance and every call in one
// ordered log; stop() records whether the handlers were already detached when
// it ran, because the spec's order is detach -> stop() -> abort().

let calls;
let instances;
class FakeSR {
  constructor() {
    instances.push(this);
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }

  start() {
    calls.push('start');
    if (FakeSR.failStart) throw new Error('InvalidStateError');
  }

  stop() { calls.push(this.onresult === null ? 'stop(detached)' : 'stop(attached)'); }

  abort() { calls.push('abort'); }
}

// A result list as the browser delivers it: array-like results, each an
// array-like of alternatives carrying isFinal.
const results = (...rs) => rs.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
const resultEvent = (...rs) => ({ results: results(...rs) });

function recorder() {
  const log = { text: [], end: 0, error: [] };
  return {
    log,
    cbs: {
      onText: (t) => { log.text.push(t); },
      onEnd: () => { log.end += 1; },
      onError: (c) => { log.error.push(c); },
    },
  };
}

beforeEach(() => {
  calls = [];
  instances = [];
  FakeSR.failStart = false;
  globalThis.window = { SpeechRecognition: FakeSR };
});
afterEach(() => { delete globalThis.window; });

test('isVoiceSupported: true with SpeechRecognition or its webkit name, false with neither', () => {
  assert.equal(isVoiceSupported(), true);
  globalThis.window = { webkitSpeechRecognition: FakeSR };
  assert.equal(isVoiceSupported(), true);
  globalThis.window = {};
  assert.equal(isVoiceSupported(), false);
});

test('listen refuses to run without its three callbacks, or without SpeechRecognition', () => {
  const { cbs } = recorder();
  for (const name of ['onText', 'onEnd', 'onError']) {
    assert.throws(() => listen({ ...cbs, [name]: undefined }), new RegExp(name));
  }
  globalThis.window = {};
  assert.throws(() => listen(cbs), /isVoiceSupported/);
  assert.equal(instances.length, 0, 'nothing was created');
});

test('each listen makes a NEW recognizer: continuous, with live words, started once', () => {
  const { cbs } = recorder();
  listen(cbs);
  listen(cbs);
  assert.equal(instances.length, 2);
  assert.notEqual(instances[0], instances[1]);
  for (const r of instances) {
    assert.equal(r.continuous, true);
    assert.equal(r.interimResults, true);
    assert.equal(r.lang, 'en-US');
  }
  assert.deepEqual(calls, ['start', 'start']);
});

test('each result shows prefix + every final + the current interim, rebuilt from e.results', () => {
  const { log, cbs } = recorder();
  listen({ prefix: 'Shopping:', ...cbs });
  const rec = instances[0];
  rec.onresult(resultEvent(['buy', false]));
  rec.onresult(resultEvent(['buy milk', true], [' and', false]));
  rec.onresult(resultEvent(['buy milk', true], [' and eggs', true]));
  assert.deepEqual(log.text, ['Shopping: buy', 'Shopping: buy milk and', 'Shopping: buy milk and eggs']);
});

test('composeText joins the prefix with one space, and returns the prefix untouched when nothing was said', () => {
  assert.equal(composeText('', results(['  hello', true])), 'hello');
  assert.equal(composeText('Call mom', results(['tomorrow', false])), 'Call mom tomorrow');
  assert.equal(composeText('Call mom ', results(['tomorrow', false])), 'Call mom tomorrow');
  assert.equal(composeText('Call mom', results()), 'Call mom');
  assert.equal(composeText('Call mom', results(['  ', false])), 'Call mom');
  assert.equal(composeText('a', results(['b', true], [' c', false])), 'a b c');
});

test('stop detaches first, then calls stop() and abort(), and nothing arrives afterwards', () => {
  const { log, cbs } = recorder();
  const session = listen(cbs);
  const rec = instances[0];
  // What a browser may still hold after the handlers are replaced.
  const { onresult, onend, onerror } = rec;
  rec.onresult(resultEvent(['hello', false]));
  session.stop();
  assert.deepEqual(calls, ['start', 'stop(detached)', 'abort']);
  assert.equal(rec.onresult, null);
  assert.equal(rec.onend, null);
  assert.equal(rec.onerror, null);
  onresult(resultEvent(['hello world', true]));
  onend();
  onerror({ error: 'no-speech' });
  assert.deepEqual(log.text, ['hello'], 'a late result does not change the text');
  assert.equal(log.end, 0, 'a late end is not reported');
  assert.deepEqual(log.error, []);
  session.stop();
  assert.deepEqual(calls, ['start', 'stop(detached)', 'abort'], 'a second stop does nothing');
});

test('recognition ending on its own is reported once, and nothing after it is', () => {
  const { log, cbs } = recorder();
  const session = listen(cbs);
  const rec = instances[0];
  const { onresult, onerror } = rec;
  rec.onend();
  assert.equal(log.end, 1);
  onresult(resultEvent(['late', true]));
  onerror({ error: 'network' });
  assert.deepEqual(log.text, []);
  assert.deepEqual(log.error, []);
  session.stop();
  assert.deepEqual(calls, ['start'], 'stop after the end calls neither stop() nor abort()');
});

test('an error is reported once with its code, and the end that follows is ignored', () => {
  const { log, cbs } = recorder();
  listen(cbs);
  const rec = instances[0];
  const { onend } = rec;
  rec.onerror({ error: 'not-allowed' });
  onend();
  assert.deepEqual(log.error, ['not-allowed']);
  assert.equal(log.end, 0);
  listen(cbs);
  instances[1].onerror({});
  assert.deepEqual(log.error, ['not-allowed', 'unknown'], 'an error with no code still reports');
});

test('a start() that throws reports start-failed and returns no session', () => {
  const { log, cbs } = recorder();
  FakeSR.failStart = true;
  assert.equal(listen(cbs), null);
  assert.deepEqual(log.error, ['start-failed']);
  assert.equal(instances[0].onresult, null, 'and nothing stays attached');
});

test('a constructor that throws reports start-failed too and returns no session', () => {
  const { log, cbs } = recorder();
  globalThis.window = { SpeechRecognition: function Broken() { throw new Error('nope'); } };
  assert.equal(listen(cbs), null);
  assert.deepEqual(log.error, ['start-failed']);
});

test('errorKind:not-allowed and service-not-allowed are refusals; every other code is retry', () => {
  assert.deepEqual(REFUSED_ERRORS, ['not-allowed', 'service-not-allowed']);
  assert.equal(errorKind('not-allowed'), 'refused');
  assert.equal(errorKind('service-not-allowed'), 'refused');
  for (const code of ['no-speech', 'audio-capture', 'network', 'aborted', 'start-failed', 'unknown']) {
    assert.equal(errorKind(code), 'retry', code);
  }
});
