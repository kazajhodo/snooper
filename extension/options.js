const defaults = {
  enabled: true,
  relay: 'ws://localhost:8787/publish',
  domains: ['ddev.site', 'localhost'],
  domScope: '',
  captureWarnings: false,
};

const fields = ['enabled', 'relay', 'domains', 'domScope', 'captureWarnings'];
const el = (id) => document.getElementById(id);

(async () => {
  const config = { ...defaults, ...(await browser.storage.local.get(defaults)) };
  for (const name of fields) {
    const input = el(name);
    if (input.type === 'checkbox') input.checked = config[name];
    else input.value = Array.isArray(config[name]) ? config[name].join(', ') : config[name];
  }
})();

el('save').addEventListener('click', async () => {
  await browser.storage.local.set({
    enabled: el('enabled').checked,
    relay: el('relay').value.trim() || defaults.relay,
    domains: el('domains').value.split(',').map((d) => d.trim()).filter(Boolean),
    domScope: el('domScope').value.trim(),
    captureWarnings: el('captureWarnings').checked,
  });
  const saved = el('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 1500);
});
