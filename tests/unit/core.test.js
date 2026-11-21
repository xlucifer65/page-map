import { describe, it, expect } from 'vitest';
import { page } from './helpers.js';

const snap = (p, o) => p.C.snapshot(p.win, p.doc, p.refs, o);
const lines = (p, o) => p.C.format(snap(p, o)).split('\n').slice(1);

describe('A1 candidate selection', () => {
  it('keeps interactive and meaningful elements, drops layout', () => {
    const p = page(`
      <div><span>plain text</span></div>
      <a href="/x">Docs</a><button>Go</button><input placeholder="Email"><select><option>One</option></select>
      <textarea placeholder="Note"></textarea><h2>Title</h2><img src="/cat.png" alt="A cat">
      <div role="button">Custom</div><div onclick="1">Clicky</div><div contenteditable="true"></div>`);
    const roles = snap(p).items.map((i) => i.role);
    expect(roles).toEqual(['link', 'button', 'textbox', 'combobox', 'textbox', 'heading', 'img', 'button', 'clickable', 'textbox']);
  });
});

describe('A2 visibility', () => {
  it('skips hidden, display:none, visibility:hidden, aria-hidden, zero-size, hidden inputs', () => {
    const p = page(`
      <button hidden>h1</button><button style="display:none">h2</button>
      <div style="display:none"><button>h3</button></div><button style="visibility:hidden">h4</button>
      <div aria-hidden="true"><button>h5</button></div><button data-zero>h6</button>
      <input type="hidden" name="csrf" value="tok"><button>Visible</button>`);
    expect(snap(p).items.map((i) => i.name)).toEqual(['Visible']);
  });
  it('skips decorative images (alt="")', () => {
    const p = page(`<img src="a.png" alt=""><img src="b.png" alt="Logo">`);
    expect(snap(p).items.map((i) => i.name)).toEqual(['Logo']);
  });
});

describe('A3 accessible names', () => {
  it('follows aria-labelledby → aria-label → label → alt → title → placeholder → text', () => {
    const p = page(`
      <span id="l1">From labelledby</span><button aria-labelledby="l1" aria-label="no">x</button>
      <button aria-label="From aria">x</button>
      <label for="e">From label</label><input id="e" placeholder="no">
      <label>Wrapped <input placeholder="no"></label>
      <input type="image" alt="From alt" src="go.png">
      <button title="From title"></button>
      <input placeholder="From placeholder">
      <a href="#">From   text
      </a>`);
    expect(snap(p).items.map((i) => i.name)).toEqual([
      'From labelledby', 'From aria', 'From label', 'Wrapped', 'From alt', 'From title', 'From placeholder', 'From text']);
  });
  it('truncates long names to 80 chars', () => {
    const p = page(`<button>${'x'.repeat(200)}</button>`);
    expect(snap(p).items[0].name.length).toBe(80);
  });
  it('wrapping label around a select does not absorb option text', () => {
    const p = page(`<label>Country <select><option>France</option><option>Germany</option></select></label>`);
    expect(snap(p).items[0]).toMatchObject({ name: 'Country', value: 'France' });
  });
  it('never uses option text as a select name', () => {
    const p = page(`<select><option>Secret option list</option></select>`);
    expect(snap(p).items[0].name).toBe('');
    expect(snap(p).items[0].value).toBe('Secret option list');
  });
});

describe('A4 roles', () => {
  it('maps input types', () => {
    const p = page(`<input type="checkbox" aria-label="c"><input type="radio" aria-label="r"><input type="submit" value="Send">
      <input type="search" aria-label="s"><input type="range" aria-label="v"><h3>H</h3>`);
    const it = snap(p).items;
    expect(it.map((i) => i.role)).toEqual(['checkbox', 'radio', 'button', 'searchbox', 'slider', 'heading']);
    expect(it[2].name).toBe('Send');
    expect(it[5].level).toBe(3);
  });
});

describe('A5 stable refs', () => {
  it('keeps the same ref for the same element across rescans and DOM changes', () => {
    const p = page(`<button id="a">A</button><button id="b">B</button>`);
    const r1 = snap(p).items.find((i) => i.name === 'B').ref;
    p.doc.body.insertAdjacentHTML('afterbegin', '<button>New</button>');
    const s2 = snap(p).items;
    expect(s2.find((i) => i.name === 'B').ref).toBe(r1);
    expect(s2[0].name).toBe('New');
  });
  it('does not write attributes into the page', () => {
    const p = page(`<button>A</button>`);
    snap(p);
    expect(p.doc.body.innerHTML).toBe('<button>A</button>');
  });
  it('resolve() returns null for removed elements', () => {
    const p = page(`<button id="a">A</button>`);
    const ref = snap(p).items[0].ref;
    expect(p.refs.resolve(ref)).toBe(p.doc.getElementById('a'));
    p.doc.getElementById('a').remove();
    expect(p.refs.resolve(ref)).toBeNull();
  });
});

