// Page-Map core: turns a live DOM into a compact, ref-addressable structure.
// Pure functions over (window, document) so it runs both as a content script
// and inside jsdom for unit tests. Exposed as globalThis.PageMapCore.
(function (root) {
  'use strict';

  const CANDIDATES = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'img',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '[role]', '[onclick]', '[contenteditable=""]', '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const LANDMARK_TAGS = { header: 'banner', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo', form: 'form', search: 'search' };
  const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'search', 'region', 'dialog', 'alertdialog']);
  // Roles that only add noise when they carry no name (layout wrappers).
  const NOISE_ROLES = new Set(['presentation', 'none', 'generic', 'group', 'list', 'listitem', 'row', 'cell', 'gridcell', 'rowgroup', 'separator', 'img-decorative']);

  const NAME_MAX = 80;
  const VALUE_MAX = 40;
  const MAX_VISIT = 60000;

  const DEFAULT_BLOCKLIST = [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'accounts.google.com', 'login.microsoftonline.com', 'gmail.com', 'outlook.com', 'mail.yahoo.com',
    'icloud.com', 'proton.me', 'fastmail.com', 'mail.zoho.com', 'mail.*', 'webmail.*',
    'web.whatsapp.com', 'messages.google.com', 'messenger.com', 'web.telegram.org',
    'paypal.com', 'venmo.com', 'revolut.com', 'wise.com', 'dashboard.stripe.com', 'connect.stripe.com',
    'coinbase.com', 'n26.com', 'monzo.com', 'lydia-app.com',
    'chase.com', 'wellsfargo.com', 'citi.com', 'americanexpress.com', 'capitalone.com',
    'hsbc.*', 'barclays.*', 'natwest.com', 'santander.*', 'bnpparibas', 'bnpparibas.*', 'societegenerale.*',
    'sg.fr', 'credit-agricole.fr', 'creditmutuel.fr', 'cic.fr', 'lcl.fr', 'caisse-epargne.fr',
    'boursorama.com', 'fortuneo.fr', 'ing.*', 'deutsche-bank.*', 'commerzbank.*', 'ameli.fr', 'impots.gouv.fr',
    'bank*.*', '*bank.*', '*.bank', '*banque*',
    '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com',
    // '!' entries are exceptions that win over the patterns above.
    '!worldbank.org', '!bankrate.com', '!databank.*',
    '!teams.microsoft.com', '!teams.cloud.microsoft', '!teams.live.com', // Teams: allowed (user choice)
    '!sharepoint.com', // SharePoint / OneDrive for Business docs: allowed (user choice)
  ];
  // Patterns without '*' also cover subdomains: 'chase.com' blocks 'secure.chase.com'.

  // ---------- refs (WeakMap: no DOM mutation, page cannot spoof refs) ----------
  // `prefix` is random per page load (content script) so a ref from a previous page can
  // never silently resolve to a different element on the new page.
  function createRefs(prefix = '') {
    let next = 1;
    const byEl = new WeakMap();
    const byRef = new Map();
    return {
      refOf(el) {
        let r = byEl.get(el);
        if (r === undefined) {
          r = prefix + (next++);
          byEl.set(el, r);
          byRef.set(r, new WeakRef(el));
        }
        return r;
      },
      prefix,
      resolve(ref) {
        const key = String(ref);
        const w = byRef.get(key);
        const el = w && w.deref();
        if (!el || !el.isConnected) { byRef.delete(key); return null; }
        return el;
      },
      foreign(ref) { return !!prefix && !String(ref).startsWith(prefix); },
      size() { return byRef.size; },
    };
  }

  // ---------- helpers ----------
  const clean = (s, max = NAME_MAX) => {
    if (s == null) return '';
    s = maskCards(String(s).replace(/\s+/g, ' ').trim());
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  function textOf(el) {
    const t = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return clean(t);
  }

  function isSecret(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(cc-|current-password|new-password|one-time-code)/.test(ac)) return true;
    let labels = '';
    try { labels = Array.from(el.labels || []).map((l) => l.textContent).join(' '); } catch (_) {}
    const words = toWords([el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labels].join(' '));
    return SECRET_WORDS.test(words);
  }

  // "securityCode" / "cc_csc" / "Card-Number" → "security code" / "cc csc" / "card number"
  function toWords(s) {
    return ' ' + String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  }
  // Whole words only: "passenger", "passport", "compass", "secretary", "classname" are NOT secrets.
  const SECRET_WORDS = new RegExp(' (' + [
    'password', 'passwd', 'pass', 'passcode', 'pass phrase', 'passphrase', 'pwd', 'pw', 'pin', 'pin code',
    'otp', 'totp', 'mfa( code)?', '2fa( code)?', 'code ?2fa', 'one time (code|password|passcode)', 'verification code',
    'auth(entication)? code', 'security code', 'cvv2?', 'cvc2?', 'cc (num|number|csc|cvv|cvc|exp|expiry)',
    'card (num|number|no)', 'cardnumber', 'credit card', 'expiry( date)?', 'expiration( date)?', 'exp date',
    'ssn', 'social security( number)?', 'tax id', 'iban', 'account (num|number|no)', 'routing (num|number|no)',
    'sort code', 'api key', 'apikey', 'secret', 'client secret', 'token', 'access token', 'auth token',
    'access key', 'private key', 'recovery (code|phrase)', 'seed phrase',
  ].join('|') + ') ');

  // Replace Luhn-valid 13–19 digit runs (cards) inside any text with <card>.
  function maskCards(s) {
    if (!/\d{4}/.test(s)) return s;
    return s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (run) => (looksLikeCard(run) ? '<card>' : run));
  }

  // Luhn-valid 13–19 digit strings are masked whatever the field is called.
  function looksLikeCard(v) {
    const d = String(v || '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return 'link';
      case 'button': case 'summary': return 'button';
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return (el.getAttribute('alt') === '') ? 'img-decorative' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'search') return 'searchbox';
        if (t === 'file') return 'file';
        if (t === 'password') return 'password';
        return 'textbox';
      }
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') return 'textbox';
    return el.hasAttribute('onclick') ? 'clickable' : 'focusable';
  }

  function labelText(el, doc) {
    try {
      if (el.labels && el.labels.length) {
        // A wrapping <label> also contains the control itself (e.g. a select's options): strip controls.
        return clean(Array.from(el.labels).map(l => {
          const c = l.cloneNode(true);
          c.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
          return c.textContent;
        }).join(' '));
      }
    } catch (_) { /* some elements throw on .labels */ }
    return '';
  }

  function nameOf(el, doc, role) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map(id => (doc.getElementById(id) || {}).textContent || '').join(' ');
      if (clean(t)) return clean(t);
    }
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return clean(aria);
    const lab = labelText(el, doc);
    if (lab) return lab;
    const tag = el.tagName;
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) {
      const alt = el.getAttribute('alt');
      if (clean(alt)) return clean(alt);
    }
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) {
      return clean(el.value || el.type);
    }
    const title = el.getAttribute('title');
    if (clean(title)) return clean(title);
    const ph = el.getAttribute('placeholder');
    if (clean(ph)) return clean(ph);
    // Inputs/selects never fall back to their text (select text = all options).
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return '';
    if (tag === 'IMG') {
      const src = (el.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop();
      return clean(src, 40);
    }
    if (role === 'textbox') return '';
    return textOf(el);
  }

  function valueOf(el, role) {
    if (isSecret(el)) return el.value ? '<secret>' : undefined;
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.selectedOptions || []).map(o => clean(o.textContent, VALUE_MAX));
      return opts.length ? opts.join(', ') : undefined;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.type || '').toLowerCase();
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(t)) return undefined;
      return el.value ? clean(el.value, VALUE_MAX) : undefined;
    }
    if (role === 'textbox' && el.isContentEditable) {
      const t = clean(el.textContent, VALUE_MAX);
      return t || undefined;
    }
    return undefined;
  }

  function flagsOf(el, doc) {
    const f = [];
    const aria = (k) => el.getAttribute('aria-' + k);
    if (el.checked === true || aria('checked') === 'true') f.push('checked');
    if (el.disabled === true || aria('disabled') === 'true') f.push('disabled');
    if (aria('expanded') === 'true') f.push('expanded');
    else if (aria('expanded') === 'false') f.push('collapsed');
    if (el.selected === true || aria('selected') === 'true') f.push('selected');
    if (aria('current') && aria('current') !== 'false') f.push('current');
    if (el.required === true || aria('required') === 'true') f.push('required');
    if (doc.activeElement === el) f.push('focused');
    if (isSecret(el)) f.push('secret');
    return f;
  }

  function isHidden(el, win) {
    if (el.hidden) return true;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') return true;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return true;
    } else {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
        const cs = win.getComputedStyle(n);
        if (cs.display === 'none') return true;
        if (n === el && cs.visibility === 'hidden') return true;
      }
    }
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true') return true;
    }
    const r = el.getBoundingClientRect();
    return r.width <= 0 || r.height <= 0;
  }

  function inViewport(el, win) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }

  // Depth-first walk over the document including open shadow roots, in document order.
  function walk(doc, visit, maxVisit = MAX_VISIT) {
    const stack = [doc.documentElement];
    let n = 0;
    while (stack.length && n < maxVisit) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      n++;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
      visit(el);
      const kids = [];
      if (el.shadowRoot) for (const c of el.shadowRoot.children) kids.push(c);
      for (const c of el.children) kids.push(c);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return n;
  }

  const capNote = (max) => `page very large: scan stopped after ${max} nodes`;

  // ---------- public API ----------
  function snapshot(win, doc, refs, opts = {}) {
    const viewportOnly = opts.viewportOnly === true;
    const maxItems = opts.maxItems || 300;
    const maxVisit = opts.maxVisit || MAX_VISIT;
    const roleFilter = opts.role ? String(opts.role).toLowerCase() : null;
    const items = [];
    let total = 0;
    let offscreen = 0;
    const visited = walk(doc, (el) => {
      if (!el.matches(CANDIDATES)) return;
      if (isHidden(el, win)) return;
      const role = roleOf(el);
      if (role === 'img-decorative') return;
      const name = nameOf(el, doc, role);
      if (NOISE_ROLES.has(role) && !name) return;
      if ((role === 'focusable' || role === 'clickable') && !name) return;
      if (roleFilter && role !== roleFilter) return;
      total++;
      const inView = inViewport(el, win);
      if (viewportOnly && !inView) { offscreen++; return; }
      if (items.length >= maxItems) return;
      const item = { ref: refs.refOf(el), role, name };
      if (role === 'heading') item.level = Number((el.tagName.match(/^H(\d)$/) || [])[1] || el.getAttribute('aria-level') || 2);
      const v = valueOf(el, role);
      if (v !== undefined) item.value = v;
      const f = flagsOf(el, doc);
      if (f.length) item.flags = f;
      items.push(item);
    }, maxVisit);
    return {
      url: String(win.location.href),
      title: clean(doc.title, 120),
      items,
      total,
      offscreen,
      truncated: total - offscreen > items.length,
      capped: visited >= maxVisit,
      maxVisit,
    };
  }

  function formatItem(it) {
    let s = `${it.ref} ${it.role}${it.level ? it.level : ''} "${it.name.replace(/"/g, "'")}"`;
    if (it.value !== undefined) s += ` =${JSON.stringify(it.value)}`;
    if (it.flags) s += ` [${it.flags.join(',')}]`;
    return s;
  }

  function format(snap) {
    const head = `${snap.title} — ${snap.url}`;
    const lines = snap.items.map(formatItem);
    const tail = [];
    if (snap.offscreen) tail.push(`${snap.offscreen} more off-screen (scroll or viewport_only=false)`);
    if (snap.capped) tail.push(capNote(snap.maxVisit));
    if (snap.truncated) tail.push(`truncated at ${snap.items.length}/${snap.total - snap.offscreen} (raise max_items or use find)`);
    return [head, ...lines, ...(tail.length ? ['… ' + tail.join('; ')] : [])].join('\n');
  }

  function outline(win, doc, refs, opts = {}) {
    const lines = [];
    const counts = {};
    const maxVisit = opts.maxVisit || MAX_VISIT;
    const visited = walk(doc, (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || LANDMARK_TAGS[tag];
      const isLandmark = role && LANDMARK_ROLES.has(role) && (tag !== 'header' && tag !== 'footer' || !el.closest('article,aside,main,nav,section'));
      const isHeading = /^h[1-6]$/.test(tag) || role === 'heading';
      if (!isLandmark && !isHeading && !el.matches(CANDIDATES)) return;
      if (isHidden(el, win)) return;
      if (isLandmark) {
        const name = clean(el.getAttribute('aria-label') || '', 40);
        lines.push(`[${role}${name ? ' "' + name + '"' : ''}]`);
        return;
      }
      if (isHeading) {
        const lvl = Number(tag[1]) || Number(el.getAttribute('aria-level')) || 2;
        lines.push(`${'  '.repeat(Math.max(0, lvl - 1))}${refs.refOf(el)} h${lvl} "${textOf(el)}"`);
        return;
      }
      const r = roleOf(el);
      if (r === 'img-decorative' || r === 'focusable' || r === 'clickable') return;
      counts[r] = (counts[r] || 0) + 1;
    }, maxVisit);
    const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
    const pct = Math.round(100 * Math.min(1, (win.scrollY || 0) / max));
    const countStr = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ');
    // A short preview of the main text lets the agent answer simple reading tasks without another call.
    const preview = readText(win, doc, { maxChars: opts.previewChars ?? 700 });
    return [
      `${clean(doc.title, 120)} — ${win.location.href}`,
      `scroll ${pct}% · ${countStr || 'no interactive elements'}`,
      ...lines.slice(0, 60),
      ...(lines.length > 60 ? [`… ${lines.length - 60} more headings/landmarks`] : []),
      ...(visited >= maxVisit ? [`… ${capNote(maxVisit)}`] : []),
      ...(preview.text ? ['--- text preview ---', preview.text, ...(preview.rest > 0 ? [`… ${preview.rest} more chars (read_text)`] : [])] : []),
    ].join('\n');
  }

  // ---------- main-content text (for reading tasks) ----------
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL', 'LI',
    'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'FORM',
    'FIELDSET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'BR', 'CENTER', 'DETAILS', 'SUMMARY']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION']);

  // The page's main content root: <main>/[role=main]/<article> when they hold real text, else <body>.
  function mainRoot(doc) {
    for (const sel of ['main', '[role="main"]', 'article']) {
      const el = doc.querySelector(sel);
      if (el && (el.textContent || '').trim().length > 200) return el;
    }
    return doc.body;
  }

  function hiddenFast(el, win) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (typeof el.checkVisibility === 'function' && el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const cs = win.getComputedStyle(el);
    // display:contents elements (MDN's <main>, many design systems) have no box, so checkVisibility()
    // reports them hidden although their children render.
    if (cs.display === 'contents') return false;
    if (typeof el.checkVisibility === 'function') return true;
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  // Visible text in reading order as light markdown: "## heading", "- item", "a | b" table rows.
  // Page chrome (nav/footer/aside/dialogs) is skipped when reading from <body>.
  function readText(win, doc, opts = {}) {
    const root = opts.root || mainRoot(doc);
    const skipChrome = root === doc.body;
    const lines = [];
    let cur = '';
    const flush = (prefix = '') => {
      const t = cur.replace(/\s+/g, ' ').trim();
      if (t) lines.push(prefix + t);
      cur = '';
    };
    const visit = (node, ctx) => {
      if (node.nodeType === 3) { cur += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      const el = node, tag = el.tagName;
      if (SKIP.has(tag)) return;
      if (tag === 'IMG') { const alt = clean(el.getAttribute('alt'), 60); if (alt) cur += ` [img: ${alt}] `; return; }
      if (hiddenFast(el, win)) return;
      const role = el.getAttribute('role') || '';
      if (tag === 'NAV' || role === 'navigation') return; // menus are never the content, even inside <main>
      if (skipChrome && (/^(FOOTER|ASIDE)$/.test(tag) || /^(contentinfo|complementary|dialog|alertdialog)$/.test(role))) return;
      const block = BLOCK.has(tag);
      if (block) flush(ctx.prefix);
      // Layout tables (rows containing other tables/blocks) are walked normally, not flattened.
      if (tag === 'TR' && !el.querySelector('table, ul, ol, p, div > div')) {
        const cells = Array.from(el.children).map((c) => clean(typeof c.innerText === 'string' ? c.innerText : c.textContent, 200)).filter(Boolean);
        if (cells.length) lines.push(cells.join(' | '));
        return;
      }
      const h = /^H([1-6])$/.exec(tag);
      const prefix = h ? '#'.repeat(Number(h[1])) + ' ' : tag === 'LI' ? '- ' : tag === 'BLOCKQUOTE' ? '> ' : ctx.prefix;
      for (const c of el.childNodes) visit(c, { prefix });
      if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) visit(c, { prefix });
      if (block) flush(prefix);
      else if (tag === 'A') cur += ' '; // adjacent links ("new | past") would otherwise run together
    };
    visit(root, { prefix: '' });
    flush();
    const out = lines.filter((l, i) => l !== lines[i - 1]).map((l) => maskCards(l));
    const text = out.join('\n');
    const offset = opts.offset || 0;
    const max = opts.maxChars || 3000;
    const slice = text.slice(offset, offset + max);
    return { text: slice, total: text.length, rest: text.length - offset - slice.length, next: offset + slice.length };
  }

  // Search mode for read_text: only the lines that match the query (plus one line of context),
  // in page order. "binomial name" → "Binomial name | Columba livia" without reading the article.
  const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'which', 'who', 'how', 'its', 'it', 'this', 'that', 'with', 'by', 'from', 'at', 'as', 'be', 'does', 'do']);
  function grepText(win, doc, query, opts = {}) {
    const all = readText(win, doc, { maxChars: 1e7 }).text.split('\n');
    const words = clean(query, 200).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
    if (!words.length) return { text: '', matches: 0 };
    const stem = (w) => w.replace(/(ies|es|s)$/, '');
    const scored = [];
    all.forEach((line, i) => {
      const l = line.toLowerCase();
      const hits = words.filter((w) => l.includes(stem(w))).length;
      if (hits) scored.push({ i, score: hits / words.length + (l.includes(words.join(' ')) ? 1 : 0) });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    const top = scored.slice(0, opts.limit || 8);
    const keep = new Set();
    for (const { i } of top) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < all.length) keep.add(j);
    const idx = [...keep].sort((a, b) => a - b);
    const out = [];
    idx.forEach((j, k) => {
      if (k && j !== idx[k - 1] + 1) out.push('…');
      out.push(all[j].length > 400 ? all[j].slice(0, 399) + '…' : all[j]);
    });
    return { text: out.join('\n'), matches: scored.length };
  }

  const nameWords = (s) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  // Edit distance ≤ 1 (insert, delete, substitute, or swap of adjacent letters).
  function withinOneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  function find(win, doc, refs, query, opts = {}) {
    const limit = opts.limit || 8;
    const q = clean(query, 200).toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const snap = snapshot(win, doc, refs, { role: opts.role, maxItems: 5000, maxVisit: opts.maxVisit });
    const scored = [];
    for (const it of snap.items) {
      const hay = `${it.name} ${it.value || ''}`.toLowerCase();
      let s = 0;
      if (!q) s = 1;
      else if (it.name.toLowerCase() === q) s = 100;
      else if (hay.startsWith(q)) s = 60;
      else if (hay.includes(q)) s = 40;
      else {
        const hit = words.filter(w => hay.includes(w)).length;
        const typos = words.filter(w => !hay.includes(w) && w.length >= 4 && nameWords(hay).some(h => h.length >= 4 && withinOneEdit(w, h))).length;
        if (hit) s = 20 * hit / words.length;
        // Typo tier: all words match, none exactly → above partial matches, below substring (40).
        if (typos) s = hit === 0 && typos === words.length ? 35 : s + 10 * typos / words.length;
        if (words.includes(it.role)) s += 10;
      }
      if (s > 0 && s >= (opts.minScore || 0)) scored.push([s, it]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, limit).map(x => x[1]);
    return { items: top, matches: scored.length, capped: snap.capped, note: snap.capped ? capNote(snap.maxVisit) : '' };
  }

  function diff(prev, next) {
    // prev/next: Map<ref, line>
    const added = [], removed = [], changed = [];
    for (const [ref, line] of next) {
      if (!prev.has(ref)) added.push(line);
      else if (prev.get(ref) !== line) changed.push(line);
    }
    for (const [ref, line] of prev) if (!next.has(ref)) removed.push(line);
    return { added, removed, changed, note: next.note || prev.note || '' };
  }

  function formatDiff(d, max = 40) {
    const out = [];
    const note = d.note ? `\n… ${d.note}` : '';
    for (const l of d.added) out.push('+ ' + l);
    for (const l of d.changed) out.push('~ ' + l);
    for (const l of d.removed) out.push('- ' + l);
    if (!out.length) return 'no changes' + note;
    return (out.length > max ? [...out.slice(0, max), `… ${out.length - max} more changes`].join('\n') : out.join('\n')) + note;
  }

  function lineMap(snap) {
    const m = new Map();
    m.note = snap.capped ? capNote(snap.maxVisit) : '';
    for (const it of snap.items) m.set(it.ref, formatItem(it));
    return m;
  }

  function globToRegExp(p) {
    return new RegExp('^' + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  }

  function isBlocked(url, list = DEFAULT_BLOCKLIST) {
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, ''); } catch (_) { return false; }
    if (!host) return false;
    const matches = (p) => {
      if (p.includes('*') || p.includes('?')) {
        // Globs also apply to subdomains: 'hsbc.*' blocks www.hsbc.co.uk.
        const re = globToRegExp(p);
        const parts = host.split('.');
        return parts.some((_, i) => re.test(parts.slice(i).join('.')));
      }
      return host === p || host.endsWith('.' + p);
    };
    const norm = list.map((p) => (p || '').trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
    if (norm.some((p) => p.startsWith('!') && matches(p.slice(1)))) return false;
    return norm.some((p) => !p.startsWith('!') && matches(p));
  }

  // ---------- actions ----------
  function setNativeValue(win, el, value) {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }

  function fire(win, el, type, init = {}) {
    const Ctor = /^key/.test(type) ? win.KeyboardEvent : (type === 'input' ? (win.InputEvent || win.Event) : win.Event);
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  function act(win, doc, refs, action, args = {}) {
    if (action === 'scroll' && args.ref == null) {
      const dir = args.direction === 'up' ? -1 : 1;
      win.scrollBy(0, dir * (args.amount || 0.8) * win.innerHeight);
      return { ok: true, info: `scrolled ${args.direction || 'down'}` };
    }
    if (refs.foreign && refs.foreign(args.ref)) return { ok: false, error: `ref ${args.ref} is from a previous page load — call outline/find again` };
    const el = refs.resolve(args.ref);
    if (!el) return { ok: false, error: `ref ${args.ref} not found (page changed — call read_page or find again)` };
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });

    switch (action) {
      case 'click': {
        if (el.disabled) return { ok: false, error: `ref ${args.ref} is disabled` };
        const opts = { bubbles: true, cancelable: true, composed: true, button: 0, view: win };
        // Many menus open on pointerdown/mousedown, not click.
        if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerdown', opts));
        el.dispatchEvent(new win.MouseEvent('mousedown', opts));
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        if (win.PointerEvent) el.dispatchEvent(new win.PointerEvent('pointerup', opts));
        el.dispatchEvent(new win.MouseEvent('mouseup', opts));
        el.click();
        return { ok: true, info: `clicked ${args.ref}` };
      }
      case 'type': {
        if (isSecret(el) && !args.allow_secret) return { ok: false, error: `ref ${args.ref} is a secret field; refusing to type without allow_secret=true` };
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        const text = String(args.text ?? '');
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const v = args.clear === false ? (el.value || '') + text : text;
          setNativeValue(win, el, v);
          fire(win, el, 'input', { data: text, inputType: 'insertText' });
          fire(win, el, 'change');
        } else if (el.isContentEditable || el.getAttribute('contenteditable') != null) {
          // execCommand goes through the editor's own input pipeline (ProseMirror, Draft, …).
          let done = false;
          try {
            // Select all of the editor (replace) or put the caret at its end (append).
            const sel = win.getSelection();
            const range = doc.createRange();
            range.selectNodeContents(el);
            if (args.clear === false) range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
            done = doc.execCommand('insertText', false, text);
          } catch (_) { done = false; }
          if (!done) {
            if (args.clear !== false) el.textContent = '';
            el.textContent += text;
            fire(win, el, 'input', { data: text, inputType: 'insertText' });
          }
        } else {
          return { ok: false, error: `ref ${args.ref} is not a text field` };
        }
        if (args.submit) {
          const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
          const down = new win.KeyboardEvent('keydown', key);
          el.dispatchEvent(down);
          el.dispatchEvent(new win.KeyboardEvent('keyup', key));
          const form = el.form || (el.closest && el.closest('form'));
          // If the page handled Enter itself (preventDefault), don't submit a second time.
          if (form && !down.defaultPrevented) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
          }
        }
        return { ok: true, info: `typed ${text.length} chars into ${args.ref}${args.submit ? ' and submitted' : ''}` };
      }
      case 'check': {
        // Checkbox / radio / switch: click only when the state differs from what is wanted.
        const want = args.checked !== false;
        const isOn = el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
        if (isOn === want) return { ok: true, info: `${args.ref} already ${want ? 'checked' : 'unchecked'}` };
        if (el.disabled) return { ok: false, error: `ref ${args.ref} is disabled` };
        el.click();
        return { ok: true, info: `${want ? 'checked' : 'unchecked'} ${args.ref}` };
      }
      case 'select_option': {
        // Custom (non-native) dropdowns need open → wait → pick; the content script does that.
        if (el.tagName !== 'SELECT') return { ok: false, custom: true, el };
        const want = String(args.option).toLowerCase();
        const opt = Array.from(el.options).find(o => o.value.toLowerCase() === want || clean(o.textContent).toLowerCase() === want)
          || Array.from(el.options).find(o => clean(o.textContent).toLowerCase().includes(want));
        if (!opt) return { ok: false, error: `no option matching "${args.option}"; options: ${Array.from(el.options).map(o => clean(o.textContent, 30)).slice(0, 20).join(' | ')}` };
        setNativeValue(win, el, opt.value);
        fire(win, el, 'input');
        fire(win, el, 'change');
        return { ok: true, info: `selected "${clean(opt.textContent)}"` };
      }
      case 'scroll':
        return { ok: true, info: `scrolled to ${args.ref}` };
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
  }

  // ---------- generic skills ----------
  const visible = (el, win) => !isHidden(el, win);

  // Options of an open custom dropdown (role=option, listbox items), best match for `text`.
  function findOption(win, doc, text) {
    const want = clean(text).toLowerCase();
    const opts = Array.from(doc.querySelectorAll('[role="option"], [role="listbox"] li, [role="menu"] [role="menuitem"], [role="menuitemradio"]'))
      .filter((o) => visible(o, win));
    const label = (o) => clean(o.getAttribute('aria-label') || o.textContent).toLowerCase();
    const hit = opts.find((o) => label(o) === want) || opts.find((o) => label(o).startsWith(want)) || opts.find((o) => label(o).includes(want));
    return { el: hit || null, available: opts.slice(0, 20).map((o) => clean(o.textContent, 30)) };
  }

  // The best form control for a human label like "Email" or "Country".
  const CONTROL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'password', 'spinbutton']);
  function resolveField(win, doc, refs, label) {
    // minScore: the label must really match (a role word like "button" alone is not enough).
    const r = find(win, doc, refs, label, { limit: 20, minScore: 20 });
    const hit = r.items.find((it) => CONTROL_ROLES.has(it.role));
    return hit ? { ref: hit.ref, role: hit.role, el: refs.resolve(hit.ref) } : null;
  }

  // Cookie banners / consent walls / newsletter popups and the button that closes them.
  // Prefers the privacy-friendly choice (reject / necessary only) when one exists.
  const INTERRUPT_TEXT = /cookie|consent|gdpr|privacy|tracking|personal data|newsletter|subscribe|sign up for|notifications?/i;
  const REJECT = /^(reject( all)?|decline( all)?|refuse( all)?|deny|(only )?(strictly )?necessary( cookies)?( only)?|essential( cookies)?( only)?|use necessary cookies only|continue without accepting|tout refuser|refuser|alle ablehnen|ablehnen)$/i;
  const ACCEPT = /^(accept( all)?( cookies)?|agree|i agree|allow( all)?( cookies)?|got it|ok|okay|i understand|understood|tout accepter|j'accepte|accepter|alle akzeptieren|akzeptieren)$/i;
  const CLOSE = /^(close|dismiss|no,? thanks|not now|maybe later|skip|×|x|✕)$/i;

  const OVERLAY_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="cmp" i], [id*="onetrust" i], [id*="didomi" i], [class*="newsletter" i], [class*="popup" i], [class*="modal" i]';
  // Overlay-like elements currently in the DOM (snapshot before an action, to spot dialogs the action opened).
  function overlayBoxes(doc) {
    try { return Array.from(doc.querySelectorAll(OVERLAY_SEL)); } catch (_) { return []; }
  }

  // opts.keep: a Set of overlay elements that existed before the agent's action. When given, a box that is
  // NOT in it (i.e. the action itself opened it, like an "Apply" form) is never auto-closed.
  function findInterruption(win, doc, opts = {}) {
    let candidates = overlayBoxes(doc);
    if (!candidates.length) return null;
    if (opts.keep) candidates = candidates.filter((c) => opts.keep.has(c));
    // opts.target: the element the agent just acted on. An overlay that contains it is where the agent is
    // working (a multi-step form, a modal editor), so it is never an interruption.
    if (opts.target) candidates = candidates.filter((c) => !c.contains(opts.target));
    // opts.inUse: overlays that contained the target BEFORE the action (the target itself may be re-rendered away).
    if (opts.inUse) candidates = candidates.filter((c) => !opts.inUse.has(c));
    // Outermost first, visible, small enough to be an overlay (not the whole app shell).
    candidates = candidates.filter((c) => !candidates.some((o) => o !== c && o.contains(c)) && visible(c, win));
    for (const box of candidates.slice(0, 10)) {
      const text = (box.textContent || '').slice(0, 3000);
      if (!INTERRUPT_TEXT.test(text)) continue;
      const buttons = Array.from(box.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
        .filter((b) => visible(b, win))
        .map((b) => ({ el: b, name: clean(b.getAttribute('aria-label') || b.textContent || b.value, 60) }));
      const kind = /cookie|consent|gdpr|privacy|tracking|personal data/i.test(text) ? 'cookie banner' : 'popup';
      const pick = buttons.find((b) => REJECT.test(b.name)) || buttons.find((b) => CLOSE.test(b.name)) || buttons.find((b) => ACCEPT.test(b.name));
      if (pick) return { kind, button: pick.el, label: pick.name };
    }
    return null;
  }

  // Reconnect backoff: a port that lived > 5 s resets to 1 s; otherwise keep backing off (max 30 s).
  function nextBackoff(current, livedMs) {
    const wait = livedMs > 5000 ? 1000 : current;
    return { wait, next: Math.min(wait * 2, 30000) };
  }

  root.PageMapCore = {
    nextBackoff,
    findOption, resolveField, findInterruption, overlayBoxes,
    createRefs, snapshot, format, formatItem, outline, readText, grepText, find, diff, formatDiff, lineMap,
    isBlocked, isSecret, looksLikeCard, maskCards, roleOf, nameOf, act, DEFAULT_BLOCKLIST,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
