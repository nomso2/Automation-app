/* Short Drama Studio — runs fully in the browser (iPhone Safari friendly).
   Scripts + voices: Google Gemini API (user's own key, free tier).
   Pictures: AI Horde (free), Pollinations (key) or user uploads.
   Video: canvas + Web Audio recorded with MediaRecorder (9:16, up to ~1 minute). */
'use strict';

/* ---------- constants ---------- */
const W = 720, H = 1280;
const VOICES = [
  ['Kore','female, firm'],['Leda','female, youthful'],['Aoede','female, breezy'],['Zephyr','female, bright'],
  ['Callirrhoe','female, easy-going'],['Autonoe','female, bright'],['Despina','female, smooth'],['Erinome','female, clear'],
  ['Laomedeia','female, upbeat'],['Achernar','female, soft'],['Gacrux','female, mature'],['Pulcherrima','female, forward'],
  ['Vindemiatrix','female, gentle'],['Sulafat','female, warm'],
  ['Charon','male, informative'],['Puck','male, upbeat'],['Fenrir','male, excitable'],['Orus','male, firm'],
  ['Enceladus','male, breathy'],['Iapetus','male, clear'],['Umbriel','male, easy-going'],['Algieba','male, smooth'],
  ['Algenib','male, gravelly'],['Rasalgethi','male, informative'],['Alnilam','male, firm'],['Schedar','male, even'],
  ['Achird','male, friendly'],['Zubenelgenubi','male, casual'],['Sadachbia','male, lively'],['Sadaltager','male, knowledgeable']
];
const DEFAULTS = {
  key: '', pkey: '', style: 'cinematic photo, dramatic lighting, shallow depth of field, 35mm film look',
  imgsrc: 'horde', tmodel: 'gemini-2.5-flash', vmodel: 'gemini-2.5-flash-preview-tts',
  nvoice: 'Charon', seriesId: ''
};

/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sds_settings') || '{}'));
const saveS = () => localStorage.setItem('sds_settings', JSON.stringify(S));

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('sds', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      ['series', 'chars', 'places', 'episodes'].forEach(n => d.objectStoreNames.contains(n) || d.createObjectStore(n, { keyPath: 'id' }));
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const put = (st, v) => tx(st, 'readwrite', s => s.put(v));
const del = (st, id) => tx(st, 'readwrite', s => s.delete(id));
const all = st => tx(st, 'readonly', s => s.getAll());
const get = (st, id) => tx(st, 'readonly', s => s.get(id));
async function bySeries(st) { return (await all(st)).filter(x => x.seriesId === S.seriesId); }

/* ---------- Gemini ---------- */
async function gemini(model, body, label = 'request') {
  if (!S.key) throw new Error('Add your Gemini API key in Settings first.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(S.key)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    const txt = await r.text();
    if (r.status === 429 || r.status >= 500) {
      let wait = 20;
      const m = txt.match(/"retryDelay":\s*"(\d+)/); if (m) wait = +m[1] + 2;
      if (/per day|PerDay/i.test(txt) && attempt >= 1) throw new Error('Daily free limit reached for ' + label + '. Try again tomorrow (or add billing to your Gemini key).');
      progress(null, `Busy (${label}). Waiting ${wait}s…`);
      await sleep(wait * 1000); continue;
    }
    let msg = txt; try { msg = JSON.parse(txt).error.message; } catch (e) {}
    throw new Error(`Gemini ${r.status}: ${msg}`);
  }
  throw new Error('Gemini kept saying busy. Try again in a few minutes.');
}
async function geminiJSON(prompt) {
  const j = await gemini(S.tmodel, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 1.0 }
  }, 'script');
  const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  try { return JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
    throw new Error('The AI returned an unreadable script. Tap Rewrite.');
  }
}

