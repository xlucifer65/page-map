// Page-Map service worker: bridge between the native host (→ MCP server) and tabs.
importScripts('core.js');

const HOST = 'com.pagemap.host';
const C = globalThis.PageMapCore;
let port = null;
let backoff = 1000;
let portOpenedAt = 0;
let retryTimer = null;

async function getBlocklist() {
  const { blocklist } = await chrome.storage.local.get('blocklist');
  return Array.isArray(blocklist) ? blocklist : C.DEFAULT_BLOCKLIST;
}

function connect() {
  if (port) return;
  retryTimer = null;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  portOpenedAt = Date.now();
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // consume ("host not found" etc.)
    port = null;
    // Only a port that stayed up a while counts as success; instant failures keep backing off.
    scheduleReconnect(Date.now() - portOpenedAt);
  });
}

function scheduleReconnect(livedMs = 0) {
  if (retryTimer) return;
  const { wait, next } = C.nextBackoff(backoff, livedMs);
  backoff = next;
  retryTimer = setTimeout(connect, wait);
}

// setTimeout dies with the service worker; an alarm wakes it up to retry (e.g. after install-host).
chrome.alarms.create('pagemap-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pagemap-reconnect' && !port) connect(); });

const TEXT_CAP = 512 * 1024; // keep replies far from any messaging limit
function reply(id, payload) {
  if (payload && typeof payload.text === 'string' && payload.text.length > TEXT_CAP) {
    payload = { ...payload, text: payload.text.slice(0, TEXT_CAP) + '\n… truncated (use find or max_items)' };
  }
  if (port) port.postMessage({ id, ...payload });
}

async function onHostMessage(msg) {
  if (!msg || typeof msg.id === 'undefined' || typeof msg.cmd !== 'string') return;
  try {
    reply(msg.id, await run(msg.cmd, msg.args || {}));
  } catch (e) {
    reply(msg.id, { ok: false, error: String((e && e.message) || e) });
  }
}

async function resolveTab(tabId) {
  if (tabId != null) {
    try { return await chrome.tabs.get(Number(tabId)); } catch (_) { throw new Error(`tab ${tabId} not found (call list_tabs)`); }
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (t) return t;
  const [any] = await chrome.tabs.query({ active: true });
  if (!any) throw new Error('no active tab');
  return any;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(t); resolve(); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }, done);
  });
}

async function frameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    return [...new Set(results.map((r) => r.frameId).filter((id) => Number.isInteger(id)))].sort((a, b) => a - b);
  } catch (_) {
    return [0];
  }
}

function splitFrameRef(ref) {
  const m = String(ref || '').match(/^f(\d+):(.+)$/);
  return m ? { frameId: Number(m[1]), ref: m[2] } : null;
}

function namespaceRefs(text, frameId) {
  return String(text || '').replace(/\b[a-z]{4}\d+\b/g, (ref) => `f${frameId}:${ref}`);
}

async function toContentFrame(tab, frameId, cmd, args) {
  const blocklist = await getBlocklist();
  const current = await chrome.tabs.get(tab.id); // re-read: the tab may have navigated/redirected
  if (C.isBlocked(current.url || current.pendingUrl || '', blocklist) || C.isBlocked(current.pendingUrl || '', blocklist)) {
    return { ok: false, error: `tab ${tab.id} is on the page-map blocklist; nothing was read` };
  }
  const targetArgs = { ...args };
  const framed = splitFrameRef(targetArgs.ref);
  if (framed) {
    if (framed.frameId !== frameId) return { ok: false, error: `ref ${targetArgs.ref} belongs to frame ${framed.frameId}` };
    targetArgs.ref = framed.ref;
  }
  const msg = { __pagemap: true, cmd, args: targetArgs, blocklist };
  const namespaceActionResult = (result) => (
    framed && result && result.ok && typeof result.text === 'string'
      ? { ...result, text: namespaceRefs(result.text, frameId) }
      : result
  );
  try {
    return namespaceActionResult(await chrome.tabs.sendMessage(tab.id, msg, { frameId }));
  } catch (e) {
    const m = String(e && e.message);
    if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
      // Tab was open before the extension loaded (or a fresh navigation): inject and retry.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ['core.js', 'content.js'] });
      return namespaceActionResult(await chrome.tabs.sendMessage(tab.id, msg, { frameId }));
    }
    if (/message (port|channel) closed|back\/forward cache|page.*(unload|moved)/i.test(m)) {
      // The action navigated away. Report the new page instead.
      if (frameId !== 0) return await afterFrameNavigation(tab, frameId, blocklist);
      return await afterNavigation(tab.id, blocklist, true);
    }
    throw e;
  }
}

