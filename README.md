# Snooper

A Firefox extension and a local relay that let Claude Code watch a browser
session directly — JS errors, AJAX failures and scoped DOM changes arrive as
events instead of being copy-pasted into the chat.

The point is to close the feedback loop: you drive, Claude sees the result.

## What it looks like in use

You click through the UI; Claude receives this without you typing anything:

```
[18:00:01] YOU   /node/999167/alchemist/full · click <input#edit-…-csv-upload[type=file]>
[18:00:04] YOU   /node/999167/alchemist/full · change <input#edit-…-csv-upload[type=file]> = blink-codes.csv
[18:00:05] DOM   /node/999167/alchemist/full · form.neo-alchemist--component-form: +169 node(s), −169 node(s)
    Error message File already locked for writing. Upload a CSV
[18:00:07] AJAX FAIL 500 /node/999167/alchemist/full/edit/f9716195
    TypeError: TableCsv::text(): Argument #1 must be of type string, Markup given
```

And Claude can interrogate the page directly, without touching your browser:

```
node relay/snoop.js query 'form[id^="neo-component-"]'
node relay/snoop.js query 'tbody tr' --in size=desktop
node relay/snoop.js scope 'form.neo-alchemist--component-form'
```

**Requirements:** Node 18+ for the relay (one dependency, `ws`), and a Firefox
build that runs unsigned add-ons.

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

### 2. Extension (Firefox Developer Edition)

This is unsigned, so it needs a Firefox build that will run unsigned add-ons:
**Developer Edition, Nightly, or ESR**. Release and Beta will not, at any pref —
they enforce signing unconditionally, so there is no workaround there.

#### Option A — temporary (start here)

No preference change, works immediately, **gone on restart**.

1. `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on…*
3. Select `extension/manifest.json` (the manifest itself, not the folder)

Good for trying it; annoying as a daily driver because it must be re-loaded
every time Firefox starts.

#### Option B — permanent

1. `about:config` → accept the warning
2. Search **`xpinstall.signatures.required`** → set it to **`false`**
   (it is `true` even in Developer Edition, so this step is required)
3. Build the `.xpi` — **zip the *contents* of `extension/`, not the folder**.
   `manifest.json` has to sit at the archive root or Firefox rejects it:
   ```
   cd extension && zip -r ../snooper.xpi . -x '.*'
   ```
4. `about:addons` → gear icon → *Install Add-on From File…* → pick `snooper.xpi`

#### Verify it is connected

With the relay running, `lsof -nP -i :8787` should show a `firefox` line. That
only proves the background page connected — see the reload gotcha below for why
that is not the same as the page being watched.

### ⚠ Reloading: the one thing that will waste your time

**Reloading the add-on does NOT re-inject into already-open tabs.** The content
script is injected at page load; reloading the extension replaces the background
page but leaves every open tab running the *previous* `inject.js`.

So after any change to the extension:

1. Reload the add-on (`about:debugging` → *Reload*, or reinstall the `.xpi`)
2. **Reload the pages you are watching** — a plain F5

Skip step 2 and you get the old behaviour with no error anywhere, which reads
exactly like "the fix didn't work". This cost an hour the first time.

Same applies to the relay: it can be stopped and started freely (the extension
reconnects with backoff), but a *schema* change between relay and extension
needs both restarted.

### 3. Options

Open the extension's options page and set:

| Setting | What it does |
|---|---|
| Relay | Where to publish. Default `ws://localhost:8787/publish`. |
| Domains | Only watch these. Default `ddev.site, localhost` — keeps it off real sites. |
| DOM scope | CSS selector. Changes inside it are summarised. **Blank disables DOM watching**, which is the right default until you need it. |
| Interactions | `clicks` (default), `all`, `off` — see below. |
| Capture `console.warn` | Off by default. Noisy. |

### Interactions

Reports **what you touched**, not where the cursor is. Coordinates are a
firehose that says nothing about intent; one line per interaction reconstructs
the path through the UI at a fraction of the cost.

- `clicks` — clicks and field changes. Low volume, high signal, on by default.
- `all` — adds hover *dwell* (a cursor that stops for a second, not one that
  crosses the page). Noisy; reach for it when you need to know what someone was
  looking at.
- `off` — when watching for one specific thing.

Password fields report that they changed and never what they contain; every
other value is clipped. File inputs report the filename.

### 4. Claude subscribes

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
| `YOU` | what you clicked or changed — the path you took through the UI, not pointer coordinates |
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
- **Queries answer per frame, and the relay folds them into one event.** A page
  with preview iframes has every frame reply independently; the relay buffers
  those replies for 700ms, drops the frames that matched nothing, dedupes
  identical answers from nested same-origin frames, and emits a single line.
  Fourteen messages become one.
- **`--in <url-substring>` targets a frame.** `snoop.js query 'tbody tr' --in
  size=desktop` asks only the desktop preview. The frame decides whether to
  answer, since only it knows its own URL.
- Each frame still caps at 10 described matches; the count says what was left
  out.
- The page-world hooks are installed at `document_start`, but jQuery usually is
  not defined yet — the AJAX hook retries for 10s before giving up.
