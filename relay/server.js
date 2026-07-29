import { WebSocketServer } from 'ws';

const PORT = Number(process.env.SNOOPER_PORT || 8787);

// Claude attaches on demand, not at browser start, so without a buffer every
// event that fired before it connected is lost. Replay is capped well below
// the buffer: one notification per frame, and a 50-line dump on connect is
// noise, not context.
const BUFFER = 50;
const REPLAY = 15;

const history = [];
const subscribers = new Set();

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
    'snapshot': 'SNAPSHOT',
    'mark': 'MARK',
    'suppressed': 'SUPPRESSED',
  }[event.type] || event.type.toUpperCase();

  let line = `[${time}] ${label}${where} · ${event.text || ''}`;
  if (event.at_source) line += ` @ ${event.at_source}`;
  if (event.detail) line += `\n    ${event.detail.replace(/\n/g, '\n    ')}`;
  return line;
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket, req) => {
  const path = (req.url || '/').split('?')[0];

  if (path !== '/publish') {
    subscribers.add(socket);
    const replay = history.slice(-REPLAY);
    if (replay.length) {
      // Sent as one frame: the subscriber turns each frame into a message, and
      // replayed history is context, not fifteen separate things that happened.
      socket.send(`↺ replaying last ${replay.length} event(s)\n${replay.join('\n')}`);
    }
    socket.on('close', () => subscribers.delete(socket));
    return;
  }

  socket.on('message', (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    }
    catch {
      return;
    }
    const line = format(payload.event || {}, payload.page);
    history.push(line);
    if (history.length > BUFFER) history.shift();
    for (const sub of subscribers) {
      if (sub.readyState === 1) sub.send(line);
    }
    process.stdout.write(`${line}\n`);
  });
});

process.stdout.write(
  `snooper relay listening on ws://localhost:${PORT}\n` +
  `  extension publishes to ws://localhost:${PORT}/publish\n` +
  `  Claude subscribes to  ws://localhost:${PORT}/subscribe\n`
);