// The action navigated a sub-frame: hand back that frame's new outline with namespaced refs.
async function afterFrameNavigation(tab, frameId, blocklist) {
  await new Promise((r) => setTimeout(r, 100));
  await waitForLoad(tab.id);
  const t = await chrome.tabs.get(tab.id);
  if (C.isBlocked(t.url || '', blocklist)) return { ok: true, text: 'page navigated → [blocked site]' };
  let o;
  try { o = await toContentFrame(tab, frameId, 'outline', { auto_dismiss: false }); } catch (e) { o = { ok: false, error: String((e && e.message) || e) }; }
  return { ok: true, text: `frame ${frameId} navigated\n${o.ok ? namespaceRefs(o.text, frameId) : o.error}` };
}

async function toContent(tab, cmd, args) {
  const framed = splitFrameRef(args.ref);
  if (framed) return toContentFrame(tab, framed.frameId, cmd, args);

  const aggregate = new Set(['outline', 'read_page', 'find', 'read_text']);
  if (!aggregate.has(cmd)) return toContentFrame(tab, 0, cmd, args);

  const ids = await frameIds(tab.id);
  if (ids.length === 1) return toContentFrame(tab, ids[0], cmd, args);
  const results = await Promise.all(ids.map(async (frameId) => {
    try {
      const result = await toContentFrame(tab, frameId, cmd, args);
      if (!result.ok) return { frameId, result };
      return {
        frameId,
        result: {
          ...result,
          text: cmd === 'read_text' ? result.text : namespaceRefs(result.text, frameId),
        },
      };
    } catch (e) {
      return { frameId, result: { ok: false, error: String((e && e.message) || e) } };
    }
  }));
  const good = results.filter(({ result }) => result.ok);
  if (!good.length) return results[0]?.result || { ok: false, error: 'no frame responded' };
  const text = good.map(({ frameId, result }) => {
    const heading = frameId === 0 ? '' : `\n[iframe frame ${frameId}]\n`;
    return heading + result.text;
  }).join('\n');
  const failed = results.filter(({ result }) => !result.ok);
  return {
    ok: true,
    text: text + (failed.length ? `\n… ${failed.length} frame${failed.length === 1 ? '' : 's'} unavailable` : ''),
  };
}

// The action loaded a new page: hand back the new page's outline right away (saves the agent a turn).
// afterAction: the action already ran the popup auto-closer with full context (what it opened, where the agent
// was working), so this outline must not run it again blindly — it would close the dialog the action opened.
async function afterNavigation(tabId, blocklist, afterAction = false) {
  await new Promise((r) => setTimeout(r, 100));
  await waitForLoad(tabId);
  const t = await chrome.tabs.get(tabId);
  if (C.isBlocked(t.url || '', blocklist)) return { ok: true, text: 'page navigated → [blocked site]' };
  const o = await toContent(t, 'outline', afterAction ? { auto_dismiss: false } : {});
  return { ok: true, text: `page navigated → ${t.url}\n${o.ok ? o.text : o.error}` };
}

const ACTIONS = new Set(['click', 'type', 'select_option', 'check', 'batch', 'fill_form']);

// Steps performed during the current action command, per tab, reported by the content script
// as they happen (so steps survive a page navigation). Used by the MCP server to build recipes.
const stepsByTab = new Map();
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only our own content scripts (sender.tab set, same extension id); data only, never commands.
  if (sender.id !== chrome.runtime.id || !sender.tab || !msg || msg.__pagemapStep !== true) return;
  const list = stepsByTab.get(sender.tab.id);
  if (list && list.length < 100 && msg.step && typeof msg.step.action === 'string') list.push(msg.step);
});

