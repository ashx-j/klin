# Klin

Klin is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), a desktop and web app for running coding agents on your machine. It works with your existing Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity and fx subscriptions.

Klin merges T3 Code's release and nightly tags, never arbitrary upstream `main`, and adds features that upstream doesn't ship. It has no mobile app.

Klin has no installers yet. Run it from source.

## Running from source

Klin uses Vite+, so you need the global `vp` command.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```powershell
irm https://vite.plus/ps1 | iex
```

`vp` provides the Node version pinned in `package.json`. From the repository root:

```bash
vp i
vp run dev
```

Open the pairing URL the dev runner prints. See [docs/operations/development.md](./docs/operations/development.md) for more.

At least one provider must be installed and signed in:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**
- fx: install [fx](https://fx.sh) and run `fx login` ([setup guide](./docs/user/providers-fx.md))

## Documentation

The docs in [docs/](./docs) come from T3 Code and still use its name.

- [FAQ](./docs/user/faq.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Source control integrations](./docs/user/source-control.md)

Building on the code? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## License

MIT, like T3 Code. See [LICENSE](./LICENSE).
