#!/usr/bin/env node
/**
 * Send one command to the extension through the relay, then exit.
 *
 *   node snoop.js query 'form[id^="neo-component-"]'
 *   node snoop.js query 'table tbody tr' --in size=desktop
 *   node snoop.js scope 'form.neo-alchemist--component-form'
 *   node snoop.js scope off
 *   node snoop.js snap '.csv-tools' --in alchemist/full?
 *   node snoop.js interactions off|clicks|all
 *   node snoop.js warnings on|off
 *   node snoop.js status
 *
 * --in <substring> restricts query/snap to frames whose URL contains it. A page
 * with preview iframes answers from every frame otherwise, and most of those
 * answers are "0 matches".
 */
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const valid = ['scope', 'snap', 'query', 'interactions', 'warnings', 'status'];

let frame = '';
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--in' || argv[i] === '--frame') {
    frame = argv[++i] || '';
    continue;
  }
  rest.push(argv[i]);
}

const [command, ...values] = rest;

if (!command || !valid.includes(command)) {
  process.stderr.write(`usage: snoop.js <${valid.join('|')}> [value] [--in <url-substring>]\n`);
  process.exit(1);
}

const PORT = Number(process.env.SNOOPER_PORT || 8787);
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/control`);

socket.on('open', () => {
  socket.send(JSON.stringify({ command, value: values.join(' '), frame }));
  // The relay acknowledges on the subscriber stream rather than back down this
  // socket, so there is nothing to wait for beyond the write landing.
  setTimeout(() => {
    socket.close();
    process.exit(0);
  }, 200);
});

socket.on('error', (error) => {
  process.stderr.write(`snooper relay unreachable on ${PORT}: ${error.message}\n`);
  process.exit(1);
});
