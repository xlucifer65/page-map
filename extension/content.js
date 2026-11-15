// Page-Map content script: answers structure queries and runs actions for the service worker.
(() => {
  if (globalThis.__pageMapLoaded) return;
  globalThis.__pageMapLoaded = true;

  const C = globalThis.PageMapCore;
  // Random 4-letter prefix per page load (1 in 457k repeat odds): refs look like "kqxa12".
  const prefix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => String.fromCharCode(97 + (b % 26))).join('');
  const refs = C.createRefs(prefix);
  let baseline = null; // Map<ref,line> for changes()
  let lastMutation = 0;

  new MutationObserver(() => { lastMutation = performance.now(); })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Resolve once the DOM has been quiet for `quietMs` (or after `maxMs`).
  function settle(maxMs = 1500, quietMs = 150) {
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        const quiet = now - Math.max(lastMutation, start) >= quietMs;
        if (quiet || now - start >= maxMs) resolve();
        else setTimeout(tick, 40);
      };
      setTimeout(tick, 60);
    });
  }

  const fullMap = () => C.lineMap(C.snapshot(window, document, refs, { maxItems: 3000 }));

  // Generic skill: close cookie banners / consent walls / newsletter popups before they eat turns.
  // Returns a note for the agent, or '' when nothing was closed. args.auto_dismiss=false disables it.
  async function dismissInterruptions(args) {
    if (args.auto_dismiss === false || args.quiet) return '';
    const notes = [];
    for (let i = 0; i < 2; i++) { // some sites stack two (consent → newsletter)
      const hit = C.findInterruption(window, document);
      if (!hit) break;
      hit.button.click();
      notes.push(`auto-closed ${hit.kind} via "${hit.label}"`);
      await settle(1200, 150);
    }
    return notes.length ? notes.join('; ') + '\n' : '';
  }

  // Stable description of an element for recipes: meaning (role + label), never position or ref.
  function describe(ref) {
    const el = ref != null ? refs.resolve(ref) : null;
    if (!el) return null;
    const role = C.roleOf(el);
    return { role, label: C.nameOf(el, document, role), secret: C.isSecret(el) || undefined };
  }

  // One action (by ref) including the async custom-dropdown flow. No diff; callers diff around it.
  async function doAction(cmd, args) {
    const d = describe(args.ref);
    const r = await doActionRaw(cmd, args);
    if (r.ok && d && cmd !== 'scroll') {
      const step = { action: cmd === 'select_option' ? 'select' : cmd, label: d.label, role: d.role };
      if (cmd === 'type') { step.text = d.secret ? undefined : String(args.text ?? ''); step.submit = args.submit || undefined; step.secret = d.secret; }
      if (cmd === 'select_option') step.option = String(args.option);
      if (cmd === 'check') step.checked = args.checked !== false;
      r.step = step;
      // Report right away: if this action navigates, this page won't live to send a reply.
      try { chrome.runtime.sendMessage({ __pagemapStep: true, step }); } catch (_) {}
    }
    return r;
  }

  async function doActionRaw(cmd, args) {
    const r = C.act(window, document, refs, cmd, args);
    if (r.ok || !r.custom) return r;
    // Custom dropdown: open it, wait for options to render, pick the matching one.
    r.el.click();
    await settle(1000, 120);
    let opt = C.findOption(window, document, args.option);
    if (!opt.el) { // some comboboxes filter as you type
      C.act(window, document, refs, 'type', { ref: args.ref, text: String(args.option) });
      await settle(1000, 150);
      opt = C.findOption(window, document, args.option);
    }
    if (!opt.el) return { ok: false, error: `no option matching "${args.option}"${opt.available.length ? '; options: ' + opt.available.join(' | ') : ''}` };
    opt.el.click();
    return { ok: true, info: `selected "${(opt.el.textContent || '').trim().slice(0, 60)}"` };
  }

  // A step can name its target by ref or by human label ("Email", "Country").
  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'password']);
  function target(step) {
    if (step.ref != null) return { ref: String(step.ref) };
    if (step.label == null) return { error: 'step needs ref or label' };
    // A known non-field role (button, link…) narrows the search: "Search" the button vs the box.
    if (step.role && !FIELD_ROLES.has(step.role)) {
      const hit = C.find(window, document, refs, step.label, { role: step.role, limit: 1, minScore: 30 }).items[0];
      if (hit) return { ref: hit.ref, role: hit.role };
    }
    const f = C.resolveField(window, document, refs, step.label);
    if (f) return { ref: f.ref, role: f.role };
    const any = C.find(window, document, refs, step.label, { limit: 1, minScore: 30 }).items[0];
    return any ? { ref: any.ref, role: any.role } : { error: `nothing labelled "${step.label}"` };
  }

  async function runSteps(steps) {
    const log = [];
    const recorded = [];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const action = st.action === 'select' ? 'select_option' : st.action;
      if (!['click', 'type', 'select_option', 'check', 'scroll'].includes(action)) return { log, error: `step ${i + 1}: unknown action "${st.action}"` };
      const t = action === 'scroll' && st.ref == null && st.label == null ? { ref: null } : target(st);
      if (t.error) return { log, error: `step ${i + 1}: ${t.error}` };
      const r = await doAction(action, { ...st, ref: t.ref });
      if (!r.ok) return { log, recorded, error: `step ${i + 1} (${action} ${st.label || st.ref}): ${r.error}` };
      if (r.step) recorded.push(r.step);
      log.push(`${i + 1}. ${r.info}`);
      await settle(800, 100);
    }
    return { log, recorded };
  }

  // fill_form: {"Full name": "Ada", "Country": "Germany", "I accept the terms": true}
  function formSteps(fields, submit) {
    const steps = [];
    for (const [label, value] of Object.entries(fields || {})) {
      const t = target({ label });
      if (t.error) { steps.push({ action: 'type', label }); continue; } // will report the miss
      if (['checkbox', 'radio', 'switch'].includes(t.role)) steps.push({ action: 'check', ref: t.ref, label, checked: value !== false && value !== 'false' && value !== 'no' });
      else if (['combobox', 'listbox'].includes(t.role)) steps.push({ action: 'select', ref: t.ref, label, option: String(value) });
      else steps.push({ action: 'type', ref: t.ref, label, text: String(value) });
    }
    if (submit) steps.push({ action: '__submit', label: Object.keys(fields || {})[0] });
    return steps;
  }

  function submitFormOf(label) {
    const t = target({ label });
    const el = t.ref ? refs.resolve(t.ref) : null;
    const form = el && (el.form || el.closest('form'));
    if (!form) return { ok: false, error: 'no form to submit (click the submit button instead)' };
    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (btn) {
      const name = (btn.textContent || btn.value || 'submit').trim().slice(0, 40);
      const step = { action: 'click', label: C.nameOf(btn, document, 'button'), role: 'button' };
      try { chrome.runtime.sendMessage({ __pagemapStep: true, step }); } catch (_) {}
      btn.click();
      return { ok: true, info: `submitted via "${name}"`, step };
    }
    form.requestSubmit();
    return { ok: true, info: 'submitted form' };
  }

  async function handle(cmd, args) {
    switch (cmd) {
      case 'ping':
        return { ok: true, text: 'pong' };
      // ---- vision mode (screenshot baseline): pixel coordinates, no structure returned ----
      case 'viewport':
        return { ok: true, w: innerWidth, h: innerHeight };
      case 'click_xy': {
        const el = document.elementFromPoint(args.x, args.y);
        if (!el) return { ok: false, error: `nothing at (${args.x}, ${args.y})` };
        const o = { bubbles: true, cancelable: true, composed: true, clientX: args.x, clientY: args.y, button: 0, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        const f = el.closest('input,textarea,select,button,a,[tabindex],[contenteditable]');
        if (f && f.focus) f.focus();
        el.dispatchEvent(new PointerEvent('pointerup', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.click();
        await settle();
        return { ok: true, text: `clicked at (${args.x}, ${args.y})` };
      }
      case 'type_text': {
        const el = document.activeElement;
        if (!el || el === document.body) return { ok: false, error: 'nothing is focused — click a field first' };
        if (C.isSecret(el) && !args.allow_secret) return { ok: false, error: 'focused field is a secret field' };
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, (el.value || '') + args.text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: args.text, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, args.text);
        }
        if (args.enter) {
          const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          const down = new KeyboardEvent('keydown', k);
          el.dispatchEvent(down);
          el.dispatchEvent(new KeyboardEvent('keyup', k));
          if (el.form && !down.defaultPrevented) el.form.requestSubmit();
        }
        await settle();
        return { ok: true, text: `typed ${args.text.length} chars${args.enter ? ' + Enter' : ''}` };
      }
      case 'outline': {
        const note = await dismissInterruptions(args);
        return { ok: true, text: note + C.outline(window, document, refs) };
      }
      case 'read_text': {
        if (args.query) {
          const g = C.grepText(window, document, args.query, { limit: 8 });
          return { ok: true, text: `${document.title} — ${location.href}\n${g.text || `no lines match "${args.query}" (try other words, or read_text without query)`}${g.matches > 8 ? `\n… ${g.matches - 8} more matching lines` : ''}` };
        }
        const r = C.readText(window, document, { maxChars: args.max_chars || 4000, offset: args.offset || 0 });
        const more = r.rest > 0 ? `\n… ${r.rest} more chars (read_text offset=${r.next})` : '';
        return { ok: true, text: `${document.title} — ${location.href}\n${r.text || '(no text)'}${more}` };
      }
      case 'read_page': {
        const snap = C.snapshot(window, document, refs, {
          viewportOnly: args.viewport_only !== false,
          maxItems: args.max_items || 150,
          role: args.role,
        });
        return { ok: true, text: C.format(snap) };
      }
      case 'find': {
        const r = C.find(window, document, refs, args.query || '', { role: args.role, limit: args.limit || 8 });
        const lines = r.items.map(C.formatItem);
        const more = r.matches > r.items.length ? `\n… ${r.matches - r.items.length} more matches` : '';
        return { ok: true, text: (lines.join('\n') || `no match for "${args.query}"`) + more };
      }
      case 'changes': {
        const now = fullMap();
        if (!baseline) { baseline = now; return { ok: true, text: `baseline set (${now.size} elements); call changes again later` }; }
        const d = C.diff(baseline, now);
        baseline = now;
        return { ok: true, text: C.formatDiff(d) };
      }
      case 'click': case 'type': case 'select_option': case 'scroll': case 'check': {
        // label instead of ref: saves the agent a find() call ("type into 'Search Wikipedia'").
        if (args.ref == null && args.label != null) {
          const t = target(args);
          if (t.error) return { ok: false, error: t.error };
          args = { ...args, ref: t.ref };
        }
        const before = fullMap();
        const urlBefore = location.href;
        const r = await doAction(cmd, args);
        if (!r.ok) return r;
        await settle();
        if (args.quiet) return { ok: true, text: r.info }; // vision mode: no structure
        const note = await dismissInterruptions(args);
        const after = fullMap();
        baseline = after;
        const nav = location.href !== urlBefore ? `\nurl → ${location.href}` : '';
        return { ok: true, steps: r.step ? [r.step] : [], text: `${note}${r.info}${nav}\n${C.formatDiff(C.diff(before, after), 30)}` };
      }
      case 'batch': case 'fill_form': {
        const before = fullMap();
        const urlBefore = location.href;
        let steps = cmd === 'batch' ? (args.steps || []) : formSteps(args.fields, args.submit);
        const submitStep = steps.length && steps[steps.length - 1].action === '__submit' ? steps.pop() : null;
        const res = await runSteps(steps);
        if (!res.error && submitStep) {
          const s2 = submitFormOf(submitStep.label);
          if (s2.ok) { res.log.push(`${res.log.length + 1}. ${s2.info}`); if (s2.step) res.recorded.push(s2.step); } else res.error = s2.error;
        }
        await settle();
        const note = await dismissInterruptions(args);
        const after = fullMap();
        baseline = after;
        const nav = location.href !== urlBefore ? `\nurl → ${location.href}` : '';
        const head = res.log.join('\n') + (res.error ? `\nSTOPPED: ${res.error}` : '');
        return { ok: !res.error || res.log.length > 0, error: res.error, steps: res.error ? [] : res.recorded, text: `${note}${head}${nav}\n${C.formatDiff(C.diff(before, after), 30)}` };
      }
      default:
        return { ok: false, error: `unknown command ${cmd}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only our own service worker may command us (messages from content scripts carry sender.tab).
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (!msg || msg.__pagemap !== true) return false;
    // Second blocklist check against the page's real current URL (covers redirects / races).
    if (C.isBlocked(location.href, msg.blocklist || C.DEFAULT_BLOCKLIST)) {
      sendResponse({ ok: false, error: 'this page is on the page-map blocklist; nothing was read' });
      return false;
    }
    handle(msg.cmd, msg.args || {}).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });
})();
