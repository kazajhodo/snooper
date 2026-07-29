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
      broadcast(format(payload.event || {}, payload.page));
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
