# Session archive

Keeps every orchestration event from all your machines in one SQLite file on a hub machine. That
covers prompts, replies, reasoning, tool calls and subagents. Klin itself deletes stored events
about a day after they happen, so this is how you keep them.

The plugin has a server half only and needs no build. Install it by dragging this folder onto
**Settings → Plugins**, or with **Add plugin → Choose folder**. Every machine runs the same plugin,
and its settings decide what each machine does.

## Setup

1. Pick a key of at least 16 characters, such as the output of `openssl rand -hex 24`.
2. On the hub, set **Archive file** to an absolute path such as
   `/srv/archive/klin-sessions.sqlite`, **Hub address** to the hub's own address such as
   `http://homeserver:4790`, and **Shared key** to the key.
3. On every other machine, set **Hub address** to the same address and **Shared key** to the same
   key. Leave **Archive file** empty.

The hub listens on the port in **Hub address** on every network interface, and refuses requests
without the key. Make sure the other machines can reach that port, such as over Tailscale. A hub
with an empty **Hub address** archives only its own events.

## How it works

Every machine reads its own stored events from where it last stopped. The hub writes them straight
into the archive. Every other machine writes them into an outbox file in the plugin's data folder,
then sends the outbox to the hub in batches and deletes each batch once the hub has stored it.

When the hub is offline, events wait in the outbox. The machine retries every few seconds at first,
then every 5 minutes, and sends everything once the hub is back. Events never get lost because the
hub was away, even for days. Sending the same events twice stores them once.

## What it can't capture

- Events Klin deleted before the plugin read them. Klin keeps stored events about a day, so history
  from before you installed the plugin is mostly gone. When the plugin notices such a hole, it
  records it in the `gaps` table.
- Tool output beyond what the agent saw. Claude Code cuts most tool output at about 30,000
  characters, and Klin cuts a file change's diff at 32 KB.

## Reading the archive

Each row of `events` is one event. `machine` is the Klin environment id of the machine that made
it, and `payload` and `metadata` are Klin's own JSON, kept as Klin wrote it. `machines` gives each
id its host name.

One thread's events in order:

```sh
sqlite3 /srv/archive/klin-sessions.sqlite \
  "SELECT occurred_at, type, payload FROM events WHERE stream_id = '<thread id>' ORDER BY sequence;"
```

Events per machine:

```sh
sqlite3 /srv/archive/klin-sessions.sqlite \
  "SELECT m.label, count(*) FROM events e JOIN machines m USING (machine) GROUP BY m.label;"
```

When events aren't arriving, check Klin's server log. The plugin logs problems such as a wrong key
or a hub it can't reach, and logs again once they clear. Its `status` method returns the same
problems with the machine's role and event counts.