describe('A5b refs from a previous page load', () => {
  it('are rejected instead of resolving to a different element', () => {
    const a = page(`<button>Buy now</button>`);
    a.refs = a.C.createRefs('abc');
    const old = snap(a).items[0].ref;
    expect(old).toBe('abc1');
    const b = page(`<button>Delete account</button>`);
    b.refs = b.C.createRefs('xyz');
    snap(b); // new page issues xyz1
    const r = b.C.act(b.win, b.doc, b.refs, 'click', { ref: old });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/previous page load/);
  });
});

describe('A6 state flags and values', () => {
  it('reports checked/disabled/expanded/required/focused and field values', () => {
    const p = page(`<input type="checkbox" checked aria-label="c"><button disabled>d</button>
      <button aria-expanded="true">e</button><input aria-label="q" required value="hello">`);
    p.doc.querySelector('[aria-label=q]').focus();
    const it = snap(p).items;
    expect(it[0].flags).toContain('checked');
    expect(it[1].flags).toContain('disabled');
    expect(it[2].flags).toContain('expanded');
    expect(it[3].flags).toEqual(expect.arrayContaining(['required', 'focused']));
    expect(it[3].value).toBe('hello');
  });
});

describe('A7 shadow DOM', () => {
  it('walks open shadow roots', () => {
    const p = page(`<div id="host"></div><button>After</button>`);
    const sr = p.doc.getElementById('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<button>Inside shadow</button>';
    expect(snap(p).items.map((i) => i.name)).toEqual(['Inside shadow', 'After']);
  });
});

describe('A8 compact format', () => {
  it('renders `ref role "name" =value [flags]`', () => {
    const p = page(`<input aria-label="Email" value="a@b.co" required><h2>Hi</h2>`);
    expect(lines(p)).toEqual(['1 textbox "Email" ="a@b.co" [required]', '2 heading2 "Hi"']);
  });
});

describe('D1 secrets never leak', () => {
  it('never exposes password / card / otp values', () => {
    const p = page(`
      <input type="password" aria-label="Password" value="hunter2">
      <input autocomplete="cc-number" aria-label="Card" value="4111111111111111">
      <input autocomplete="one-time-code" aria-label="Code" value="123456">
      <input name="user_pin" aria-label="PIN" value="9999">
      <input name="pinterest_handle" aria-label="Handle" value="ok-to-show">`);
    const out = p.C.format(snap(p));
    for (const s of ['hunter2', '4111111111111111', '123456', '9999']) expect(out).not.toContain(s);
    expect(out).toContain('<secret>');
    expect(snap(p).items.slice(0, 4).every((i) => i.flags.includes('secret'))).toBe(true);
    expect(out).toContain('ok-to-show'); // "pin" inside a word is not a secret
  });
});

describe('D1b more secret names + card numbers', () => {
  it('masks card/csc/api-key/token fields and Luhn-valid numbers anywhere', () => {
    const p = page(`
      <input name="credit_card" aria-label="a" value="5500 0000 0000 0004">
      <input name="cc_csc" aria-label="b" value="123">
      <input name="api_key" aria-label="c" value="sk-live-abc">
      <input name="auth_token" aria-label="d" value="tok123">
      <input name="notes" aria-label="e" value="4111-1111-1111-1111">
      <input name="phone" aria-label="f" value="0612345678">`);
    const out = p.C.format(snap(p));
    for (const s of ['5500', '123"', 'sk-live', 'tok123', '4111']) expect(out).not.toContain(s);
    expect(out).toContain('0612345678'); // not Luhn-length → still shown
    expect(p.C.looksLikeCard('4111111111111111')).toBe(true);
    expect(p.C.looksLikeCard('4111111111111112')).toBe(false);
  });
  it('catches common real-world secret names, labels and placeholders', () => {
    const { C, doc } = page(`
      <input name="securityCode"><input name="expiry"><input name="mfaCode"><input name="verification_code">
      <input name="totp"><input name="code2fa"><input name="accountNumber"><input name="routingNumber">
      <input name="sortCode"><input name="tax_id"><input name="f7" aria-label="Card number">
      <input name="x1" placeholder="CVV"><label>One-time code <input name="x2"></label>`);
    for (const el of doc.querySelectorAll('input')) expect([el.name, C.isSecret(el)]).toEqual([el.name, true]);
  });
  it('does NOT flag ordinary fields that merely contain secret-ish letters', () => {
    const { C, doc } = page(`
      <input name="passenger_name"><input name="passport_no"><input name="compass_heading"><input name="bypass_reason">
      <input name="classname"><input name="secretary_name"><input name="tokenizer_lang"><input name="cardnotes">
      <input name="discard_note"><input name="csc_region"><input name="spinner"><input name="shipping_address">`);
    for (const el of doc.querySelectorAll('input')) expect([el.name, C.isSecret(el)]).toEqual([el.name, false]);
  });
  it('masks card numbers inside free text, options and names', () => {
    const p = page(`<textarea aria-label="Notes">my card is 4111 1111 1111 1111 exp 12/29</textarea>
      <select aria-label="Pay"><option>Visa 4111111111111111</option></select><button>Order 1234567890123</button>`);
    const out = p.C.format(snap(p));
    expect(out).not.toContain('4111');
    expect(out).toContain('my card is <card> exp 12/29');
    expect(out).toContain('Visa <card>');
    expect(out).toContain('1234567890123'); // not Luhn-valid → kept
  });
  it('find never matches on secret values', () => {
    const p = page(`<input type="password" aria-label="pw" value="hunter2">`);
    expect(p.C.find(p.win, p.doc, p.refs, 'hunter2').items).toEqual([]);
  });
});

describe('D2 blocklist', () => {
  it('matches exact hosts and wildcards', () => {
    const { C } = page('');
    expect(C.isBlocked('https://mail.google.com/mail/u/0')).toBe(true);
    expect(C.isBlocked('https://www.paypal.com/x')).toBe(true);
    expect(C.isBlocked('https://online.mybank.fr/')).toBe(true);
    expect(C.isBlocked('https://github.com/')).toBe(false);
    expect(C.isBlocked('https://github.com/', ['github.com'])).toBe(true);
    expect(C.isBlocked('not a url')).toBe(false);
  });
  it('allows SharePoint but keeps the Microsoft sign-in page blocked', () => {
    const { C } = page('');
    expect(C.isBlocked('https://contoso.sharepoint.com/sites/x', C.DEFAULT_BLOCKLIST)).toBe(false);
    expect(C.isBlocked('https://contoso.sharepoint.com/sites/x/Documents%20partages/Forms/AllItems.aspx?id=%2Fsites%2Fx%2Fa', C.DEFAULT_BLOCKLIST)).toBe(false);
    expect(C.isBlocked('https://login.microsoftonline.com/common/oauth2/authorize', C.DEFAULT_BLOCKLIST)).toBe(true);
  });
  it('normalizes trailing dots/case and plain patterns cover subdomains', () => {
    const { C } = page('');
    expect(C.isBlocked('https://MAIL.google.com./x')).toBe(true);
    expect(C.isBlocked('https://secure.chase.com/')).toBe(true);
    expect(C.isBlocked('https://gmail.com/')).toBe(true);
    expect(C.isBlocked('https://web.whatsapp.com/')).toBe(true);
    expect(C.isBlocked('https://notchase.com/')).toBe(false);
    expect(C.isBlocked('https://example.com/', ['example.com.'])).toBe(true);
  });
  it('covers EU/UK/FR banks and mail, without over-blocking docs and news', () => {
    const { C } = page('');
    for (const u of ['https://www.hsbc.co.uk/', 'https://www.barclays.co.uk/', 'https://mabanque.bnpparibas/',
      'https://clients.boursorama.com/', 'https://www.creditmutuel.fr/', 'https://app.n26.com/', 'https://www.fastmail.com/',
      'https://mail.zoho.com/', 'https://www.messenger.com/', 'https://www.labanquepostale.fr/', 'https://www.lloydsbank.com/',
      'https://dashboard.stripe.com/'])
      expect([u, C.isBlocked(u)]).toEqual([u, true]);
    for (const u of ['https://docs.stripe.com/', 'https://www.worldbank.org/', 'https://www.bankrate.com/', 'https://github.com/',
      'https://news.ycombinator.com/'])
      expect([u, C.isBlocked(u)]).toEqual([u, false]);
  });
});

describe('D6 typing into secrets', () => {
  it('refuses unless allow_secret', () => {
    const p = page(`<input type="password" aria-label="pw">`);
    const ref = snap(p).items[0].ref;
    expect(p.C.act(p.win, p.doc, p.refs, 'type', { ref, text: 'x' }).ok).toBe(false);
    expect(p.C.act(p.win, p.doc, p.refs, 'type', { ref, text: 'x', allow_secret: true }).ok).toBe(true);
    expect(p.doc.querySelector('input').value).toBe('x');
  });
});

describe('E1 outline', () => {
  it('shows landmarks, headings with refs and role counts — not every element', () => {
    const p = page(`<header><nav aria-label="Main"><a href="/">Home</a><a href="/b">Blog</a></nav></header>
      <main><h1>Welcome</h1><h2>Sub</h2><button>Buy</button></main><footer>f</footer>`);
    const o = p.C.outline(p.win, p.doc, p.refs);
    expect(o).toContain('[banner]');
    expect(o).toContain('[navigation "Main"]');
    expect(o).toContain('[main]');
    expect(o).toMatch(/\d+ h1 "Welcome"/);
    expect(o).toMatch(/ {2}\d+ h2 "Sub"/);
    expect(o).toContain('2 link');
    expect(o).toContain('1 button');
    expect(o).not.toContain('Blog');
  });
});

describe('E1b readText (main content for reading tasks)', () => {
  it('prefers <main>, renders headings/lists/tables as light markdown, skips controls and hidden text', () => {
    const p = page(`<nav><a href="/">Home</a></nav>
      <main><h1>Rock dove</h1><p>The rock dove (<i>Columba livia</i>) is a bird.</p>
      <ul><li>Wild</li><li>Feral</li></ul><table><tr><th>Kingdom</th><td>Animalia</td></tr></table>
      <button>Edit</button><p style="display:none">hidden text</p>
      <p>padding ${'text '.repeat(40)}</p></main>`);
    const r = p.C.readText(p.win, p.doc);
    expect(r.text).toContain('# Rock dove');
    expect(r.text).toContain('The rock dove (Columba livia) is a bird.');
    expect(r.text).toContain('- Wild\n- Feral');
    expect(r.text).toContain('Kingdom | Animalia');
    expect(r.text).not.toContain('Home');
    expect(r.text).not.toContain('Edit');
    expect(r.text).not.toContain('hidden text');
  });
  it('falls back to <body> without nav/footer on pages with no <main> (e.g. link lists)', () => {
    const p = page(`<nav>Site nav</nav><table><tr><td>1.</td><td><a href="#">First story title</a></td></tr>
      <tr><td>2.</td><td><a href="#">Second story</a></td></tr></table><footer>Legal</footer>`);
    const t = p.C.readText(p.win, p.doc).text;
    expect(t).toContain('1. | First story title');
    expect(t).not.toMatch(/Site nav|Legal/);
  });
  it('pages with offset and masks card numbers', () => {
    const p = page(`<main><p>${'a'.repeat(250)}</p><p>card 4111 1111 1111 1111</p></main>`);
    const r1 = p.C.readText(p.win, p.doc, { maxChars: 100 });
    expect(r1.text).toHaveLength(100);
    expect(r1.rest).toBeGreaterThan(0);
    const r2 = p.C.readText(p.win, p.doc, { offset: r1.next, maxChars: 10000 });
    expect(r2.rest).toBe(0);
    expect(r2.text).toContain('card <card>');
  });
  it('grepText returns only matching lines with context, in page order', () => {
    const p = page(`<main><h1>Rock dove</h1><p>Intro text about pigeons.</p>
      <table><tr><th>Kingdom</th><td>Animalia</td></tr><tr><th>Binomial name</th><td>Columba livia</td></tr></table>
      ${'<p>Unrelated filler paragraph.</p>'.repeat(30)}<h2>Diet</h2><p>They eat seeds.</p></main>`);
    const g = p.C.grepText(p.win, p.doc, 'What is the binomial name?');
    expect(g.text).toContain('Binomial name | Columba livia');
    expect(g.text).toContain('Kingdom | Animalia'); // context line
    expect(g.text.split('Unrelated filler').length - 1).toBeLessThanOrEqual(1); // at most one context line, not 30
    expect(p.C.grepText(p.win, p.doc, 'diets').text).toContain('## Diet'); // simple plural stemming
    expect(p.C.grepText(p.win, p.doc, 'zzzz').text).toBe('');
  });
  it('outline includes a text preview so simple reading tasks need no second call', () => {
    const p = page(`<table><tr><td>1.</td><td><a href="#">Top story here</a></td></tr></table>`);
    const o = p.C.outline(p.win, p.doc, p.refs);
    expect(o).toContain('--- text preview ---');
    expect(o).toContain('Top story here');
  });
});

describe('E2 viewport + max_items', () => {
  it('defaults callers to viewport, reports what was left out', () => {
    const p = page(`<button>On</button><div data-offscreen><button>Off1</button><button>Off2</button></div>`);
    const s = snap(p, { viewportOnly: true });
    expect(s.items.map((i) => i.name)).toEqual(['On']);
    expect(s.offscreen).toBe(2);
    expect(p.C.format(s)).toContain('2 more off-screen');
    const t = snap(p, { maxItems: 2 });
    expect(t.items).toHaveLength(2);
    expect(t.truncated).toBe(true);
  });
});

describe('E3 find', () => {
  it('ranks exact > prefix > contains > word overlap and filters by role', () => {
    const p = page(`<a href="#">Sign in help</a><button>Sign in</button><button>Please sign in now</button><input placeholder="Search">`);
    const r = p.C.find(p.win, p.doc, p.refs, 'sign in');
    expect(r.items.map((i) => i.name)).toEqual(['Sign in', 'Sign in help', 'Please sign in now']);
    const b = p.C.find(p.win, p.doc, p.refs, 'sign', { role: 'button' });
    expect(b.items.every((i) => i.role === 'button')).toBe(true);
    expect(p.C.find(p.win, p.doc, p.refs, 'zzz').items).toEqual([]);
  });
  it('respects limit', () => {
    const p = page(Array.from({ length: 30 }, (_, i) => `<button>Item ${i}</button>`).join(''));
    const r = p.C.find(p.win, p.doc, p.refs, 'item', { limit: 5 });
    expect(r.items).toHaveLength(5);
    expect(r.matches).toBe(30);
  });
});

describe('B5 diffs', () => {
  it('reports added, changed and removed lines', () => {
    const p = page(`<button id="a">A</button><input aria-label="q"><button id="c">C</button>`);
    const before = p.C.lineMap(snap(p));
    p.doc.getElementById('c').remove();
    p.doc.querySelector('input').value = 'typed';
    p.doc.body.insertAdjacentHTML('beforeend', '<button>New</button>');
    const d = p.C.diff(before, p.C.lineMap(snap(p)));
    expect(d.added).toEqual([expect.stringContaining('"New"')]);
    expect(d.changed).toEqual([expect.stringContaining('="typed"')]);
    expect(d.removed).toEqual([expect.stringContaining('"C"')]);
    expect(p.C.formatDiff(d)).toMatch(/^\+ .*\n~ .*\n- /);
    expect(p.C.formatDiff({ added: [], removed: [], changed: [] })).toBe('no changes');
  });
});

describe('generic skills', () => {
  it('findInterruption picks the privacy-friendly button on a cookie banner', () => {
    const p = page(`<div role="dialog">We use cookies. <button>Accept all</button><button>Reject all</button></div>`);
    const hit = p.C.findInterruption(p.win, p.doc);
    expect(hit).toMatchObject({ kind: 'cookie banner', label: 'Reject all' });
  });
  it('falls back to accept when there is no reject, and closes newsletter popups', () => {
    const a = page(`<div id="cookie-notice">This site uses cookies <button>Got it</button></div>`);
    expect(a.C.findInterruption(a.win, a.doc).label).toBe('Got it');
    const b = page(`<div class="modal">Subscribe to our newsletter! <button aria-label="Close">×</button><button>Subscribe</button></div>`);
    expect(b.C.findInterruption(b.win, b.doc)).toMatchObject({ kind: 'popup', label: 'Close' });
  });
  it('never closes a dialog the agent just opened (keep = overlays present before the action)', () => {
    const p = page(`<div role="dialog">Apply to Acme. See our privacy policy. <button aria-label="Dismiss">×</button><button>Next</button></div>`);
    expect(p.C.findInterruption(p.win, p.doc)).toMatchObject({ label: 'Dismiss' }); // no snapshot: old behaviour
    expect(p.C.findInterruption(p.win, p.doc, { keep: new Set() })).toBeNull(); // opened by the action: left alone
    const existing = new Set(p.C.overlayBoxes(p.doc));
    expect(p.C.findInterruption(p.win, p.doc, { keep: existing })).toMatchObject({ label: 'Dismiss' }); // was already there
  });
  it('never closes the overlay that contains the element the agent acted on', () => {
    const p = page(`<div role="dialog">Apply. Privacy policy. <button aria-label="Dismiss">×</button><button id="next">Next</button></div>`);
    const next = p.doc.getElementById('next');
    const keep = new Set(p.C.overlayBoxes(p.doc));
    expect(p.C.findInterruption(p.win, p.doc, { keep, target: next })).toBeNull();
  });
  it('keeps an in-use overlay even when the clicked element was re-rendered away', () => {
    const p = page(`<div role="dialog">Apply. Privacy policy. <button aria-label="Dismiss">×</button><footer><button id="next">Next</button></footer></div>`);
    const boxes = p.C.overlayBoxes(p.doc);
    const next = p.doc.getElementById('next');
    const inUse = new Set(boxes.filter((b) => b.contains(next)));
    next.parentElement.innerHTML = '<button>Review</button>'; // SPA swaps the footer
    expect(p.C.findInterruption(p.win, p.doc, { keep: new Set(boxes), inUse })).toBeNull();
  });
  it('ignores ordinary dialogs and hidden banners', () => {
    const p = page(`<div role="dialog">Edit profile <button>Save</button></div><div id="cookie-x" style="display:none">cookies <button>Accept</button></div>`);
    expect(p.C.findInterruption(p.win, p.doc)).toBeNull();
  });
  it('findOption matches visible role=option items', () => {
    const p = page(`<ul role="listbox"><li role="option">Small</li><li role="option">Large</li></ul><ul role="listbox" hidden><li role="option">Large hidden</li></ul>`);
    const r = p.C.findOption(p.win, p.doc, 'large');
    expect(r.el.textContent).toBe('Large');
    expect(p.C.findOption(p.win, p.doc, 'xl').available).toEqual(['Small', 'Large']);
  });
  it('resolveField finds the control for a label, not a same-named button', () => {
    const p = page(`<button>Email</button><label>Email <input name="e"></label><label><input type="checkbox"> I accept the terms</label>`);
    expect(p.C.resolveField(p.win, p.doc, p.refs, 'Email').role).toBe('textbox');
    expect(p.C.resolveField(p.win, p.doc, p.refs, 'accept the terms').role).toBe('checkbox');
  });
  it('resolveLabel ranks same-name matches: button over rowheader/checkbox, role overrides', () => {
    const p = page(`<div role="row"><input type="checkbox" aria-label="Course 1"><div role="rowheader" tabindex="0">Course 1</div><button>Course 1</button></div>`);
    const pick = (o) => p.C.resolveLabel(p.win, p.doc, p.refs, 'Course 1', o).role;
    expect(pick({ action: 'click' })).toBe('button');
    expect(pick({ action: 'click', role: 'checkbox' })).toBe('checkbox');
    expect(pick({ action: 'click', role: 'rowheader' })).toBe('rowheader');
  });
  it('click double dispatches two click rounds then dblclick; open-retry guards', () => {
    const p = page(`<button id="b">Open</button><button id="d">Delete file</button><input type="checkbox" id="c" aria-label="x">`);
    const seen = [];
    const b = p.doc.getElementById('b');
    for (const t of ['mousedown', 'click', 'dblclick']) b.addEventListener(t, () => seen.push(t));
    const ref = snap(p).items.find((i) => i.name === 'Open').ref;
    p.C.act(p.win, p.doc, p.refs, 'click', { ref, double: true });
    expect(seen).toEqual(['mousedown', 'click', 'mousedown', 'click', 'dblclick']);
    expect(p.C.canRetryOpen(b, 'button', 'Open')).toBe(true);
    expect(p.C.canRetryOpen(p.doc.getElementById('d'), 'button', 'Delete file')).toBe(false);
    expect(p.C.canRetryOpen(p.doc.getElementById('c'), 'checkbox', 'x')).toBe(false);
    const m = (l) => new Map([['r1', l]]);
    expect(p.C.onlySoftChanges(m('r1 button "A"'), m('r1 button "A" [focused]'))).toBe(true);
    expect(p.C.onlySoftChanges(m('r1 checkbox "A"'), m('r1 checkbox "A" [checked,focused]'))).toBe(true);
    expect(p.C.onlySoftChanges(m('r1 button "A"'), m('r1 button "B"'))).toBe(false);
    expect(p.C.onlySoftChanges(m('r1 button "A"'), new Map([['r1', 'r1 button "A"'], ['r2', 'x']]))).toBe(false);
  });
  it('check sets a checkbox only when needed', () => {
    const p = page(`<input type="checkbox" aria-label="t">`);
    const ref = snap(p).items[0].ref;
    expect(p.C.act(p.win, p.doc, p.refs, 'check', { ref }).info).toMatch(/^checked/);
    expect(p.C.act(p.win, p.doc, p.refs, 'check', { ref }).info).toMatch(/already checked/);
    expect(p.C.act(p.win, p.doc, p.refs, 'check', { ref, checked: false }).info).toMatch(/^unchecked/);
  });
  it('click/check/type/select do not scroll the page; only scroll does', () => {
    const p = page(`<input type="radio" name="q" aria-label="r" data-offscreen><input aria-label="t" data-offscreen>
      <select aria-label="s" data-offscreen><option>a</option><option>b</option></select>`);
    let scrolls = 0;
    p.win.Element.prototype.scrollIntoView = () => { scrolls++; };
    const [r, t, s] = snap(p, { all: true }).items.map((i) => i.ref);
    p.C.act(p.win, p.doc, p.refs, 'click', { ref: r });
    p.C.act(p.win, p.doc, p.refs, 'check', { ref: r, checked: false });
    p.C.act(p.win, p.doc, p.refs, 'type', { ref: t, text: 'x' });
    p.C.act(p.win, p.doc, p.refs, 'select_option', { ref: s, option: 'b' });
    expect(scrolls).toBe(0);
    p.C.act(p.win, p.doc, p.refs, 'scroll', { ref: r });
    expect(scrolls).toBe(1);
  });
});

describe('actions', () => {
  it('click fires handlers; disabled is refused; stale ref is reported', () => {
    const p = page(`<button>Go</button><button disabled>No</button>`);
    p.doc.querySelector('button').addEventListener('click', function () { this.textContent = 'Done'; });
    const [go, no] = snap(p).items;
    expect(p.C.act(p.win, p.doc, p.refs, 'click', { ref: go.ref }).ok).toBe(true);
    expect(p.doc.querySelector('button').textContent).toBe('Done');
    expect(p.C.act(p.win, p.doc, p.refs, 'click', { ref: no.ref }).ok).toBe(false);
    expect(p.C.act(p.win, p.doc, p.refs, 'click', { ref: 999 }).error).toMatch(/not found/);
  });
  it('type sets value and fires input/change; submit submits the form', () => {
    const p = page(`<form><input aria-label="q"></form>`);
    const events = [];
    const input = p.doc.querySelector('input');
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    p.doc.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); events.push('submit'); });
    const ref = snap(p).items[0].ref;
    expect(p.C.act(p.win, p.doc, p.refs, 'type', { ref, text: 'cats', submit: true }).ok).toBe(true);
    expect(input.value).toBe('cats');
    expect(events).toEqual(['input', 'change', 'submit']);
    p.C.act(p.win, p.doc, p.refs, 'type', { ref, text: '!', clear: false });
    expect(input.value).toBe('cats!');
  });
  it('click sends pointer/mouse down+up before click (menus that open on mousedown)', () => {
    const p = page(`<button>Menu</button>`);
    const seen = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) p.doc.querySelector('button').addEventListener(t, () => seen.push(t));
    p.C.act(p.win, p.doc, p.refs, 'click', { ref: snap(p).items[0].ref });
    expect(seen.filter((t) => t !== 'pointerdown' && t !== 'pointerup')).toEqual(['mousedown', 'mouseup', 'click']);
  });
  it('submit does not double-submit when the page handles Enter itself', () => {
    const p = page(`<form><input aria-label="q"></form>`);
    let submits = 0;
    p.doc.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submits++; } });
    p.doc.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); submits++; });
    p.C.act(p.win, p.doc, p.refs, 'type', { ref: snap(p).items[0].ref, text: 'x', submit: true });
    expect(submits).toBe(1);
  });
  it('select_option matches by value or text and lists options on miss', () => {
    const p = page(`<select aria-label="c"><option value="fr">France</option><option value="de">Germany</option></select>`);
    const ref = snap(p).items[0].ref;
    expect(p.C.act(p.win, p.doc, p.refs, 'select_option', { ref, option: 'Germany' }).ok).toBe(true);
    expect(p.doc.querySelector('select').value).toBe('de');
    expect(p.C.act(p.win, p.doc, p.refs, 'select_option', { ref, option: 'fr' }).ok).toBe(true);
    expect(p.C.act(p.win, p.doc, p.refs, 'select_option', { ref, option: 'Spain' }).error).toContain('France | Germany');
  });
});

