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

A client that supports a limited context is why `tools/list` is small (12 tools since 0.9.0): see "The tool surface" below before adding a tool to the list.

## The tool surface: discovery-first (0.9.0)

`tools/list` presents **12 tools**, not the whole catalogue. Everything else - the other hand-written tools and all the generated VS Code command tools (thousands, one per command id) - stays callable but is not listed:

1. `discover({"query":"fold"})` searches every tool by regular expression over name, command id and description, ranked so a name match comes first. `discover({"category":"hand-written"})` lists the server's own tools; `discover({})` maps the command namespaces (`workbench`, `editor`, `git`, ...) to browse down with `workbench/action/files`.
2. Every hit comes back with its `inputSchema`, so the call is right the first time.
3. Run it through `batch({"calls":[{"tool":"<name>","arguments":{...}}]})` - `batch` runs any tool by name, including the ones the list does not present, so a client that refuses unlisted names still has a way in.

Why (2026-11-13): the server used to list all 2824 generated tools plus the hand-written ones. A client with a limited context window filled to 100% before the first message and then could not compact while the server was attached - the tool schemas alone were larger than its window. The presented list is now about 5 KB instead of about 1.5 MB, and `discover` reaches the rest. This is sublime-commander's default-surface design.

`vscodeMcp.exposeAllTools` (default `false`) restores the full list for a client whose own batch equivalent is unusable. It is not needed for a client that refuses a tool it was not told about: that is what `batch` is for.

## Tools

