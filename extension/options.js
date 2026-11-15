const ta = document.getElementById('list');
const status = document.getElementById('status');
const defaults = globalThis.PageMapCore.DEFAULT_BLOCKLIST;

chrome.storage.local.get('blocklist').then(({ blocklist }) => {
  ta.value = (Array.isArray(blocklist) ? blocklist : defaults).join('\n');
});

document.getElementById('save').onclick = async () => {
  const list = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ blocklist: list });
  status.textContent = `saved ${list.length} patterns`;
};

document.getElementById('reset').onclick = async () => {
  await chrome.storage.local.remove('blocklist');
  ta.value = defaults.join('\n');
  status.textContent = 'reset to defaults';
};