describe('nextBackoff', () => {
  const { C } = page('');
  it('doubles after short-lived ports', () => {
    let b = 1000;
    const waits = [];
    for (let i = 0; i < 3; i++) { const r = C.nextBackoff(b, 100); waits.push(r.wait); b = r.next; }
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(b).toBe(8000);
  });
  it('caps at 30 s', () => {
    expect(C.nextBackoff(30000, 0)).toEqual({ wait: 30000, next: 30000 });
    expect(C.nextBackoff(16000, 0).next).toBe(30000);
  });
  it('resets to 1 s after a port that lived > 5 s', () => {
    expect(C.nextBackoff(16000, 5001)).toEqual({ wait: 1000, next: 2000 });
    expect(C.nextBackoff(16000, 5000).wait).toBe(16000);
  });
});

describe('large-page notice', () => {
  const big = (n) => Array.from({ length: n }, (_, i) => `<button>Item ${i}</button>`).join('');
  const NOTE = /page very large: scan stopped after 20 nodes/;

  it('find, outline and diffs mention a capped scan', () => {
    const p = page(`<h1>T</h1>${big(40)}`);
    expect(p.C.find(p.win, p.doc, p.refs, 'item', { maxVisit: 20 }).note).toMatch(NOTE);
    expect(p.C.outline(p.win, p.doc, p.refs, { maxVisit: 20 })).toMatch(NOTE);
    const map = (n) => p.C.lineMap(p.C.snapshot(p.win, p.doc, p.refs, { maxVisit: n }));
    expect(p.C.formatDiff(p.C.diff(map(20), map(20)))).toMatch(NOTE);
  });

  it('adds nothing on normal pages', () => {
    const p = page(`<h1>T</h1>${big(5)}`);
    expect(p.C.find(p.win, p.doc, p.refs, 'item').note).toBe('');
    expect(p.C.outline(p.win, p.doc, p.refs)).not.toMatch(/very large/);
    const m = p.C.lineMap(p.C.snapshot(p.win, p.doc, p.refs));
    expect(p.C.formatDiff(p.C.diff(m, m))).toBe('no changes');
  });
});

