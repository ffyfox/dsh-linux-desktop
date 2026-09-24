# dsh-linux-desktop

> Make DeepSeek Harness feel like a native application on Linux: launch it from your app launcher, get a chromeless standalone window, and have the service it started stop when you close the window.

This is a DSH bundle. It reuses the Chromium-family browser already installed on your system, wires `dsh web` into the desktop through standard XDG desktop entries, and does not change the behaviour of `dsh web` itself.

**Distribution status**: published to npm; also installable straight from GitHub.

---

## What it does

`dsh web` provides a complete web interface, but on a Linux desktop it has three rough edges: no dedicated taskbar or Alt-Tab entry; a service lifetime tied to a terminal; and desktop plugins in the community that mainly target Windows and macOS — as of September 2026 we have not seen one built around Linux XDG desktop entries (corrections welcome).

This plugin addresses all three. It does five things:

1. Writes a standard XDG desktop entry to `~/.local/share/applications/`, so `dsh web` can be started from the app launcher.
2. Opens a window using Chromium's `--app` mode, containing only the dsh web interface — no address bar, tabs, or bookmarks bar.
3. Starts `dsh web` when it is not running, and stops the service it started once the window closes.
4. Maintains those files idempotently: every `dsh web` boot syncs them to the current version, and leaves them untouched when nothing changed.
5. Contributes a "Desktop integration" card to the Web settings page under Plugins → Plugin configuration, for editing the configuration below.

## Requirements