function withSteps(tabId, cmd, res) {
  if (!ACTIONS.has(cmd) || !res) return res;
  const steps = stepsByTab.get(tabId) || [];
  stepsByTab.delete(tabId);
  return { ...res, steps };
}

// In-flight uploads: files arrive from the MCP server in chunks (Chrome caps host messages at 1 MB).
const uploads = new Map();

// MAIN-world hook: when armed (data-pm-arm on <html>), a page's own fileInput.click()/showPicker()
// is captured instead of opening the OS file picker — the input is marked (and attached if detached)
// so the content script can fill it. Normal user clicks are untouched (hook only fires when armed).
function installUploadHook() {
  if (window.__pmUploadHook) return;
  window.__pmUploadHook = true;
  const capture = (inp) => {
    const root = document.documentElement;
    if (inp.type !== 'file' || root.getAttribute('data-pm-arm') !== '1') return false;
    root.removeAttribute('data-pm-arm');
    if (!inp.isConnected) { inp.style.display = 'none'; root.appendChild(inp); }
    inp.setAttribute('data-pm-upload', '1');
    return true;
  };
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (capture(this)) return; return click.call(this); };
  const show = HTMLInputElement.prototype.showPicker;
  if (show) HTMLInputElement.prototype.showPicker = function () { if (capture(this)) return; return show.call(this); };
}

