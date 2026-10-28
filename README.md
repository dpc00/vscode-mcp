# vscode-mcp

An MCP server inside VS Code, like [sublime-mcp](https://github.com/dpc00/sublime-mcp) is for Sublime Text. It is a VS Code extension in plain JavaScript (no dependencies, no build step) that serves MCP (JSON-RPC over HTTP) on `http://127.0.0.1:9560/mcp`.

## Run it

Development mode, nothing installed into VS Code:

    Code.exe --extensionDevelopmentPath=<this folder>

Connect Claude Code:

    claude mcp add --transport http vscode-mcp http://127.0.0.1:9560/mcp

Port: setting `vscodeMcp.port`. The server accepts only loopback hosts and refuses any request that carries an `Origin` header, so a web page cannot drive the editor.

## Tools (v0.1)

`get_help`, `list_commands`, `run_command` (any VS Code command), `get_open_files`, `get_workspace_folders`, `get_active_file`, `get_text`, `open_file`, `replace_text`, `save_file`, `create_file` (new text file, refuses to overwrite unless told), `reload_window` (answers first, reloads half a second later), `activate_extension` (forces one extension to start and reports the error it throws, 30 s limit), `read_log` (error lines of the extension host log, or any file in that log folder), `close_file` (by path, name or group+index only), `get_diagnostics`, `list_extensions`, `install_extension`, `uninstall_extension`, `show_message`.

## Known gaps (found while building it)

- `workbench.extensions.installExtension` opens a "Do you trust the publisher?" dialog that no API can answer, so `install_extension` uses VS Code's own CLI (`out/cli.js`), which does not ask. A new extension shows in `list_extensions` after `workbench.action.reloadWindow`.
- The extension API cannot read or pick items of a quick pick opened by another extension, cannot take screenshots and cannot read other extensions' output channels.
- A command that opens a modal blocks its own call until someone answers the dialog; use an external screenshot tool to see it.
- Found testing 15 extensions in the Windows Sandbox (2026-10-28): completions and hover text ARE reachable (run_command vscode.executeCompletionItemProvider / vscode.executeHoverProvider with {"$uri": ...} and {"$pos": [line, char]} arguments, added after this was first written wrongly as a gap), but inline decorations (Error Lens, Better Comments) and tree view contents (Todo Tree) are not readable; there was no tool that creates a new file (now `create_file`, 0.2.0); `run_command` with `workbench.action.reloadWindow` always returns "Canceled" because the server restarts (now use `reload_window`, which answers first; wait about 8 s, then call again); the first call after a fresh VS Code start can fail with ECONNRESET until the window is up.
- `install_extension` and `uninstall_extension` use the CLI's default folders unless the window was started with its own `--extensions-dir` or `--user-data-dir`: set `vscodeMcp.extensionsDir` and `vscodeMcp.userDataDir` to those folders (fixed in b8e4143). The CLI installs the latest release, not a pre-release, so an audit must read the installed version from `list_extensions` before comparing it with a downloaded `.vsix`.