- Linux
- A Chromium-family browser: Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, or Opera
- `dsh` installed (its absolute path is baked into the launcher and the context-menu action at install time, so it need not be on the desktop session `PATH`)
- Optional: `curl` (falls back to bash's built-in `/dev/tcp` for port probing)

Firefox is not supported: Mozilla removed SSB (Site Specific Browser), so Firefox cannot provide a chromeless standalone window. Degrading to `firefox --new-window` would bring back the address bar and tabs, so this plugin fails loudly in that case instead of silently degrading.

## Install

```bash
dsh plugin --profile web add dsh-linux-desktop
```

Restart `dsh web` once after installing.

To track `main` instead, install from GitHub:

```bash
dsh plugin --profile web add github:ffyfox/dsh-linux-desktop
```

Either source can be pinned to a version:

```bash
dsh plugin --profile web add dsh-linux-desktop@0.4.2
dsh plugin --profile web add github:ffyfox/dsh-linux-desktop#v0.4.2
```

For working on the code, use a local checkout instead:

```bash
dsh plugin --profile web add /path/to/dsh-linux-desktop
```

> **All three sources were verified** in an isolated `DSH_HOME`, and `dsh` registers the row in the profile's `dsh.profile.bundles` automatically — no manual `package.json` edit needed. Installing by package name from the registry is by far the fastest; the GitHub form clones the whole repository.
>
> This plugin is plain ESM JavaScript with no build step, so installing it from any source does not require granting pnpm an `allowBuilds` permission.

## Usage

Click **DeepSeek Harness** in your app launcher (KRunner, the application menu, or a pinned taskbar entry).

The launcher works in this order:

1. Takes a single-instance lock. Only one instance owns the service lifecycle.
2. Probes whether `dsh web` is already listening. An HTTP 401 also counts as "listening".
3. If it is not listening, starts a `dsh web` and records that this instance started it.
4. Polls until the tokenized URL appears.
5. Opens a standalone window in `--app` mode.
6. Waits for the window process to exit.

When the window closes, if this instance started the service, it sends `SIGTERM` to the process group and `SIGKILL` on timeout.

**A service this instance did not start is never stopped.** That includes a `dsh web` you started by hand in a terminal. "The server is still running after I closed the window" is therefore correct behaviour in some cases.

### About the tokenized URL

`dsh web` has an authentication fence: a request to `/` without a cookie returns HTTP 401 (`dsh web authentication required`). Each process start generates a random launch token, and only the `GET /?token=...` exchange sets a signed cookie; after that the bare URL works. The cookie is bound to host and port, and is valid for 30 days.

A token is therefore needed on first launch, after cookie expiry, or when using a browser profile directory that has never authenticated. This plugin has the plugin row running inside the `dsh web` process call the official `ctx.connection.authenticatedUrl()` API and write the result to a runtime file that the launcher reads. That way the plugin can obtain a token no matter who started the service.

## Commands

Installation writes a CLI shim to `~/.local/bin/dsh-desktop`, so the following commands can be run directly.

| Command | Purpose |
|---|---|
| `dsh-desktop install` | Install or repair the desktop integration (idempotent) |
| `dsh-desktop uninstall` | Remove the desktop integration, keeping config and backups |
| `dsh-desktop status` | Show installation status and health checks |
| `dsh-desktop doctor` | Diagnose and suggest fixes |
| `dsh-desktop config` | Show the config file location and contents |
| `dsh-desktop set <key> <value>` | Change one config value and reinstall |
| `dsh-desktop open` | Open dsh in a standalone window, equivalent to clicking the desktop icon |
| `dsh-desktop stop` | Stop the running `dsh web` |
| `dsh-desktop restart` | Restart `dsh web` |
| `dsh-desktop runtime` | Show the runtime state of the current `dsh web` |

Options for `install`: `--force`, `--port`, `--host`, `--size`, `--browser`, `--profile-mode`, `--no-kwin`, `--hyprland`, `--no-auto-install`.
Options for `stop` and `restart`: `--force`.
General options: `--root <dir>` (sandbox mode, redirects all reads and writes into that directory) and `--json`.

The `dsh-desktop` bin is installed under the profile's `node_modules/.bin/`, which is not on `PATH`. The shim hard-codes the absolute path and is refreshed on every install or self-repair. The equivalent without the shim is:

```bash
dsh plugin --profile web exec dsh-desktop <subcommand>
```

`stop` and `restart` are operations you explicitly request, so they act — but they still read `/proc/<pid>/cmdline` first to verify the target process really is `dsh web`, and refuse with a `--force` hint if it is not.

> `dsh-desktop runtime` prints the full tokenized URL in the clear. The launcher's debug log redacts the token as `<REDACTED>`, but this command does not — the URL it prints is the point of the command. Be careful not to paste its output anywhere public.

## Configuration

The config file is `~/.config/dsh-desktop/config.json`, created automatically on first install.

| Key | Meaning |
|---|---|
| `host` / `port` | Address the launcher uses when starting `dsh web`. |
| `window` | Initial standalone window size, in logical pixels. |
| `browser` | `auto`, or `chrome` / `chromium` / `brave` / `edge` / `vivaldi` / `opera`, or an absolute path to a browser executable. |
| `profileMode` | `dedicated` (default) or `shared`. |
| `profile` | Which dsh profile the desktop icon starts. Default `web` (equivalent to `dsh web`). |
| `devProfile` | When non-empty, the desktop entry gains a "run with development profile" context-menu action. See "Daily and development setups" below. |
| `autoInstall` | Whether to auto-install or self-repair on `dsh web` boot. |
| `manageKwinRules` | Whether to manage the KWin window rule; only effective on KDE. |
| `manageHyprlandRules` | Whether to manage the Hyprland window rule; only effective on Hyprland. **Off by default** — see "Hyprland and window size" below. |
| `terminalAction` / `terminalCommand` | The "run in terminal" entry in the desktop entry's context menu. Empty means auto-detect an installed terminal. |

There are three ways to change the configuration. The first is recommended:

```bash
# 1. From the Web settings page: Plugins -> Plugin configuration -> Desktop integration.
#    Saving takes effect immediately.
# 2. Edit directly, then reinstall
$EDITOR ~/.config/dsh-desktop/config.json
dsh plugin --profile web exec dsh-desktop install

# 3. Or change it through the CLI, which reinstalls automatically
dsh plugin --profile web exec dsh-desktop set window 1400x900
```

### The settings card and config.json

The card writes to DSH's `settings.yaml` (namespace `linux-desktop`), which layers **on top of** `config.json`: the effective value is schema defaults → `config.json` → the `settings.yaml` user layer. An existing `config.json` therefore keeps working and needs no migration; a field the card changed shows as "Overridden", and "Reset" drops it back to the `config.json` value.

`host` and `port` are not on the card. They must match the address `dsh web` actually binds, so `config.json` remains their only source.

The card depends on `@deepseek-ai/schemastery` (installed as a dependency). If you installed from a local checkout (`link:`) and that package is unavailable, the card does not appear; the rest of the desktop integration works as usual.

### profileMode

When Chrome is already running, executing `chrome --app=URL` hands the window off to the existing browser process and the launcher process exits immediately. In that situation, waiting on the process cannot detect the window closing.

| Mode | Behaviour | Cost |
|---|---|---|
| `dedicated` (default) | `--user-data-dir` points at a dedicated profile directory, so the browser process lives and dies with the window and window close can be detected reliably | One extra browser process; a separate cookie jar that authenticates via the token URL on first launch and is then good for 30 days |
| `shared` | Reuses the default browser profile directory | Shared login state, no extra process; but when Chrome is already running the window close cannot be detected, so the service is not stopped automatically — a notification explains this |

### Daily and development setups

`dsh web` and `dsh --profile web` are exactly equivalent, and the desktop icon runs the former. So by default **the profile the icon starts is your daily environment**.

If you develop a plugin (with the source checkout `link:`ed into a profile), that working tree *is* the running plugin: saving a client file hot-reloads it into the browser, and one bad line of host code means the next restart does not come up. Pointing `devProfile` at another profile separates the two completely:

```json
{
  "profile": "web",
  "devProfile": "web-dev"
}
```

- **Click the icon** → `web` (install a published, frozen version here — keep it stable)
- **Right-click → "Run with development profile"** → `web-dev` (point this at your source checkout)

That context-menu action always carries three environment variables:

| Variable | Purpose |
|---|---|
| `DSH_DESKTOP_PROFILE` | Switches to the profile named by `devProfile`. |
| `DSH_DESKTOP_PORT` | Uses `port + 1`. Without a different port, the second setup's server probe would hit the first one and simply reuse it — so the right-click action would show you the daily setup again. |
| `DSH_DESKTOP_ROOT` | The sandbox root (`$XDG_CACHE_HOME/dsh-desktop-dev`). **This one is not optional**: the plugin's auto-install writes `~/.local/bin` and `~/.local/share/applications`, and those are **not** separated per profile. Without the sandbox, starting once with development code overwrites the daily setup's launcher and desktop entry. |

All three can also be set by hand, so the development setup works without the context-menu action:

```bash
DSH_DESKTOP_ROOT=~/.cache/dsh-desktop-dev dsh --profile web-dev --no-open --port 3081
```

`dsh-desktop start` / `restart` use the profile named by `profile`; `stop` identifies the service from its command line and accepts both spellings (`dsh web` and `dsh --profile <name>`).

## Hyprland and window size

Hyprland is a tiling compositor, and a fixed window size conflicts with tiling by nature. Measured on Hyprland 0.56.2:

| Managed? | Result |
|---|---|
| No (**default**) | The window tiles and fills the workspace. The `window` width/height has **no effect** — under tiling the `--window-size` the browser passes is ignored by the compositor. |
| Yes | The window is forced to float at the `window` width/height. |

Off by default is deliberate: someone who chose a tiling WM wants tiling, and the plugin should not silently turn that into floating. To pin the size, enable "Manage the Hyprland window rule" on the settings page, or run `dsh-desktop install --hyprland`.

The rule is inlined into your Hyprland config and wrapped in comment markers:

```ini
# dsh-desktop begin
windowrule = match:class ^(chrome-127\.0\.0\.1__-Default)$, float on, size 1200 750
# dsh-desktop end
```

Since Hyprland 0.56 a fresh install generates a Lua-format `hyprland.lua`, while users upgrading from older versions keep `hyprland.conf`; the plugin writes whichever syntax belongs to the file actually in effect (when both exist, `.lua` wins, matching Hyprland's own behaviour).

Before writing anything it runs `Hyprland --verify-config` offline, and if verification fails it writes nothing at all — a config error makes Hyprland refuse to start, and your whole desktop depends on that file. For the same reason the plugin will **not** create a config file for a user who has never run Hyprland, and does not use `source =` to include an external file (a missing target breaks the entire config just as badly).

Requires Hyprland 0.53 or newer (earlier versions only have the old `windowrulev2` syntax, which is untested here; the plugin skips and says so).

## GNOME and window size

**GNOME needs no window rule, and the plugin writes nothing at all.**

GNOME is a stacking (floating) window manager — the exact opposite of Hyprland. Windows float freely, so Mutter honours the `--window-size` the browser passes. Measured on Mutter 50.5 with a headless virtual monitor:

| `--window-size` | Actual window |
|---|---|
| 900,600 | 900x600 |
| 1200,750 | 1200x750 |
| 1280,800 | 1280x800 |
| 2200,1500 | 2200x1500 |

All honoured **exactly**. GNOME has neither a rule file like `kwinrulesrc` nor an equivalent dconf key — this is not "not supported yet", it is how GNOME is designed. So the plugin writes no configuration on GNOME.

### The one exception: auto-maximize

Mutter enables `org.gnome.mutter auto-maximize` by default: **when a window's area exceeds roughly 80% of the work area it is maximized outright and the requested size is discarded.**

So `dsh-desktop status` / `doctor` reads the logical work area once (**read-only**, via `gdctl show`) and warns when your `window` size would trip that rule:

```
! gnome-window-size    window 2400x1500 covers 88% of the 2560x1600 logical work area, over 80% — GNOME will maximize it and the size setting will have no effect.
```

Two ways out:

1. Lower the width/height below 80% of the logical work area (recommended — it affects nothing else);
2. `gsettings set org.gnome.mutter auto-maximize false`. Note this is a **global** setting: **no** application will auto-maximize any more. The plugin will **not** change it for you, because it is not a per-window rule. Restore it with `gsettings reset org.gnome.mutter auto-maximize`.

The 80% threshold comes from the source constant `MAX_UNMAXIMIZED_WINDOW_AREA = .8`, while the measured flip point was between 83.2% and 83.8% (cause unknown). **Warning a little early beats letting you hit "I set a size and it did nothing".**

### Position cannot be set

Wayland has no protocol for a client to position itself, and GNOME uses its own placement algorithm. `--window-position` has no effect on GNOME — not because the plugin skipped it, but because the protocol layer has no such capability.

## Uninstall

```bash
dsh plugin --profile web exec dsh-desktop uninstall
```

Removes the launcher script, `dsh.desktop`, the app_id alias entry, the icons, and the KWin / Hyprland rules.
Keeps `~/.config/dsh-desktop/`, which holds the configuration and backups.

## Compatibility

| Dimension | Status |
|---|---|
| DSH | **Verified**: 0.1.7-rc.1 (client settings service `configForms`). **Backward compatible**: hosts older than 0.1.7 that still expose `settingsScope` also work |
| Desktop environment | **Verified**: KDE Plasma 6. **Partially verified**: Hyprland 0.56.2 (app_id derivation and the window size rule are measured — see "Hyprland and window size"; the desktop entry under a full session is not verified). **Partially verified**: GNOME / Mutter 50.5 (window sizing behaviour is measured — see "GNOME and window size"; the desktop entry under a full session is not verified). **Expected to work, not verified**: Sway and other wlroots compositors, Xfce, MATE, Cinnamon, i3 — the window and desktop entry are standard XDG, and window rules are only written on KDE and Hyprland |
| Display protocol | **Verified**: Wayland. **Expected to work, not verified**: X11 |
| Browser | **Verified**: Google Chrome. **Expected to work, not verified**: Chromium, Brave, Edge, Vivaldi, Opera |
| Distribution | **Verified**: Arch Linux |

Verified environment: Arch Linux, KDE Plasma 6, Wayland, 200% scaling (1536×960 logical).

The entries marked "not verified" above come from architectural inference and have not been measured in those environments. If you run this on one of them, the output of `dsh-desktop doctor` serves as the verification result.

## Troubleshooting

```bash
dsh plugin --profile web exec dsh-desktop doctor
```

| Symptom | Cause and fix |
|---|---|
| Taskbar shows a yellow circle with a white W | The app_id alias entry or alias icon is missing. Run `dsh-desktop install --force`. |
| Window shows `dsh web authentication required` | No tokenized URL was obtained and the dedicated profile directory has no valid cookie. Restart `dsh web` once. |
| The window opened in the default browser profile rather than a standalone one | A deliberate fallback: with no token and a dedicated profile directory that has never authenticated, it uses the default profile to avoid a 401. It reverts after one `dsh web` restart. |
| Window stretches to full height and touches the top and bottom edges | The KWin rule is not active. Check whether any group in `~/.config/kwinrulesrc` has `description = DeepSeek Harness Window Rule` (the group name is a number, not that sentence), then run `qdbus6 org.kde.KWin /KWin reconfigure`. |
| On Hyprland the window fills the whole workspace and the size setting does nothing | That is the **default**: under tiling the size setting has no effect. To pin the size, enable "Manage the Hyprland window rule" on the settings page, or run `dsh-desktop install --hyprland`. |
| On Hyprland, management is enabled but the window still fills the workspace | Check whether `~/.config/hypr/hyprland.conf` (or `hyprland.lua`) contains a `dsh-desktop begin` marker block. If not, the write was skipped — run `dsh-desktop doctor` and read the reason on the `hyprland-rule` line (commonly: Hyprland older than 0.53, or no config file yet). |
| On GNOME the window opens maximized and the size setting does nothing | Mutter's auto-maximize fired (window area above ~80% of the logical work area). Lower the size below 80% of the screen, or run `gsettings set org.gnome.mutter auto-maximize false` yourself (a global setting; the plugin will not change it for you). The `gnome-window-size` line in `dsh-desktop doctor` computes the exact percentage. |
| On GNOME `gnome-window-size` only says "honoured natively" without numbers | The logical work area could not be read (`gdctl show` failed — e.g. not in a GNOME session, or a very old GNOME). This is a normal fallback and does not affect the window: GNOME honours `--window-size` anyway. |
| The launcher does nothing | Run `DSH_DESKTOP_DEBUG=1 ~/.local/bin/dsh-desktop-app` to see debug output. Logs live in `$XDG_RUNTIME_DIR/dsh-desktop-web.log`. |
| Right-click "Open in Terminal (dsh-tui)" drops into a plain bash and prints `Could not find 'dsh'` | The entry used a bare `dsh`, and the desktop session `PATH` has no user-level bin directories. Run `dsh-desktop install --force` to regenerate the entry; the action now uses the absolute path to `dsh`. |
| The service was just auto-started and the window takes tens of seconds to appear | Deliberate: the auto-start path waits for the `dsh web:` settled line and then for a session-API probe to succeed before opening the window. The larger the server's plugin set, the longer that wait; when the window does appear the backend is guaranteed ready. |
| The server is still running after the window closes | You are in `shared` mode, or the service was started elsewhere and is deliberately not taken over. Use `dedicated` and start the service from the desktop icon. |
| Boot fails with `dsh-linux-desktop: pending (waiting for service: settingsScope)` and `dsh web` will not start | DSH 0.1.7 renamed the settings service from `settingsScope` to `configForms`, and 0.4.1 and earlier wait forever for the old name. Upgrade to 0.4.2 or later. |
| No "Desktop integration" card under Plugin configuration | The Host did not register the namespace. Confirm `dsh web` has been restarted and that `@deepseek-ai/schemastery` can be loaded; for a local-checkout install see "The settings card and config.json" above. |

## Development

Run these from the repository root:

```bash
node test/smoke.mjs                                   # smoke tests, 157 checks total, zero dependencies
node scripts/prepublish-check.mjs                     # pre-publish validation
npm pack --dry-run                                    # validate the package contents
node bin/dsh-desktop.js install --root /tmp/sandbox   # sandboxed install, touches nothing real
```

The first three are the commands CI runs on every push and pull request, and they are the gate a change must pass before merging. CI covers Node 20, 22, and 24, and additionally verifies on macOS that the plugin does nothing at all on non-Linux platforms.

`--root <dir>` or the `DSH_DESKTOP_ROOT` environment variable redirects all reads and writes into a sandbox, including `HOME` and every `XDG_*` path. Ports are not sandboxed, so take care not to disturb a service you are using.

### Releasing

**One command runs the mechanical steps:**

```bash
npm run release      # validate (--release) → produce the artifact from the tag → print the publish command
```

It runs the full validation, exports the tag's tree and packs it in a temp directory, verifies it byte for byte, then prints a ready-to-paste `npm publish` command. **It deliberately does not publish** — npm requires a browser confirmation, and "should this go out now" is a judgement call, not a mechanical step.

Step by step, if you prefer:

```bash
npm run check                        # pre-publish validation (including "shipped files are committed")
git tag -a v0.5.1 -m "…"             # the tag must point exactly at HEAD
npm run pack:tag                     # export the tag, pack in a temp dir, verify file by file
npm publish <the tgz path printed above>   # publish that tgz, not the working tree
```

`npm publish` **must carry `--registry=https://registry.npmjs.org` explicitly**: this machine's default npm registry is a read-only mirror. An environment without a TTY also needs a pty driver, or npm refuses and redacts the login URL.

`npm run pack:tag` refuses three states: uncommitted changes under the shipped paths, `HEAD` not exactly tagged `v<version>`, or that tag missing. It exports the tag's tree to a temp directory, runs `npm pack` **inside that temp directory**, then compares every file in the tgz byte for byte against the exported tree — so "v0.4.1 on GitHub" and "0.4.1 on npm" can never diverge again (that incident was caused by `npm publish` packing a working tree with uncommitted changes, on top of a tag pointing at the wrong commit).

After publishing, **verify** — this is the step that actually settles "published == tag":

```bash
npm run verify:published             # download the package from npm and diff it against the tag
```

#### The two validation modes

| Command | When the tag does not point at HEAD | Use |
|---|---|---|
| `npm run check` | reported as a note (normal during development) | run by hand |
| `npm run check:pre-commit` | note, and skips both "package contents" and "clean working tree" | the git pre-commit hook |
| `npm run check -- --release` | **fatal, refuses** | `prepublishOnly` and `npm run release` |

`--release` closes a real hole: running `npm publish` from the repository root (no tarball argument) makes `prepublishOnly` run the validation, but the default mode only *notes* a tag mismatch — so "clean working tree, tag pointing at a different commit" would slip through. That is the other half of the 0.4.1 incident.

#### Validate before every commit

```bash
npm run hooks:install                # once per clone; sets core.hooksPath
```

Every `git commit` then runs `check:pre-commit` (about 5 seconds) first. Use `git commit --no-verify` to skip it in a hurry.

To check which version the everyday profile is actually running, point it at a freshly packed tgz:

```bash
npm run snapshot -- --profile web    # pack, then repoint that profile's dependency to file:<tgz>
```

`--profile` is required and has no default: the command edits a real profile's `package.json`, and pointing the wrong profile at a snapshot is too costly a mistake. If `dsh plugin install` fails, `package.json` is rolled back to its previous contents.

## Architecture decisions

**[docs/internals.md](https://github.com/ffyfox/dsh-linux-desktop/blob/main/docs/internals.md)** records this project's design trade-offs and measured findings: the directory layout, how runtime state is produced and consumed, three architecture-deciding findings, and the concrete mechanism behind "no impact on dsh web itself".

## License

MIT
