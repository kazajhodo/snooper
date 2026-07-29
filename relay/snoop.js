#!/usr/bin/env node
/**
 * Send one command to the extension through the relay, then exit.
 *
 *   node snoop.js query 'form[id^="neo-component-"]'
 *   node snoop.js scope 'form[id^="neo-component-"]'
 *   node snoop.js scope off
 *   node snoop.js snap [selector]
 *   node snoop.js warnings on|off
 *   node snoop.js status
 */
import WebSocket from 'ws';

const [command, ...rest] = process.argv.slice(2);
const valid = ['scope', 'snap', 'query', 'warnings', 'status'];

if (!command || !valid.includes(command)) {
  process.stderr.write(`usage: snoop.js <${valid.join('|')}> [value]\n`);
  process.exit(1);
}

const PORT = Number(process.env.SNOOPER_PORT || 8787);
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/control`);

socket.on('open', () => {
  socket.send(JSON.stringify({ command, value: rest.join(' ') }));
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