/* ---------- audio ---------- */
let AC;
function audioCtx() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function pcmToBuffer(b64, rate) {
  const bin = atob(b64), n = bin.length >> 1, buf = audioCtx().createBuffer(1, n, rate), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
  return buf;
}
async function tts(text, speakers /* [{label, voice}] */) {
  const speechConfig = speakers.length > 1
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map(s => ({ speaker: s.label, voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: speakers[0].voice } } };
  const j = await gemini(S.vmodel, {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig }
  }, 'voices');
  const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error('No audio came back from Gemini.');
  const rate = +((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
  return pcmToBuffer(part.inlineData.data, rate);
}
function playBuffer(buf) { const a = audioCtx(), s = a.createBufferSource(); s.buffer = buf; s.connect(a.destination); s.start(); }

/* ---------- images ---------- */
function fileToDataURL(blob) { return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }); }
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function shrink(dataURL, max = 1080) {
  const img = await loadImg(dataURL), sc = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
async function drawPicture(prompt, kind, seed, onStatus) {
  const portrait = kind === 'char';
  if (S.imgsrc === 'upload') throw new Error('Picture maker is set to "upload". Tap Upload, or change it in Settings.');
  if (S.imgsrc === 'pollinations') {
    if (!S.pkey) throw new Error('Add your Pollinations key in Settings (free at enter.pollinations.ai).');
    onStatus('Drawing…');
    const w = portrait ? 768 : 720, h = portrait ? 1024 : 1280;
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=${w}&height=${h}&seed=${seed}&nologo=true&key=${encodeURIComponent(S.pkey)}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + S.pkey } });
    if (!r.ok) throw new Error('Pollinations error ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return shrink(await fileToDataURL(await r.blob()));
  }
  // AI Horde (free, anonymous)
  const headers = { 'Content-Type': 'application/json', apikey: '0000000000', 'Client-Agent': 'short-drama-studio:1.0:nomso2' };
  const body = { prompt: prompt + ' ### text, watermark, blurry, deformed, extra fingers, nsfw', nsfw: false, censor_nsfw: true, r2: false,
    params: { width: 512, height: 512, steps: 24, n: 1, sampler_name: 'k_euler_a', cfg_scale: 7, seed: String(seed) } };
  const r = await fetch('https://aihorde.net/api/v2/generate/async', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j.id) throw new Error('AI Horde: ' + (j.message || r.status));
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const c = await (await fetch('https://aihorde.net/api/v2/generate/check/' + j.id, { headers })).json();
    if (c.faulted) throw new Error('AI Horde failed this picture. Try again.');
    onStatus(c.done ? 'Finishing…' : `Free queue: position ${c.queue_position ?? '?'}, about ${c.wait_time ?? '?'}s`);
    if (c.done) break;
  }
  const st = await (await fetch('https://aihorde.net/api/v2/generate/status/' + j.id, { headers })).json();
  const img = st.generations?.[0]?.img;
  if (!img) throw new Error('AI Horde returned no picture.');
  const data = img.startsWith('http') ? await fileToDataURL(await (await fetch(img)).blob()) : 'data:image/webp;base64,' + img;
  return shrink(data);
}
const charPrompt = c => `${S.style}. Portrait of ${c.desc}${c.role ? ', ' + c.role : ''}, facing camera, upper body, expressive face, simple blurred background, character reference, highly detailed`;
const placePrompt = p => `${S.style}. ${p.desc || p.name}, establishing shot, empty, no people, atmospheric, vertical composition`;

/* ---------- UI: tabs & settings ---------- */
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'cast') renderCast();
  if (b.dataset.tab === 'places') renderPlaces();
  if (b.dataset.tab === 'episodes') renderEpisodes();
});
function fillVoices() {
  $$('.voice-select').forEach(s => s.innerHTML = VOICES.map(([v, d]) => `<option value="${v}">${v} — ${d}</option>`).join(''));
}
function loadSettingsUI() {
  $('#set-key').value = S.key; $('#set-pkey').value = S.pkey; $('#set-style').value = S.style;
  $('#set-imgsrc').value = S.imgsrc; $('#set-tmodel').value = S.tmodel; $('#set-vmodel').value = S.vmodel; $('#set-nvoice').value = S.nvoice;
}
$('#save-settings').onclick = () => {
  Object.assign(S, { key: $('#set-key').value.trim(), pkey: $('#set-pkey').value.trim(), style: $('#set-style').value.trim() || DEFAULTS.style,
    imgsrc: $('#set-imgsrc').value, tmodel: $('#set-tmodel').value.trim() || DEFAULTS.tmodel, vmodel: $('#set-vmodel').value.trim() || DEFAULTS.vmodel,
    nvoice: $('#set-nvoice').value });
  saveS(); toast('Settings saved');
};
function toast(m) { const t = document.createElement('div'); t.textContent = m;
  Object.assign(t.style, { position: 'fixed', left: '50%', bottom: '30px', transform: 'translateX(-50%)', background: '#333', color: '#fff', padding: '10px 16px', borderRadius: '10px', zIndex: 99 });
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }

/* ---------- series ---------- */
async function renderSeries() {
  let list = await all('series');
  if (!list.length) { const s = { id: uid(), name: 'My First Series', summary: '', episodes: 0 }; await put('series', s); list = [s]; }
  if (!list.find(s => s.id === S.seriesId)) { S.seriesId = list[0].id; saveS(); }
  $('#series-select').innerHTML = list.map(s => `<option value="${s.id}" ${s.id === S.seriesId ? 'selected' : ''}>${esc(s.name)} (${s.episodes || 0} eps)</option>`).join('');
}
$('#series-select').onchange = e => { S.seriesId = e.target.value; saveS(); };
$('#new-series-btn').onclick = async () => {
  const name = prompt('Series name?'); if (!name) return;
  const s = { id: uid(), name, summary: '', episodes: 0 }; await put('series', s); S.seriesId = s.id; saveS(); renderSeries();
  toast('New series. Add its cast, or write an idea and tap Write script to get a suggested cast.');
};

