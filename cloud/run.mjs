// Makes episodes on GitHub's computers (no phone needed). Runs the same app in headless Chrome.
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE = path.join(ROOT, 'cloud', 'state.json');
const OUT = path.join(ROOT, 'cloud', 'out');
const N = Math.max(1, Math.min(10, +(process.env.EPISODES || 2)));
const MOCK = !process.env.GEMINI_KEY; // test mode when no key secret yet
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(ROOT, 'cloud', 'last-run.log'); fs.writeFileSync(LOG, '');
const say = m => { const l = new Date().toISOString().slice(11, 19) + ' ' + m; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
process.on('uncaughtException', e => { say('CRASH: ' + (e.stack || e.message)); process.exit(1); });
process.on('unhandledRejection', e => { say('CRASH: ' + (e?.stack || e)); process.exit(1); });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((q, r) => {
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(8765);

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!/^\[vite\]/.test(t)) say('page: ' + t.slice(0, 300)); });
page.on('pageerror', e => say('page error: ' + e.message));
await page.evaluateOnNewDocument(s => localStorage.setItem('sds_settings', JSON.stringify(s)), {
  key: process.env.GEMINI_KEY || 'mock', pkey: process.env.POLLINATIONS_KEY || '', imgsrc: process.env.POLLINATIONS_KEY ? 'pollinations' : 'horde'
});
await page.exposeFunction('edgeTTS', async (text, voice) => {
  const { execFileSync } = await import('node:child_process');
  const f = `/tmp/edge-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
  try { execFileSync('edge-tts', ['--voice', voice, '--text', text, '--write-media', f], { timeout: 120000, stdio: 'pipe' }); }
  catch (e) { say('edge-tts failed: ' + String(e.stderr || e.message).slice(-300)); throw e; }
  const b = fs.readFileSync(f).toString('base64'); fs.unlinkSync(f); return b;
});
await page.goto('http://localhost:8765/index.html', { waitUntil: 'load' });
await page.setViewport({ width: 420, height: 900 });

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
const cfg = { genre: process.env.GENRE || '', lang: process.env.LANG_NAME || '', secs: process.env.SECS || '', idea: process.env.IDEA || '' };

await page.evaluate(async (state, cfg, MOCK) => {
  window.uiDialog = async (m) => { console.log('DIALOG: ' + m); return true; }; // auto-answer yes
  window.showResult = (blob, caption) => { window.__out = { blob, caption }; };
  batchRunning = true;
  if (state) {
    for (const st of ['series', 'chars', 'places', 'episodes']) for (const x of state[st] || []) await put(st, x);
    S.seriesId = state.seriesId || state.series?.[0]?.id; saveS();
  } else {
    const s = { id: uid(), name: 'Cloud Series', summary: '', episodes: 0 }; await put('series', s); S.seriesId = s.id; saveS();
  }
  await renderSeries();
  if (cfg.genre) $('#genre').value = cfg.genre;
  if (cfg.lang) $('#lang').value = cfg.lang;
  if (cfg.secs) $('#length').value = cfg.secs;
  if (MOCK) { // pipeline test without keys
    window.geminiJSON = async p => /casting/.test(p)
      ? { series_name: 'Test Series', characters: [{ name: 'Ada', look: 'young woman', role: 'heroine', voice: 'Kore' }, { name: 'Tunde', look: 'young man', role: 'rival', voice: 'Puck' }], places: [{ name: 'Office', look: 'office' }] }
      : { title: 'Test Episode', summary: 'test', caption: 'Test', hashtags: ['test'], hook: 'Wait for it', scenes: [
          { place: 'Office', action: 'argue', on_screen: ['Ada', 'Tunde'], lines: [{ speaker: 'Ada', emotion: 'angry', text: 'You lied to me!' }, { speaker: 'Tunde', emotion: 'calm', text: 'I had no choice.' }] }] };
    window.tts = async () => { const a = audioCtx(); return a.createBuffer(1, 24000 * 2, 24000); };
    window.drawPicture = async () => { const c = document.createElement('canvas'); c.width = 512; c.height = 768; const g = c.getContext('2d'); g.fillStyle = '#' + Math.floor(Math.random() * 1e6).toString(16).padStart(6, '0'); g.fillRect(0, 0, 512, 768); return c.toDataURL('image/jpeg'); };
  }
  $('#idea').value = cfg.idea;
}, state, cfg, MOCK);
say(MOCK ? 'TEST MODE (no GEMINI_KEY secret): fake script, voices and pictures' : `Making ${N} episode(s)`);

const made = [];
for (let i = 0; i < N; i++) {
  say(`Episode ${i + 1}: writing script`);
  const res = await page.evaluate(async (i) => {
    try {
      if (i > 0) $('#idea').value = '';
      window.__out = null; $('#err-log').textContent = '';
      await writeScript(); btnDone('#write-btn');
      if (!current) return { err: 'No script was written. ' + $('#err-log').textContent };
      const sc = current.script.scenes; console.log('SCRIPT: ' + sc.length + ' scenes, ' + sc.reduce((a, x) => a + x.lines.length, 0) + ' lines, ' + sc.reduce((a, x) => a + x.lines.reduce((b, l) => b + l.text.split(/\s+/).length, 0), 0) + ' words; actions: ' + sc.map(x => x.action).join(' | ').slice(0, 600));
      const ok = await makeVideo();
      console.log('SHOTS: ' + current.script.scenes.map((x, k) => (k + 1) + ':' + (x.move ? 'move-' + x.move : x.shot ? 'shot' : 'none')).join(' '));
      if (!ok || !window.__out) return { err: 'Video failed. ' + $('#err-log').textContent + ' ' + $('#progress-text').textContent };
      const buf = new Uint8Array(await window.__out.blob.arrayBuffer());
      let bin = ''; for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
      return { title: current.script.title, number: current.series.episodes, series: current.series.name, caption: window.__out.caption, type: window.__out.blob.type, b64: btoa(bin) };
    } catch (e) { return { err: e.message + ' ' + ($('#err-log')?.textContent || '') }; }
  }, i);
  if (res.err) { say('FAILED: ' + res.err.trim()); break; }
  const base = `ep${String(res.number).padStart(3, '0')}`;
  const raw = path.join(OUT, base + (res.type.includes('mp4') ? '.raw.mp4' : '.webm'));
  fs.writeFileSync(raw, Buffer.from(res.b64, 'base64'));
  const mp4 = path.join(OUT, base + '.mp4');
  execSync(`ffmpeg -y -loglevel error -i "${raw}" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -movflags +faststart "${mp4}"`);
  fs.unlinkSync(raw);
  fs.writeFileSync(path.join(OUT, base + '.txt'), `${res.series} - Episode ${res.number}: ${res.title}\n\n${res.caption}\n`);
  made.push({ file: base, ...res, b64: undefined });
  say(`Episode ${res.number} done: ${res.title}`);
}

// save the series (cast, pictures, story so far) for next time
if (!MOCK) {
  const st = await page.evaluate(async () => ({ seriesId: S.seriesId, series: await all('series'), chars: await all('chars'), places: await all('places'), episodes: (await all('episodes')).map(e => ({ id: e.id, seriesId: e.seriesId, number: e.number, title: e.title, summary: e.summary, createdAt: e.createdAt })).slice(-30) }));
  fs.writeFileSync(STATE, JSON.stringify(st));
}
fs.writeFileSync(path.join(OUT, 'made.json'), JSON.stringify(made));
say(`Finished: ${made.length} episode(s)`);
await browser.close(); server.close();
process.exit(made.length ? 0 : 1);