describe('find typo tolerance', () => {
  const p = page('<button>Search</button><input aria-label="Email"><button>Reset password</button><a href="#">Seach team</a>');
  const names = (q, o) => p.C.find(p.win, p.doc, p.refs, q, o).items.map((i) => i.name);

  it('matches a word within one edit (insert, swap, substitute)', () => {
    expect(names('serch')[0]).toBe('Search');
    expect(names('emial')).toEqual(['Email']);
    expect(names('pasword')).toEqual(['Reset password']);
    expect(names('seerch')).toEqual(['Search']);
  });
  it('scores typos below substring matches', () => {
    const q = names('serch re'); // typo+substring words, not an exact substring
    expect(names('search')[0]).toBe('Search'); // exact stays first
    expect(names('seach')).toEqual(['Seach team', 'Search']); // substring before typo
    expect(q).not.toContain('Email');
  });
  it('ignores short words and junk', () => {
    expect(names('zzzz')).toEqual([]);
    expect(names('emil'.slice(0, 3))).toEqual([]);
    expect(names('zzzz', { minScore: 20 })).toEqual([]);
  });
  it('label targeting still tolerates a typo but not junk', () => {
    expect(p.C.resolveField(p.win, p.doc, p.refs, 'Emial').role).toBe('textbox');
    expect(p.C.resolveField(p.win, p.doc, p.refs, 'zzzz')).toBeFalsy();
  });
});

describe('find role filters', () => {
  it('matches tabs by role', () => {
    const p = page('<div role="tab">Shared</div><button>Shared</button>');
    expect(p.C.find(p.win, p.doc, p.refs, 'Shared', { role: 'tab' }).items.map((i) => i.role)).toEqual(['tab']);
  });

  it('normalizes explicit role casing', () => {
    const p = page('<div role="TAB">Shared</div>');
    expect(p.C.find(p.win, p.doc, p.refs, 'Shared', { role: 'tab' }).items[0].role).toBe('tab');
  });
});
