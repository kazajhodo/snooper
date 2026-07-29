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
  let observed = new WeakSet();
  let observers = [];

  const startScopeWatch = () => {
    const selector = config.domScope;
    if (!selector) return;
    const root = document.querySelector(selector);
    if (!root || observed.has(root)) return false;
    observed.add(root);

    const observer = new MutationObserver((records) => {
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
      // event as far as anyone watching is concerned. The window is generous
      // because rich editors mutate continuously — too short and a single form
      // reports itself a dozen times for one user action.
      if (!flushTimer) flushTimer = setTimeout(summarise, 1200);
    });

    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'hidden'] });
    observers.push(observer);

    return true;
  };

  // Polled rather than one-shot: the scope element usually arrives with an AJAX
  // response instead of the page, and is replaced again on every subsequent
  // one. Cheap — a querySelector against a WeakSet check — and it runs for the
  // life of the page so a scope that comes and goes keeps being picked up.
  startScopeWatch();
  setInterval(startScopeWatch, 1000);

  const retarget = (selector) => {
    for (const observer of observers) observer.disconnect();
    observers = [];
    observed = new WeakSet();
    config.domScope = selector || '';
    startScopeWatch();
  };

  // --- inspection ----------------------------------------------------------

  const snapshot = (selector) => {
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

  /**
   * An element in one line: enough to recognise it, never enough to read the
   * page through it.
   */
  const describeNode = (node) => {
    if (!node || node.nodeType !== 1) return String(node);
    const id = node.id ? `#${node.id}` : '';
    const cls = node.classList.length ? `.${[...node.classList].slice(0, 4).join('.')}` : '';
    const type = node.getAttribute?.('type') ? `[type=${node.getAttribute('type')}]` : '';
    return `<${node.tagName.toLowerCase()}${id}${cls}${type}>`;
  };

  const nodeText = (node, max = 70) =>
    (node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);

  /**
   * Enough of each match to choose a watch target, and no more — this is for
   * finding the right selector, not for reading the page.
   */
  const query = (selector) => {
    let nodes;
    try {
      nodes = [...document.querySelectorAll(selector)];
    }
    catch {
      post({ type: 'mark', text: `query: invalid selector ${selector}` });
      return;
    }
    // Ten, not twenty-five: every frame on the page answers a query
    // independently, so the reply is multiplied by frame count before it is
    // ever read. Ten is enough to pick a target; the count says how much was
    // left out.
    const described = nodes.slice(0, 10).map((node, i) => `${i}: ${describeNode(node)} ${nodeText(node)}`);
    post({
      type: 'query',
      text: `${selector} → ${nodes.length} match(es)`,
      detail: described.length ? clip(described.join('\n'), 1200) : undefined,
    });
  };

  // --- interactions --------------------------------------------------------

  // What was clicked, not where the pointer is: coordinates are a firehose that
  // says nothing about intent, while one line per interaction reconstructs the
  // path someone took through the UI.
  let interactions = config.interactions ?? 'clicks';
  let hoverTimer = null;
  let lastHovered = null;

  document.addEventListener('click', (e) => {
    if (interactions === 'off') return;
    const target = e.target;
    post({ type: 'interaction', text: `click ${describeNode(target)} ${clip(nodeText(target, 40), 40)}` });
  }, true);

  document.addEventListener('change', (e) => {
    if (interactions === 'off') return;
    const target = e.target;
    // Never report what was typed into a password field, and only ever a clip
    // of anything else — this is a record of what was touched, not of content.
    if (target.type === 'password') {
      post({ type: 'interaction', text: `change ${describeNode(target)} (value withheld)` });
      return;
    }
    const value = target.type === 'file'
      ? [...(target.files || [])].map((f) => f.name).join(', ')
      : String(target.value ?? '');
    post({ type: 'interaction', text: `change ${describeNode(target)} = ${clip(value, 60)}` });
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (interactions !== 'all') return;
    const target = e.target;
    clearTimeout(hoverTimer);
    // Dwell, not movement: a cursor crossing the page is not a signal, a cursor
    // stopping on something is.
    hoverTimer = setTimeout(() => {
      if (target === lastHovered) return;
      lastHovered = target;
      post({ type: 'interaction', text: `hover ${describeNode(target)} ${clip(nodeText(target, 40), 40)}` });
    }, 1000);
  }, true);

  // --- commands from the relay ---------------------------------------------

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__snoopConfig) {
      const next = e.data.__snoopConfig;
      if (next.interactions !== undefined) interactions = next.interactions;
      if (next.domScope !== undefined) retarget(next.domScope);
      return;
    }
    const command = e.data.__snoopCommand;
    if (!command) return;
    if (command.name === 'snap') snapshot(command.value);
    if (command.name === 'query') query(command.value);
  });

  // --- manual marks --------------------------------------------------------

  window.__snoop = (note) => {
    post({ type: 'mark', text: clip(note) });
  };

  window.__snoop.snap = snapshot;
  window.__snoop.query = query;
})();