/* ---------- cast & places ---------- */
async function renderCast() {
  const cs = await bySeries('chars'), sr = await get('series', S.seriesId);
  $('#cast-list').innerHTML = cs.map(c => tileHTML(c, VOICES.find(v => v[0] === c.voice)?.[1] || c.voice)).join('') || '<p class="hint">No characters yet.</p>';
  $$('#cast-list .tile').forEach(t => t.onclick = () => openEditor('char', cs.find(c => c.id === t.dataset.id)));
  $('#tab-cast h2').textContent = 'Cast — ' + (sr?.name || '');
  addDrawAll('#cast-list', cs, 'char');
}
async function renderPlaces() {
  const ps = await bySeries('places'), sr = await get('series', S.seriesId);
  $('#place-list').innerHTML = ps.map(p => tileHTML(p, '')).join('') || '<p class="hint">No places yet.</p>';
  $$('#place-list .tile').forEach(t => t.onclick = () => openEditor('place', ps.find(c => c.id === t.dataset.id)));
  $('#tab-places h2').textContent = 'Places — ' + (sr?.name || '');
  addDrawAll('#place-list', ps, 'place');
}
function tileHTML(x, sub) {
  return `<button class="tile" data-id="${x.id}">${x.img ? `<img src="${x.img}">` : '<div class="noimg">🎨</div>'}<div class="meta"><b>${esc(x.name)}</b>${esc(sub)}</div></button>`;
}
function addDrawAll(sel, items, kind) {
  const missing = items.filter(x => !x.img);
  const id = sel.replace('#', '') + '-drawall';
  $('#' + id)?.remove();
  if (!missing.length || S.imgsrc === 'upload') return;
  const b = document.createElement('button'); b.id = id; b.className = 'ghost small'; b.style.width = '100%';
  b.textContent = `🎨 Draw ${missing.length} missing picture${missing.length > 1 ? 's' : ''}`;
  b.onclick = async () => {
    b.disabled = true;
    for (const [i, x] of missing.entries()) {
      try {
        x.img = await drawPicture(kind === 'char' ? charPrompt(x) : placePrompt(x), kind, x.seed, s => b.textContent = `${x.name} (${i + 1}/${missing.length}): ${s}`);
        await put(kind === 'char' ? 'chars' : 'places', x);
      } catch (e) { alert(x.name + ': ' + e.message); break; }
    }
    kind === 'char' ? renderCast() : renderPlaces();
  };
  $(sel).after(b);
}

