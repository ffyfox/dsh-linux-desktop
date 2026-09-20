# dsh-linux-desktop

> Make DeepSeek Harness feel like a native application on Linux: launch it from your app launcher, get a chromeless standalone window, and have the background server stop when you close it.

This is a DSH bundle. It reuses the Chromium-family browser already installed on your system, wires `dsh web` into the desktop through standard XDG desktop entries, and does not change the behaviour of `dsh web` itself.

**Distribution status**: this repository is currently private and the npm package has been unpublished. See below for how to install.

---

## What it does

`dsh web` provides a complete web interface, but on a Linux desktop it has three rough edges: no dedicated taskbar or Alt-Tab entry; a service lifetime tied to a terminal; and a community of desktop plugins that targets Windows and macOS, with nothing for Linux XDG desktop entries.

This plugin addresses all three. It does four things:

1. Writes a standard XDG desktop entry to `~/.local/share/applications/`, so `dsh web` can be started from the app launcher.
2. Opens a window using Chromium's `--app` mode, containing only the dsh web interface — no address bar, tabs, or bookmarks bar.
3. Starts `dsh web` when it is not running, and stops the service it started once the window closes.
4. Maintains those files idempotently: every `dsh web` boot syncs them to the current version, and leaves them untouched when nothing changed.

## Requirements

- Linux
- A Chromium-family browser: Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi, or Opera
- `dsh` installed and on `PATH`
- Optional: `curl` (falls back to bash's built-in `/dev/tcp` for port probing)

Firefox is not supported: Mozilla removed SSB (Site Specific Browser), so Firefox cannot provide a chromeless standalone window. Degrading to `firefox --new-window` would bring back the address bar and tabs, so this plugin fails loudly in that case instead of silently degrading.

## Install

The only available installation method is currently a local checkout:

```bash
dsh plugin --profile web add /path/to/dsh-linux-desktop
```

Restart `dsh web` once after installing.

> **Why this is the only method**: the npm package `dsh-linux-desktop` has been unpublished and this repository is private, so `add dsh-linux-desktop` (by package name) and `add github:ffyfox/dsh-linux-desktop` are not available to anyone else.
>
> The local-checkout method was verified in an isolated `DSH_HOME`. This plugin is plain ESM JavaScript with no build step, so installing it from any source does not require granting pnpm an `allowBuilds` permission.

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

Options for `install`: `--force`, `--port`, `--host`, `--size`, `--browser`, `--profile-mode`, `--no-kwin`, `--no-auto-install`.
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
| `autoInstall` | Whether to auto-install or self-repair on `dsh web` boot. |
| `manageKwinRules` | Whether to manage the KWin window rule; only effective on KDE. |
| `terminalAction` / `terminalCommand` | The "run in terminal" entry in the desktop entry's context menu. Empty means auto-detect an installed terminal. |

There are two ways to change the configuration:

```bash
# Edit directly, then reinstall
$EDITOR ~/.config/dsh-desktop/config.json
dsh plugin --profile web exec dsh-desktop install

# Or change it through the CLI, which reinstalls automatically
dsh plugin --profile web exec dsh-desktop set window 1400x900
```

### profileMode

When Chrome is already running, executing `chrome --app=URL` hands the window off to the existing browser process and the launcher process exits immediately. In that situation, waiting on the process cannot detect the window closing.

| Mode | Behaviour | Cost |
|---|---|---|
| `dedicated` (default) | `--user-data-dir` points at a dedicated profile directory, so the browser process lives and dies with the window and window close can be detected reliably | One extra browser process; a separate cookie jar that authenticates via the token URL on first launch and is then good for 30 days |
| `shared` | Reuses the default browser profile directory | Shared login state, no extra process; but when Chrome is already running the window close cannot be detected, so the service is not stopped automatically — a notification explains this |

## Uninstall

```bash
dsh plugin --profile web exec dsh-desktop uninstall
```

Removes the launcher script, `dsh.desktop`, the app_id alias entry, the icons, and the KWin rule.
Keeps `~/.config/dsh-desktop/`, which holds the configuration and backups.

## Compatibility

| Dimension | Status |
|---|---|
| Desktop environment | **Verified**: KDE Plasma 6. **Expected to work, not verified**: GNOME, Hyprland/Sway and other wlroots compositors, Xfce, MATE, Cinnamon, i3 — the window and desktop entry are standard XDG, and the KWin rule is only written on KDE |
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
| The launcher does nothing | Run `DSH_DESKTOP_DEBUG=1 ~/.local/bin/dsh-desktop-app` to see debug output. Logs live in `$XDG_RUNTIME_DIR/dsh-desktop-web.log`. |
| The server is still running after the window closes | You are in `shared` mode, or the service was started elsewhere and is deliberately not taken over. Use `dedicated` and start the service from the desktop icon. |

## Development

```bash
git clone https://github.com/ffyfox/dsh-linux-desktop.git
cd dsh-linux-desktop
node test/smoke.mjs                                   # smoke tests, 61 checks, zero dependencies
node scripts/prepublish-check.mjs                     # pre-publish validation
npm pack --dry-run                                    # validate the package contents
node bin/dsh-desktop.js install --root /tmp/sandbox   # sandboxed install, touches nothing real
```

The first three are the commands CI runs on every push and pull request, and they are the gate a change must pass before merging. CI covers Node 20, 22, and 24, and additionally verifies on macOS that the plugin does nothing at all on non-Linux platforms.

`--root <dir>` or the `DSH_DESKTOP_ROOT` environment variable redirects all reads and writes into a sandbox, including `HOME` and every `XDG_*` path. Ports are not sandboxed, so take care not to disturb a service you are using.

## Architecture decisions

**[docs/internals.md](https://github.com/ffyfox/dsh-linux-desktop/blob/main/docs/internals.md)** records this project's design trade-offs and measured findings: the directory layout, how runtime state is produced and consumed, three architecture-deciding findings, and the concrete mechanism behind "no impact on dsh web itself".

## License

MIT
