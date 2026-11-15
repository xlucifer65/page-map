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

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'content.js'] });
}

async function toContent(tab, cmd, args) {
  const blocklist = await getBlocklist();
  const current = await chrome.tabs.get(tab.id); // re-read: the tab may have navigated/redirected
  if (C.isBlocked(current.url || current.pendingUrl || '', blocklist) || C.isBlocked(current.pendingUrl || '', blocklist)) {
    return { ok: false, error: `tab ${tab.id} is on the page-map blocklist; nothing was read` };
  }
  const msg = { __pagemap: true, cmd, args, blocklist };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    const m = String(e && e.message);
    if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
      // Tab was open before the extension loaded (or a fresh navigation): inject and retry.
      await inject(tab.id);
      return await chrome.tabs.sendMessage(tab.id, msg);
    }
    if (/message (port|channel) closed|back\/forward cache|page.*(unload|moved)/i.test(m)) {
      // The action navigated away. Report the new page instead.
      return await afterNavigation(tab.id, blocklist);
    }
    throw e;
  }
}

// The action loaded a new page: hand back the new page's outline right away (saves the agent a turn).
async function afterNavigation(tabId, blocklist) {
  await new Promise((r) => setTimeout(r, 100));
  await waitForLoad(tabId);
  const t = await chrome.tabs.get(tabId);
  if (C.isBlocked(t.url || '', blocklist)) return { ok: true, text: 'page navigated → [blocked site]' };
  const o = await toContent(t, 'outline', {});
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

async function run(cmd, args) {
  if (cmd === 'reload_extension') { // dev: pick up new code (scripts/reload-ext.js)
    setTimeout(() => chrome.runtime.reload(), 100);
    return { ok: true, text: 'reloading' };
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

  const allowed = new Set(['outline', 'read_text', 'read_page', 'find', 'changes', 'click', 'type', 'select_option', 'scroll',
    'check', 'batch', 'fill_form', 'click_xy', 'type_text']);
  if (!allowed.has(cmd)) return { ok: false, error: `unknown command ${cmd}` };
  const urlBefore = tab.url;
  if (ACTIONS.has(cmd)) stepsByTab.set(tab.id, []);
  const res = await withSteps(tab.id, cmd, await toContent(tab, cmd, args));
  // The page answered before it started navigating (e.g. a form submit that loads a new page).
  if (ACTIONS.has(cmd) && !args.quiet && res && res.ok && !/^page navigated/.test(res.text || '')) {
    await new Promise((r) => setTimeout(r, 150));
    const t = await chrome.tabs.get(tab.id);
    if (t.status === 'loading' || (t.url && t.url.split('#')[0] !== String(urlBefore).split('#')[0])) {
      const nav = await afterNavigation(tab.id, await getBlocklist());
      return { ...res, url: (await chrome.tabs.get(tab.id)).url, text: `${res.text}\n${nav.text}` };
    }
  }
  return res;
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
