// Unit tests for js/core.js (no dependency). Run: node tests/unit.js
'use strict';
const assert = require('assert');
const RA = require('../js/core.js');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

/** Minimal Standard MIDI File parser, used to check our writer. */
function parseMIDI(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => String.fromCharCode(...u8.slice(o, o + n));
  assert.strictEqual(str(0, 4), 'MThd');
  const fmt = dv.getUint16(8), ntr = dv.getUint16(10), ppq = dv.getUint16(12);
  assert.strictEqual(str(14, 4), 'MTrk');
  const len = dv.getUint32(18); let p = 22; const end = p + len;
  assert.strictEqual(end, u8.length, 'track length matches file');
  const ev = []; let tick = 0, status = 0;
  const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  while (p < end) {
    tick += vlq();
    let b = u8[p];
    if (b & 0x80) { status = b; p++; }
    if (status === 0xFF) { const type = u8[p++]; const l = vlq(); ev.push({ tick, meta: type, data: u8.slice(p, p + l) }); p += l; if (type === 0x2F) break; }
    else { const d1 = u8[p++], d2 = u8[p++]; ev.push({ tick, status, d1, d2 }); }
  }
  return { fmt, ntr, ppq, ev };
}

test('10 voices with unique GM notes', () => {
  assert.strictEqual(RA.TRACKS.length, 10);
  assert.strictEqual(new Set(RA.TRACKS.map(t => t.gm)).size, 10);
});
test('every preset row matches its length and is non-empty', () => {
  assert.ok(RA.PRESET_IDS.length >= 6);
  RA.PRESET_IDS.forEach(id => {
    const P = RA.PRESETS[id];
    Object.values(P.rows).forEach(r => assert.strictEqual(r.length, P.length, id));
    const p = RA.patternFromPreset(id);
    assert.ok(!RA.isPatternEmpty(p), id);
    assert.ok(P.bpm >= 40 && P.bpm <= 240);
  });
});
test('setPatternLength duplicates into empty space and keeps hidden data', () => {
  const p = RA.patternFromPreset('house');
  RA.setPatternLength(p, 32);
  assert.deepStrictEqual(p.grid.kick.slice(16, 32), p.grid.kick.slice(0, 16));
  p.grid.kick[20] = 3; RA.setPatternLength(p, 16); assert.strictEqual(p.grid.kick[20], 3);
  RA.setPatternLength(p, 32); assert.strictEqual(p.grid.kick[20], 3, 'not overwritten when area not empty');
});
test('swing delays odd steps only, up to half a step', () => {
  assert.strictEqual(RA.swingOffset(0, 120, 100), 0);
  assert.ok(Math.abs(RA.swingOffset(1, 120, 100) - 0.0625) < 1e-9);
  assert.strictEqual(RA.swingOffset(3, 120, 0), 0);
});
test('computeEvents: count, timing, mute and solo', () => {
  const s = RA.defaultState(); s.bpm = 120;
  s.patterns.A.grid.kick[0] = 2; s.patterns.A.grid.kick[4] = 3; s.patterns.A.grid.snare[4] = 2;
  let r = RA.computeEvents(s, 2);
  assert.strictEqual(r.events.length, 6);
  assert.ok(Math.abs(r.duration - 4) < 1e-9, '2 bars of 16ths at 120 = 4 s');
  assert.ok(Math.abs(r.events.find(e => e.track === 'snare').t - 0.5) < 1e-9);
  s.kit.snare.mute = true; assert.strictEqual(RA.computeEvents(s, 1).events.length, 2);
  s.kit.snare.mute = false; s.kit.snare.solo = true; assert.strictEqual(RA.computeEvents(s, 1).events.length, 1);
});
test('chain plays non-empty banks in order', () => {
  const s = RA.defaultState(); s.chain = true;
  s.patterns.A.grid.kick[0] = 2; s.patterns.C.grid.kick[0] = 2; s.patterns.C.length = 12;
  assert.deepStrictEqual(RA.playOrder(s), ['A', 'C']);
  const r = RA.computeEvents(s, 1);
  assert.deepStrictEqual(r.events.map(e => e.bank), ['A', 'C']);
  assert.ok(Math.abs(r.duration - RA.stepDuration(120) * 28) < 1e-9);
});
test('WAV header is valid RIFF/WAVE PCM 16-bit stereo', () => {
  const L = new Float32Array([0, 0.5, -1, 1]), R = new Float32Array([0, -0.5, 1, 2]);
  const w = RA.encodeWAV([L, R], 44100), dv = new DataView(w.buffer);
  assert.strictEqual(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.strictEqual(String.fromCharCode(...w.slice(8, 12)), 'WAVE');
  assert.strictEqual(dv.getUint16(20, true), 1); assert.strictEqual(dv.getUint16(22, true), 2);
  assert.strictEqual(dv.getUint32(24, true), 44100); assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(dv.getUint32(40, true), 16); assert.strictEqual(w.length, 44 + 16);
  assert.strictEqual(dv.getInt16(44 + 4 * 3 + 2, true), 32767, 'clipped');
});
test('MIDI file: header, tempo, channel 10, GM notes, velocities, length', () => {
  const s = RA.defaultState(); s.bpm = 100;
  s.patterns.A = RA.patternFromPreset('house');
  const m = parseMIDI(RA.encodeMIDI(s, 2));
  assert.strictEqual(m.fmt, 0); assert.strictEqual(m.ntr, 1); assert.strictEqual(m.ppq, 96);
  const tempo = m.ev.find(e => e.meta === 0x51).data;
  assert.strictEqual((tempo[0] << 16) | (tempo[1] << 8) | tempo[2], 600000);
  const ons = m.ev.filter(e => e.status === 0x99);
  const expected = RA.computeEvents(s, 2).events.length;
  assert.strictEqual(ons.length, expected);
  assert.strictEqual(m.ev.filter(e => e.status === 0x89).length, expected);
  assert.ok(ons.every(e => [36, 38, 39, 42, 46, 45, 50, 37, 56, 70].includes(e.d1)));
  assert.ok(ons.some(e => e.d2 === 127) && ons.some(e => e.d2 === 56));
  assert.strictEqual(m.ev[m.ev.length - 1].meta, 0x2F);
  assert.strictEqual(m.ev[m.ev.length - 1].tick, 2 * 16 * 24, 'end of track at 2 bars');
});
test('MIDI 6/8 time signature for 12-step patterns', () => {
  const s = RA.defaultState(); s.patterns.A = RA.patternFromPreset('chaabi');
  const m = parseMIDI(RA.encodeMIDI(s, 1));
  const ts = m.ev.find(e => e.meta === 0x58).data;
  assert.deepStrictEqual([ts[0], ts[1]], [6, 3]);
});
test('normalizeState sanitizes input and rejects garbage', () => {
  assert.throws(() => RA.normalizeState(null));
  assert.throws(() => RA.normalizeState({ foo: 1 }));
  const s = RA.normalizeState({ bpm: 999, swing: -5, patterns: { A: { length: 7, grid: { kick: [9, 1, 'x'], snare: 'x.X.' } } }, kit: { kick: { vol: 5, tune: 40 } } });
  assert.strictEqual(s.bpm, 240); assert.strictEqual(s.swing, 0);
  assert.strictEqual(s.patterns.A.length, 16);
  assert.deepStrictEqual(s.patterns.A.grid.kick.slice(0, 3), [3, 1, 0]);
  assert.deepStrictEqual(s.patterns.A.grid.snare.slice(0, 4), [2, 0, 3, 0]);
  assert.strictEqual(s.kit.kick.vol, 1); assert.strictEqual(s.kit.kick.tune, 12);
  const round = RA.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(round, s);
});
test('randomizer is deterministic with a seed and respects length', () => {
  const a = RA.randomizePattern(RA.emptyPattern(16), 42), b = RA.randomizePattern(RA.emptyPattern(16), 42);
  assert.deepStrictEqual(a, b);
  assert.ok(!RA.isPatternEmpty(a));
  assert.strictEqual(a.grid.kick[0] > 0, true);
  assert.ok(a.grid.kick.slice(16).every(v => v === 0));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
