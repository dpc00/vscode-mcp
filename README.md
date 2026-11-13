# vscode-mcp

An MCP server inside VS Code, like [sublime-mcp](https://github.com/dpc00/sublime-mcp) is for Sublime Text. It is a VS Code extension in plain JavaScript (no build step; one dependency, the prebuilt [koffi](https://www.npmjs.com/package/koffi) FFI, which ships inside the extension - the user's machine provides nothing and compiles nothing) that serves MCP (JSON-RPC over HTTP) on `http://127.0.0.1:9560/mcp`.

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue)](https://www.paypal.me/DChitester)

Donate via PayPal: https://www.paypal.me/DChitester
Contact: donaldchitester@gmail.com

## Run it

Development mode, nothing installed into VS Code:

    npm install
    Code.exe --extensionDevelopmentPath=<this folder>

Connect Claude Code:

    claude mcp add --transport http vscode-mcp http://127.0.0.1:9560/mcp

Port: setting `vscodeMcp.port`. The server accepts only loopback hosts and refuses any request that carries an `Origin` header, so a web page cannot drive the editor.

After the extension host restarts, the client finds the same tools again on the same port (poll `get_help` until `pid` changes). A restart that adds NEW tools also needs the client's tool list refreshed - opencode caches what it first fetched, so a tool the server already serves answers "Unknown tool" until `opencode api post '/api/experimental/mcp/vscode-mcp/connect?location%5Bdirectory%5D=<cwd>'`.

## Tools (v0.7)

`get_help` (also reports `pid`, `started_at` and `uptime_ms`, so a client can tell a restarted extension host from the one it was talking to before `reload_window`), **`self_test` (one call runs a battery against the running VS Code build - version and command count, create/get/replace/expect round trip, open/active/save/close, run_command, completions, quick pick drive, output channel show, list_dialogs, diagnostics, nested batch - and names every capability that broke; run it first after a VS Code update instead of assuming the API surface is unchanged)**, `list_commands`, `run_command` (any VS Code command; a command that opens a modal answers `pending: true` with the live dialog list after 12 s instead of hanging), **`discover`** (finds tools by regular expression over name and description, including the generated ones - never scroll a list, search it), `batch` (several tool calls in one request, with optional sleeps), `wait_for` (polls a file until it exists / contains text / is absent, so a test continues the moment the effect lands instead of after a fixed sleep), `wait_config` (polls a setting until it has the value just written to settings.json), `expect` (asserts a file's text - the open document if open, else disk - with `equals`, `contains`, `not_contains` or `matches`, and returns pass/fail plus the first differing line instead of the text; line endings normalised), `complete` (completions at a position, filtered and without the 20000-character cap), `hover`, `definitions`, `insert_text`, `get_open_files`, `get_workspace_folders`, `get_active_file`, `get_text`, `open_file`, `replace_text`, `save_file`, `create_file` (new text file, refuses to overwrite unless told), `reload_window` (answers first, reloads half a second later), `activate_extension` (forces one extension to start and reports the error it throws, 30 s limit), `read_log` (error lines of the extension host log, or any file in that log folder), `close_file` (by path, name or group+index only; `discard` reverts a dirty document first, so no native save dialog), `get_diagnostics`, `list_extensions`, `install_extension` and `uninstall_extension` (one `id`, a list `ids` installed by one CLI process, or - for install - a `vsix` path already on disk, which skips the marketplace round trip), `show_message`.

**Generated command tools (0.7.0, the sublime-commander pattern).** At activation the server takes this window's full VS Code command list and wraps EVERY command as a tool named after it (`workbench.action.files.newUntitledFile` becomes `workbench_action_files_newUntitledFile`; very long ids get a hash suffix). Each wrapper dispatches the command as-is with `{"args": [...]}` exactly like `run_command`, and carries the original id in its description, so extension commands appear as first-class tools the moment they are installed. This VS Code 1.144 window yields 2824 generated tools on top of the 29 hand-written ones; `discover` is how they stay usable. 0.7.0 also removes `run_shell`: the MCP surface is the editor's domain, and shelling out belongs to the test driver's own shell, not to a VS Code bridge.

**Native dialogs (0.7.1; 0.8.0 dropped PowerShell for a bundled FFI).** `list_dialogs` enumerates this instance's native OS dialogs (class `#32770`): hwnd, title and the labelled buttons of each, walked at every child depth because Task Dialogs and file pickers virtualize their controls inside child containers. `dismiss_dialog` closes one cancel-first: a button matching `cancel_re` (default cancel/no/don't save/close/discard) when one is visible, otherwise `WM_COMMAND IDCANCEL` (the dialog's own cancel press, which works when the buttons are virtualized), then `WM_CLOSE` - and it verifies the close by re-enumerating, so the result reports `dismissed` or `still_up` and no second `list_dialogs` round trip is needed. Since 0.8.0 both tools are instant: the extension declares its six user32 functions on koffi (a prebuilt N-API FFI, about 1 MB of x64 binary inside the `.vsix`) and walks the windows directly - no PowerShell process per call, and no C# compile on the user's machine (the 0.7.2 approach compiled a P/Invoke assembly with Add-Type and cached it in temp; that requirement on the user's .NET toolchain is gone).

Why `expect` exists: a test phase used to end with `get_text` and the agent reading the whole file to see whether it matched. With the assertion inside the batch, a phase returns "ok" or the one line that differs, so several phases can run per round trip and nothing is read that did not fail. Measured on the Live Server round (2026-11-11): 11-step serving batch 0.98 s, 7-step HTTP edge-case batch 0.36 s, settings write + stop/start + 3 assertions 1.9 s.

A local `.vsix` install is NOT faster than the marketplace one when the package is heavy (Live Server: 40 s both ways - its own 3500-file unpack dominates); the argument is for offline or pinned-version installs.

## Known gaps (found while building it)

- `workbench.extensions.installExtension` opens a "Do you trust the publisher?" dialog that no API can answer, so `install_extension` uses VS Code's own CLI (`out/cli.js`), which does not ask. A new extension shows in `list_extensions` after `workbench.action.reloadWindow`.
- The extension API cannot read or pick *items* of a quick pick opened by another extension. **Mitigation**: quick picks are drivable via commands (`workbench.action.quickOpen`, `workbench.action.quickOpenSelectNext`/`Previous`, `workbench.action.acceptSelectedQuickOpenItem`, `workbench.action.closeQuickOpen`). See self_test for live example.
- Cannot take screenshots from inside the extension host (use external tool or computer-use-mcp).
- Cannot read *content* of other extensions' output channels via the API. **Mitigation**: drive `workbench.action.showOutputChannels`; read extension host logs via `read_log`; specific channels like "Git" or "MCP" can be shown.
- A command that opens a modal blocks its own call until someone answers the dialog; the call returns after ~12s with `pending: true` + live `list_dialogs` data (hwnd + buttons). Use `dismiss_dialog` (cancel-first) then re-issue the command. See `run_command` and generated command tools.
- Inline decorations (e.g. Error Lens, Better Comments), tree view contents (e.g. Todo Tree), and most webviews are not readable via the extension API.
- Completions/hover are reachable via `complete` / `hover` (or run_command with execute*Provider + {$uri, $pos}).
- `run_command` with `workbench.action.reloadWindow` always returns "Canceled" (server restarts); use dedicated `reload_window` tool instead (answers first, poll `get_help` for pid change).
- First call after fresh VS Code start can fail with ECONNRESET until window is ready.

## Quick pick driving example (mitigates the items gap)
```json
// In a batch or sequential calls
{ "tool": "run_command", "arguments": { "command": "workbench.action.quickOpen" } },
{ "tool": "run_command", "arguments": { "command": "workbench.action.quickOpenSelectNext" } },
{ "tool": "run_command", "arguments": { "command": "workbench.action.acceptSelectedQuickOpenItem" } }
// or closeQuickOpen to abandon
```

## Handling modals / pending
A modal (e.g. format picker, save dialog) makes `run_command` (or any generated command) return after timeout:
`{ "pending": true, "dialogs": [ { "hwnd": 123, "title": "...", "buttons": [...] } ] }`
Then:
- `list_dialogs` (or already included)
- `dismiss_dialog` (with optional `hwnd`, `cancel_re`)
- Re-run the original command.

## self_test
Run first after any VS Code update or mcp reconnect. It exercises core hand-written tools + quick pick drive + output show + dialog layer + nested batch. Currently 14 checks (all pass on 1.146.0). Extends automatically when new hand-written tools are added.