`get_help` (also reports what the surface presents, and `pid`, `started_at` and `uptime_ms`, so a client can tell a restarted extension host from the one it was talking to before `reload_window`), **`self_test` (one call runs a battery against the running VS Code build - version and command count, the default surface and that a discovered tool runs through batch, create/get/replace/expect round trip, open/active/save/close, run_command, completions, quick pick drive, output channel show, list_dialogs, diagnostics, nested batch, loop guard - and names every capability that broke; run it first after a VS Code update instead of assuming the API surface is unchanged)**, `list_commands`, `run_command` (any VS Code command; a command that opens a modal answers `pending: true` with the live dialog list after 12 s instead of hanging), **`discover`** (finds tools by regular expression over name and description, including the generated ones - never scroll a list, search it), `batch` (several tool calls in one request, with optional sleeps), `wait_for` (polls a file until it exists / contains text / is absent, so a test continues the moment the effect lands instead of after a fixed sleep), `wait_config` (polls a setting until it has the value just written to settings.json), `expect` (asserts a file's text - the open document if open, else disk - with `equals`, `contains`, `not_contains` or `matches`, and returns pass/fail plus the first differing line instead of the text; line endings normalised), `complete` (completions at a position, filtered and without the 20000-character cap), `hover`, `definitions`, `insert_text`, `get_open_files`, `get_workspace_folders`, `get_active_file`, `get_text`, `open_file`, `replace_text`, `save_file`, `create_file` (new text file, refuses to overwrite unless told), `reload_window` (answers first, reloads half a second later), `activate_extension` (forces one extension to start and reports the error it throws, 30 s limit), `read_log` (error lines of the extension host log, or any file in that log folder), `close_file` (by path, name or group+index only; `discard` reverts a dirty document first, so no native save dialog), `get_diagnostics`, `list_extensions`, `install_extension` and `uninstall_extension` (one `id`, a list `ids` installed by one CLI process, or - for install - a `vsix` path already on disk, which skips the marketplace round trip), `show_message`.

**Debugging (2026-11-18, added for the `xdebug.php-debug` round).** Five tools make any debugger testable without the Debug view, a capture or a keystroke: `breakpoints` lists what the workbench holds (path, 0-based line, enabled, condition, hitCondition, logMessage), `set_breakpoints` creates or replaces source breakpoints through `vscode.debug.addBreakpoints` (`items: [{path, line, condition?, hitCondition?, logMessage?, enabled?}]`, idempotent per path+line), `clear_breakpoints` removes all or one file's, `debug_request` forwards one DAP request to `vscode.debug.activeDebugSession.customRequest` (`stackTrace`, `scopes`, `variables`, `evaluate`, `exceptionInfo`, `next`, `stepIn`, `stepOut`, `continue`, `setExceptionBreakpoints`, …) and returns the adapter's answer as JSON, and `debug_state` reports the active session plus, with `details`, its threads and top stack frames. They exist because the workbench breakpoint commands are inert from `run_command` - `editor.debug.action.toggleBreakpoint`, `debug.toggleBreakpoint` and F9 created nothing at all on VS Code 1.146 (empty Breakpoints view, no `breakpoint_set` on the wire) - and because the Variables/Call Stack views are the only other way to read a stop.

**Loop guard (0.9.1).** Every tool call - direct, generated, or inside `batch` - is fingerprinted by name + arguments + failure signature. The same call failing identically 4 times inside 15 minutes answers `{loop_breaker: true, tool, last_error, streak, note}` instead of running again: the loop that burned two hours on 2026-11-13 cannot form, because the 5th identical failure never reaches VS Code. A different result, different arguments, or a success ends the streak; `pending: true` (a dialog up) neither counts nor clears. `loop_reset({tool})` clears a streak once the situation genuinely changed (extension finished installing, dialog answered, window reloaded).

**Generated command tools (0.7.0, the sublime-commander pattern).** At activation the server takes this window's full VS Code command list and wraps EVERY command as a tool named after it (`workbench.action.files.newUntitledFile` becomes `workbench_action_files_newUntitledFile`; very long ids get a hash suffix). Each wrapper dispatches the command as-is with `{"args": [...]}` exactly like `run_command`, and carries the original id in its description, so extension commands appear the moment they are installed. This VS Code 1.144 window yields 2824 generated tools on top of the hand-written ones; since 0.9.0 they are **not** in `tools/list` - `discover` finds one and `batch` runs it. 0.7.0 also removes `run_shell`: the MCP surface is the editor's domain, and shelling out belongs to the test driver's own shell, not to a VS Code bridge. **0.9.2 reverses that decision** — a driver with no shell of its own could not read a program's effects at all, which cost a whole audit round an extra round trip per check; it is back as `run_shell` (see below).

**Language-model tools (added 2026-11-16).** `lm_tools` lists what `vscode.lm.tools` exposes in this window (name, tags, description; filterable), and `lm_tool({name, input})` invokes one through `vscode.lm.invokeTool`, returning its content parts as text. No chat participant is required - that was the wrong assumption behind "these tools cannot be tested in a rig with AI features off": an extension may call `invokeTool` directly, so anything an extension contributes under `contributes.languageModelTools` is drivable here, and a consent prompt, if one appears, is answerable with `list_dialogs`/`dismiss_dialog`. First used on `ms-dotnettools.vscode-dotnet-runtime` 3.2.0: 6 of its 8 tools driven with their exact outputs (recommended SDK version, available-versions list with support phases, installed-versions, executable-path search, settings guide, the local uninstaller's own validation text); the other two are system-wide installs that require admin.

**Native dialogs (0.7.1; 0.8.0 dropped PowerShell for a bundled FFI).** `list_dialogs` enumerates this instance's native OS dialogs (class `#32770`): hwnd, title and the labelled buttons of each, walked at every child depth because Task Dialogs and file pickers virtualize their controls inside child containers. `dismiss_dialog` closes one cancel-first: a button matching `cancel_re` (default cancel/no/don't save/close/discard) when one is visible, otherwise `WM_COMMAND IDCANCEL` (the dialog's own cancel press, which works when the buttons are virtualized), then `WM_CLOSE` - and it verifies the close by re-enumerating, so the result reports `dismissed` or `still_up` and no second `list_dialogs` round trip is needed. Since 0.8.0 both tools are instant: the extension declares its six user32 functions on koffi (a prebuilt N-API FFI, about 1 MB of x64 binary inside the `.vsix`) and walks the windows directly - no PowerShell process per call, and no C# compile on the user's machine (the 0.7.2 approach compiled a P/Invoke assembly with Add-Type and cached it in temp; that requirement on the user's .NET toolchain is gone).

Why `expect` exists: a test phase used to end with `get_text` and the agent reading the whole file to see whether it matched. With the assertion inside the batch, a phase returns "ok" or the one line that differs, so several phases can run per round trip and nothing is read that did not fail. Measured on the Live Server round (2026-11-11): 11-step serving batch 0.98 s, 7-step HTTP edge-case batch 0.36 s, settings write + stop/start + 3 assertions 1.9 s.

A local `.vsix` install is NOT faster than the marketplace one when the package is heavy (Live Server: 40 s both ways - its own 3500-file unpack dominates); the argument is for offline or pinned-version installs.

**0.9.4: primitives, no procedures.** Three capability holes were closed by adding tools, and
the first cut put the caller's procedure inside them. It does not belong there: a tool says what it
does, once.

- `reload_window` is on the default surface (the host restart a client cannot reach otherwise). It
  is a plain call; put it last in a batch, because anything after it does not run.
- `activate_window({title})` brings the first visible window whose title contains `title` forward
  with one user32 call (`SwitchToThisWindow`, what the taskbar uses) and reports the foreground
  window afterwards. `ok:false` means nothing moved.
- `send_keys({text, keys, window})` sends unicode key events and named chords to whatever has the
  keyboard focus - it does not touch focus, choose a window, or retry, so the caller must check
  `activate_window` said ok first. Pass `window` (a title substring) and it fails closed instead:
  the foreground window is re-read immediately before every record batch and the call throws
  `refused: foreground window is "…"` without sending anything else, so a focus steal cannot type
  into the person's own terminal. `keys` understands mouse-free punctuation as well
  (`ctrl+shift+-`, `[`, `]`, `\\`, `;`, `'`, `,`, `.`, `/`, `` ` ``) through the `VK_OEM_*` codes.
  A modifier is sent 40 ms before its key and released 30 ms after it, so a chord like `shift+b`
  arrives with the modifier actually down.
- `click_at({x, y, button, count})` moves the pointer and clicks at absolute screen pixels. No
  window logic.
- `run_shell({command})` runs one command in the workspace folder and returns `code`,
  `timed_out`, `ms`, `stdout`, `stderr`.

Which primitive to use, in what order - activate, then focus the widget, then type - is the caller's
procedure and lives in the skill, not here.

**0.9.5/0.9.6: snippet and completion primitives.** A snippet pack is hundreds of happy-path
assertions; the missing piece was a primitive, not patience.

- `insert_snippet({name|text, langId, expect?, revert?, include_text?})` inserts into the active
  editor and answers with `matches`/`first_difference` (or text), reverting afterwards when asked -
  one call where `insertSnippet` + `get_text` + `revert` used to be three.
- `verify_snippets({langId, items:[{name, body}], revert})` runs such a list in ONE call and holds no
  knowledge of any extension: for each item it inserts the snippet BY NAME and again from its BODY,
  reads both expansions and compares them, so the assertion is "the registered snippet expands to
  its own manifest body" with no expansion model on the client. `expect` may replace `body` for a
  fixed string. Returns `{total, pass, fail, failures}`, failures only in detail (313 snippets =
  one call, measured 2026-11-15).
- `complete` takes `kind` ("Snippet", "Function", …) beside `filter`, applied before the limit, so a
  language whose provider returns thousands of items still lists its snippets in one call.

## Known gaps (found while building it)

- A client's transport timeout (30 s in the harness this server was built against) kills a `batch`
  that contains a blocking step - `workbench.action.debug.start`, a modal, a long `wait_for` - and
  the failure reads as "request timeout, outcome unknown". Blocking commands belong in their own
  call; after a timeout, read the effect (`list_dialogs`, the file on disk) before retrying.
- `workbench.extensions.installExtension` opens a "Do you trust the publisher?" dialog that no API can answer, so `install_extension` uses VS Code's own CLI (`out/cli.js`), which does not ask. A new extension shows in `list_extensions` after `workbench.action.reloadWindow`.
- The extension API cannot read or pick *items* of a quick pick opened by another extension. **Mitigation**: quick picks are drivable via commands (`workbench.action.quickOpen`, `workbench.action.quickOpenSelectNext`/`Previous`, `workbench.action.acceptSelectedQuickOpenItem`, `workbench.action.closeQuickOpen`). See self_test for live example.
- Cannot take screenshots from inside the extension host (use external tool or computer-use-mcp).
- Cannot read *content* of other extensions' output channels via the API. **Mitigation**: drive `workbench.action.showOutputChannels`; read extension host logs via `read_log`; specific channels like "Git" or "MCP" can be shown.
- A command that opens a modal blocks its own call until someone answers the dialog; the call returns after ~12s with `pending: true` + live `list_dialogs` data (hwnd + buttons). Use `dismiss_dialog` (cancel-first) then re-issue the command. See `run_command` and generated command tools.
- Inline decorations (e.g. Error Lens, Better Comments), tree view contents (e.g. Todo Tree), and most webviews are not readable via the extension API.
- Completions/hover are reachable via `complete` / `hover` (or run_command with execute*Provider + {$uri, $pos}).
- `run_command` with `workbench.action.reloadWindow` always answers "Canceled" (the host dies mid-call); use `reload_window` - listed, and legal as the last call of a batch.
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
Run first after any VS Code update or mcp reconnect. It exercises the default surface (counts what `tools/list` presents and runs a discovered tool through `batch`) plus core hand-written tools, quick pick drive, output show, dialog layer and nested batch. Currently 15 checks (all pass on 1.146.0). Extends automatically when new hand-written tools are added. It does not need a running client: `node tools/test_surface.js` drives the same protocol in a plain Node process with a stubbed `vscode` module, and is the cheap regression guard for the surface.
