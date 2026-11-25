// Runs one of batch.js's helpers on a page in a separate headless Chrome (DevTools on port 9333).
// usage: node tests/forms/run_batch.mjs <url> "<collect()|confirmed()|submit()>" ["<JS to run first>"] ["<JS to read after>"]
import fs from 'node:fs';
const [, , url, call, before = '', after = ''] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;
await send('Page.enable'); await send('Page.navigate', { url }); await sleep(1500);
if (before) await evaluate(before);
const source = fs.readFileSync(new URL('../../macos/batch.js', import.meta.url), 'utf8');
console.log(JSON.stringify({ result: JSON.parse(await evaluate(source + `\nJSON.stringify(window.__applyDeskBatch.${call})`)), after: after ? await evaluate(after) : undefined }));
await send('Target.closeTarget', { targetId: target.id }); process.exit(0);
