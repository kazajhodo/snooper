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
  socket.addEventListener('close', scheduleRetry);
  socket.addEventListener('error', () => socket?.close());
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
    suppressedNotice = false;
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
