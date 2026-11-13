# Plugins

Plugins add features to T3 Code: right panels, commands, themes, styles and tools for agents. A
plugin runs inside each environment's T3 Code server that has it, with the same access to your
files, threads and credentials as T3 Code itself. A plugin's row lists the permissions it says it
uses, but T3 Code doesn't enforce them. Install only plugins you trust. T3 Code copies a plugin to
all your machines (see [Plugins on all your machines](#plugins-on-all-your-machines)), so trust it
on every one of them.

## Add a plugin

Open **Settings → Plugins** and drag a plugin's folder onto the page. **Add plugin** also lets you
choose the folder in a file window.

T3 Code copies a plugin folder into the environment's `plugins` folder, so later changes to your
copy do not affect the installed plugin. To update it, add the new version's folder the same way.
A new plugin is installed turned off, so none of it runs until you have read its row and turned it
on. A new version of a plugin stays on or off as the old one was. If a new version fails to install
or start, you keep the version you had, and T3 Code says why. A plugin that needs a newer version
of T3 Code, or whose settings T3 Code can't check, isn't installed, and T3 Code says why.

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default. Two folders with the same plugin id don't run until you delete one of them, and the
plugin's row names both.

To load a plugin from a folder on the environment's machine without copying it, such as one you're
building, choose **Add plugin**, open **Link a plugin folder** and enter the folder's path. **Reload**
then runs its latest files. Linking a folder in place of an installed copy keeps the plugin's switch,
settings and data, and dropping a folder in place of a linked one does the same.

**Settings → Plugins** shows one environment at a time, the main one until you pick another at the
top of the page.

## Plugins on all your machines

Installing, updating, turning on or off, or removing a plugin on one of your machines does the same
on the others. This covers plugins you drop in, link from a folder or copy into the `plugins`
folder by hand. A linked plugin reaches your other machines as an installed copy when you link it,
and again each time you choose **Reload** where it is linked, so an edit in progress stays on its
machine. Settings, secrets and stored data stay on each machine, and `.env` files in a plugin's
folder are never copied.

The app does the copying. Whenever it is connected to two of your machines, it brings each one up
to the newest change made on any of them, and looks again at each machine's `plugins` folder when it
connects. A machine that is offline keeps what it has and catches up the next time the app connects
to it, as does a machine you connect for the first time. Its own plugins then reach your other
machines too. When the same plugin changed on two machines while they were apart, the change with
the newer files wins, and a plugin's version and its switch are decided separately. A copy that
fails is tried again after a while, and again when the app reconnects to that machine.

A plugin's row says how it is on each machine, such as on, off, offline, kept off, or why it
couldn't be copied there. A machine that can't run a plugin's server code, such as one whose T3
Code server runs on Node older than 24, still gets the plugin, and its row there says why it doesn't
run. Its themes, styles and web part still work from that machine. A machine whose T3 Code is too
old for a plugin doesn't get it until it is updated. A plugin folder over 1,000 files or 25 MB isn't
copied, and its row says so.

A new plugin is off everywhere until you turn it on. Turning it on or off on any machine does the
same on all of them, including machines that get the plugin later, which then run it without asking
again. So turning a plugin on is where you approve running its code on all your machines. How
plugins were switched before sharing began stays on each machine until you flip them.

To take a plugin off one machine only, choose **Remove** on its row there and then **Remove here
only**. Your other machines keep it, and its row on them shows the machine as kept off, with **Add
back** to copy it there again. **Remove everywhere** removes it from every machine, with its
settings, secrets and stored data on each.

To keep a whole machine out, open **Settings → Plugins** for it and turn off **Share plugins with my
other machines**. It keeps the plugins it has, and changes stop going to and from it. When you turn
it back on, changes made on it meanwhile go to your other machines too, removals included. Only the
machines this app manages plugins on take part, so a server you reach as a guest never gets your
plugins and never sends you its own.

## Turn a plugin on or off

Use the switch on the plugin's row. It turns the plugin on or off on all your machines. A plugin
that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. A plugin with server code needs the environment's
T3 Code server to run on Node 24 or later, as the desktop app's does. **Reload** restarts a plugin
with its current files. Turning a plugin off doesn't stop code it started on its own, such as a
timer. If its row says some of its code is still running, restart T3 Code to stop it.

A plugin can stop T3 Code's server. When the server starts again, a plugin that stopped it while
starting, or with an error T3 Code could trace to it, is off, and its row says why. To try it again,
turn it back on. If T3 Code still won't start, run its server with `t3 --no-plugins`, which lists
your plugins but runs none, and turn the plugin off.

## Plugin settings

If a plugin has settings, open them with the settings button on its row. Each setting saves as soon
as you change it or leave its field, and an empty field shows the default the plugin uses. Settings
shown as JSON save together only when you select **Save**. Secret
fields are stored in the environment's secret store and are never shown again after you save them;
the clear button next to one removes it.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm in the popup. Removing a plugin also deletes its
settings, secrets and stored data, on every machine that shares plugins, and this can't be undone.
Reinstalling it later starts fresh.

A plugin loaded from its own folder shows **Unlink** instead. Unlinking stops loading it and deletes
its settings, secrets and stored data the same way, but leaves the folder where it is.

## Themes and styles

A plugin can change how T3 Code looks with files alone. CSS can still load files from other sites
and reveal what the page shows to them, so trust a styles-only plugin as you would any other. Theme
files in its `themes` folder show up as themes while the plugin is on. CSS files in its `styles`
folder apply to the app while the plugin is on, on top of T3 Code's own styles and your theme. A
plugin can be just a `styles` folder and its manifest. Themes and styles load from the same
environments as plugin UI (see [Where plugins live](#where-plugins-live)).

## Tools for agents

A plugin can give agents new tools. Agents in threads started after you turn the plugin on see them.
Turning the plugin off takes its tools away from every thread. Tools that only read work in any
thread. Tools that change things work only in a thread set to **Full access** and not in Plan mode.

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin. Their settings and files are in `plugin-data`, and `plugins.json` records which
ones are enabled and the newest change to each that this machine shares with your others. T3 Code
reads a plugin's settings file once, so an edit you make to it by hand shows after T3 Code
restarts.

Plugin UI, styles and themes load in the web and desktop apps. They load from the app's main
environment, which is the desktop app's own server or the server the web app was opened from, and
from any other environment you turn on under **Load plugin UI from** in **Settings → Plugins**. You
can turn the main environment off there too. app.t3.codes and a desktop app with its local
environment turned off have no main environment, so no plugin UI loads until you choose one. The
choice applies to this browser only. Each chosen environment's plugins run code in this window, with
access to every environment this window is connected to, so choose only environments whose plugins
you trust.

A plugin's right panels show only in the threads of the plugin's own environment. A plugin that is on
in more than one chosen environment adds its commands and styles once, from the main environment
when it's on there. The mobile app doesn't show plugin UI, settings or
themes.
