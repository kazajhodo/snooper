# Snooper

A Firefox extension and a local relay that let Claude Code watch a browser
session directly — JS errors, AJAX failures and scoped DOM changes arrive as
events instead of being copy-pasted into the chat.

The point is to close the feedback loop: you drive, Claude sees the result.

## Why it is shaped this way

**The browser half only.** Server-side errors are already available without a
browser (`drush watchdog:tail`, application logs), so this deliberately does not
try to be a general observability tool. It carries what only the browser knows.

**Everything is filtered, nothing is streamed raw.** Each event becomes a
message in Claude's context, so a raw console pipe would exhaust a session in
minutes and cost more attention than it saves. Hence per-event dedupe, a hard
rate limit, coalesced DOM batches, and DOM reporting as *summaries* rather than
markup.

**MV2, persistent background.** Firefox MV3 background pages are non-persistent
event pages, which would tear the WebSocket down between events.

## Setup

### 1. Relay

```
cd relay
npm install
npm start
```

Listens on `ws://localhost:8787`. The extension publishes to `/publish`; Claude
subscribes to `/subscribe`. It keeps the last 50 events and replays the last 15
to a subscriber that attaches late, since Claude connects on demand rather than
at browser start.

### 2. Extension

Firefox Developer Edition, unsigned:

- **Temporary** (simplest, resets on restart) — `about:debugging#/runtime/this-firefox`
  → *Load Temporary Add-on* → pick `extension/manifest.json`.
- **Persistent** — set `xpinstall.signatures.required=false` in `about:config`,
  zip the contents of `extension/` into an `.xpi` and install it.

Then open the extension's options page and set:

| Setting | What it does |
|---|---|
| Relay | Where to publish. Default `ws://localhost:8787/publish`. |
| Domains | Only watch these. Default `ddev.site, localhost` — keeps it off real sites. |
| DOM scope | CSS selector. Changes inside it are summarised. **Blank disables DOM watching**, which is the right default until you need it. |
| Capture `console.warn` | Off by default. Noisy. |

### 3. Claude subscribes

Claude opens `ws://localhost:8787/subscribe` with its `Monitor` tool and each
frame becomes a notification.

## What gets reported

| Event | Source |
|---|---|
| `JS ERROR` | `window.onerror`, with file:line and stack |
| `UNHANDLED REJECTION` | `unhandledrejection` |
| `CONSOLE ERROR` / `CONSOLE WARN` | wrapped `console` in the page world |
| `AJAX FAIL` | jQuery `ajaxError` — **including the response body**, which is where a Drupal AJAX 500's exception message lives |
| `RESOURCE FAIL` | failed subresource loads |
| `DOM` | coalesced mutation summary inside the scope, plus any `.messages` / `[role=alert]` text that appeared |
| `SNAPSHOT` | on request only |
| `MARK` | on request only |

## Driving it from the page

```js
__snoop('about to hit save')   // drop a labelled marker in the stream
__snoop.snap()                 // send the DOM scope's markup (capped at 12KB)
__snoop.snap('.some-form')     // snapshot something else
```

Marks and snapshots bypass dedupe — they were asked for.

## Limits worth knowing

- 30 spontaneous events/minute, then the feed cuts with one `SUPPRESSED` line.
  Silence and a severed feed look identical otherwise.
- **DOM summaries have their own 6/minute cap.** A rich editing form mutates
  continuously; on the shared counter it starves out the errors you actually
  want.
- **Answers are not rate limited** — marks, queries, snapshots and acks were
  asked for, so they never count against the spontaneous budget.
- Identical events collapse within 5 seconds.
- Snapshots are capped at 12KB, other text at 800 chars.
- The page-world hooks are installed at `document_start`, but jQuery usually is
  not defined yet — the AJAX hook retries for 10s before giving up.
