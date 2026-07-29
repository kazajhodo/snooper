# Snooper

A Firefox extension and a local relay that let **Claude Code watch a browser
session directly**. JS errors, failed requests, scoped DOM changes and what you
clicked arrive as live events, instead of being copy-pasted into the chat.

You drive. Claude sees the result.

```
[18:00:01] YOU   /node/999167/alchemist/full · click <input#edit-…-csv-upload[type=file]>
[18:00:04] YOU   /node/999167/alchemist/full · change <input#edit-…-csv-upload[type=file]> = blink-codes.csv
[18:00:05] DOM   /node/999167/alchemist/full · form.neo-alchemist--component-form: +169 −169 node(s)
    Error message File already locked for writing. Upload a CSV
[18:00:07] AJAX FAIL 500 /node/999167/alchemist/full/edit/f9716195
    TypeError: TableCsv::text(): Argument #1 must be of type string, Markup given
```

Claude can also interrogate the page without touching your browser:

```
node relay/snoop.js query 'tbody tr' --in size=desktop
node relay/snoop.js scope 'form.neo-alchemist--component-form'
```

It **observes only** — it cannot click, type or navigate. For that, use a
headless driver.

## Install

The setup, operation and troubleshooting all live in a **Claude skill**, so it
loads when it is relevant rather than being a page nobody re-reads:

```
cp -R skills/snooper /path/to/your/project/.claude/skills/
```

Then just ask Claude to set up Snooper, or to watch the browser while you
reproduce something.

Doing it by hand instead: read [`skills/snooper/SKILL.md`](skills/snooper/SKILL.md).
It covers which Firefox builds run unsigned add-ons, the `about:config` pref,
building the `.xpi`, the commands, and the traps — including the one that will
cost you an hour otherwise (**reloading the add-on does not re-inject into
already-open tabs; reload the pages too**).

**Requirements:** Node 18+ for the relay (one dependency, `ws`), and Firefox
Developer Edition, Nightly or ESR — Release and Beta will not run unsigned
add-ons at any pref.

## Design notes

**Browser half only.** Server-side errors are already reachable without a browser
(`drush watchdog:tail`, application logs). This carries what only the browser
knows, and pairs with a server-side tail rather than replacing it.

**Everything is filtered, nothing is streamed raw.** Each event becomes a message
in Claude's context, so a raw console pipe would exhaust a session in minutes and
cost more attention than it saves. Hence dedupe, per-channel rate limits,
coalesced DOM batches, and DOM reported as summaries rather than markup.

**MV2 with a persistent background page.** Firefox MV3 background pages are
non-persistent event pages, which would tear the WebSocket down between events.

## Layout

```
extension/   MV2 add-on — socket, filtering, page-context hooks
relay/       ws relay (server.js) + one-shot command sender (snoop.js)
skills/      the Claude skill: setup, operation, traps
```
