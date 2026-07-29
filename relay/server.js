import { WebSocketServer } from 'ws';

const PORT = Number(process.env.SNOOPER_PORT || 8787);

// Loopback only. This carries whatever a developer's browser is doing and
// accepts commands that retarget the extension, so binding every interface
// would put both on the local network.
const HOST = '127.0.0.1';

// Claude attaches on demand, not at browser start, so without a buffer every
// event that fired before it connected is lost. Replay is capped well below
// the buffer: one notification per frame, and a 50-line dump on connect is
// noise, not context.
const BUFFER = 50;
const REPLAY = 15;

const history = [];
const subscribers = new Set();
const publishers = new Set();

/**
 * One event, one line — the subscriber reads these as plain text, not JSON.
 */
function format(event, page) {
  const time = new Date(event.at || Date.now()).toTimeString().slice(0, 8);
  const where = page ? ` ${page}` : '';
  const label = {
    'js-error': 'JS ERROR',
    'unhandled-rejection': 'UNHANDLED REJECTION',
    'console-error': 'CONSOLE ERROR',
    'console-warn': 'CONSOLE WARN',
    'ajax-error': 'AJAX FAIL',
    'resource-error': 'RESOURCE FAIL',
    'dom': 'DOM',
    'interaction': 'YOU',
    'query': 'QUERY',
    'snapshot': 'SNAPSHOT',
    'mark': 'MARK',
    'suppressed': 'SUPPRESSED',
    'ack': 'ACK',
  }[event.type] || event.type.toUpperCase();

  let line = `[${time}] ${label}${where} · ${event.text || ''}`;
  if (event.at_source) line += ` @ ${event.at_source}`;
  if (event.detail) line += `\n    ${event.detail.replace(/\n/g, '\n    ')}`;
  return line;
}

// Every frame on a page answers a query independently, and on a page with
// preview iframes most of them answer "0 matches". Folding the replies into one
// event is the difference between fourteen messages and one.
const QUERY_WINDOW_MS = 700;
const pendingQueries = new Map();

/**
 * Relay and extension are updated independently, so an older extension may not
 * send `count`. Reading it back out of the text keeps a version skew from
 * reporting every frame as a miss — a wrong answer is worse than a stale one.
 */
function countOf(event) {
  if (typeof event.count === 'number') return event.count;
  const match = /→\s*(\d+)\s*match/.exec(event.text || '');
  return match ? Number(match[1]) : 0;
}

/**
 * The selector alone, however the extension phrased it. Older builds send only
 * the rendered text ("sel → 3 match(es)"), and the key has to be identical
 * either way or one query lands in two buckets.
 */
function selectorOf(event) {
  if (event.selector) return event.selector;
  return (event.text || '?').replace(/\s*→\s*\d+\s*match\(es\)\s*$/, '');
}

function openQuery(key) {
  let entry = pendingQueries.get(key);
  if (!entry) {
    entry = { frames: [], timer: null };
    pendingQueries.set(key, entry);
    entry.timer = setTimeout(() => flushQuery(key), QUERY_WINDOW_MS);
  }
  return entry;
}

function bufferQuery(event, page) {
  const key = selectorOf(event);
  const entry = openQuery(key);
  const count = countOf(event);
  // Nested same-origin frames answer twice with identical results.
  const seen = entry.frames.some((f) => f.page === page && f.count === count && f.detail === event.detail);
  if (!seen) {
    entry.frames.push({ page, count, detail: event.detail });
  }
}

function flushQuery(key) {
  const entry = pendingQueries.get(key);
  pendingQueries.delete(key);
  if (!entry) return;

  const time = new Date().toTimeString().slice(0, 8);
  if (!entry.frames.length) {
    // No frame answered at all — usually a --in filter that matched nothing.
    // Saying so beats silence, which reads identically to "zero matches".
    broadcast(`[${time}] QUERY ${key} · no frame answered (filter matched no frame, or no page is listening)`);
    return;
  }
  const hits = entry.frames.filter((f) => f.count > 0);
  let line = `[${time}] QUERY ${key} · ${hits.length}/${entry.frames.length} frame(s) matched`;
  for (const hit of hits) {
    line += `\n  ${hit.page} → ${hit.count}`;
    if (hit.detail) line += `\n    ${hit.detail.replace(/\n/g, '\n    ')}`;
  }
  broadcast(line);
}

function broadcast(line) {
  history.push(line);
  if (history.length > BUFFER) history.shift();
  for (const sub of subscribers) {
    if (sub.readyState === 1) sub.send(line);
  }
  process.stdout.write(`${line}\n`);
}

const wss = new WebSocketServer({ port: PORT, host: HOST });

wss.on('connection', (socket, req) => {
  const path = (req.url || '/').split('?')[0];

  // The extension: sends events, receives commands.
  if (path === '/publish') {
    publishers.add(socket);
    socket.on('close', () => publishers.delete(socket));
    socket.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      }
      catch {
        return;
      }
      const event = payload.event || {};
      if (event.type === 'query') {
        bufferQuery(event, payload.page);
        return;
      }
      broadcast(format(event, payload.page));
    });
    return;
  }

  // A command sender (snoop.js). Write-only: it fires one command and exits.
  if (path === '/control') {
    socket.on('message', (data) => {
      const command = data.toString();
      if (!publishers.size) {
        broadcast(format({ type: 'ack', text: `command dropped, no extension connected: ${command}` }));
        return;
      }
      for (const pub of publishers) {
        if (pub.readyState === 1) pub.send(command);
      }
      // Open the bucket now rather than on the first reply, so a query that
      // nothing answers still reports back instead of vanishing.
      try {
        const parsed = JSON.parse(command);
        if (parsed.command === 'query' && parsed.value) openQuery(parsed.value);
      }
      catch {
        // Not JSON; nothing to pre-arm.
      }
      // Echoed so the command appears in the same stream as its effects —
      // otherwise a retarget and the events it produces look unrelated.
      broadcast(format({ type: 'ack', text: `→ ${command}` }));
    });
    return;
  }

  subscribers.add(socket);
  const replay = history.slice(-REPLAY);
  if (replay.length) {
    // Sent as one frame: the subscriber turns each frame into a message, and
    // replayed history is context, not fifteen separate things that happened.
    socket.send(`↺ replaying last ${replay.length} event(s)\n${replay.join('\n')}`);
  }
  socket.on('close', () => subscribers.delete(socket));
});

process.stdout.write(
  `snooper relay listening on ws://${HOST}:${PORT}\n` +
  `  extension publishes to ws://${HOST}:${PORT}/publish\n` +
  `  Claude subscribes to  ws://${HOST}:${PORT}/subscribe\n` +
  `  commands go to        ws://${HOST}:${PORT}/control\n`
);
