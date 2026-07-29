/**
 * Page-context hooks.
 *
 * This has to run in the page's own world, not the content script's isolated
 * one: an isolated script gets its own `console` and never sees the page's
 * jQuery, so console wrapping and Drupal's AJAX events are both invisible from
 * there.
 */
(() => {
  const config = JSON.parse(document.currentScript?.dataset.snoopConfig || '{}');
  const MAX_TEXT = 800;
  const MAX_SNAPSHOT = 12000;

  const clip = (value, max = MAX_TEXT) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
  };

  const post = (event) => {
    try {
      window.postMessage({ __snoop: true, event: { at: Date.now(), ...event } }, '*');
    }
    catch {
      // A structured-clone failure must never take the page down with it.
    }
  };

  const describe = (arg) => {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    }
    catch {
      return String(arg);
    }
  };

  // --- console -------------------------------------------------------------

  for (const level of ['error', 'warn']) {
    if (level === 'warn' && !config.captureWarnings) continue;
    const original = console[level];
    console[level] = function (...args) {
      post({ type: `console-${level}`, text: clip(args.map(describe).join(' ')) });
      return original.apply(this, args);
    };
  }

  // --- uncaught errors -----------------------------------------------------

  window.addEventListener('error', (e) => {
    // Failed subresources fire here too, with no message and the element as
    // the target — worth reporting, but as a different kind of thing.
    if (!e.message && e.target && e.target !== window) {
      const src = e.target.src || e.target.href;
      if (src) post({ type: 'resource-error', text: clip(src, 200) });
      return;
    }
    post({
      type: 'js-error',
      text: clip(e.message),
      at_source: `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`,
      detail: e.error?.stack ? clip(e.error.stack, 600) : undefined,
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    post({ type: 'unhandled-rejection', text: clip(describe(e.reason)) });
  });

  // --- Drupal AJAX ---------------------------------------------------------

  // The response body is the whole point: a Drupal AJAX 500 renders as a modal
  // the developer has to copy out by hand, and the exception message is in
  // there. jQuery's ajaxError carries it.
  const hookAjax = () => {
    const jq = window.jQuery;
    if (!jq) return false;
    jq(document).on('ajaxError', (_event, xhr, settings) => {
      const body = (xhr.responseText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      post({
        type: 'ajax-error',
        text: `${xhr.status || 'no status'} ${clip(settings?.url, 200)}`,
        detail: clip(body, 600),
      });
    });
    return true;
  };

  if (!hookAjax()) {
    // jQuery is usually not defined at document_start.
    let tries = 0;
    const timer = setInterval(() => {
      if (hookAjax() || ++tries > 40) clearInterval(timer);
    }, 250);
  }

  // --- scoped DOM watch ----------------------------------------------------

  // Deliberately a summary, never raw markup. An unscoped or unsummarised DOM
  // feed costs more to read than it saves, which is the failure mode this
  // whole tool exists to avoid.
  let pending = null;
  let flushTimer = null;

  const summarise = () => {
    flushTimer = null;
    const batch = pending;
    pending = null;
    if (!batch) return;

    const parts = [];
    if (batch.added) parts.push(`+${batch.added} node(s)`);
    if (batch.removed) parts.push(`−${batch.removed} node(s)`);
    if (batch.attributes) parts.push(`${batch.attributes} attribute change(s)`);

    post({
      type: 'dom',
      text: `${batch.scope}: ${parts.join(', ') || 'changed'}`,
      // Messages the user would be reading on screen right now — the reason to
      // watch the DOM at all rather than just the console.
      detail: batch.messages.length ? clip(batch.messages.join(' | '), 600) : undefined,
    });
  };

  const noteworthy = (node) => {
    if (node.nodeType !== 1) return null;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const selector = '.messages, .messages--error, .messages--warning, .form-item--error-message, [role="alert"]';
    if (node.matches?.(selector) || node.querySelector?.(selector)) return text;
    return null;
  };

  // Scope roots already being watched. An AJAX-driven UI replaces the scope
  // element wholesale rather than mutating it, and an observer stays bound to
  // the node it was given — so without re-binding, watching survives exactly
  // one rebuild and then goes quiet without saying so.
  const observed = new WeakSet();

  const startScopeWatch = () => {
    const selector = config.domScope;
    if (!selector) return;
    const root = document.querySelector(selector);
    if (!root || observed.has(root)) return false;
    observed.add(root);

    new MutationObserver((records) => {
      pending = pending || { scope: selector, added: 0, removed: 0, attributes: 0, messages: [] };
      for (const record of records) {
        if (record.type === 'attributes') {
          pending.attributes++;
          continue;
        }
        pending.added += record.addedNodes.length;
        pending.removed += record.removedNodes.length;
        for (const node of record.addedNodes) {
          const message = noteworthy(node);
          if (message && !pending.messages.includes(message)) pending.messages.push(message);
        }
      }
      // Coalesced: one AJAX rebuild produces hundreds of records and is one
      // event as far as anyone watching is concerned.
      if (!flushTimer) flushTimer = setTimeout(summarise, 400);
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'hidden'] });

    return true;
  };

  if (config.domScope) {
    // Polled rather than one-shot: the scope element usually arrives with an
    // AJAX response instead of the page, and is replaced again on every
    // subsequent one. Cheap — a querySelector against a WeakSet check — and it
    // runs for the life of the page so a scope that comes and goes keeps being
    // picked up.
    startScopeWatch();
    setInterval(startScopeWatch, 1000);
  }

  // --- manual marks --------------------------------------------------------

  window.__snoop = (note) => {
    post({ type: 'mark', text: clip(note) });
  };

  window.__snoop.snap = (selector) => {
    const target = document.querySelector(selector || config.domScope || 'body');
    if (!target) {
      post({ type: 'mark', text: `snap: nothing matches ${selector || config.domScope}` });
      return;
    }
    post({
      type: 'snapshot',
      text: selector || config.domScope || 'body',
      detail: clip(target.outerHTML.replace(/\s+/g, ' '), MAX_SNAPSHOT),
    });
  };
})();
