# pi-claude-plugins

A [pi](https://github.com/badlogic/pi-mono) extension that imports **enabled Claude marketplace plugin skills and commands** into the current pi session.

It bridges Claude's plugin marketplace layout into pi by exposing:

- **skills** as pi skills
- **command markdown files** as pi prompt templates / slash commands

The extension only loads plugins that are currently enabled in Claude after checking both:

- `~/.claude/plugins/installed_plugins.json`
- `~/.claude/settings.json`

## What gets loaded

### Skills

The extension loads skill files from these locations:

- `~/.claude/plugins/marketplaces/*/skills/*/SKILL.md`
- `~/.claude/plugins/marketplaces/*/plugins/*/skills/*/SKILL.md`

These are returned to pi as `skillPaths` through the `resources_discover` hook.

### Command markdown files

The extension also loads command markdown files from these locations:

- `~/.claude/plugins/marketplaces/*/commands/*.md`
- `~/.claude/plugins/marketplaces/*/plugins/*/commands/*.md`

These are returned to pi as `promptPaths`, so they show up like pi prompt templates / slash commands.

## Install

```bash
pi install npm:pi-claude-plugin
```

## Remove

```bash
pi remove npm:pi-claude-plugin
```

## How plugin enablement works

The extension does **not** load every plugin found on disk.
It first reads:

- `~/.claude/plugins/installed_plugins.json`
- `~/.claude/settings.json`

A plugin is loaded only if:

- it exists in `installed_plugins.json`
- it matches the current scope (`user` or current project)
- it is **not** explicitly disabled in `settings.json`

If `~/.claude/settings.json` contains:

```json
{
  "enabledPlugins": {
    "playwright-cli@playwright-cli": false
  }
}
```

then that plugin is ignored completely, even if it is installed.

### Plugin key format

Claude's installed plugins file uses keys like:

- `planning-with-files@planning-with-files`
- `frontend-design@claude-plugins-official`
- `playwright-cli@playwright-cli`

This extension maps marketplace paths to those keys as follows.

#### Top-level marketplace skills

For:

- `~/.claude/plugins/marketplaces/<marketplace>/skills/<plugin>/SKILL.md`

it checks whether this plugin key is enabled:

- `<plugin>@<marketplace>`

#### Nested plugin skills

For:

- `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/skills/<skill>/SKILL.md`

it checks whether this plugin key is enabled:

- `<plugin>@<marketplace>`

#### Top-level marketplace commands

For:

- `~/.claude/plugins/marketplaces/<marketplace>/commands/*.md`

it checks whether this marketplace-level plugin key is enabled:

- `<marketplace>@<marketplace>`

This matches layouts like:

- `~/.claude/plugins/marketplaces/planning-with-files/commands/*.md`

#### Nested plugin commands

For:

- `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/commands/*.md`

it checks whether this plugin key is enabled:

- `<plugin>@<marketplace>`

## Scope rules

`installed_plugins.json` can contain both user-scoped and project-scoped plugin installs.

This extension respects that:

- **user** scope → always loaded
- **project** scope → only loaded when the current pi working directory is inside that `projectPath`

So if a Claude plugin is enabled only for one project, this extension will only expose it in pi when you are inside that same project tree.

## Ignored paths

The extension intentionally ignores:

- hidden files and directories (`.`-prefixed)
- `node_modules/`
- `build/`
- `dist/`
- `out/`
- symlinked directories/files

This avoids duplicate, generated, or unrelated content being imported.

## Runtime behavior

On startup and on `/reload`, the extension:

1. reads `~/.claude/plugins/installed_plugins.json`
2. reads `~/.claude/settings.json`
3. determines which Claude plugins are enabled for the current pi cwd
4. scans the supported skill and command locations
5. filters out anything not enabled or explicitly disabled
6. returns the remaining files to pi via `resources_discover`

The extension also prints and notifies a summary like:

- number of loaded skill files
- number of loaded command markdown files

## Why some Claude resources may still not appear

Even when a file exists on disk, it will not be loaded if:

- the plugin is not present / enabled in `installed_plugins.json`
- the plugin is explicitly disabled in `~/.claude/settings.json`
- the plugin is project-scoped for a different project
- the file is outside the supported path patterns
- the file is inside a hidden/ignored directory

## Skill collisions and validation warnings

This extension forwards Claude plugin resources into pi, but **pi still applies its own resource rules**.

That means:

- pi skill names must still be unique within the session
- pi may skip colliding skills if multiple files declare the same `name:` in frontmatter
- pi may emit warnings if a skill's `name` does not match its parent directory

These warnings come from pi's skill loader, not from this extension itself.

## Limitations

- This extension does not execute Claude plugin hooks or plugin runtime logic
- It only imports filesystem resources that map cleanly into pi:
  - skills (`SKILL.md`)
  - command markdown files (`*.md` in `commands/`)
- It does not import arbitrary plugin code, agents, hooks, or non-markdown command formats
- It does not import or bridge Claude plugin MCP integrations / MCP servers

## When to reload

Run `/reload` in pi after:

- enabling or disabling Claude plugins
- changing `~/.claude/plugins/installed_plugins.json`
- changing `~/.claude/settings.json`
- installing/removing marketplace plugins
- adding/removing skills or command markdown files in the marketplace directories

## Files

- Extension entry point: `extensions/index.ts`
- Package manifest: `package.json`

## License

MIT
