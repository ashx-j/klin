# Plugins

A plugin is a folder with a `t3-plugin.json` manifest
([schema](../../packages/contracts/src/plugins.ts)), typed with
[`@t3tools/plugin-sdk`](../../packages/plugin-sdk).
[`PluginHost`](../../apps/server/src/plugins/PluginHost.ts) runs plugins and
[`PluginInstaller`](../../apps/server/src/plugins/PluginInstaller.ts) installs them.

## Trust and failure

Plugins are trusted code the user chose to install. Server entries run in the server process and web
bundles run as React code in the page with every connection's credentials, with no sandbox. Manifest
`permissions` are shown on the plugin's row and not enforced, and `settings.get()` hands plugins
secret values in plain text. Do not shape the API around a future sandbox.

The host isolates failure instead. A plugin that throws while starting, or whose start doesn't
settle in 30 seconds, is marked failed, and a throw in a handler fails that call. Node exits on a
rejection nobody handles, so every promise the API hands a plugin comes from `call` or `refused` in
[`facade.ts`](../../apps/server/src/plugins/api/facade.ts), which mark it handled.

Plugin code can still fail where nothing T3 runs is waiting, such as in a timer or a child process
with no `'error'` listener. The [failure guard](../../apps/server/src/plugins/pluginFailureGuard.ts)
ties such a failure to a plugin when it can. A plugin's unhandled rejection becomes that plugin's
`serverFailure`, and Node does not exit. The plugin stays active. Disabling or reloading it releases
what it registered through the API, but timers it started itself keep running, and Node keeps its
code until the server restarts. This is accepted because the user chose to install that code, and
the alternative is one plugin bug stopping the server and every running agent.

An uncaught exception still stops the server, because Node calls resuming after one unsafe. When the
guard ties one to a plugin, it saves the error to `plugins.json` before Node exits. The next start
lists that plugin as failed with its switch off until the user turns it on again, so a plugin that
throws at startup can't stop every start. A failure the guard can't tie to a plugin
stops the server too.

Some failures end the process before any handler runs: `process.exit`, running out of memory, a
native crash, or a loop that never yields while the plugin starts, which no deadline can interrupt.
So the host writes a starting mark to `plugins.json` before it loads and activates a plugin, and
clears it after. A start that finds a mark left behind turns that plugin off and says why.
`--no-plugins` lists plugins but runs none, so a user can always reach Settings to turn one off.

The host runs plugin code in an `AsyncLocalStorage` scope, which Node carries into the timers and
callbacks that code starts, so a failure with only Node's frames in its stack is still the plugin's.
Before Node 24 that scope slows every promise in the process about 3x, so the host fails plugins
with a server half there as incompatible, though the server still allows Node 22.16+ and 23.11+.
Plugins without one still run.

## The API and manifests

The server bundle inlines `effect`, so plugins never share the host's Effect runtime or `Schema`
instances. They get Promises, `AsyncIterable` streams, `AbortSignal` and the SDK's own types, never
T3's contracts, which change between releases.

`plugins.invoke` and `plugins.subscribe` need only the read scope, so the host checks a method's
`access` itself: a `write` method needs the caller's operate scope, as T3's own changes do. A call
fails after 30 seconds and aborts the handler's signal, so a handler that never answers can't hold
a client's call open. An agent's tool call gets 5 minutes, because a tool may do real work, then
fails the same way with an error the agent reads, so a hung tool can't hold the turn. Each
subscriber gets its own sliding buffer per channel, so a busy channel or a slow subscriber drops
only that channel's oldest values.

Manifests accept keys they don't know, so a newer manifest still loads on an older T3. The
plugin's row names the keys T3 ignored, so a typo such as `setingsSchema` shows.
`engines.t3` is how a plugin requires a newer T3: the server refuses to install or start a version
outside it. `api.version` is how a plugin detects newer API members and still runs on older
releases, so a change that adds a member raises it and names that version in the member's doc.

Discovery and install compile the manifest's `settingsSchema`, so a schema T3 can't validate fails
the plugin with the reason instead of refusing every save later.

## State lives beside T3's

