/**
 * Holds the relay socket and gates what reaches it.
 *
 * Persistent on purpose (MV2): a non-persistent event page is torn down between
 * events, which takes the socket with it and reconnects on every error.
 */

const defaults = {
  enabled: true,
  relay: 'ws://localhost:8787/publish',
  domains: ['ddev.site', 'localhost'],
  domScope: '',
  captureWarnings: false,
};

let config = { ...defaults };
let socket = null;
let retry = 0;
let retryTimer = null;

// Every frame becomes a message in Claude's context, so the two limiters below
// are not politeness — an unthrottled console loop would exhaust a session.
const DEDUPE_MS = 5000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60000;

// Answers to a question that was just asked. They are not part of the
// spontaneous feed the limits exist to bound, and counting them means a few
// deliberate queries can exhaust the budget before a single real error lands.
const SOLICITED = new Set(['mark', 'snapshot', 'query', 'ack']);

// DOM summaries get their own, much tighter budget. A rich editing form mutates
// continuously, so left on the shared counter it starves everything else.
const DOM_LIMIT = 6;
let domCount = 0;

const recent = new Map();
let windowStart = Date.now();
let windowCount = 0;
let suppressedNotice = false;

function connect() {
  clearTimeout(retryTimer);
  if (!config.enabled) return;

  try {
    socket = new WebSocket(config.relay);
  }
  catch {
    scheduleRetry();
    return;
  }

  socket.addEventListener('open', () => {
    retry = 0;
  });
  socket.addEventListener('message', (e) => handleCommand(e.data));
  socket.addEventListener('close', scheduleRetry);
  socket.addEventListener('error', () => socket?.close());
}

/**
 * Commands arrive back down the same socket, so whoever is watching the stream
 * can retarget the watch without touching the options page.
 */
async function handleCommand(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  }
  catch {
    return;
  }

  const { command, value } = message;

  if (command === 'scope') {
    const domScope = (!value || value === 'off') ? '' : value;
    await browser.storage.local.set({ domScope });
    await pushToTabs({ __snoopConfig: { domScope, captureWarnings: config.captureWarnings } });
    send({ type: 'ack', text: domScope ? `scope set: ${domScope}` : 'scope cleared', at: Date.now() });
    return;
  }

  if (command === 'warnings') {
    const captureWarnings = value === 'on';
    await browser.storage.local.set({ captureWarnings });
    send({ type: 'ack', text: `console.warn capture ${captureWarnings ? 'on' : 'off'} (takes effect on page reload)`, at: Date.now() });
    return;
  }

  if (command === 'snap' || command === 'query') {
    await pushToTabs({ __snoopCommand: { name: command, value } });
    return;
  }

  if (command === 'status') {
    send({
      type: 'ack',
      at: Date.now(),
      text: `enabled=${config.enabled} scope=${config.domScope || '(none)'} warnings=${config.captureWarnings} domains=${config.domains.join(',') || '(all)'}`,
    });
  }
}

/**
 * Only tabs the content script actually runs in — a command sent to a tab with
 * no listener rejects, and an unhandled rejection per tab is noise.
 */
async function pushToTabs(payload) {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map((tab) => browser.tabs.sendMessage(tab.id, payload).catch(() => {})));
}

function scheduleRetry() {
  socket = null;
  // The relay is a local dev process that gets stopped and started freely, so
  // a dropped socket is normal rather than a failure. Back off, don't give up.
  const delay = Math.min(30000, 1000 * 2 ** retry++);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, delay);
}

function allow(event) {
  const now = Date.now();

  if (now - windowStart > RATE_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
    domCount = 0;
    suppressedNotice = false;
  }

  if (SOLICITED.has(event.type)) return true;

  if (event.type === 'dom' && ++domCount > DOM_LIMIT) {
    if (domCount === DOM_LIMIT + 1) {
      send({ type: 'suppressed', text: `DOM summaries capped (${DOM_LIMIT}/min) — errors and answers still coming through`, at: now });
    }
    return false;
  }

  if (++windowCount > RATE_LIMIT) {
    if (suppressedNotice) return false;
    suppressedNotice = true;
    // One line saying the feed was cut beats silence, which reads identically
    // to a quiet page.
    send({ type: 'suppressed', text: `rate limit hit (${RATE_LIMIT}/min) — further events dropped this minute`, at: now });
    return false;
  }

  // Marks and snapshots are asked for explicitly; never collapse them.
  if (event.type === 'mark' || event.type === 'snapshot') return true;

  const key = `${event.type}:${event.text}`;
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  return true;
}

function send(event, page) {
  if (socket?.readyState === 1) {
    socket.send(JSON.stringify({ event, page }));
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message?.__snoop || !config.enabled) return;
  if (!allow(message.event)) return;
  const page = message.page || (sender.tab ? new URL(sender.tab.url).pathname : '');
  send(message.event, page);
});

browser.storage.onChanged.addListener(async () => {
  const previous = config.relay;
  config = { ...defaults, ...(await browser.storage.local.get(defaults)) };
  if (config.relay !== previous || !socket) {
    socket?.close();
    retry = 0;
    connect();
  }
});

(async () => {
  config = { ...defaults, ...(await browser.storage.local.get(defaults)) };
  connect();
})();
