// Microsoft Edge voice relay for Short Drama Studio (Cloudflare Worker)
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
async function gec() {
  let t = Math.floor(Date.now() / 1000) + 11644473600; t -= t % 300;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BigInt(t) * 10000000n + TOKEN));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const q = new URL(req.url).searchParams, text = q.get('text'), voice = q.get('voice') || 'en-US-AvaMultilingualNeural';
    if (!text) return new Response('ok', { headers: CORS });
    const id = crypto.randomUUID().replace(/-/g, '');
    const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${await gec()}&Sec-MS-GEC-Version=1-143.0.3650.75&ConnectionId=${id}`;
    const r = await fetch(url, { headers: { Upgrade: 'websocket', Pragma: 'no-cache', 'Cache-Control': 'no-cache', Cookie: 'muid=' + crypto.randomUUID().replace(/-/g, '').toUpperCase() + ';', Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0' } });
    const ws = r.webSocket; if (!ws) return new Response('Microsoft refused: ' + r.status, { status: 502, headers: CORS });
    ws.accept();
    const chunks = [];
    const done = new Promise((res, rej) => {
      ws.addEventListener('message', e => {
        if (typeof e.data === 'string') { if (e.data.includes('Path:turn.end')) res(); return; }
        const b = new Uint8Array(e.data), h = (b[0] << 8) | b[1];
        if (new TextDecoder().decode(b.slice(2, 2 + h)).includes('Path:audio')) chunks.push(b.slice(2 + h));
      });
      ws.addEventListener('close', () => res()); ws.addEventListener('error', rej);
      setTimeout(() => rej(new Error('timeout')), 25000);
    });
    const ts = new Date().toString();
    ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
    ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${esc(voice)}'><prosody pitch='+0Hz' rate='${q.get('rate') || '+0%'}' volume='+0%'>${esc(text)}</prosody></voice></speak>`);
    try { await done; } catch (e) { if (!chunks.length) return new Response('Voice failed: ' + e.message, { status: 502, headers: CORS }); }
    try { ws.close(); } catch {}
    if (!chunks.length) return new Response('No audio', { status: 502, headers: CORS });
    return new Response(new Blob(chunks), { headers: { ...CORS, 'Content-Type': 'audio/mpeg' } });
  }
};