`<stateDir>/plugins.json` holds enabled flags, dev paths, the plugins that stopped the server,
starting marks and the sharing ledger (see [Sharing across machines](#sharing-across-machines)).
Settings go in `plugin-data/<id>/`, a plugin's own files in `plugin-data/<id>/files/` (its
`dataDir`), and storage in `plugins.sqlite`. They stay out of
`settings.json`, whose writer drops keys it doesn't know, and out of `statev2.sqlite`, which holds
T3's event-sourced state: plugin data isn't events, has no schema of T3's, and is deleted with its
plugin. Settings stay
out of `plugins/<id>/`, so replacing a plugin's files keeps them. Removing a plugin deletes its
settings, secrets and storage, so nothing is left that no plugin can reach.

All of a plugin's secrets share one secret store entry, because a keychain can't list names and
removal must also find the secrets of fields a plugin has since renamed. The settings store keeps
each plugin's files in memory after the first read and changes them only through its own writes,
so a hand edit to `settings.json` shows after a restart.

## Installing

Installs copy into `plugin-staging/`, outside `plugins/`, so discovery never sees a half-written
plugin. Only the swap takes the lifecycle lock, so a slow copy does not block other plugins. The
old version waits in staging until the new one starts and goes back if it fails.

Clients upload a dropped folder's files, never its path, which would mean nothing on a remote
environment. They post them over HTTP to a URL `plugins.createUploadUrl` signs for 5 minutes,
because one large WebSocket message holds up every other stream on the socket. As for attachments,
the signature is the credential, so the upload works the same on every kind of connection. Each URL
installs once. The server keeps its unused URLs in memory, so a restart refuses those it signed
before.

Discovery takes the id from the manifest, because people copy plugin folders in by hand. Settings,
storage and the enabled flag belong to the id, so a later folder with an id already listed fails as
a duplicate. An id that several folders share is one failed row naming each folder, and no copy
runs until the user deletes the extras. It has no Remove, because removal deletes the id's data,
which the copy kept would need. After a discovery that read every folder, the host forgets the
enabled flag and crash record of every id no folder has, so a folder copied in later with that id
starts off. A folder it can't read, such as one on a drive that isn't mounted, keeps its flag and
gets a failed row. Nothing watches `plugins/`: the server reads it at startup, on reload and
when Settings asks.

## Clients

Each browser keeps its own choice of the environments it loads plugin UI from, the main one by
default, because that code runs with every connection's credentials. Right panels show only in their
environment's threads. Commands and styles have no thread, so a plugin on in several chosen
environments adds them from the first, and the next takes over when it's turned off there.

The parts a plugin can redraw sit on hot paths: the composer's control row, the sidebar and the
Settings and Usage frame. Each host draws its part through
[`PluginPart`](../../apps/web/src/plugins/PluginPart.tsx), which keeps T3's own element until a
loaded plugin replaces that part, so the tree under it never remounts while none does and the
registry stays out of startup. The composer fold works the same way: the timeline reports leaving
its end only while a plugin asks for the fold, so threads pay nothing otherwise.

Rows carry `hasSettings` rather than the settings schema. Every client, read-only ones and the
idle watcher included, gets the whole list again on each status change, and only the settings
form needs the schema, which it fetches with `plugins.settings.get`. The list decodes row by row,
so a row an older client can't read, such as one with a newer failure stage, is left out and the
rest still shows.

A user with no plugins shouldn't pay for them at startup. What loads with the app is the plugin RPC
schemas, which are part of the app's RPC group, the cache that paints published themes from the
first frame, and the small pieces app code reads plugin parts through, such as the
[`pluginUi.ts`](../../apps/web/src/plugins/pluginUi.ts) stub. The rest loads behind
[`PluginLoaderStarter`](../../apps/web/src/plugins/PluginLoaderStarter.tsx). Once the app is idle,
or at once in a browser where plugins changed the layout last time, it downloads a watcher that
follows `plugins.subscribeStates` for each chosen environment, a stream of its own because the
server config stream would resend the whole config on every plugin change. It downloads the web
loader only when an active plugin has a web part, and a separate styles chunk only when one has a
`styles/` folder. The server starts plugins after it is listening.

A bare `import(url)` cannot send credentials, so the loader fetches each bundle with the
connection's credentials and imports it from a `blob:` URL, which the desktop CSP allows. Mobile
release builds cannot load code, so the mobile app shows no plugin UI, settings or themes.

Bundles get React, the UI kit, `Atom` functions and atom hooks from `globalThis.__t3PluginHost`,
because a second React or effect would not share T3's renderer or atom registry. The SDK declares
its own atom types, so a plugin needs no `effect` and T3's effect upgrades don't break its
typecheck. No type check compares those types with effect's. Instead the `hello-web` fixture
typechecks against the SDK's types, and `pluginLoader.browser.test.ts` runs its settings panel on
effect's functions, so an effect upgrade that changes one the fixture uses fails there. A change to
a shared function or hook needs a matching change in the SDK's `atom.ts` or `atom-react.ts`.

Plugin themes arrive over the server config stream after the first paint, so the client saves them
in localStorage for the boot script in `index.html`. The server marks plugin themes, so the client
can show only those of chosen environments. The desktop main process cannot read localStorage, so
the page sends it the canvas it paints under a light and a dark native theme.

## Event feed

`events.stored` hands a plugin `orchestration_events` rows read only, as stored, with the prompt a
row shares with an earlier one put back. Payloads stay JSON text, so the server decodes nothing and
a plugin that keeps events keeps T3's own format, whatever it becomes. It is pull based: each
`next()` reads one page from the reader connection, and nothing is buffered between pulls, so a
slow plugin only falls behind. While caught up, the feed waits on a one-slot queue that a
subscription to committed events refills, so a burst of commits wakes it once. The subscription
exists only while a plugin iterates, and deactivation interrupts the stream.

[Projection maintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
events about a day after the projections cover them, keeping some, such as each stream's newest.
So a full-history read gets what is left, and a feed that resumes below the pruned-through mark
reports `missed` once for that range. A plugin that must keep every event has to keep up, which is
why the session archive copies each machine's events to local disk before shipping them.

## Sharing across machines

Each machine keeps, in `plugins.json`, the newest decision it knows for each plugin: the files
(revision and time) and the switch (on or off and time), each settled by the later time. Removals
stay as entries, so a machine carries a removal to machines it meets later. The rules live in
[`@t3tools/shared/pluginFleet`](../../packages/shared/src/pluginFleet.ts), which the server and
client share.

The client copies, not the servers. A client managing plugins on two machines already holds a
session allowed to install code on each, and servers hold no credentials for each other except
peer links, which are a Labs feature carrying an agent's access, not an owner's. So sharing adds no
new way for one machine to act on another. The [sync loop](../../apps/web/src/plugins/pluginFleetSync.ts)
plans from every sharing machine's list, copies files through the signed download and upload
URLs, and sends switches and removals through `plugins.fleet.apply`. Each server decides under its
lifecycle lock whether an entry is newer, so two windows syncing at once apply each change once.
A server only reports entries to sessions that manage plugins, so a guest's server is never a
source or a target.

An entry only describes files the machine has, or a removal it carried out, so discovery can tell a
change made on the machine from one waiting to arrive: a folder whose revision differs from its
entry was changed there. A new folder takes its newest file time, so of two machines that had
different versions before they shared, the one installed later wins. Local changes take at least the
entry's time plus one, so a change made after seeing another machine's wins even with skewed clocks.
A revision hashes paths and bytes with `/` separators and leaves out `.git` and `node_modules`, as
uploads do, so it is the same on every platform. Discovery caches it by file sizes and times.

A copy that fails to start stays, unlike a manual update that rolls back, because the other
machines have that version and a rollback would only diverge. The switch from a removed plugin's
entry is kept for when it comes back.

The trust step moves with it: a plugin still arrives off, and turning it on is a decision for every
machine. Anything that can write one machine's `plugins/` folder or `plugins.json` can therefore get
code onto the others once a client connects to both. Plugins are trusted code and an agent with full
access on a machine can already run anything there, so this is accepted for a single owner's
machines; the per-machine **Share plugins** switch is the way out.

## Agent tools

MCP servers can't remove a tool, so each plugin tool registers with an `EnabledWhen` check that the
server runs on every list and call. A stopped plugin's tools leave new listings and answer as not
found.
