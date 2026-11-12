# vscode-mcp

An MCP server inside VS Code, like [sublime-mcp](https://github.com/dpc00/sublime-mcp) is for Sublime Text. It is a VS Code extension in plain JavaScript (no dependencies, no build step) that serves MCP (JSON-RPC over HTTP) on `http://127.0.0.1:9560/mcp`.

## Run it

Development mode, nothing installed into VS Code:

    Code.exe --extensionDevelopmentPath=<this folder>

Connect Claude Code:

    claude mcp add --transport http vscode-mcp http://127.0.0.1:9560/mcp

Port: setting `vscodeMcp.port`. The server accepts only loopback hosts and refuses any request that carries an `Origin` header, so a web page cannot drive the editor.

## Tools (v0.6)

`get_help` (also reports `pid`, `started_at` and `uptime_ms`, so a client can tell a restarted extension host from the one it was talking to before `reload_window`), `list_commands`, `run_command` (any VS Code command), `batch` (several tool calls in one request, with optional sleeps), `run_shell` (runs a shell command from inside the extension host: exit code, stdout, stderr, cwd defaults to the workspace folder - read what a program wrote or run it under test without a terminal round trip), `wait_for` (polls a file until it exists / contains text / is absent, so a test continues the moment the effect lands instead of after a fixed sleep), `wait_config` (polls a setting until it has the value just written to settings.json), `expect` (asserts a file's text - the open document if open, else disk - with `equals`, `contains`, `not_contains` or `matches`, and returns pass/fail plus the first differing line instead of the text; line endings normalised), `complete` (completions at a position, filtered and without the 20000-character cap), `hover`, `definitions`, `insert_text`, `get_open_files`, `get_workspace_folders`, `get_active_file`, `get_text`, `open_file`, `replace_text`, `save_file`, `create_file` (new text file, refuses to overwrite unless told), `reload_window` (answers first, reloads half a second later), `activate_extension` (forces one extension to start and reports the error it throws, 30 s limit), `read_log` (error lines of the extension host log, or any file in that log folder), `close_file` (by path, name or group+index only; `discard` reverts a dirty document first, so no native save dialog), `get_diagnostics`, `list_extensions`, `install_extension` and `uninstall_extension` (one `id`, a list `ids` installed by one CLI process, or - for install - a `vsix` path already on disk, which skips the marketplace round trip), `show_message`.

Why `expect` exists: a test phase used to end with `get_text` and the agent reading the whole file to see whether it matched. With the assertion inside the batch, a phase returns "ok" or the one line that differs, so several phases can run per round trip and nothing is read that did not fail. Measured on the Live Server round (2026-11-11): 11-step serving batch 0.98 s, 7-step HTTP edge-case batch 0.36 s, settings write + stop/start + 3 assertions 1.9 s.

A local `.vsix` install is NOT faster than the marketplace one when the package is heavy (Live Server: 40 s both ways - its own 3500-file unpack dominates); the argument is for offline or pinned-version installs.

## Known gaps (found while building it)

- `workbench.extensions.installExtension` opens a "Do you trust the publisher?" dialog that no API can answer, so `install_extension` uses VS Code's own CLI (`out/cli.js`), which does not ask. A new extension shows in `list_extensions` after `workbench.action.reloadWindow`.
- The extension API cannot read or pick items of a quick pick opened by another extension, cannot take screenshots and cannot read other extensions' output channels.
- A command that opens a modal blocks its own call until someone answers the dialog; use an external screenshot tool to see it.
- Found testing 15 extensions in the Windows Sandbox (2026-10-28): completions and hover text ARE reachable (run_command vscode.executeCompletionItemProvider / vscode.executeHoverProvider with {"$uri": ...} and {"$pos": [line, char]} arguments, added after this was first written wrongly as a gap), but inline decorations (Error Lens, Better Comments) and tree view contents (Todo Tree) are not readable; there was no tool that creates a new file (now `create_file`, 0.2.0); `run_command` with `workbench.action.reloadWindow` always returns "Canceled" because the server restarts (now use `reload_window`, which answers first; the old host keeps answering for 1-3 s, so poll `get_help` until `pid` changes, which takes about 2-4 s); the first call after a fresh VS Code start can fail with ECONNRESET until the window is up.
- `install_extension` and `uninstall_extension` use the CLI's default folders unless the window was started with its own `--extensions-dir` or `--user-data-dir`: set `vscodeMcp.extensionsDir` and `vscodeMcp.userDataDir` to those folders (fixed in b8e4143). The CLI installs the latest release, not a pre-release, so an audit must read the installed version from `list_extensions` before comparing it with a downloaded `.vsix`.