async function run(cmd, args) {
  if (cmd === 'upload_begin') {
    if (!args.id || !Array.isArray(args.files)) return { ok: false, error: 'bad upload' };
    uploads.set(args.id, { files: args.files.map((f) => ({ name: String(f.name), type: String(f.type || ''), chunks: [] })) });
    setTimeout(() => uploads.delete(args.id), 60000);
    return { ok: true, text: 'ready' };
  }
  if (cmd === 'upload_chunk') {
    const u = uploads.get(args.id);
    if (!u || !u.files[args.index]) return { ok: false, error: 'unknown upload' };
    u.files[args.index].chunks.push(String(args.data || ''));
    return { ok: true, text: 'ok' };
  }
  if (cmd === 'reload_extension') { // dev: pick up new code (scripts/reload-ext.js)
    setTimeout(() => chrome.runtime.reload(), 100);
    return { ok: true, text: 'reloading' };
  }
  if (cmd === 'close_tabs') { // maintenance: close specific tabs by id (never "all")
    const ids = (args.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return { ok: false, error: 'ids required' };
    await chrome.tabs.remove(ids);
    return { ok: true, text: `closed ${ids.length} tabs` };
  }
  if (cmd === 'hello') return { ok: true, text: `page-map extension ${chrome.runtime.getManifest().version}` };

  if (cmd === 'list_tabs') {
    const tabs = await chrome.tabs.query({});
    const bl = await getBlocklist();
    const lines = tabs.map((t) => {
      const head = `${t.id}${t.active ? '*' : ''}`;
      if (C.isBlocked(t.url || '', bl)) {
        let host = ''; try { host = new URL(t.url).hostname; } catch (_) {}
        return `${head} [blocked] ${host}`; // no title/path: they can hold emails, message ids
      }
      return `${head} "${(t.title || '').slice(0, 70)}" ${t.url}`;
    });
    return { ok: true, text: lines.join('\n') + '\n(* = active in its window)' };
  }

  if (cmd === 'navigate') {
    if (!/^https?:\/\//i.test(args.url || '')) return { ok: false, error: 'url must start with http:// or https://' };
    if (C.isBlocked(args.url, await getBlocklist())) return { ok: false, error: 'that site is on the page-map blocklist' };
    let tab;
    // background=true keeps focus where it is (parallel agents each work in their own tab).
    if (args.new_tab) tab = await chrome.tabs.create({ url: args.url, active: !args.background });
    else { tab = await resolveTab(args.tab); await chrome.tabs.update(tab.id, { url: args.url }); }
    await new Promise((r) => setTimeout(r, 100));
    await waitForLoad(tab.id);
    if (args.quiet) { // vision mode: don't hand out structure
      const t = await chrome.tabs.get(tab.id);
      return C.isBlocked(t.url || '', await getBlocklist()) ? { ok: false, error: 'blocked site' } : { ok: true, tabId: tab.id, text: `tab ${tab.id} loaded ${t.url}` };
    }
    const res = await toContent(await chrome.tabs.get(tab.id), 'outline', {});
    return res.ok ? { ok: true, tabId: tab.id, text: `tab ${tab.id}\n${res.text}` } : res;
  }

  const tab = await resolveTab(args.tab);
  if (!/^https?:|^file:/i.test(tab.url || '')) return { ok: false, error: `tab ${tab.id} is a browser page (${tab.url}); page-map only reads web pages` };
  if (C.isBlocked(tab.url, await getBlocklist())) return { ok: false, error: `tab ${tab.id} is on the page-map blocklist; nothing was read` };

  if (cmd === 'screenshot') {
    const blockedNow = async () => {
      const t = await chrome.tabs.get(tab.id);
      const bl = await getBlocklist();
      return C.isBlocked(t.url || '', bl) || C.isBlocked(t.pendingUrl || '', bl);
    };
    if (await blockedNow()) return { ok: false, error: `tab ${tab.id} is on the page-map blocklist; nothing was captured` };
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    if (await blockedNow()) return { ok: false, error: `tab ${tab.id} is on the page-map blocklist; nothing was captured` };
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    return { ok: true, image: data.replace(/^data:image\/jpeg;base64,/, ''), mime: 'image/jpeg' };
  }

  if (cmd === 'vision_screenshot') {
    // Screenshot scaled to CSS pixels, so x/y the model reads off the image are click_xy coordinates.
    if (C.isBlocked((await chrome.tabs.get(tab.id)).url || '', await getBlocklist())) return { ok: false, error: 'blocked site' };
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    const vp = await toContent(tab, 'viewport', {});
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const bmp = await createImageBitmap(await (await fetch(shot)).blob());
    const canvas = new OffscreenCanvas(vp.w, vp.h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, vp.w, vp.h);
    const buf = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { ok: true, image: btoa(bin), mime: 'image/jpeg', w: vp.w, h: vp.h };
  }

  if (cmd === 'upload_commit') {
    const u = uploads.get(args.id);
    uploads.delete(args.id);
    if (!u) return { ok: false, error: 'upload expired or unknown' };
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: installUploadHook }); } catch (_) {}
    const files = u.files.map((f) => ({ name: f.name, type: f.type, b64: f.chunks.join('') }));
    return await toContent(tab, 'upload', { ref: args.ref, label: args.label, files });
  }

  const allowed = new Set(['outline', 'read_text', 'read_page', 'find', 'changes', 'click', 'type', 'select_option', 'scroll',
    'check', 'batch', 'fill_form', 'click_xy', 'type_text', 'key']);
  if (!allowed.has(cmd)) return { ok: false, error: `unknown command ${cmd}` };
  const urlBefore = tab.url;
  if (ACTIONS.has(cmd)) stepsByTab.set(tab.id, []);
  const res = await withSteps(tab.id, cmd, await toContent(tab, cmd, args));
  // The page answered before it started navigating (e.g. a form submit that loads a new page).
  if (ACTIONS.has(cmd) && !args.quiet && res && res.ok && !/^(page|frame \d+) navigated/.test(res.text || '')) {
    await new Promise((r) => setTimeout(r, 150));
    const t = await chrome.tabs.get(tab.id);
    // Only a real page change counts: SPAs rewrite the query string when a dialog opens (same origin + path).
    const page = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (_) { return String(u).split('#')[0]; } };
    if (t.status === 'loading' || (t.url && page(t.url) !== page(urlBefore))) {
      const nav = await afterNavigation(tab.id, await getBlocklist(), true);
      return { ...res, url: (await chrome.tabs.get(tab.id)).url, text: `${res.text}\n${nav.text}` };
    }
  }
  return res;
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
