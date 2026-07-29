---
name: snooper
description: Install, operate and troubleshoot Snooper — a Firefox extension plus local WebSocket relay that streams JS errors, AJAX failures, scoped DOM changes and user interactions into Claude Code as live events, so a developer driving the browser never has to copy-paste what happened. Use when setting Snooper up, when asked to watch a browser session, when debugging a UI bug where the developer is at the keyboard and Claude needs to see the result, or when working in ~/Projects/snooper. NOT for headless browser automation (use Playwright/Puppeteer — Snooper observes a human-driven session, it cannot click anything), and NOT for server-side errors (use drush watchdog:tail or the application log; Snooper deliberately covers only what the browser knows).
---

# Snooper

A Firefox extension and a local relay that let Claude watch a browser session
directly. The developer drives; Claude sees errors, failed requests, scoped DOM
changes and interactions arrive as events.

**It observes. It cannot act.** There is no clicking, typing or navigating from
this side — only reading, plus asking the page questions via `query` / `snap`.

## When this earns its keep

A UI bug where the developer is at the keyboard and the failure is visible in the
browser: an AJAX 500 whose body holds the real exception, a form error message,
a JS exception, a DOM that does not update. Without it, every one of those costs
a copy-paste round trip and arrives partially transcribed.

**When it does not:** anything reproducible headlessly (write a test), anything
server-side (`drush watchdog:tail` streams that with no browser involved), or a
question answerable by reading code.

Pair it with a server-side tail when debugging a full-stack path — Snooper for
what the browser knows, watchdog for the exception and backtrace.

## Setup

### 1. Relay

```
cd ~/Projects/snooper/relay
npm install
npm start
```

Listens on `ws://127.0.0.1:8787` (loopback only, deliberately — it carries what
the browser is doing and accepts commands that retarget the extension).

- extension publishes to `/publish`
- Claude subscribes to `/subscribe`
- commands go to `/control`

It buffers the last 50 events and replays the last 15 to a late subscriber, since
Claude attaches on demand rather than at browser start.

### 2. Extension — Firefox Developer Edition

Unsigned, so it needs a build that will run unsigned add-ons: **Developer
Edition, Nightly or ESR**. Release and Beta enforce signing unconditionally —
there is no pref that changes that.

**Temporary** (no pref, gone on restart — start here):

1. `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on…*
3. select `extension/manifest.json` — the manifest, not the folder

**Permanent:**

1. `about:config` → set **`xpinstall.signatures.required`** to **`false`**
   (it is `true` even in Developer Edition, so this step is required)
2. zip the **contents** of `extension/`, not the folder — `manifest.json` must be
   at the archive root:
   ```
   cd extension && zip -r ../snooper.xpi . -x '.*'
   ```
3. `about:addons` → gear → *Install Add-on From File…*

Confirm the socket: `lsof -nP -i :8787` should show a `firefox` line. That proves
the background page connected — **not** that the page you care about is watched
(see Traps).

### 3. Claude subscribes

Open the relay as a WebSocket monitor; each frame becomes a notification:

```
Monitor({ ws: { url: 'ws://localhost:8787/subscribe' }, persistent: true })
```

## Driving it

All from the shell, no browser UI:

```
node ~/Projects/snooper/relay/snoop.js status
node ~/Projects/snooper/relay/snoop.js query '<css selector>' [--in <url-substring>]
node ~/Projects/snooper/relay/snoop.js scope '<css selector>' | off
node ~/Projects/snooper/relay/snoop.js snap ['<selector>'] [--in <url-substring>]
node ~/Projects/snooper/relay/snoop.js interactions off | clicks | all
node ~/Projects/snooper/relay/snoop.js warnings on | off
```

- **`query`** — the workhorse. Ask what is on the page, get one line per match
  (tag, id, classes, leading text). Use it to find a selector before setting a
  scope, and to check state instead of asking the developer to describe it.
- **`--in`** restricts to frames whose URL contains the substring. Essential on a
  page with preview iframes: every frame answers otherwise.
- **`scope`** — turn on DOM watching for one wrapper. Reports coalesced
  *summaries* plus any `.messages` / `[role=alert]` text that appeared. Blank/off
  by default and that is the right default.
- **`snap`** — capped markup dump. Only when a summary genuinely is not enough.
- **`interactions`** — `clicks` (default) reports what was clicked and changed;
  `all` adds hover dwell and is noisy; `off` when watching for one thing.

From the page itself (developer console):

```js
__snoop('about to hit save')   // labelled marker in the stream
__snoop.snap()                 // snapshot the scope
__snoop.query('.some-thing')   // same as the CLI query
```

Marks and snapshots bypass dedupe — they were asked for.

## Budget discipline

Every event becomes a message in Claude's context, so this is a feature with a
running cost. Built-in limits: 30 spontaneous events/min, DOM summaries capped at
6/min separately (a rich editor mutates constantly and would starve out real
errors), interactions at 20/min, identical events collapse within 5s, snapshots
capped at 12KB. Answers (query/snap/mark/ack) are exempt — they were requested.

**Turn channels down when they are not earning.** Before a stretch of CLI work,
`interactions off` and `scope off`; errors and AJAX failures cost nothing while
nothing is wrong. Leave those on always.

## Traps

**Reloading the add-on does not re-inject into open tabs.** The content script is
injected at page load. Reload the extension and every open tab keeps running the
*previous* `inject.js` — old behaviour, no error anywhere, reads exactly like a
fix that did not work. **Always reload the pages too.**

**Silence is ambiguous.** A query nothing answers now reports "no frame answered"
rather than saying nothing, but if a command produces no ACK at all, check the
relay is running and the extension is connected before believing the result.

**`lsof` showing firefox proves only the background page.** The content script is
gated by the domain allowlist (default `ddev.site, localhost`) and by page load.

**Version skew.** Relay and extension update independently. If query results look
structurally wrong after an update, restart the relay *and* reload the extension
*and* the pages.

**Queries multiply by frame count.** A page with preview iframes has every frame
answer. The relay folds replies into one event, but the underlying work — and the
text volume — still scales. Use `--in`, and prefer a narrow selector.

## Layout

```
extension/     MV2 add-on (persistent background: MV3 event pages would drop the socket)
  background.js  socket, dedupe, rate limits, command handling
  content.js     bridge between page world and background
  inject.js      page-context hooks: console, errors, AJAX, DOM, interactions
relay/
  server.js      ws relay, event formatting, query aggregation
  snoop.js       one-shot command sender
```

Tuning knobs live in `background.js` (`DEDUPE_MS`, `RATE_LIMIT`, `DOM_LIMIT`,
`INTERACTION_LIMIT`) and `inject.js` (clip lengths, coalesce window). Expect to
retune them in use — the right values depend on what is being watched.