let edKind, edItem;
function openEditor(kind, item) {
  edKind = kind;
  edItem = item ? { ...item } : { id: uid(), seriesId: S.seriesId, name: '', desc: '', role: '', voice: kind === 'char' ? 'Kore' : '', img: '', seed: Math.floor(Math.random() * 1e9) };
  $('#editor-title').textContent = (item ? 'Edit ' : 'New ') + (kind === 'char' ? 'character' : 'place');
  $('#ed-desc-label').textContent = kind === 'char' ? 'Look (age, skin tone, hair, clothes — be specific, it never changes)' : 'What it looks like';
  $('#ed-voice-wrap').classList.toggle('hidden', kind !== 'char');
  $('#ed-name').value = edItem.name; $('#ed-desc').value = edItem.desc; $('#ed-role').value = edItem.role || '';
  $('#ed-voice').value = edItem.voice || 'Kore'; $('#ed-img').src = edItem.img || ''; $('#ed-status').textContent = '';
  $('#ed-delete').classList.toggle('hidden', !item);
  $('#editor').showModal();
}
function readEditor() { edItem.name = $('#ed-name').value.trim(); edItem.desc = $('#ed-desc').value.trim(); edItem.role = $('#ed-role').value.trim(); edItem.voice = $('#ed-voice').value; }
$('#add-char-btn').onclick = () => openEditor('char');
$('#add-place-btn').onclick = () => openEditor('place');
$('#ed-cancel').onclick = () => $('#editor').close();
$('#ed-save').onclick = async () => {
  readEditor(); if (!edItem.name) return alert('Give it a name.');
  await put(edKind === 'char' ? 'chars' : 'places', edItem); $('#editor').close();
  edKind === 'char' ? renderCast() : renderPlaces();
};
$('#ed-delete').onclick = async () => {
  if (!confirm('Delete ' + edItem.name + '?')) return;
  await del(edKind === 'char' ? 'chars' : 'places', edItem.id); $('#editor').close();
  edKind === 'char' ? renderCast() : renderPlaces();
};
$('#ed-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; edItem.img = await shrink(await fileToDataURL(f)); $('#ed-img').src = edItem.img; };
$('#ed-gen').onclick = async () => {
  readEditor(); if (!edItem.desc) return alert('Describe it first.');
  const b = $('#ed-gen'); b.disabled = true;
  try {
    edItem.img = await drawPicture(edKind === 'char' ? charPrompt(edItem) : placePrompt(edItem), edKind, edItem.seed, s => $('#ed-status').textContent = s);
    $('#ed-img').src = edItem.img; $('#ed-status').textContent = 'Done. Tap Save to lock it in. Not right? Draw again.';
    edItem.seed = edItem.seed + 1; // next redraw gives a new variation; the saved picture itself is what stays constant
  } catch (e) { $('#ed-status').textContent = e.message; }
  b.disabled = false;
};
$('#ed-test-voice').onclick = async () => {
  readEditor(); audioCtx();
  try { $('#ed-status').textContent = 'Generating voice…'; playBuffer(await tts(`Say naturally: Hi, I'm ${edItem.name || 'here'}. This is how I sound.`, [{ label: 'A', voice: edItem.voice }])); $('#ed-status').textContent = ''; }
  catch (e) { $('#ed-status').textContent = e.message; }
};

/* ---------- script writing ---------- */
let current = null; // { script, chars, places, series }

async function suggestCast(idea, genre, lang) {
  const voices = VOICES.map(v => `${v[0]} (${v[1]})`).join(', ');
  const j = await geminiJSON(`You are casting a vertical short drama series for TikTok/YouTube Shorts.
Genre: ${genre}. Language of dialogue: ${lang}. Idea: ${idea || 'invent a gripping, addictive premise'}.
Return JSON: {"series_name": string, "characters": [{"name": string, "look": "very specific fixed visual description: age, gender, skin tone, hair, face, outfit", "role": "personality and role in story", "voice": one of [${voices}] matching gender and age}], "places": [{"name": string, "look": "visual description of the location"}]}
3 to 4 characters, 3 to 4 places. Voice must be just the name, e.g. "Kore".`);
  for (const c of j.characters || []) await put('chars', { id: uid(), seriesId: S.seriesId, name: c.name, desc: c.look, role: c.role, voice: (VOICES.find(v => v[0].toLowerCase() === String(c.voice).split(' ')[0].toLowerCase()) || VOICES[0])[0], img: '', seed: Math.floor(Math.random() * 1e9) });
  for (const p of j.places || []) await put('places', { id: uid(), seriesId: S.seriesId, name: p.name, desc: p.look, img: '', seed: Math.floor(Math.random() * 1e9) });
  const sr = await get('series', S.seriesId);
  if (sr && sr.name.startsWith('My First Series') && j.series_name) { sr.name = j.series_name; await put('series', sr); renderSeries(); }
}

async function writeScript() {
  const idea = $('#idea').value.trim(), genre = $('#genre').value, lang = $('#lang').value, secs = +$('#length').value;
  const narr = $('#use-narrator').checked;
  let chars = await bySeries('chars'), places = await bySeries('places');
  if (!chars.length) {
    if (!confirm('This series has no cast yet. Let the AI create the cast and places from your idea?')) return;
    btnBusy('#write-btn', 'Creating cast…'); await suggestCast(idea, genre, lang);
    chars = await bySeries('chars'); places = await bySeries('places');
    toast('Cast created. Open Cast and Places to draw their pictures once.');
  }
  if (!places.length) { await put('places', { id: uid(), seriesId: S.seriesId, name: 'Living room', desc: 'a stylish modern living room at night', img: '', seed: 1 }); places = await bySeries('places'); }
  const series = await get('series', S.seriesId);
  const eps = (await bySeries('episodes')).sort((a, b) => a.createdAt - b.createdAt).slice(-5);
  const words = Math.round(secs * 2.3);
  btnBusy('#write-btn', 'Writing…');
  const j = await geminiJSON(`Write episode ${(series.episodes || 0) + 1} of the vertical short drama series "${series.name}" for TikTok and YouTube Shorts.
Genre: ${genre}. All spoken lines in ${lang}.
${idea ? 'This episode\'s idea: ' + idea : 'Continue the story naturally from the previous episodes.'}
${eps.length ? 'Previous episodes (keep continuity):\n' + eps.map((e, i) => `- ${e.title}: ${e.summary}`).join('\n') : 'This is the first episode.'}

CAST (use ONLY these exact names, never invent new characters):
${chars.map(c => `- ${c.name}: ${c.role || ''}. Looks: ${c.desc}`).join('\n')}
PLACES (use ONLY these exact names):
${places.map(p => `- ${p.name}`).join('\n')}

Rules:
- Total spoken words about ${words} so it lasts about ${secs} seconds. 4 to 7 scenes.
- Line one must be a shocking hook in the first 3 seconds. Fast, emotional, short lines.
- ${narr ? 'Use "Narrator" sparingly for scene-setting.' : 'No narrator: only characters speak.'}
- End on a cliffhanger that makes viewers want the next part.
Return JSON only:
{"title": string, "hook": "max 7 words for on-screen title", "summary": "2 sentences of what happened, for continuity",
 "caption": "TikTok caption, 1-2 sentences", "hashtags": [5-8 strings without #],
 "scenes": [{"place": exact place name, "on_screen": [1 or 2 exact character names visible], "lines": [{"speaker": exact character name${narr ? ' or "Narrator"' : ''}, "emotion": "one or two words", "text": string}]}]}`);
  if (!Array.isArray(j.scenes) || !j.scenes.length) throw new Error('The script came back empty. Tap Rewrite.');
  // validate names so nothing outside the locked cast appears
  const findC = n => chars.find(c => c.name.toLowerCase() === String(n || '').trim().toLowerCase()) || chars.find(c => String(n || '').toLowerCase().includes(c.name.toLowerCase().split(' ')[0]));
  const findP = n => places.find(p => p.name.toLowerCase() === String(n || '').trim().toLowerCase()) || places[0];
  j.scenes = j.scenes.map(sc => ({
    placeId: findP(sc.place).id,
    onScreen: (sc.on_screen || []).map(findC).filter(Boolean).map(c => c.id).slice(0, 2),
    lines: (sc.lines || []).filter(l => l.text).map(l => { const c = /narrator/i.test(l.speaker) ? null : findC(l.speaker); return { charId: c ? c.id : null, emotion: l.emotion || '', text: String(l.text).trim() }; })
  })).filter(sc => sc.lines.length);
  current = { script: j, chars, places, series, secs };
  showScript();
}
function btnBusy(sel, txt) { const b = $(sel); b.dataset.label ??= b.textContent; b.textContent = txt; b.disabled = true; }
function btnDone(sel) { const b = $(sel); if (b.dataset.label) b.textContent = b.dataset.label; b.disabled = false; }

function showScript() {
  const { script, chars, places } = current;
  const cn = id => id ? (chars.find(c => c.id === id)?.name || '?') : 'Narrator';
  $('#ep-title').textContent = script.title;
  $('#script-view').innerHTML = `<p class="hint">Hook: ${esc(script.hook)}</p>` + script.scenes.map(sc => `<div class="scene"><div class="loc">📍 ${esc(places.find(p => p.id === sc.placeId)?.name)}</div>${sc.lines.map(l => `<p><span class="who">${esc(cn(l.charId))}</span>${l.emotion ? ` <i>(${esc(l.emotion)})</i>` : ''}: ${esc(l.text)}</p>`).join('')}</div>`).join('');
  $('#script-card').classList.remove('hidden');
  $('#script-card').scrollIntoView({ behavior: 'smooth' });
}
$('#write-btn').onclick = async () => { try { await writeScript(); } catch (e) { alert(e.message); } btnDone('#write-btn'); };
$('#rewrite-btn').onclick = $('#write-btn').onclick;

/* ---------- voices for the episode ---------- */
function progress(frac, text) { if (frac != null) $('#bar-fill').style.width = Math.round(frac * 100) + '%'; if (text) $('#progress-text').textContent = text; }

async function voiceEpisode() {
  const { script, chars } = current;
  const voiceOf = id => id ? (chars.find(c => c.id === id)?.voice || 'Kore') : S.nvoice;
  const labelOf = id => (id ? (chars.find(c => c.id === id)?.name || 'Speaker') : 'Narrator').replace(/[^A-Za-z0-9]/g, '') || 'Speaker';
  // group consecutive lines into chunks with at most 2 different speakers (one TTS request each)
  const chunks = [];
  script.scenes.forEach((sc, si) => {
    let cur = null;
    sc.lines.forEach(l => {
      const key = l.charId || 'N';
      if (!cur || (!cur.keys.includes(key) && cur.keys.length >= 2) || cur.lines.length >= 8) { cur = { si, keys: [], lines: [] }; chunks.push(cur); }
      if (!cur.keys.includes(key)) cur.keys.push(key);
      cur.lines.push(l);
    });
  });
  const segs = []; // {scene, charId, text, start, end}
  const buffers = [];
  let t = 0.6; const GAP = 0.35;
  for (const [i, ch] of chunks.entries()) {
    progress(0.05 + 0.55 * i / chunks.length, `Recording voices ${i + 1}/${chunks.length}…`);
    const ids = ch.keys.map(k => k === 'N' ? null : k);
    let buf;
    if (ids.length === 1) {
      const l = ch.lines;
      buf = await tts(`Read this as a dramatic short-film performance${l[0].emotion ? ', ' + l[0].emotion : ''}, with natural pauses between sentences:\n` + l.map(x => x.text).join('\n'), [{ label: 'A', voice: voiceOf(ids[0]) }]);
    } else {
      const text = 'TTS the following dramatic conversation with real emotion:\n' + ch.lines.map(l => `${labelOf(l.charId)}: ${l.emotion ? '(' + l.emotion + ') ' : ''}${l.text}`).join('\n');
      buf = await tts(text, ids.map(id => ({ label: labelOf(id), voice: voiceOf(id) })));
    }
    // spread caption timing across the lines by character count
    const total = ch.lines.reduce((a, l) => a + l.text.length + 12, 0);
    let s = t;
    ch.lines.forEach(l => { const d = buf.duration * (l.text.length + 12) / total; segs.push({ scene: ch.si, charId: l.charId, text: l.text, start: s, end: s + d }); s += d; });
    buffers.push({ buf, at: t }); t += buf.duration + GAP;
  }
  const endVoice = t;
  const total = endVoice + 2.2; // outro card
  const a = audioCtx();
  const out = a.createBuffer(1, Math.ceil(total * a.sampleRate), a.sampleRate), o = out.getChannelData(0);
  for (const { buf, at } of buffers) {
    const src = buf.sampleRate === a.sampleRate ? buf : await resample(buf, a.sampleRate);
    o.set(src.getChannelData(0).subarray(0, Math.min(src.length, o.length - Math.floor(at * a.sampleRate))), Math.floor(at * a.sampleRate));
  }
  // scene boundaries
  const scenes = current.script.scenes.map((sc, i) => {
    const ss = segs.filter(x => x.scene === i);
    return { ...sc, start: ss.length ? ss[0].start - (i === 0 ? 0.6 : GAP / 2) : 0, end: ss.length ? ss[ss.length - 1].end + GAP / 2 : 0 };
  });
  scenes.forEach((sc, i) => { if (i === 0) sc.start = 0; if (i === scenes.length - 1) sc.end = total; else scenes[i + 1].start = sc.end; });
  return { audio: out, segs, scenes, total, endVoice };
}
async function resample(buf, rate) {
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate), s = off.createBufferSource();
  s.buffer = buf; s.connect(off.destination); s.start(); return off.startRendering();
}

