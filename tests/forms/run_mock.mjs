// Drives a headless Chrome (DevTools on port 9333) through one mock form with autofill.js.
// usage: node tests/forms/run_mock.mjs <url> <plan.json> [check expression file]
import fs from 'node:fs';
const [, , url, planPath, checkPath] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result.result.value;
};
const b64 = buf => Buffer.from(buf).toString('base64');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(1200);
await evaluate('localStorage.clear(); sessionStorage.clear(); true');
await send('Page.reload', {});
await sleep(1500);
await evaluate(fs.readFileSync(process.env.FILLER || new URL('../../macos/autofill.js', import.meta.url), 'utf8') + '\n;true');
const started = Date.now();
await evaluate(`applyDeskFill(${JSON.stringify(b64(fs.readFileSync(planPath)))}, ${JSON.stringify(b64('%PDF-1.4 made-up test resume'))}, ${JSON.stringify(b64('Riley_Test_Resume.pdf'))})`);
let status = {}, waited = 0;
for (let i = 0; i < 600; i += 1) {
  await sleep(500);
  status = JSON.parse(await evaluate('(window.__applyDeskPump && window.__applyDeskPump(), JSON.stringify({ done: window.__applyDeskFill.done, needs: window.__applyDeskFill.needs, waiting: window.__applyDeskFill.waiting }))'));
  if (status.done) break;
  waited = status.waiting ? waited + 1 : 0;
  if (waited >= 8) { status.stoppedWaiting = true; break; }  // the run is waiting on the user: report it
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const items = await evaluate('JSON.stringify(window.__applyDeskFill.items)');
const check = checkPath ? await evaluate(fs.readFileSync(checkPath, 'utf8')) : null;
console.log(JSON.stringify({ seconds, done: status.done, needs: status.needs, items: JSON.parse(items), check }, null, 1));
await send('Target.closeTarget', { targetId: target.id }).catch(() => {});
ws.close();
process.exit(0);
