/*
 * Rythme Atelier — synth.js
 * Every drum sound is synthesized from oscillators and noise with the Web
 * Audio API (no samples). The same functions drive the live AudioContext
 * and the OfflineAudioContext used for WAV export, so both sound identical.
 *
 * Envelopes use setTargetAtTime (exponential approach) so that a closed
 * hi-hat can "choke" a ringing open hi-hat at any moment.
 */
(function (root) {
  'use strict';
  var RA = root.RA;

  // One white-noise buffer per context (WeakMap keeps things garbage-collectable).
  var noiseCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function noiseBuffer(ctx) {
    var b = noiseCache && noiseCache.get(ctx);
    if (b) return b;
    var len = ctx.sampleRate; // 1 second
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = b.getChannelData(0), seed = 22222;
    for (var i = 0; i < len; i++) { // tiny LCG: deterministic noise for reproducible renders
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = seed / 0x3fffffff - 1;
    }
    if (noiseCache) noiseCache.set(ctx, b);
    return b;
  }
  function noise(ctx, t, dur) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx); s.loop = true;
    s.start(t, (t * 7.31) % 0.9); s.stop(t + dur);
    return s;
  }
  function osc(ctx, type, freq, t, dur) {
    var o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    o.start(t); o.stop(t + dur); return o;
  }
  function filter(ctx, type, freq, q) {
    var f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q; return f;
  }
  /** Gain envelope: fast attack to `peak`, then exponential decay with time-constant `tc`. */
  function env(ctx, t, peak, attack, tc) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, tc);
    return g;
  }
  function chain() { for (var i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]); return arguments[arguments.length - 1]; }

  /** Six detuned square waves — the classic "metallic" hi-hat / cymbal source. */
  function metal(ctx, t, dur, r) {
    var sum = ctx.createGain(); sum.gain.value = 0.4;
    [2, 3, 4.16, 5.43, 6.79, 8.21].forEach(function (k) { osc(ctx, 'square', 40 * k * r, t, dur).connect(sum); });
    return sum;
  }

  // Open hi-hat currently ringing, per context (for choke).
  var ringing = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  var VOICES = {
    kick: function (ctx, out, t, v, r, d) {
      var len = 0.5 * d, o = osc(ctx, 'sine', 165 * r, t, len * 1.6 + 0.05);
      o.frequency.exponentialRampToValueAtTime(52 * r, t + 0.08);
      o.frequency.setTargetAtTime(42 * r, t + 0.08, 0.18);
      chain(o, env(ctx, t, 0.95 * v, 0.002, len / 4.5), out);
      // Beater click
      chain(noise(ctx, t, 0.03), filter(ctx, 'highpass', 2800), env(ctx, t, 0.22 * v, 0.001, 0.004), out);
    },
    snare: function (ctx, out, t, v, r, d) {
      var o = osc(ctx, 'triangle', 200 * r, t, 0.3);
      o.frequency.exponentialRampToValueAtTime(150 * r, t + 0.05);
      chain(o, env(ctx, t, 0.55 * v, 0.001, 0.035 * d), out);
      chain(noise(ctx, t, 0.5 * d + 0.05), filter(ctx, 'highpass', 1300 * r), filter(ctx, 'peaking', 4200, 1),
        env(ctx, t, 0.6 * v, 0.001, 0.055 * d), out);
    },
    clap: function (ctx, out, t, v, r, d) {
      var g = ctx.createGain(), dur = 0.6 * d + 0.1;
      g.gain.setValueAtTime(0, t);
      for (var k = 0; k < 3; k++) { // three quick hand slaps…
        g.gain.setValueAtTime(1.4 * v, t + k * 0.011);
        g.gain.setTargetAtTime(0.04, t + k * 0.011 + 0.001, 0.0035);
      }
      g.gain.setValueAtTime(1.4 * v, t + 0.034); // …then the room tail
      g.gain.setTargetAtTime(0, t + 0.035, 0.065 * d);
      chain(noise(ctx, t, dur), filter(ctx, 'bandpass', 1150 * r, 0.9), filter(ctx, 'highpass', 600), g, out);
    },
    chh: function (ctx, out, t, v, r, d) {
      var prev = ringing && ringing.get(ctx);
      if (prev && prev.end > t) { prev.g.gain.cancelScheduledValues(t); prev.g.gain.setTargetAtTime(0, t, 0.006); prev.end = t; }
      var dur = 0.25 * d + 0.05, g = env(ctx, t, 1.0 * v, 0.001, 0.016 * d);
      var bp = filter(ctx, 'bandpass', 10000, 0.8), hp = filter(ctx, 'highpass', 7000 * Math.min(r, 1.3));
      metal(ctx, t, dur, r).connect(bp);
      chain(noise(ctx, t, dur), filter(ctx, 'highpass', 8000), ctx.createGain()).connect(bp);
      chain(bp, hp, g, out);
    },
    ohh: function (ctx, out, t, v, r, d) {
      var dur = 1.4 * d + 0.1, g = env(ctx, t, 1.2 * v, 0.002, 0.11 * d);
      var bp = filter(ctx, 'bandpass', 9500, 0.7), hp = filter(ctx, 'highpass', 6500 * Math.min(r, 1.3));
      metal(ctx, t, dur, r).connect(bp);
      var n = chain(noise(ctx, t, dur), ctx.createGain()); n.gain.value = 0.4; n.connect(bp);
      chain(bp, hp, g, out);
      if (ringing) ringing.set(ctx, { g: g, end: t + dur });
    },
    tomlow: function (ctx, out, t, v, r, d) { tom(ctx, out, t, v, 98 * r, d); },
    tomhigh: function (ctx, out, t, v, r, d) { tom(ctx, out, t, v, 168 * r, d); },
    rim: function (ctx, out, t, v, r, d) {
      chain(osc(ctx, 'triangle', 1700 * r, t, 0.1), filter(ctx, 'highpass', 500), env(ctx, t, 0.7 * v, 0.0005, 0.009 * d), out);
      chain(osc(ctx, 'square', 480 * r, t, 0.1), filter(ctx, 'bandpass', 900, 2), env(ctx, t, 0.3 * v, 0.0005, 0.007 * d), out);
      chain(noise(ctx, t, 0.05), filter(ctx, 'highpass', 3000), env(ctx, t, 0.25 * v, 0.0005, 0.004), out);
    },
    cowbell: function (ctx, out, t, v, r, d) {
      var dur = 0.7 * d + 0.05, sum = ctx.createGain(); sum.gain.value = 1.1;
      osc(ctx, 'square', 545 * r, t, dur).connect(sum);
      osc(ctx, 'square', 815 * r, t, dur).connect(sum);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * v, t + 0.001);
      g.gain.setTargetAtTime(0.15 * v, t + 0.001, 0.012);         // sharp strike…
      g.gain.setTargetAtTime(0, t + 0.03, 0.09 * d);               // …then ring
      chain(sum, filter(ctx, 'bandpass', 800 * r, 1.4), g, out);
    },
    shaker: function (ctx, out, t, v, r, d) {
      chain(noise(ctx, t, 0.3 * d + 0.05), filter(ctx, 'highpass', 4500 * r), filter(ctx, 'peaking', 8500, 2),
        env(ctx, t, 0.75 * v, 0.014, 0.028 * d), out);
    }
  };
  function tom(ctx, out, t, v, f, d) {
    var len = 0.5 * d, o = osc(ctx, 'sine', f * 1.35, t, len * 1.6 + 0.05);
    o.frequency.setTargetAtTime(f, t, 0.03);
    chain(o, env(ctx, t, 0.9 * v, 0.002, len / 4.5), out);
    chain(noise(ctx, t, 0.05), filter(ctx, 'lowpass', 2500), env(ctx, t, 0.12 * v, 0.001, 0.008), out);
  }

  /**
   * Build the mixing graph: per-track gain → stereo pan → master gain →
   * soft clipper → destination. Optionally an analyser for the meter.
   */
  function createMixer(ctx, state, withAnalyser) {
    var master = ctx.createGain(); master.gain.value = state.master;
    // Stateless soft clipper (tanh) instead of a compressor: no gain "pumping"
    // and the first hit of a render is exactly as loud as the others.
    var pre = ctx.createGain(); pre.gain.value = 0.5;
    var comp = ctx.createWaveShaper(), n = 2048, curve = new Float32Array(n), k = Math.tanh(2);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(2 * x) / k; }
    comp.curve = curve; comp.oversample = '2x';
    master.connect(pre); pre.connect(comp); comp.connect(ctx.destination);
    var analyser = null;
    if (withAnalyser) { analyser = ctx.createAnalyser(); analyser.fftSize = 512; comp.connect(analyser); }
    var ch = {};
    RA.TRACK_IDS.forEach(function (id) {
      var g = ctx.createGain(), p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { g.connect(p); p.connect(master); } else g.connect(master);
      ch[id] = { gain: g, pan: p };
    });
    var mx = {
      master: master, analyser: analyser, ch: ch,
      /** Apply kit volumes/pans + master volume (smoothly when live). */
      apply: function (st) {
        var now = ctx.currentTime;
        master.gain.setTargetAtTime(st.master, now, 0.01);
        RA.TRACK_IDS.forEach(function (id) {
          ch[id].gain.gain.setTargetAtTime(st.kit[id].vol, now, 0.01);
          if (ch[id].pan) ch[id].pan.pan.setTargetAtTime(st.kit[id].pan, now, 0.01);
        });
      }
    };
    // Initial values set directly (no ramp) so offline renders start right.
    RA.TRACK_IDS.forEach(function (id) {
      ch[id].gain.gain.value = state.kit[id].vol;
      if (ch[id].pan) ch[id].pan.pan.value = state.kit[id].pan;
    });
    return mx;
  }

  /** Play one hit. `level` is a velocity level 1–3. */
  function trigger(ctx, mixer, id, t, level, kitParams) {
    var fn = VOICES[id]; if (!fn) return;
    var r = Math.pow(2, (kitParams.tune || 0) / 12);
    fn(ctx, mixer.ch[id].gain, Math.max(t, ctx.currentTime), RA.VEL_GAIN[level] || 0, r, kitParams.decay || 1);
  }

  /** Render `loops` repetitions to an AudioBuffer with an OfflineAudioContext. */
  function renderOffline(state, loops, sampleRate) {
    sampleRate = sampleRate || 44100;
    var res = RA.computeEvents(state, loops), tail = 1.5;
    var Off = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    var ctx = new Off(2, Math.ceil((res.duration + tail) * sampleRate), sampleRate);
    var mx = createMixer(ctx, state, false);
    res.events.forEach(function (e) { trigger(ctx, mx, e.track, e.t + 0.005, e.vel, state.kit[e.track]); });
    return ctx.startRendering();
  }

  root.RASynth = { VOICES: VOICES, createMixer: createMixer, trigger: trigger, renderOffline: renderOffline };
})(typeof self !== 'undefined' ? self : this);
