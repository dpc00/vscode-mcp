---
name: session-baton-2026-10-28-vscode-mcp-started
description: START HERE (vscode-mcp): Donald ordered an audit of ~50000 VS Code extensions through a new MCP; vscode-mcp 0.1.0 built, tested in portable VS Code, committed locally (ccddbe8), registered with Claude Code, audit not started
metadata:
  type: project
---

**Donald, 2026-10-28:** "you install VS Code, we install MCP, you control VS Code with it and test 50000 extensions." Then: "first, make a new MCP, vscode-mcp. Similar to sublime-mcp. Or an extension which is a similar mcp."

**Done**
- VS Code 1.144.0 portable zip (signed) in `C:\Users\donal\tools\vscode_portable\app` (own `data` folder; no registry, no admin). Ledger lines in the audit repo `data\installs_ledger.md`. Remove = recycle that folder.
- `projects\vscode-mcp`: plain JS extension, no dependencies, JSON-RPC over HTTP on 127.0.0.1:9560/mcp, 16 tools (run_command, tabs, text, diagnostics, extensions). Run: `Code.exe --extensionDevelopmentPath=C:\Users\donal\projects\vscode-mcp` (portable, from `tools\vscode_portable\app`). Committed locally as ccddbe8, no remote, not pushed.
- Registered: `claude mcp add --transport http --scope user vscode-mcp http://127.0.0.1:9560/mcp` (shows Connected in `claude mcp list` while the window is open; the tools appear in a session after `/mcp reconnect vscode-mcp` or a restart).
- Tested: get_help, list_extensions, install via CLI, reload, uninstall via CLI. `pkief.material-icon-theme` was the test extension; uninstalled, its folder is deleted at VS Code's next start (ledger removal line still to write after that).

**Later same day:** reconnect worked after `/reload-plugins` (the plain `/mcp reconnect vscode-mcp` said "not found" because the server was added mid-session). Tested from Claude with the real tools: get_help, open_file, get_diagnostics (JSON "Property expected"), replace_text, close_file (refuses a dirty tab), save_file, get_text, close_file, list_extensions. All behaved. The uninstalled test extension still shows in list_extensions until a window reload.

**Found (gaps)**
- `workbench.extensions.installExtension` raises a "Do you trust the publisher?" modal nothing can answer; install_extension therefore uses VS Code's cli.js. The new extension appears after `workbench.action.reloadWindow`.
- No API for another extension's quick pick, screenshots or output channels.

**Next**
- Reconnect the MCP in a session, then test the tools from Claude (close_file, replace_text, get_diagnostics are untested).
- Audit plan (his go needed on scale): 50000 is weeks of work; proposed batches from the top by installs, results to a RESULTS-style file, nothing filed on GitHub (hold stands). Extensions needing accounts or paid tools get "prerequisite" rows. Test each in the throwaway portable, uninstall, verify the folder is empty, ledger line per install.
- Never leave the portable VS Code window open unattended; close it when done.
