/*
 * Rythme Atelier — app.js
 * User interface, lookahead audio scheduler, autosave, exports.
 *
 * Scheduling: a light timer (Web Worker, fallback setTimeout) only wakes us
 * up every 25 ms; the actual note times are computed on the AudioContext
 * clock and scheduled ~120 ms ahead ("two clocks" technique), so timing stays
 * sample-accurate even if the main thread is busy.
 */
(function () {
  'use strict';
  var RA = window.RA, SY = window.RASynth, I18N = window.RAI18N;
  var $ = function (id) { return document.getElementById(id); };
  var STORE_KEY = 'rythme-atelier:state:v1', LANG_KEY = 'rythme-atelier:lang';
  var LOOKAHEAD = 0.12, TICK_MS = 25;

  /* ------------------------------------------------------------------ state */
  var S = loadState();
  var lang = (function () { try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; } })() || 'fr';
  if (!I18N.STR[lang]) lang = 'fr';
  var brush = 2, selTrack = 'kick', clipboard = null, history = [];
  var focusPos = { r: 0, c: 0 };

  function initialState() {
    var s = RA.defaultState();
    s.patterns.A = RA.patternFromPreset('house');
    s.patterns.B = RA.patternFromPreset('funk');
    s.patterns.C = RA.patternFromPreset('chaabi');
    s.bpm = RA.PRESETS.house.bpm; s.swing = RA.PRESETS.house.swing;
    return s;
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return RA.normalizeState(JSON.parse(raw));
    } catch (e) { /* corrupted save: start fresh */ }
    return initialState();
  }
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* quota / private mode */ }
    }, 250);
  }
  function snapshot() { return JSON.stringify(S); }
  function pushHistory() { history.push(snapshot()); if (history.length > 60) history.shift(); }
  function undo() {
    if (!history.length) return toast(t('tNothing'));
    S = RA.normalizeState(JSON.parse(history.pop()));
    if (mixer) mixer.apply(S);
    renderAll(); save(); toast(t('tUndo'));
  }
  function pat() { return S.patterns[S.bank]; }

  /* ------------------------------------------------------------------ i18n */
  function t(k) { var v = I18N.STR[lang][k]; return v == null ? (I18N.STR.fr[k] || k) : v; }
  function trackName(id) { return I18N.STR[lang].tracks[id]; }
  function velName(v) { return [t('velOff'), t('velSoft'), t('velNormal'), t('velAccent')][v]; }
  function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.title = t(el.getAttribute('data-i18n-title')); });
    var ps = $('presetSel'), cur = ps.value;
    ps.innerHTML = '';
    RA.PRESET_IDS.forEach(function (id) {
      var o = document.createElement('option'); o.value = id; o.textContent = I18N.STR[lang].presets[id]; ps.appendChild(o);
    });
    if (cur) ps.value = cur;
    updatePlayButton();
  }

  /* ------------------------------------------------------------------ audio */
  var ctx = null, mixer = null;
  function ensureAudio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { toast(t('tAudioErr')); return null; }
      ctx = new AC({ latencyHint: 'interactive' });
      mixer = SY.createMixer(ctx, S, true);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function audition(id, level) {
    if (!ensureAudio()) return;
    SY.trigger(ctx, mixer, id, ctx.currentTime + 0.005, level || 2, S.kit[id]);
  }

  /* ------------------------------------------------------------ scheduler */
  var playing = false, nextTime = 0, stepIdx = 0, playBank = 'A', visQueue = [], curStep = -1, ticker = null;

  function makeTicker() {
    // A Worker timer keeps ticking when the tab is in the background.
    try {
      var src = 'var h=null;onmessage=function(e){if(e.data==="start"){clearInterval(h);h=setInterval(function(){postMessage(0)},' + TICK_MS + ')}else{clearInterval(h);h=null}}';
      var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = schedule;
      return { start: function () { w.postMessage('start'); }, stop: function () { w.postMessage('stop'); } };
    } catch (e) {
      var h = null;
      return { start: function () { clearInterval(h); h = setInterval(schedule, TICK_MS); }, stop: function () { clearInterval(h); } };
    }
  }

  function schedule() {
    if (!playing) return;
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      var p = S.patterns[playBank];
      if (stepIdx >= p.length) stepIdx = 0;
      var tt = nextTime + RA.swingOffset(stepIdx, S.bpm, S.swing);
      for (var k = 0; k < RA.TRACK_IDS.length; k++) {
        var id = RA.TRACK_IDS[k], v = p.grid[id][stepIdx];
        if (v && RA.audible(S.kit, id)) SY.trigger(ctx, mixer, id, tt, v, S.kit[id]);
      }
      visQueue.push({ t: tt, step: stepIdx, bank: playBank });
      nextTime += RA.stepDuration(S.bpm);
      stepIdx++;
      if (stepIdx >= p.length) {           // end of pattern
        stepIdx = 0;
        if (S.chain) {
          var order = RA.playOrder(S), i = order.indexOf(playBank);
          playBank = order[(i + 1) % order.length] || order[0];
        } else playBank = S.bank;
      }
    }
  }

  function start() {
    if (!ensureAudio()) return;
    playing = true;
    stepIdx = 0; visQueue = [];
    playBank = S.chain ? RA.playOrder(S)[0] : S.bank;
    if (S.chain && playBank !== S.bank) { S.bank = playBank; renderBanks(); renderGrid(); }
    nextTime = ctx.currentTime + 0.06;
    schedule();
    if (!ticker) ticker = makeTicker();
    ticker.start();
    updatePlayButton();
  }
  function stop() {
    playing = false;
    if (ticker) ticker.stop();
    visQueue = []; setPlayhead(-1);
    updatePlayButton();
  }
  function togglePlay() { playing ? stop() : start(); }

  /* Animation loop: playhead follows the audio clock + output meter. */
  var meterBuf = null;
  function frame() {
    if (ctx && playing) {
      var now = ctx.currentTime, cur = null;
      while (visQueue.length && visQueue[0].t <= now) cur = visQueue.shift();
      if (cur) {
        if (cur.bank !== S.bank && S.chain) { S.bank = cur.bank; renderBanks(); renderGrid(); }
        setPlayhead(cur.bank === S.bank ? cur.step : -1);
      }
    }
    if (mixer && mixer.analyser) {
      if (!meterBuf) meterBuf = new Float32Array(mixer.analyser.fftSize);
      mixer.analyser.getFloatTimeDomainData(meterBuf);
      var peak = 0; for (var i = 0; i < meterBuf.length; i++) { var a = Math.abs(meterBuf[i]); if (a > peak) peak = a; }
      $('meterBar').style.transform = 'scaleX(' + Math.min(1, peak).toFixed(3) + ')';
      $('meterBar').classList.toggle('hot', peak > 0.95);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ grid */
  var cells = {};   // cells[trackId][step] -> button
  var cols = [];    // cols[step] -> header cell
  function groupSize(len) { return len % 3 === 0 && len % 16 !== 0 ? 6 : 4; }

  function renderGrid() {
    var g = $('grid'), p = pat(), len = p.length, gs = groupSize(len);
    g.innerHTML = ''; cells = {}; cols = [];
    g.style.setProperty('--steps', len);
    g.classList.toggle('long', len > 16);
    g.setAttribute('aria-rowcount', RA.TRACKS.length + 1);
    // Header row: step numbers
    var hr = document.createElement('div'); hr.className = 'row head'; hr.setAttribute('role', 'row');
    var corner = document.createElement('div'); corner.className = 'track-head'; corner.setAttribute('role', 'columnheader');
    corner.textContent = t('bank') + ' ' + S.bank + ' · ' + len;
    hr.appendChild(corner);
    var hs = document.createElement('div'); hs.className = 'steps';
    for (var i = 0; i < len; i++) {
      var h = document.createElement('div'); h.className = 'num' + (i % gs === 0 ? ' beat' : '');
      h.setAttribute('role', 'columnheader'); h.textContent = i + 1; hs.appendChild(h); cols.push(h);
    }
    hr.appendChild(hs); g.appendChild(hr);

    RA.TRACKS.forEach(function (tr, r) {
      var row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'row');
      row.dataset.track = tr.id; row.classList.add('c-' + tr.id);
      var th = document.createElement('div'); th.className = 'track-head'; th.setAttribute('role', 'rowheader');
      var nb = document.createElement('button'); nb.type = 'button'; nb.className = 'tname'; nb.dataset.select = tr.id;
      nb.innerHTML = '<span class="key" aria-hidden="true">' + tr.key + '</span><span class="label"></span><span class="short" aria-hidden="true"></span>';
      nb.querySelector('.label').textContent = trackName(tr.id);
      nb.querySelector('.short').textContent = I18N.STR[lang].tracksShort[tr.id];
      nb.title = trackName(tr.id);
      nb.setAttribute('aria-label', t('audition') + ' : ' + trackName(tr.id));
      var mb = document.createElement('button'); mb.type = 'button'; mb.className = 'ms mute'; mb.dataset.mute = tr.id;
      mb.textContent = t('muteShort'); mb.setAttribute('aria-label', t('mute') + ' — ' + trackName(tr.id));
      var sb = document.createElement('button'); sb.type = 'button'; sb.className = 'ms solo'; sb.dataset.solo = tr.id;
      sb.textContent = t('soloShort'); sb.setAttribute('aria-label', t('solo') + ' — ' + trackName(tr.id));
      th.appendChild(nb); th.appendChild(mb); th.appendChild(sb); row.appendChild(th);
      var steps = document.createElement('div'); steps.className = 'steps';
      cells[tr.id] = [];
      for (var i = 0; i < len; i++) {
        var c = document.createElement('button'); c.type = 'button';
        c.className = 'cell' + (i % gs === 0 ? ' beat' : '') + (Math.floor(i / gs) % 2 ? ' alt' : '');
        c.dataset.track = tr.id; c.dataset.step = i; c.dataset.r = r; c.dataset.c = i;
        c.setAttribute('role', 'gridcell'); c.tabIndex = -1;
        steps.appendChild(c); cells[tr.id].push(c);
        updateCell(tr.id, i);
      }
      row.appendChild(steps); g.appendChild(row);
    });
    if (focusPos.c >= len) focusPos.c = 0;
    var fc = cells[RA.TRACK_IDS[focusPos.r]][focusPos.c]; if (fc) fc.tabIndex = 0;
    updateTrackHeads();
    curStep = -1;
    $('length').value = String(len);
  }
  function updateCell(id, i) {
    var c = cells[id] && cells[id][i]; if (!c) return;
    var v = pat().grid[id][i];
    c.classList.remove('v1', 'v2', 'v3'); if (v) c.classList.add('v' + v);
    c.setAttribute('aria-pressed', v ? 'true' : 'false');
    c.setAttribute('aria-label', trackName(id) + ', ' + t('step') + ' ' + (i + 1) + ' : ' + velName(v));
  }
  function updateTrackHeads() {
    RA.TRACK_IDS.forEach(function (id) {
      var row = document.querySelector('.row[data-track="' + id + '"]'); if (!row) return;
      var k = S.kit[id];
      row.querySelector('.mute').setAttribute('aria-pressed', k.mute ? 'true' : 'false');
      row.querySelector('.solo').setAttribute('aria-pressed', k.solo ? 'true' : 'false');
      row.classList.toggle('silent', !RA.audible(S.kit, id));
      row.classList.toggle('selected', id === selTrack);
    });
  }
  function setPlayhead(step) {
    if (step === curStep) return;
    if (curStep >= 0 && cols[curStep]) {
      cols[curStep].classList.remove('ph');
      RA.TRACK_IDS.forEach(function (id) { var c = cells[id][curStep]; if (c) c.classList.remove('ph'); });
    }
    curStep = step;
    if (step >= 0 && cols[step]) {
      cols[step].classList.add('ph');
      RA.TRACK_IDS.forEach(function (id) { var c = cells[id][step]; if (c) c.classList.add('ph'); });
    }
  }

  function setStep(id, i, v) {
    var p = pat(); if (p.grid[id][i] === v) return;
    p.grid[id][i] = v; updateCell(id, i); save();
    if (v && !playing) audition(id, v);
  }
  function nextValueFor(id, i, cycle) {
    var v = pat().grid[id][i];
    if (cycle) return (v + 1) % 4;
    return v === brush ? 0 : brush;
  }

  // Grid interactions (event delegation)
  var painting = null, skipClick = false;
  function bindGrid() {
    var g = $('grid');
    g.addEventListener('pointerdown', function (e) {
      var c = e.target.closest('.cell');
      if (!c || e.pointerType !== 'mouse' || e.button !== 0) return;
      e.preventDefault();
      var id = c.dataset.track, i = +c.dataset.step;
      pushHistory();
      var v = nextValueFor(id, i, e.shiftKey);
      painting = v; setStep(id, i, v); skipClick = true; focusCell(+c.dataset.r, i, false);
    });
    g.addEventListener('pointerover', function (e) {
      if (painting == null) return;
      var c = e.target.closest('.cell'); if (c) setStep(c.dataset.track, +c.dataset.step, painting);
    });
    window.addEventListener('pointerup', function () { painting = null; setTimeout(function () { skipClick = false; }, 0); });
    g.addEventListener('click', function (e) {
      var c = e.target.closest('.cell');
      if (c) {
        if (skipClick) { skipClick = false; return; }
        pushHistory();
        setStep(c.dataset.track, +c.dataset.step, nextValueFor(c.dataset.track, +c.dataset.step, e.shiftKey));
        focusCell(+c.dataset.r, +c.dataset.step, false);
        return;
      }
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.select) { selectTrack(b.dataset.select); audition(b.dataset.select, 2); }
      else if (b.dataset.mute) toggleMute(b.dataset.mute);
      else if (b.dataset.solo) toggleSolo(b.dataset.solo);
    });
    g.addEventListener('contextmenu', function (e) {
      var c = e.target.closest('.cell'); if (!c) return;
      e.preventDefault(); pushHistory();
      setStep(c.dataset.track, +c.dataset.step, nextValueFor(c.dataset.track, +c.dataset.step, true));
    });
    g.addEventListener('keydown', function (e) {
      var c = e.target.closest('.cell'); if (!c) return;
      var r = +c.dataset.r, col = +c.dataset.c, len = pat().length, n = RA.TRACKS.length;
      var moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
      if (moves[e.key]) {
        e.preventDefault();
        focusCell((r + moves[e.key][0] + n) % n, (col + moves[e.key][1] + len) % len, true);
      } else if (e.key === 'Home') { e.preventDefault(); focusCell(r, 0, true); }
      else if (e.key === 'End') { e.preventDefault(); focusCell(r, len - 1, true); }
    });
  }
  function focusCell(r, c, move) {
    var old = cells[RA.TRACK_IDS[focusPos.r]] && cells[RA.TRACK_IDS[focusPos.r]][focusPos.c];
    if (old) old.tabIndex = -1;
    focusPos = { r: r, c: c };
    var el = cells[RA.TRACK_IDS[r]][c]; el.tabIndex = 0;
    if (move) el.focus();
    if (RA.TRACK_IDS[r] !== selTrack) selectTrack(RA.TRACK_IDS[r]);
  }

  /* ---------------------------------------------------- mute / solo / edit */
  function toggleMute(id) { S.kit[id].mute = !S.kit[id].mute; updateTrackHeads(); save(); }
  function toggleSolo(id) { S.kit[id].solo = !S.kit[id].solo; updateTrackHeads(); save(); }
  function selectTrack(id) { selTrack = id; updateTrackHeads(); renderEditor(); }

  function fmtPan(v) { v = +v; return Math.abs(v) < 0.025 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100); }
  function renderEditor() {
    var k = S.kit[selTrack];
    $('edName').textContent = trackName(selTrack);
    $('edVol').value = k.vol; $('edVolOut').textContent = Math.round(k.vol * 100) + ' %';
    $('edPan').value = k.pan; $('edPanOut').textContent = fmtPan(k.pan);
    $('edTune').value = k.tune; $('edTuneOut').textContent = (k.tune > 0 ? '+' : '') + k.tune;
    $('edDecay').value = k.decay; $('edDecayOut').textContent = '×' + (+k.decay).toFixed(2);
  }
  function bindEditor() {
    [['edVol', 'vol'], ['edPan', 'pan'], ['edTune', 'tune'], ['edDecay', 'decay']].forEach(function (pair) {
      $(pair[0]).addEventListener('input', function (e) {
        S.kit[selTrack][pair[1]] = +e.target.value;
        renderEditor(); if (mixer) mixer.apply(S); save();
      });
      $(pair[0]).addEventListener('change', function () { if (!playing && (pair[1] === 'tune' || pair[1] === 'decay')) audition(selTrack, 2); });
    });
    $('edListen').addEventListener('click', function () { audition(selTrack, 2); });
    $('edReset').addEventListener('click', function () {
      pushHistory();
      var d = RA.defaultKit()[selTrack];
      d.mute = S.kit[selTrack].mute; d.solo = S.kit[selTrack].solo;
      S.kit[selTrack] = d; renderEditor(); if (mixer) mixer.apply(S); save();
    });
  }

  /* ------------------------------------------------------------- transport */
  function setBpm(v) {
    S.bpm = Math.round(RA.clamp(v, 40, 240));
    $('bpm').value = S.bpm; $('bpmRange').value = S.bpm; save();
  }
  function renderTransport() {
    $('bpm').value = S.bpm; $('bpmRange').value = S.bpm;
    $('swing').value = S.swing; $('swingOut').textContent = S.swing + ' %';
    $('master').value = S.master; $('masterOut').textContent = Math.round(S.master * 100) + ' %';
    $('chain').checked = S.chain;
    $('length').value = String(pat().length);
  }
  function updatePlayButton() {
    var b = $('playBtn'); b.setAttribute('aria-pressed', playing ? 'true' : 'false');
    b.classList.toggle('on', playing);
    b.querySelector('.play-label').textContent = playing ? t('stop') : t('play');
    b.setAttribute('aria-label', t('playStop'));
  }
  function bindTransport() {
    $('playBtn').addEventListener('click', togglePlay);
    $('bpm').addEventListener('change', function (e) { setBpm(e.target.value); });
    $('bpmRange').addEventListener('input', function (e) { setBpm(e.target.value); });
    $('bpmDown').addEventListener('click', function () { setBpm(S.bpm - 1); });
    $('bpmUp').addEventListener('click', function () { setBpm(S.bpm + 1); });
    $('swing').addEventListener('input', function (e) { S.swing = +e.target.value; $('swingOut').textContent = S.swing + ' %'; save(); });
    $('master').addEventListener('input', function (e) {
      S.master = +e.target.value; $('masterOut').textContent = Math.round(S.master * 100) + ' %'; if (mixer) mixer.apply(S); save();
    });
    $('length').addEventListener('change', function (e) {
      pushHistory(); RA.setPatternLength(pat(), +e.target.value); renderGrid(); save();
    });
    $('chain').addEventListener('change', function (e) { S.chain = e.target.checked; save(); });
  }

  /* ------------------------------------------------------------ bank/tools */
  function renderBanks() {
    var wrap = $('banks'); wrap.innerHTML = '';
    RA.BANKS.forEach(function (b) {
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bank';
      btn.setAttribute('role', 'radio'); btn.setAttribute('aria-checked', b === S.bank ? 'true' : 'false');
      btn.setAttribute('aria-label', t('bank') + ' ' + b);
      btn.tabIndex = b === S.bank ? 0 : -1;
      btn.dataset.bank = b; btn.textContent = b;
      if (RA.isPatternEmpty(S.patterns[b])) btn.classList.add('empty');
      wrap.appendChild(btn);
    });
  }
  function selectBank(b) {
    if (RA.BANKS.indexOf(b) < 0) return;
    S.bank = b;
    if (playing) {            // jump playback to the chosen pattern (keeps the position in the bar)
      playBank = b; if (stepIdx >= pat().length) stepIdx = 0;
      visQueue = visQueue.filter(function (e) { return e.bank === b; });
    }
    renderBanks(); renderGrid(); renderTransport(); save();
  }
  function bindTools() {
    $('banks').addEventListener('click', function (e) { var b = e.target.closest('.bank'); if (b) selectBank(b.dataset.bank); });
    $('banks').addEventListener('keydown', function (e) {
      var i = RA.BANKS.indexOf(S.bank);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % 4;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i + 3) % 4;
      else return;
      e.preventDefault(); e.stopPropagation(); selectBank(RA.BANKS[i]);
      $('banks').querySelector('[data-bank="' + S.bank + '"]').focus();
    });
    $('copyBtn').addEventListener('click', function () { clipboard = RA.clonePattern(pat()); toast(t('tCopied') + ' (' + S.bank + ')'); });
    $('pasteBtn').addEventListener('click', function () {
      if (!clipboard) return toast(t('tNoClip'));
      pushHistory(); S.patterns[S.bank] = RA.clonePattern(clipboard); afterPatternChange(); toast(t('tPasted') + ' → ' + S.bank);
    });
    $('clearBtn').addEventListener('click', function () {
      pushHistory(); var len = pat().length; S.patterns[S.bank] = RA.emptyPattern(len); afterPatternChange(); toast(t('tCleared'));
    });
    $('randomBtn').addEventListener('click', function () {
      pushHistory(); RA.randomizePattern(pat()); afterPatternChange(); toast(t('tRandom'));
    });
    $('undoBtn').addEventListener('click', undo);
    $('presetBtn').addEventListener('click', function () {
      var id = $('presetSel').value, p = RA.patternFromPreset(id); if (!p) return;
      pushHistory(); S.patterns[S.bank] = p; S.bpm = RA.PRESETS[id].bpm; S.swing = RA.PRESETS[id].swing;
      afterPatternChange(); renderTransport(); toast(t('tPreset') + ' : ' + I18N.STR[lang].presets[id] + ' → ' + S.bank);
    });
    document.querySelectorAll('input[name="brush"]').forEach(function (r) {
      r.addEventListener('change', function () { brush = +r.value; });
    });
  }
  function afterPatternChange() { renderBanks(); renderGrid(); renderTransport(); save(); }

  /* --------------------------------------------------------------- exports */
  function download(name, data, mime) {
    var url = URL.createObjectURL(new Blob([data], { type: mime }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function baseName() {
    return 'rythme-atelier-' + (S.chain ? RA.playOrder(S).join('') : S.bank) + '-' + S.bpm + 'bpm';
  }
  function hasNotes() { return RA.computeEvents(S, 1).events.length > 0; }
  function bindExports() {
    $('wavBtn').addEventListener('click', function () {
      if (!hasNotes()) return toast(t('tEmpty'));
      var btn = $('wavBtn'); btn.disabled = true; toast(t('tRendering'));
      SY.renderOffline(S, +$('loops').value, 44100).then(function (buf) {
        var chs = []; for (var c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
        download(baseName() + '.wav', RA.encodeWAV(chs, buf.sampleRate), 'audio/wav');
        toast(t('tWav'));
      }).catch(function (err) { console.warn(err); toast(t('tAudioErr')); })
        .then(function () { btn.disabled = false; });
    });
    $('midiBtn').addEventListener('click', function () {
      if (!hasNotes()) return toast(t('tEmpty'));
      download(baseName() + '.mid', RA.encodeMIDI(S, +$('loops').value), 'audio/midi');
      toast(t('tMidi'));
    });
    $('jsonBtn').addEventListener('click', function () {
      download('rythme-atelier-projet.json', JSON.stringify(S, null, 1), 'application/json');
      toast(t('tJson'));
    });
    $('jsonFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var ns = RA.normalizeState(JSON.parse(rd.result));
          pushHistory(); S = ns; if (mixer) mixer.apply(S); renderAll(); save(); toast(t('tImported'));
        } catch (err) { toast(t('tBadFile')); }
        e.target.value = '';
      };
      rd.readAsText(f);
    });
  }

  /* ------------------------------------------------------------- keyboard */
  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !/^(checkbox|radio|range|button|file)$/.test(el.type));
  }
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if ($('helpDlg').open) return;
      var typing = isTyping(e.target);
      if (e.code === 'Space' && !typing) { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      if (/^[abcd]$/i.test(k)) { selectBank(k.toUpperCase()); return; }
      var tr = RA.TRACKS.filter(function (x) { return x.key === k; })[0];
      if (tr && !e.repeat) { audition(tr.id, e.shiftKey ? 3 : 2); selectTrack(tr.id); return; }
      if (k === '+' || k === '=') { setBpm(S.bpm + (e.shiftKey && k === '=' ? 10 : 1)); return; }
      if (k === '-' || k === '_') { setBpm(S.bpm - (k === '_' ? 10 : 1)); return; }
      if (k === 'm' || k === 'M') { toggleMute(selTrack); return; }
      if (k === 's' || k === 'S') { toggleSolo(selTrack); return; }
      if (k === '?') { openHelp(); }
    });
    // Stop a focused button from also being "clicked" by the Space key.
    document.addEventListener('keyup', function (e) { if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault(); });
  }
  function openHelp() { var d = $('helpDlg'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }

  /* ------------------------------------------------------------------ misc */
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  function renderLangSelect() {
    var sel = $('lang'); sel.innerHTML = '';
    I18N.LANGS.forEach(function (l) { var o = document.createElement('option'); o.value = l[0]; o.textContent = l[1]; sel.appendChild(o); });
    sel.value = lang;
    sel.addEventListener('change', function () {
      lang = sel.value; try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      renderAll();
    });
  }
  function renderAll() {
    applyI18n(); renderTransport(); renderBanks(); renderGrid(); renderEditor();
  }

  // Test / debugging hook (read-only snapshot + control), harmless in production.
  window.RythmeAtelier = {
    state: function () { return JSON.parse(snapshot()); },
    isPlaying: function () { return playing; },
    currentStep: function () { return curStep; },
    audioState: function () { return ctx ? ctx.state : 'none'; }
  };

  renderLangSelect();
  $('helpBtn').addEventListener('click', openHelp);
  bindTransport(); bindTools(); bindGrid(); bindEditor(); bindExports(); bindKeys();
  renderAll();
  requestAnimationFrame(frame);
})();