/* ---------- rendering ---------- */
function coverDraw(g, img, scale, panX, panY) {
  const r = Math.max(W / img.width, H / img.height) * scale, w = img.width * r, h = img.height * r;
  g.drawImage(img, (W - w) / 2 + panX * (w - W) / 2, (H - h) / 2 + panY * (h - H) / 2, w, h);
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function wrap(g, text, maxW) {
  const words = text.split(/\s+/), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
function captionChunk(seg, t) {
  const words = seg.text.split(/\s+/), size = 5, groups = [];
  for (let i = 0; i < words.length; i += size) groups.push(words.slice(i, i + size));
  const p = Math.min(0.999, Math.max(0, (t - seg.start) / (seg.end - seg.start)));
  const totalChars = seg.text.length; let acc = 0, gi = 0;
  for (let i = 0; i < groups.length; i++) { acc += groups[i].join(' ').length + 1; if (p * totalChars < acc) { gi = i; break; } gi = i; }
  const start = groups.slice(0, gi).join(' ').length, gLen = groups[gi].join(' ').length + 1;
  const wp = Math.min(0.999, Math.max(0, (p * totalChars - start) / gLen));
  return { words: groups[gi], active: Math.floor(wp * groups[gi].length) };
}
function drawFrame(g, t, R, imgs) {
  const { scenes, segs, total, endVoice } = R, { script, chars, series } = current;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const si = Math.max(0, scenes.findIndex(s => t >= s.start && t < s.end)), sc = scenes[si] || scenes[scenes.length - 1];
  const local = (t - sc.start) / Math.max(0.1, sc.end - sc.start);
  // background with slow Ken Burns move
  const bg = imgs[sc.placeId];
  if (bg) { g.save(); g.filter = 'brightness(0.62)'; coverDraw(g, bg, 1.06 + 0.12 * local, si % 2 ? -0.6 + local : 0.6 - local, 0); g.restore(); }
  else { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#2a1630'); gr.addColorStop(1, '#0a0a12'); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
  // who is on screen: current speaker, else scene's on-screen cast
  const seg = segs.find(s => t >= s.start && t < s.end);
  let show = seg && seg.charId ? [seg.charId] : (sc.onScreen?.length ? sc.onScreen : []);
  if (seg && seg.charId && sc.onScreen?.length === 2 && sc.onScreen.includes(seg.charId)) show = sc.onScreen;
  const portraitBox = (id, x, y, w, h, active) => {
    const c = chars.find(c => c.id === id); if (!c) return;
    const im = imgs[id], bounce = active ? 1 + 0.015 * Math.sin(t * 6) : 0.94;
    g.save(); g.translate(x + w / 2, y + h / 2); g.scale(bounce, bounce); g.translate(-w / 2, -h / 2);
    g.globalAlpha = active ? 1 : 0.55;
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 30;
    roundRect(g, 0, 0, w, h, 28); g.fillStyle = '#222'; g.fill(); g.shadowBlur = 0; g.save(); g.clip();
    if (im) { const r = Math.max(w / im.width, h / im.height), iw = im.width * r, ih = im.height * r; g.drawImage(im, (w - iw) / 2, (h - ih) / 2 - (ih - h) * 0.15, iw, ih); }
    else { g.fillStyle = '#4a2a55'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center'; g.fillText(c.name[0], w / 2, h / 2 + 40); }
    g.restore();
    g.lineWidth = active ? 6 : 3; g.strokeStyle = active ? '#ff3b6b' : 'rgba(255,255,255,.5)'; roundRect(g, 0, 0, w, h, 28); g.stroke();
    // name tag
    g.font = 'bold 30px -apple-system, sans-serif'; const tw = g.measureText(c.name).width + 36;
    roundRect(g, (w - tw) / 2, h - 26, tw, 52, 26); g.fillStyle = active ? '#ff3b6b' : '#333'; g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(c.name, w / 2, h + 10);
    g.restore();
  };
  if (show.length === 1) portraitBox(show[0], 110, 250, 500, 640, !!(seg && seg.charId === show[0]));
  else if (show.length === 2) { portraitBox(show[0], 30, 300, 320, 440, seg?.charId === show[0]); portraitBox(show[1], 370, 300, 320, 440, seg?.charId === show[1]); }
  // bottom gradient
  const gr = g.createLinearGradient(0, H * 0.6, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.85)'); g.fillStyle = gr; g.fillRect(0, H * 0.6, W, H * 0.4);
  // captions
  if (seg && t < endVoice) {
    const { words, active } = captionChunk(seg, t);
    g.font = '900 54px -apple-system, "Arial Black", sans-serif'; g.textAlign = 'left'; g.lineJoin = 'round';
    const lines = wrap(g, words.join(' '), W - 100); let wi = 0, y = 1010;
    if (!seg.charId) { g.font = 'italic 800 46px -apple-system, sans-serif'; }
    for (const ln of lines) {
      const lw = g.measureText(ln).width; let x = (W - lw) / 2;
      for (const w of ln.split(' ')) {
        g.lineWidth = 10; g.strokeStyle = '#000'; g.strokeText(w, x, y);
        g.fillStyle = wi === active ? '#ffd93b' : '#fff'; g.fillText(w, x, y);
        x += g.measureText(w + ' ').width; wi++;
      }
      y += 66;
    }
  }
  // header: series + episode
  g.font = 'bold 26px -apple-system, sans-serif'; g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillText(`${series.name} · Ep ${(series.episodes || 0) + 1}`, 32, 70);
  // hook title for the first 3.2s
  if (t < 3.2) {
    const a = Math.min(1, t * 3, (3.2 - t) * 3);
    g.save(); g.globalAlpha = a; g.font = '900 64px -apple-system, "Arial Black", sans-serif'; g.textAlign = 'center';
    const ls = wrap(g, (script.hook || script.title).toUpperCase(), W - 80); let y = 170;
    for (const l of ls) { g.lineWidth = 12; g.strokeStyle = '#000'; g.strokeText(l, W / 2, y); g.fillStyle = '#ffd93b'; g.fillText(l, W / 2, y); y += 74; }
    g.restore();
  }
  // outro
  if (t >= endVoice) {
    const a = Math.min(1, (t - endVoice) * 2.5);
    g.fillStyle = `rgba(0,0,0,${0.75 * a})`; g.fillRect(0, 0, W, H);
    g.globalAlpha = a; g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '900 70px -apple-system, sans-serif';
    g.fillText('TO BE CONTINUED…', W / 2, H / 2 - 20);
    g.font = 'bold 38px -apple-system, sans-serif'; g.fillStyle = '#ffd93b';
    g.fillText(`Follow for Part ${(series.episodes || 0) + 2}`, W / 2, H / 2 + 50); g.globalAlpha = 1;
  }
  // progress bar on video (retention trick)
  g.fillStyle = '#ff3b6b'; g.fillRect(0, H - 8, W * Math.min(1, t / total), 8);
}

function pickMime() {
  const opts = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function musicBed(a, dest, total, scenes) {
  // soft, royalty-free synth pad so the video isn't silent between lines
  const gain = a.createGain(); gain.gain.value = 0.0; gain.connect(dest); gain.connect(a.destination);
  const t0 = a.currentTime; gain.gain.linearRampToValueAtTime(0.035, t0 + 1.5); gain.gain.setValueAtTime(0.035, t0 + total - 1.5); gain.gain.linearRampToValueAtTime(0, t0 + total);
  const chords = [[110, 130.81, 164.81], [87.31, 110, 130.81], [98, 123.47, 146.83], [82.41, 103.83, 123.47]];
  scenes.forEach((sc, i) => chords[i % 4].forEach(f => {
    const o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f; const og = a.createGain(); og.gain.value = 0.33;
    o.connect(og); og.connect(gain); o.start(t0 + sc.start); o.stop(t0 + sc.end + 0.05);
  }));
}

async function renderVideo(R, imgs) {
  const cv = $('#stage'), g = cv.getContext('2d'), a = audioCtx();
  const dest = a.createMediaStreamDestination();
  const stream = cv.captureStream(30);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video. Update iOS to 15 or newer and use Safari.');
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  drawFrame(g, 0, R, imgs);
  rec.start(1000);
  await sleep(150);
  const src = a.createBufferSource(); src.buffer = R.audio; src.connect(dest); src.connect(a.destination);
  const start = a.currentTime + 0.05; src.start(start);
  musicBed(a, dest, R.total, R.scenes);
  await new Promise(res => {
    const loop = () => {
      const t = a.currentTime - start;
      drawFrame(g, Math.max(0, t), R, imgs);
      progress(0.6 + 0.4 * Math.min(1, t / R.total), `Recording video… ${Math.max(0, Math.floor(t))}/${Math.ceil(R.total)}s (keep this screen open)`);
      if (t >= R.total) return res();
      requestAnimationFrame(loop);
    };
    loop();
  });
  await sleep(300); rec.stop(); await done;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

/* ---------- make video ---------- */
let lastBlob = null, lastName = 'drama.mp4';
$('#make-btn').onclick = async () => {
  if (!current) return;
  audioCtx(); // unlock audio on this tap (iOS)
  $('#progress-card').classList.remove('hidden'); $('#result-card').classList.add('hidden');
  $('#progress-card').scrollIntoView({ behavior: 'smooth' });
  btnBusy('#make-btn', 'Working…');
  try {
    progress(0.02, 'Loading cast pictures…');
    const imgs = {};
    // re-read so pictures drawn after the script was written are used too
    current.chars = await Promise.all(current.chars.map(async c => (await get('chars', c.id)) || c));
    current.places = await Promise.all(current.places.map(async p => (await get('places', p.id)) || p));
    for (const x of [...current.chars, ...current.places]) if (x.img) imgs[x.id] = await loadImg(x.img);
    const R = await voiceEpisode();
    progress(0.6, 'Recording video…');
    const blob = await renderVideo(R, imgs);
    lastBlob = blob; lastName = (current.script.title || 'drama').replace(/[^\w\- ]/g, '').slice(0, 40).trim().replace(/\s+/g, '-') + (blob.type.includes('mp4') ? '.mp4' : '.webm');
    // save the episode & move the series forward
    const s = current.series; s.episodes = (s.episodes || 0) + 1; s.summary = current.script.summary; await put('series', s);
    const caption = `${current.script.caption || current.script.title}\n\n${(current.script.hashtags || []).map(h => '#' + String(h).replace(/^#/, '').replace(/\s+/g, '')).join(' ')} #shortdrama #fyp`;
    await put('episodes', { id: uid(), seriesId: s.id, number: s.episodes, title: current.script.title, summary: current.script.summary, caption, createdAt: Date.now(), video: blob, name: lastName });
    showResult(blob, caption);
    renderSeries();
    progress(1, 'Done!');
  } catch (e) { console.error(e); alert(e.message); progress(null, 'Stopped: ' + e.message); }
  btnDone('#make-btn');
};
function showResult(blob, caption) {
  $('#result-video').src = URL.createObjectURL(blob);
  $('#caption-text').textContent = caption;
  $('#result-card').classList.remove('hidden');
  $('#result-card').scrollIntoView({ behavior: 'smooth' });
}
async function shareBlob(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
$('#save-btn').onclick = () => lastBlob && shareBlob(lastBlob, lastName, current?.script?.title);
$('#copy-caption-btn').onclick = async () => { await navigator.clipboard.writeText($('#caption-text').textContent); toast('Caption copied'); };

/* ---------- episodes ---------- */
async function renderEpisodes() {
  const eps = (await all('episodes')).sort((a, b) => b.createdAt - a.createdAt), ss = await all('series');
  $('#episode-list').innerHTML = eps.map(e => `<div class="ep"><div><b>${esc(e.title)}</b><br><small>${esc(ss.find(s => s.id === e.seriesId)?.name || '')} · Ep ${e.number} · ${new Date(e.createdAt).toLocaleDateString()}</small></div>
    <button class="ghost small" data-share="${e.id}">⬇️</button><button class="ghost small" data-cap="${e.id}">📋</button><button class="danger small" data-del="${e.id}">✕</button></div>`).join('') || '<p class="hint">No episodes yet.</p>';
  $$('[data-share]').forEach(b => b.onclick = async () => { const e = await get('episodes', b.dataset.share); e.video ? shareBlob(e.video, e.name, e.title) : alert('Video not stored.'); });
  $$('[data-cap]').forEach(b => b.onclick = async () => { const e = await get('episodes', b.dataset.cap); await navigator.clipboard.writeText(e.caption); toast('Caption copied'); });
  $$('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete this episode video?')) { await del('episodes', b.dataset.del); renderEpisodes(); } });
}

/* ---------- start ---------- */
fillVoices(); loadSettingsUI(); renderSeries();
if (!S.key) setTimeout(() => { $('[data-tab=settings]').click(); toast('Start by adding your Gemini API key'); }, 400);
if (navigator.storage?.persist) navigator.storage.persist();
