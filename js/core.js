/*
 * Rythme Atelier — core.js
 * Pure, DOM-free logic: track list, state model, presets, timing (swing),
 * event list computation, WAV encoder, Standard MIDI File writer, JSON
 * validation and randomizer. Works in the browser (window.RA) and in Node
 * (module.exports) so it can be unit-tested without a browser.
 *
 * Step values: 0 = off, 1 = soft, 2 = normal, 3 = accent.
 * A step is always a 16th note; a pattern has 12, 16, 24 or 32 steps
 * (12/24 = one/two bars of 6/8, 16/32 = one/two bars of 4/4).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Maximum steps stored per track (shorter patterns keep hidden data). */
  var MAX_STEPS = 32;
  var LENGTHS = [12, 16, 24, 32];
  var BANKS = ['A', 'B', 'C', 'D'];

  /** Voices, in display order. `gm` = General MIDI drum note (channel 10). */
  var TRACKS = [
    { id: 'kick',    gm: 36, key: '1' }, // Bass Drum 1
    { id: 'snare',   gm: 38, key: '2' }, // Acoustic Snare
    { id: 'clap',    gm: 39, key: '3' }, // Hand Clap
    { id: 'chh',     gm: 42, key: '4' }, // Closed Hi-Hat
    { id: 'ohh',     gm: 46, key: '5' }, // Open Hi-Hat
    { id: 'tomlow',  gm: 45, key: '6' }, // Low Tom
    { id: 'tomhigh', gm: 50, key: '7' }, // High Tom
    { id: 'rim',     gm: 37, key: '8' }, // Side Stick
    { id: 'cowbell', gm: 56, key: '9' }, // Cowbell
    { id: 'shaker',  gm: 70, key: '0' }  // Maracas (GM level 1 shaker)
  ];
  var TRACK_IDS = TRACKS.map(function (t) { return t.id; });

  /** Gain multiplier for each velocity level. */
  var VEL_GAIN = [0, 0.42, 0.78, 1.0];
  /** MIDI velocity for each level. */
  var VEL_MIDI = [0, 56, 96, 127];

  function clamp(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return Math.min(hi, Math.max(lo, v)); }

  function emptyGrid() {
    var g = {};
    TRACK_IDS.forEach(function (id) { g[id] = new Array(MAX_STEPS).fill(0); });
    return g;
  }
  function emptyPattern(len) { return { length: len || 16, grid: emptyGrid() }; }

  function defaultKit() {
    var k = {};
    TRACK_IDS.forEach(function (id) {
      k[id] = { vol: 0.8, pan: 0, tune: 0, decay: 1, mute: false, solo: false };
    });
    // Gentle default balance.
    k.chh.vol = 0.6; k.ohh.vol = 0.55; k.shaker.vol = 0.5; k.cowbell.vol = 0.55;
    k.chh.pan = 0.15; k.ohh.pan = 0.15; k.shaker.pan = -0.25; k.tomhigh.pan = 0.3; k.tomlow.pan = -0.3;
    return k;
  }

  function defaultState() {
    var s = { app: 'rythme-atelier', version: 1, bpm: 120, swing: 0, master: 0.8,
      bank: 'A', chain: false, kit: defaultKit(), patterns: {} };
    BANKS.forEach(function (b) { s.patterns[b] = emptyPattern(16); });
    return s;
  }

  /* ---------------------------------------------------------------------
   * Presets — original grooves written for this project, in a compact
   * text notation: '.' off, 'o' soft, 'x' normal, 'X' accent.
   * ------------------------------------------------------------------- */
  var PRESETS = {
    house: { bpm: 124, swing: 8, length: 16, rows: {
      kick:  'X...X...X...X...',
      clap:  '....x.......x...',
      chh:   'x.o.x.o.x.o.x.oo',
      ohh:   '..x...x...x...x.',
      shaker:'.o.o.o.o.o.o.oxo',
      rim:   '.......o......o.' } },
    techno: { bpm: 132, swing: 0, length: 16, rows: {
      kick:  'X...X...X...X...',
      snare: '....o.......o..o',
      chh:   'xoxoxoxoxoxoxoxo',
      ohh:   '..X...X...X...X.',
      rim:   '..o..o....o..o..',
      tomlow:'...........o..o.' } },
    hiphop: { bpm: 90, swing: 28, length: 16, rows: {
      kick:  'X.....x...X..o..',
      snare: '....X.......X...',
      chh:   'x.x.x.x.x.xox.x.',
      ohh:   '..............x.',
      rim:   '.......o........',
      shaker:'...o.......o....' } },
    trap: { bpm: 140, swing: 0, length: 32, rows: {
      kick:  'X......x..x.....X.....x...o.x...',
      snare: '........X...............X.......',
      clap:  '........x...............x.......',
      chh:   'x.x.x.x.xxx.x.x.x.x.x.x.x.xxxxXx',
      ohh:   '..............x...........x.....',
      tomlow:'.............................x.x',
      rim:   '.....o..............o..........o' } },
    rock: { bpm: 112, swing: 0, length: 16, rows: {
      kick:  'X.....x.X.x.....',
      snare: '....X.......X..o',
      chh:   'X.x.X.x.X.x.X.x.',
      ohh:   '..............x.',
      tomhigh:'............o.o.',
      tomlow:'..............x.' } },
    reggae: { bpm: 76, swing: 18, length: 16, rows: {
      kick:  '........X.......',
      rim:   '........X.......',
      chh:   'x.ox.ox.x.ox.ox.',
      ohh:   '......x.......x.',
      shaker:'.o.o.o.o.o.o.o.o',
      cowbell:'..o.......o.....' } },
    chaabi: { bpm: 112, swing: 10, length: 12, rows: {
      // 6/8 feel: doum (low tom) / tek (rim, high tom), clap on the off-pulses.
      tomlow: 'X.....x..x..',
      tomhigh:'...x..o....o',
      rim:    '..x.x...x.x.',
      clap:   '......X.....',
      shaker: 'xoxoxoxoxoxo',
      kick:   'X.....x.....' } },
    funk: { bpm: 102, swing: 14, length: 16, rows: {
      kick:  'X.x.......x..x..',
      snare: '....X..o.o..X..o',
      chh:   'xxXxxxXxxxXxxxXx',
      ohh:   '.............x..',
      cowbell:'X.......X.......',
      clap:  '............o...' } }
  };
  var PRESET_IDS = Object.keys(PRESETS);

  var CH = { '.': 0, '-': 0, 'o': 1, 'x': 2, 'X': 3 };

  /** Build a pattern object from a preset id. */
  function patternFromPreset(id) {
    var p = PRESETS[id]; if (!p) return null;
    var pat = emptyPattern(p.length);
    Object.keys(p.rows).forEach(function (tid) {
      var row = p.rows[tid];
      for (var i = 0; i < row.length && i < MAX_STEPS; i++) pat.grid[tid][i] = CH[row[i]] || 0;
    });
    return pat;
  }

  function clonePattern(p) {
    var c = { length: p.length, grid: {} };
    TRACK_IDS.forEach(function (id) { c.grid[id] = p.grid[id].slice(); });
    return c;
  }
  function isPatternEmpty(p) {
    return TRACK_IDS.every(function (id) {
      for (var i = 0; i < p.length; i++) if (p.grid[id][i]) return false;
      return true;
    });
  }

  /** Change a pattern's length; when growing into an empty area, repeat the existing bar(s). */
  function setPatternLength(p, len) {
    len = LENGTHS.indexOf(len) >= 0 ? len : 16;
    var old = p.length;
    if (len > old) {
      var revealedEmpty = TRACK_IDS.every(function (id) {
        for (var i = old; i < len; i++) if (p.grid[id][i]) return false;
        return true;
      });
      if (revealedEmpty) TRACK_IDS.forEach(function (id) {
        for (var i = old; i < len; i++) p.grid[id][i] = p.grid[id][i % old];
      });
    }
    p.length = len;
    return p;
  }

  /* ---------------------------------------------------------------------
   * Randomizer — seeded PRNG + per-voice probability profiles so that the
   * result stays musical (kicks near downbeats, snares on backbeats…).
   * ------------------------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Probabilities by position inside a 4-step beat: [on-beat, e, and, a].
  var RAND_PROFILE = {
    kick:    [0.75, 0.05, 0.25, 0.12],
    snare:   [0.1, 0.06, 0.08, 0.1],
    clap:    [0.05, 0.03, 0.05, 0.05],
    chh:     [0.85, 0.35, 0.8, 0.35],
    ohh:     [0.02, 0.03, 0.3, 0.04],
    tomlow:  [0.06, 0.04, 0.06, 0.08],
    tomhigh: [0.04, 0.05, 0.05, 0.08],
    rim:     [0.05, 0.1, 0.06, 0.12],
    cowbell: [0.08, 0.02, 0.06, 0.03],
    shaker:  [0.25, 0.5, 0.25, 0.5]
  };
  function randomizePattern(p, seed) {
    var rnd = mulberry32(seed == null ? (Date.now() & 0xffffffff) : seed);
    var len = p.length;
    TRACK_IDS.forEach(function (id) {
      var prof = RAND_PROFILE[id];
      for (var i = 0; i < MAX_STEPS; i++) {
        var pos = i % 4, beat = Math.floor(i / 4) % 4, v = 0;
        var pr = prof[pos];
        if (id === 'snare' || id === 'clap') { if (pos === 0 && (beat === 1 || beat === 3)) pr = id === 'snare' ? 0.92 : 0.45; }
        if (id === 'kick' && i % 16 === 0) pr = 1;
        if (i < len && rnd() < pr) {
          var r = rnd();
          v = r < 0.2 ? 1 : (r < 0.85 ? 2 : 3);
          if (pos === 0 && v === 1) v = 2;
        }
        p.grid[id][i] = v;
      }
    });
    // Avoid closed + open hat on the same step (open hat would be choked).
    for (var j = 0; j < len; j++) if (p.grid.ohh[j]) p.grid.chh[j] = 0;
    return p;
  }

  /* ---------------------------------------------------------------------
   * Timing
   * ------------------------------------------------------------------- */
  function stepDuration(bpm) { return 60 / clamp(bpm, 40, 240) / 4; }
  /** Swing 0..100 %: odd 16ths are delayed by up to half a step (≈66 % ≈ triplet shuffle). */
  function swingOffset(stepIndex, bpm, swing) {
    return (stepIndex % 2 === 1) ? stepDuration(bpm) * 0.5 * clamp(swing, 0, 100) / 100 : 0;
  }

  /** Is a track audible given mute/solo states? */
  function audible(kit, id) {
    var anySolo = TRACK_IDS.some(function (t) { return kit[t].solo; });
    if (anySolo) return !!kit[id].solo;
    return !kit[id].mute;
  }

  /** Order of banks played: just the current one, or every non-empty bank (chain). */
  function playOrder(state) {
    if (!state.chain) return [state.bank];
    var list = BANKS.filter(function (b) { return !isPatternEmpty(state.patterns[b]); });
    return list.length ? list : [state.bank];
  }

  /**
   * Compute every note event for `loops` repetitions of the play order.
   * Returns { events: [{t, track, vel, bank, step}], duration } (seconds).
   */
  function computeEvents(state, loops) {
    var order = playOrder(state), sd = stepDuration(state.bpm), t0 = 0, ev = [];
    for (var l = 0; l < loops; l++) {
      order.forEach(function (b) {
        var p = state.patterns[b];
        for (var i = 0; i < p.length; i++) {
          var t = t0 + i * sd + swingOffset(i, state.bpm, state.swing);
          TRACK_IDS.forEach(function (id) {
            var v = p.grid[id][i];
            if (v && audible(state.kit, id)) ev.push({ t: t, track: id, vel: v, bank: b, step: i });
          });
        }
        t0 += p.length * sd;
      });
    }
    return { events: ev, duration: t0 };
  }

  /* ---------------------------------------------------------------------
   * WAV encoder (16-bit PCM, interleaved)
   * ------------------------------------------------------------------- */
  function encodeWAV(channels, sampleRate) {
    var nCh = channels.length, len = channels[0].length;
    var dataBytes = len * nCh * 2, buf = new ArrayBuffer(44 + dataBytes), dv = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nCh * 2, true);
    dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, dataBytes, true);
    var o = 44;
    for (var i = 0; i < len; i++) for (var c = 0; c < nCh; c++) {
      var s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
    }
    return new Uint8Array(buf);
  }

  /* ---------------------------------------------------------------------
   * Standard MIDI File (format 0, one track, GM drums on channel 10)
   * ------------------------------------------------------------------- */
  var PPQ = 96, TICKS_PER_STEP = PPQ / 4;
  function vlq(n) {
    var bytes = [n & 0x7f]; n >>>= 7;
    while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>>= 7; }
    return bytes;
  }
  function encodeMIDI(state, loops) {
    var order = playOrder(state), raw = [], tick0 = 0;
    for (var l = 0; l < loops; l++) {
      order.forEach(function (b) {
        var p = state.patterns[b];
        for (var i = 0; i < p.length; i++) {
          var sw = (i % 2 === 1) ? Math.round(TICKS_PER_STEP * 0.5 * clamp(state.swing, 0, 100) / 100) : 0;
          var tk = tick0 + i * TICKS_PER_STEP + sw;
          TRACKS.forEach(function (tr) {
            var v = p.grid[tr.id][i];
            if (!v || !audible(state.kit, tr.id)) return;
            raw.push({ tick: tk, data: [0x99, tr.gm, VEL_MIDI[v]], ord: 1 });
            raw.push({ tick: tk + TICKS_PER_STEP / 2, data: [0x89, tr.gm, 0], ord: 0 });
          });
        }
        tick0 += p.length * TICKS_PER_STEP;
      });
    }
    // Note-offs first at equal ticks so retriggers stay clean.
    raw.sort(function (a, b) { return a.tick - b.tick || a.ord - b.ord; });
    var first = state.patterns[order[0]];
    var sixEight = first.length % 12 === 0 && first.length !== 0 && first.length % 16 !== 0;
    var tempo = Math.round(60000000 / clamp(state.bpm, 40, 240));
    var trk = [];
    function push(delta, bytes) { trk.push.apply(trk, vlq(delta).concat(bytes)); }
    var name = 'Rythme Atelier';
    push(0, [0xFF, 0x03, name.length].concat(name.split('').map(function (c) { return c.charCodeAt(0); })));
    push(0, [0xFF, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]);
    push(0, sixEight ? [0xFF, 0x58, 0x04, 6, 3, 12, 8] : [0xFF, 0x58, 0x04, 4, 2, 24, 8]);
    var last = 0;
    raw.forEach(function (e) { push(e.tick - last, e.data); last = e.tick; });
    push(Math.max(0, tick0 - last), [0xFF, 0x2F, 0x00]);
    var head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
    var L = trk.length;
    var chunk = [0x4D, 0x54, 0x72, 0x6B, (L >>> 24) & 0xff, (L >>> 16) & 0xff, (L >>> 8) & 0xff, L & 0xff];
    return new Uint8Array(head.concat(chunk, trk));
  }

  /* ---------------------------------------------------------------------
   * JSON import validation — never trust the file, rebuild a clean state.
   * ------------------------------------------------------------------- */
  function normalizeState(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('invalid');
    if (!obj.patterns || typeof obj.patterns !== 'object') throw new Error('invalid');
    var s = defaultState();
    s.bpm = Math.round(clamp(obj.bpm == null ? 120 : obj.bpm, 40, 240));
    s.swing = Math.round(clamp(obj.swing || 0, 0, 100));
    s.master = clamp(obj.master == null ? 0.8 : obj.master, 0, 1);
    s.bank = BANKS.indexOf(obj.bank) >= 0 ? obj.bank : 'A';
    s.chain = !!obj.chain;
    if (obj.kit && typeof obj.kit === 'object') TRACK_IDS.forEach(function (id) {
      var k = obj.kit[id]; if (!k || typeof k !== 'object') return;
      s.kit[id] = {
        vol: clamp(k.vol == null ? 0.8 : k.vol, 0, 1), pan: clamp(k.pan || 0, -1, 1),
        tune: Math.round(clamp(k.tune || 0, -12, 12)), decay: clamp(k.decay == null ? 1 : k.decay, 0.2, 3),
        mute: !!k.mute, solo: !!k.solo };
    });
    var found = 0;
    BANKS.forEach(function (b) {
      var p = obj.patterns[b]; if (!p || typeof p !== 'object') return;
      found++;
      var pat = emptyPattern(LENGTHS.indexOf(Number(p.length)) >= 0 ? Number(p.length) : 16);
      if (p.grid && typeof p.grid === 'object') TRACK_IDS.forEach(function (id) {
        var row = p.grid[id];
        if (typeof row === 'string') row = row.split('').map(function (c) { return CH[c] || 0; });
        if (!Array.isArray(row)) return;
        for (var i = 0; i < MAX_STEPS && i < row.length; i++) pat.grid[id][i] = Math.round(clamp(row[i] || 0, 0, 3));
      });
      s.patterns[b] = pat;
    });
    if (!found) throw new Error('invalid');
    return s;
  }

  return {
    MAX_STEPS: MAX_STEPS, LENGTHS: LENGTHS, BANKS: BANKS, TRACKS: TRACKS, TRACK_IDS: TRACK_IDS,
    VEL_GAIN: VEL_GAIN, VEL_MIDI: VEL_MIDI, PRESETS: PRESETS, PRESET_IDS: PRESET_IDS,
    clamp: clamp, emptyPattern: emptyPattern, defaultKit: defaultKit, defaultState: defaultState,
    patternFromPreset: patternFromPreset, clonePattern: clonePattern, isPatternEmpty: isPatternEmpty,
    setPatternLength: setPatternLength, randomizePattern: randomizePattern, mulberry32: mulberry32,
    stepDuration: stepDuration, swingOffset: swingOffset, audible: audible, playOrder: playOrder,
    computeEvents: computeEvents, encodeWAV: encodeWAV, encodeMIDI: encodeMIDI, PPQ: PPQ,
    normalizeState: normalizeState
  };
});
