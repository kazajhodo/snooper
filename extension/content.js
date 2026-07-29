/**
 * Bridge between the page world and the background page.
 */
(async () => {
  const defaults = {
    enabled: true,
    domains: ['ddev.site', 'localhost'],
    domScope: '',
    captureWarnings: false,
  };
  const config = { ...defaults, ...(await browser.storage.local.get(defaults)) };

  if (!config.enabled) return;
  if (config.domains.length && !config.domains.some((d) => location.hostname.endsWith(d))) return;

  // Config travels on the script tag rather than by message: inject.js runs the
  // moment it is appended, so anything sent afterwards arrives too late to
  // configure the hooks it has already installed.
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('inject.js');
  script.dataset.snoopConfig = JSON.stringify({
    domScope: config.domScope,
    captureWarnings: config.captureWarnings,
  });
  (document.head || document.documentElement).prepend(script);
  script.remove();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__snoop) return;
    browser.runtime.sendMessage({ __snoop: true, event: e.data.event, page: location.pathname + location.search });
  });
})();
