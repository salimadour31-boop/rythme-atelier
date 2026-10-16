// End-to-end tests (Playwright + Chromium) against a local static server.
// Usage:  npm i playwright && npx playwright install chromium   (outside the repo is fine)
//         python3 -m http.server 8765 &   then   RA_URL=http://localhost:8765/ node tests/e2e.js
//         SHOTS=1 also writes screenshots/ (desktop + mobile).
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { pw = require('playwright-core'); }
const { chromium } = pw;
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const URL0 = process.env.RA_URL || 'http://localhost:8765/';
const SHOTS = !!process.env.SHOTS;
let passes = 0, failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? passes++ : failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function download(page, sel) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(sel)]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(p) };
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  async function newPage(width, height, isMobile) {
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: !!isMobile, hasTouch: !!isMobile, acceptDownloads: true, deviceScaleFactor: isMobile ? 2 : 1 });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    return page;
  }

  /* ---------------- desktop 1280 ---------------- */
  const page = await newPage(1280, 900);
  await page.goto(URL0);
  await page.waitForSelector('.cell');
  ok(await page.locator('.row[data-track] ').count() === 10, '10 track rows');
  ok(await page.locator('.row[data-track="kick"] .cell').count() === 16, '16 steps by default');
  ok((await page.textContent('#playBtn .play-label')).trim() === 'Lecture', 'French by default');

  // Play / stop with the button (real click = user gesture for AudioContext)
  await page.click('#playBtn');
  await sleep(700);
  ok(await page.evaluate(() => RythmeAtelier.isPlaying()), 'play starts');
  ok(await page.evaluate(() => RythmeAtelier.audioState()) === 'running', 'AudioContext running');
  const s1 = await page.evaluate(() => RythmeAtelier.currentStep());
  await sleep(300);
  const s2 = await page.evaluate(() => RythmeAtelier.currentStep());
  ok(s1 >= 0 && s2 >= 0 && s1 !== s2, `playhead moves (${s1} → ${s2})`);
  ok(await page.locator('.cell.ph').count() === 10, 'playhead column highlighted');
  if (SHOTS) await page.screenshot({ path: path.join(ROOT, 'screenshots/desktop.png'), fullPage: true });
  await page.click('#playBtn');
  ok(!(await page.evaluate(() => RythmeAtelier.isPlaying())), 'stop works');
  ok(await page.locator('.cell.ph').count() === 0, 'playhead cleared on stop');

  // Space toggles play even when a grid cell has focus (and must not toggle the cell)
  await page.focus('.row[data-track="kick"] .cell >> nth=0');
  const before = await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.kick[0]);
  await page.keyboard.press('Space'); await sleep(200);
  ok(await page.evaluate(() => RythmeAtelier.isPlaying()), 'Space starts playback');
  await page.keyboard.press('Space'); await sleep(100);
  ok(!(await page.evaluate(() => RythmeAtelier.isPlaying())), 'Space stops playback');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.kick[0]) === before, 'Space did not toggle the focused cell');

  // Step editing
  await page.click('.row[data-track="cowbell"] .cell >> nth=2');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.cowbell[2]) === 2, 'click sets a normal step');
  await page.click('.row[data-track="cowbell"] .cell >> nth=2', { modifiers: ['Shift'] });
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.cowbell[2]) === 3, 'shift+click cycles to accent');
  await page.click('.row[data-track="cowbell"] .cell >> nth=2');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.cowbell[2]) === 2, 'click with normal brush on accent sets normal');
  await page.click('.row[data-track="cowbell"] .cell >> nth=2');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.cowbell[2]) === 0, 'click again clears');
  await page.keyboard.press('Control+z');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.cowbell[2]) === 2, 'Ctrl+Z undoes');
  // Keyboard: arrows + Enter
  await page.focus('.row[data-track="kick"] .cell >> nth=0');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  const k0 = await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.snare[1]);
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => RythmeAtelier.state().patterns.A.grid.snare[1]) !== k0, 'arrow keys + Enter edit the grid');

  // Mute / solo
  await page.click('.row[data-track="kick"] .mute');
  ok(await page.evaluate(() => RythmeAtelier.state().kit.kick.mute), 'mute toggles');
  await page.click('.row[data-track="kick"] .mute');
  await page.click('.row[data-track="snare"] .solo');
  ok(await page.locator('.row.silent').count() === 9, 'solo silences other tracks');
  await page.click('.row[data-track="snare"] .solo');

  // Track editor
  await page.click('.row[data-track="tomlow"] .tname');
  ok((await page.textContent('#edName')).trim() === 'Tom grave', 'track select updates editor');
  await page.fill('#edTune', '5'); await page.dispatchEvent('#edTune', 'input');
  ok(await page.evaluate(() => RythmeAtelier.state().kit.tomlow.tune) === 5, 'tune slider updates kit');

  // Swing / BPM
  await page.fill('#bpm', '300'); await page.dispatchEvent('#bpm', 'change');
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 240, 'BPM clamped to 240');
  await page.fill('#bpm', '96'); await page.dispatchEvent('#bpm', 'change');
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 96, 'BPM set to 96');

  // Banks + presets + random + copy/paste
  await page.keyboard.press('Escape'); await page.click('h1');
  await page.keyboard.press('d');
  ok(await page.evaluate(() => RythmeAtelier.state().bank) === 'D', 'key D selects bank D');
  await page.selectOption('#presetSel', 'trap'); await page.click('#presetBtn');
  ok(await page.locator('.row[data-track="kick"] .cell').count() === 32, 'trap preset loads 32 steps');
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 140, 'preset sets BPM');
  await page.click('#copyBtn'); await page.click('[data-bank="C"]'); await page.click('#pasteBtn');
  ok(await page.evaluate(() => JSON.stringify(RythmeAtelier.state().patterns.C) === JSON.stringify(RythmeAtelier.state().patterns.D)), 'copy / paste between banks');
  await page.click('#clearBtn');
  ok(await page.locator('.cell.v1, .cell.v2, .cell.v3').count() === 0, 'clear empties the pattern');
  await page.click('#randomBtn');
  ok(await page.locator('.cell.v1, .cell.v2, .cell.v3').count() > 5, 'randomize fills the pattern');
  await page.selectOption('#length', '12');
  ok(await page.locator('.row[data-track="kick"] .cell').count() === 12, 'length 12');
  await page.selectOption('#length', '16');
  await page.click('[data-bank="A"]');

  // Exports
  const wav = await download(page, '#wavBtn');
  const w = wav.buf, dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const riff = w.slice(0, 4).toString() === 'RIFF' && w.slice(8, 12).toString() === 'WAVE' && w.slice(36, 40).toString() === 'data';
  ok(riff, `WAV header valid (${wav.name}, ${(w.length / 1024).toFixed(0)} KB)`);
  let peak = 0; for (let o = 44; o < w.length; o += 2) peak = Math.max(peak, Math.abs(dv.getInt16(o, true)));
  const secs = (w.length - 44) / 4 / dv.getUint32(24, true);
  const st = await page.evaluate(() => RythmeAtelier.state());
  const expected = 4 * st.patterns[st.bank].length * 60 / st.bpm / 4 + 1.5;
  ok(peak > 3000 && Math.abs(secs - expected) < 0.05, `WAV has audio (peak ${peak}) and length ${secs.toFixed(2)} s ≈ ${expected.toFixed(2)} s`);
  const mid = await download(page, '#midiBtn');
  ok(mid.buf.slice(0, 4).toString() === 'MThd' && mid.buf.slice(14, 18).toString() === 'MTrk' && mid.name.endsWith('.mid'), 'MIDI file starts with MThd / MTrk');
  ok(mid.buf.includes(Buffer.from([0x99, 36])), 'MIDI contains kick note-on on channel 10');
  const js = await download(page, '#jsonBtn');
  const parsed = JSON.parse(js.buf.toString());
  ok(parsed.app === 'rythme-atelier' && parsed.patterns.D.length === 32, 'JSON export contains the project');

  // Import JSON (modified BPM) then reload → autosave
  parsed.bpm = 77; const tmp = path.join(require('os').tmpdir(), 'ra-import.json');
  fs.writeFileSync(tmp, JSON.stringify(parsed));
  await page.setInputFiles('#jsonFile', tmp); await sleep(300);
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 77, 'JSON import applied');
  const bad = path.join(require('os').tmpdir(), 'ra-bad.json'); fs.writeFileSync(bad, '{"hello": 1}');
  await page.setInputFiles('#jsonFile', bad); await sleep(300);
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 77, 'invalid JSON rejected safely');
  await sleep(400);
  await page.reload(); await page.waitForSelector('.cell');
  ok(await page.evaluate(() => RythmeAtelier.state().bpm) === 77, 'autosave restored after reload');

  // Language switch
  await page.selectOption('#lang', 'en');
  ok((await page.textContent('#playBtn .play-label')).trim() === 'Play' && await page.getAttribute('html', 'lang') === 'en', 'English UI');
  ok((await page.textContent('.row[data-track="kick"] .label')).trim() === 'Kick', 'English track names');
  await page.selectOption('#lang', 'kab');
  ok((await page.textContent('#playBtn .play-label')).trim() === 'Bdu' && await page.getAttribute('html', 'lang') === 'kab', 'Taqbaylit UI');
  await page.reload(); await page.waitForSelector('.cell');
  ok((await page.textContent('#playBtn .play-label')).trim() === 'Bdu', 'language remembered');
  await page.selectOption('#lang', 'fr');

  // Help dialog
  await page.keyboard.press('?');
  ok(await page.evaluate(() => document.getElementById('helpDlg').open), 'help dialog opens with ?');
  await page.keyboard.press('Escape');

  // Every button / input has an accessible name
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, input, select')].filter(el => {
    if (el.closest('dialog') && !el.closest('dialog').open) return false;
    const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length && el.labels[0].textContent.trim()) || el.title;
    return !name;
  }).map(el => el.id || el.className));
  ok(unnamed.length === 0, 'all controls have an accessible name ' + (unnamed.length ? JSON.stringify(unnamed) : ''));

  /* ---------------- mobile 390 ---------------- */
  const m = await newPage(390, 844, true);
  await m.goto(URL0); await m.waitForSelector('.cell');
  await m.evaluate(() => localStorage.clear()); await m.reload(); await m.waitForSelector('.cell');
  const dims = await m.evaluate(() => ({ page: document.documentElement.scrollWidth, gs: document.getElementById('gridScroll').scrollWidth, gc: document.getElementById('gridScroll').clientWidth }));
  ok(dims.page <= 390, `no page-level horizontal overflow on mobile (${dims.page}px)`);
  ok(dims.gs > dims.gc, `grid scrolls horizontally inside its panel (${dims.gs} > ${dims.gc})`);
  await m.tap('#playBtn'); await sleep(600);
  ok(await m.evaluate(() => RythmeAtelier.isPlaying()), 'tap play works on mobile');
  await m.tap('.row[data-track="clap"] .cell >> nth=1');
  ok(await m.evaluate(() => RythmeAtelier.state().patterns.A.grid.clap[1]) === 2, 'tap sets a step on mobile');
  if (SHOTS) {
    await m.evaluate(() => document.querySelector('.tools').scrollIntoView()); await sleep(150);
    await m.screenshot({ path: path.join(ROOT, 'screenshots/mobile.png'), fullPage: false });
  }
  await m.tap('#playBtn');

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
