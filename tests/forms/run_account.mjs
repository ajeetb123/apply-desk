// Runs macos/account.js on the sign-in mocks in a headless Chrome (DevTools on
// port 9333) with test credentials only, and prints what each step did.
// usage: serve tests/forms on 8766, then: node tests/forms/run_account.mjs
import fs from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const helper = fs.readFileSync(new URL('../../macos/account.js', import.meta.url), 'utf8');
const base = 'http://127.0.0.1:8766/';
const user = { email: 'riley@example.com', name: 'Riley Test', google: true, agree: true };

async function page(url) {
  const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(800);
  const run = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  await run(helper + ';true');
  const call = (fn, arg = null) => run(`window.__applyDeskAccount.${fn}(${JSON.stringify(arg)})`);
  return { run, call, close: async () => { await send('Target.closeTarget', { targetId: target.id }); ws.close(); } };
}

const results = {};
// 1. New site, Google offered: press Google.
let p = await page(base + 'signin.html');
results.google = [await p.call('look'), await p.call('act', { ...user, password: '', known: false }), await p.run('window.mock.googlePressed')];
await p.close();
// 2. New site without Google: open Create Account, fill it, tick only the required terms box.
p = await page(base + 'signin.html?google=0');
const made = [await p.call('act', { ...user, google: false, password: '', known: false })];
made.push(await p.call('look'), await p.call('act', { ...user, google: false, password: 'New-Test-Pass-9', known: false }), await p.run('JSON.stringify(window.mock.created)'), await p.call('look'));
results.create = made;
await p.close();
// 3. Account made, site emails a link: the user verifies.
p = await page(base + 'signin.html?google=0&verify=1');
await p.call('act', { ...user, google: false, known: false });
await p.call('act', { ...user, google: false, password: 'New-Test-Pass-9', known: false });
results.verify = await p.call('look');
await p.close();
// 4. A site Apply Desk made an account on: sign in with the saved password.
p = await page(base + 'signin.html?google=0');
results.signin = [await p.call('act', { ...user, google: false, password: 'Known-Test-Pass-1', known: true }), await p.run('window.mock.signedIn'), await p.call('look')];
await p.close();
// 5. Google's pages: pick the right account; continue only for a plain sign-in.
for (const step of ['chooser', 'consent', 'more', 'password']) {
  p = await page(base + 'google.html?step=' + step);
  results['google_' + step] = [await p.call('google', user.email), await p.run('JSON.stringify(window.mock)')];
  await p.close();
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
