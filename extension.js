'use strict';
// vscode-mcp: an MCP server inside VS Code's extension host. It exposes the
// editor's own commands, tabs, text and extensions to an agent, the way
// sublime-mcp does for Sublime Text. Plain JavaScript, no dependencies.
const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const VERSION = '0.7.1';
const STARTED_AT = Date.now();
const MAX_TEXT = 20000;
const MAX_BODY = 4 * 1024 * 1024;

let server = null;
let statusItem = null;
let logDir = null; // this window's extension host log folder (parent of this extension's own log folder)

function cap(text, limit) {
    const n = limit || MAX_TEXT;
    return text.length > n ? text.slice(0, n) + '\n[truncated, ' + text.length + ' characters in all]' : text;
}

function fileUri(p) {
    return vscode.Uri.file(p);
}

// JSON cannot carry VS Code objects, but built-in commands such as vscode.executeHoverProvider need them.
// {"$uri": "c:\\a.txt" or "file:///c:/a.txt"}, {"$pos": [line, character]}, {"$range": [l1, c1, l2, c2]}.
function reviveArg(arg) {
    if (Array.isArray(arg)) return arg.map(reviveArg);
    if (arg && typeof arg === 'object') {
        if (typeof arg.$uri === 'string') return /^[a-z][a-z0-9+.-]+:\/\//i.test(arg.$uri) ? vscode.Uri.parse(arg.$uri) : fileUri(arg.$uri);
        if (Array.isArray(arg.$pos) && arg.$pos.length === 2) return new vscode.Position(arg.$pos[0], arg.$pos[1]);
        if (Array.isArray(arg.$range) && arg.$range.length === 4) return new vscode.Range(arg.$range[0], arg.$range[1], arg.$range[2], arg.$range[3]);
    }
    return arg;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeUri(uri) {
    if (!uri) return null;
    return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function listTabs() {
    const out = [];
    vscode.window.tabGroups.all.forEach((group, g) => {
        group.tabs.forEach((tab, i) => {
            out.push({
                group: g,
                index: i,
                label: tab.label,
                path: describeUri(tab.input && tab.input.uri),
                active: tab.isActive,
                dirty: tab.isDirty,
                pinned: tab.isPinned,
            });
        });
    });
    return out;
}

function findTab(args) {
    const matches = [];
    vscode.window.tabGroups.all.forEach((group, g) => {
        group.tabs.forEach((tab, i) => {
            const p = describeUri(tab.input && tab.input.uri);
            if (args.index !== undefined && args.group !== undefined) {
                if (g === args.group && i === args.index) matches.push(tab);
            } else if (args.path && p && p.toLowerCase() === String(args.path).toLowerCase()) {
                matches.push(tab);
            } else if (args.name && tab.label === args.name) {
                matches.push(tab);
            }
        });
    });
    if (matches.length === 0) throw new Error('no tab matches; open tabs: ' + JSON.stringify(listTabs().map(t => t.label)));
    if (matches.length > 1) throw new Error('several tabs match; use group + index from get_open_files');
    return matches[0];
}

function posOf(doc, line, character) {
    return doc.validatePosition(new vscode.Position(line, character || 0));
}

function extInfo(ext) {
    return {
        id: ext.id,
        version: ext.packageJSON && ext.packageJSON.version,
        active: ext.isActive,
        builtin: ext.extensionPath.replace(/\\/g, '/').includes('/resources/app/extensions/'),
    };
}

// Runs VS Code's own command-line interface (the same cli.js that bin/code.cmd starts) and returns its output.
function runCli(cliArgs) {
    const cli = path.join(vscode.env.appRoot, 'out', 'cli.js');
    // The CLI installs into its own default folders unless told where this window keeps its extensions.
    const config = vscode.workspace.getConfiguration('vscodeMcp');
    const dirs = [];
    const extensionsDir = config.get('extensionsDir', '');
    const userDataDir = config.get('userDataDir', '');
    if (extensionsDir) dirs.push('--extensions-dir=' + extensionsDir);
    if (userDataDir) dirs.push('--user-data-dir=' + userDataDir);
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [cli, '--ms-enable-electron-run-as-node', ...dirs, ...cliArgs],
            { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), timeout: 5 * 60 * 1000, windowsHide: true },
            (err, stdout, stderr) => {
                const text = String(stdout || '') + String(stderr || '');
                if (err && !text) reject(err); else resolve(text);
            });
    });
}

// Native dialogs of THIS VS Code instance (main process + this extension host), found by
// enumerating the OS windows whose class is #32770 - the class every standard Windows
// dialog uses, and no VS Code editor window uses. Implemented in PowerShell (inline, no
// native dependency): the same trick sublime-commander's dialog watcher uses, ported.
const VSDLG_CS = `
using System;using System.Runtime.InteropServices;using System.Text;
public class VSDlg {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}`;
const PS_PRELUDE = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n` + VSDLG_CS + `\n'@\n`;
const PS_ENUM_DIALOGS = PS_PRELUDE + `
$targets = $env:VSCODE_PIDS.Split(',') | ForEach-Object { [uint32]$_ }
$found = @()
$h = [VSDlg]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  $wpid = [uint32]0
  [void][VSDlg]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($targets -contains $wpid -and [VSDlg]::IsWindowVisible($h)) {
    $cn = New-Object System.Text.StringBuilder 256
    [void][VSDlg]::GetClassName($h, $cn, 256)
    if ($cn.ToString() -eq '#32770') {
      $tt = New-Object System.Text.StringBuilder 512
      [void][VSDlg]::GetWindowText($h, $tt, 512)
      $buttons = @()
      $b = [VSDlg]::FindWindowEx($h, [IntPtr]::Zero, 'Button', $null)
      while ($b -ne [IntPtr]::Zero) {
        $bt = New-Object System.Text.StringBuilder 256
        [void][VSDlg]::GetWindowText($b, $bt, 256)
        if ($bt.Length -gt 0) { $buttons += @{ hwnd = $b.ToInt64(); text = $bt.ToString() } }
        $b = [VSDlg]::FindWindowEx($h, $b, 'Button', $null)
      }
      $found += @{ hwnd = $h.ToInt64(); pid = $wpid; title = $tt.ToString(); buttons = $buttons }
    }
  }
  $h = [VSDlg]::GetWindow($h, 2)
}
if ($found.Count -eq 0) { '[]' } else { $found | ConvertTo-Json -Depth 3 -Compress }
`;

function dialogPids() {
    // The main process (parent of this extension host) owns the native dialogs; this
    // extension host owns none, but is included so nothing is missed.
    const pids = [process.ppid, process.pid].filter((p) => Number.isFinite(p));
    return pids.join(',');
}

function runPowerShell(script, timeoutMs) {
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { env: Object.assign({}, process.env, { VSCODE_PIDS: dialogPids() }), timeout: timeoutMs || 20000, windowsHide: true },
            (err, stdout) => {
                if (err && !String(stdout || '').trim()) { resolve({ error: String((err && err.message) || err).slice(0, 300) }); return; }
                resolve({ stdout: String(stdout || '').trim() });
            });
    });
}

function parseDialogs(stdout) {
    try {
        const value = JSON.parse(stdout);
        return Array.isArray(value) ? value : [value];
    } catch (e) { return []; }
}

function psDismiss(targetHwnd, msg) {
    return PS_PRELUDE + `\n[void][VSDlg]::PostMessage([IntPtr]::new(` + Number(targetHwnd) + `), ` + Number(msg) + `, [IntPtr]::Zero, [IntPtr]::Zero)\n'done'\n`;
}

const CANCEL_RE = /cancel|no\b|don.?t save|close|discard/i;

// Observed behaviour of VS Code commands, recorded by tools/probe_vscode_commands.js on a
// disposable profile and shipped beside the extension. When present, each generated command
// tool's description gains an "Observed on VS Code ..." line (the sublime-commander pattern).
let COMMAND_BEHAVIOR = null;
try { COMMAND_BEHAVIOR = JSON.parse(fs.readFileSync(path.join(__dirname, 'commands_behavior.json'), 'utf8')); } catch (e) {}

const TOOLS = [
    {
        name: 'get_help',
        description: 'Describes this server and its tools, and the gaps compared with sublime-mcp. Also reports pid, started_at and uptime_ms so a client can tell a restarted extension host from the one it was talking to before reload_window:',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({
            server: 'vscode-mcp ' + VERSION,
            pid: process.pid,
            started_at: STARTED_AT,
            uptime_ms: Date.now() - STARTED_AT,
            vscode: vscode.version,
            what: 'Runs inside the VS Code extension host. Every VS Code command is reachable with run_command; list_commands finds them.',
            gaps: [
                'No tool reads or picks items in a quick pick opened by another extension (the API does not expose it).',
                'No screenshots from inside the extension host; use an external screenshot tool.',
                'Output channels of other extensions cannot be read through the API.',
            ],
            tools_hand_written: TOOLS.filter(t => !t.generated).map(t => t.name),
            tools_count: TOOLS.length,
            generated: 'Every tool above the hand-written list is a GENERATED VS Code command tool, one per command id, dispatched as-is. Find them with discover {query}; run them with {"args": [...]} exactly like run_command.',
        }),
    },
    {
        name: 'list_commands',
        description: 'Lists VS Code command ids, optionally filtered by a substring. Without a filter only the count is returned (there are thousands).',
        inputSchema: { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'number' } } },
        run: async (a) => {
            const all = await vscode.commands.getCommands(true);
            if (!a.filter) return { count: all.length, hint: 'pass filter' };
            const f = String(a.filter).toLowerCase();
            const hits = all.filter(c => c.toLowerCase().includes(f));
            return { count: hits.length, commands: hits.slice(0, a.limit || 100) };
        },
    },
    {
        name: 'run_command',
        description: 'Runs a VS Code command by id with optional arguments, like choosing it from the command palette. Returns the command result (JSON, capped) or an error. Arguments that need VS Code objects are written as {"$uri": "c:\\\\a.txt"}, {"$pos": [line, character]} and {"$range": [l1, c1, l2, c2]}, e.g. vscode.executeHoverProvider with [{"$uri": "..."}, {"$pos": [0, 5]}].',
        inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array' } }, required: ['command'] },
        run: async (a) => {
            const result = await vscode.commands.executeCommand(a.command, ...(a.args || []).map(reviveArg));
            if (result === undefined) return { ok: true, result: null };
            // Provider commands (completions, hover, symbols) return large objects: cap what goes back.
            const text = JSON.stringify(result);
            if (text && text.length > MAX_TEXT) return { ok: true, truncated: true, result: cap(text) };
            return { ok: true, result };
        },
    },
    {
        name: 'get_open_files',
        description: 'Lists every open tab: group, index, label, path, active, dirty, pinned.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => listTabs(),
    },
    {
        name: 'get_workspace_folders',
        description: 'Lists the folders of the open workspace.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
    },
    {
        name: 'get_active_file',
        description: 'Path, language, selection and text (capped) of the active editor. Pass max to change the cap.',
        inputSchema: { type: 'object', properties: { max: { type: 'number' } } },
        run: async (a) => {
            const ed = vscode.window.activeTextEditor;
            if (!ed) return { active: false };
            const doc = ed.document;
            return {
                path: describeUri(doc.uri),
                language: doc.languageId,
                lines: doc.lineCount,
                dirty: doc.isDirty,
                selection: ed.selections.map(s => ({ start: [s.start.line, s.start.character], end: [s.end.line, s.end.character] })),
                text: cap(doc.getText(), a.max),
            };
        },
    },
    {
        name: 'get_text',
        description: 'Reads a line range of an open or on-disk file: path, start_line, end_line (0-based, end exclusive). Capped.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const start = a.start_line || 0;
            const end = a.end_line === undefined ? doc.lineCount : Math.min(a.end_line, doc.lineCount);
            const range = new vscode.Range(posOf(doc, start, 0), posOf(doc, end, 0));
            return { path: a.path, lines: doc.lineCount, text: cap(doc.getText(range)) };
        },
    },
    {
        name: 'open_file',
        description: 'Opens a file in an editor tab (optionally at a 0-based line), without taking over an existing preview tab.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (a.line !== undefined) {
                const p = posOf(doc, a.line, a.character || 0);
                ed.selection = new vscode.Selection(p, p);
                ed.revealRange(new vscode.Range(p, p));
            }
            return { ok: true, path: describeUri(doc.uri) };
        },
    },
    {
        name: 'replace_text',
        description: 'In a file, replaces one exact occurrence of old_string with new_string (error if it occurs zero or several times). Does not save.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const text = doc.getText();
            const at = text.indexOf(a.old_string);
            if (at < 0) throw new Error('old_string not found');
            if (text.indexOf(a.old_string, at + 1) >= 0) throw new Error('old_string occurs more than once');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + a.old_string.length)), a.new_string);
            const ok = await vscode.workspace.applyEdit(edit);
            return { ok, dirty: doc.isDirty };
        },
    },
    {
        name: 'save_file',
        description: 'Saves an open file by path.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async (a) => {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === String(a.path).toLowerCase());
            if (!doc) throw new Error('file is not open');
            return { ok: await doc.save() };
        },
    },
    {
        name: 'create_file',
        description: 'Creates a text file (and its folders) with the given content. Refuses to replace an existing file unless overwrite is true. Writes to disk directly; open it afterwards with open_file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path'] },
        run: async (a) => {
            if (!path.isAbsolute(String(a.path))) throw new Error('path must be absolute');
            const uri = fileUri(a.path);
            let exists = true;
            try { await vscode.workspace.fs.stat(uri); } catch (e) { exists = false; }
            if (exists && !a.overwrite) throw new Error('file exists; pass overwrite:true to replace it');
            await vscode.workspace.fs.createDirectory(fileUri(path.dirname(String(a.path))));
            const bytes = Buffer.from(String(a.content || ''), 'utf8');
            await vscode.workspace.fs.writeFile(uri, bytes);
            return { ok: true, path: describeUri(uri), bytes: bytes.length, replaced: exists };
        },
    },
    {
        name: 'complete',
        description: 'Completions at a position (path, 0-based line and character), without the 20000-character cap of run_command: returns total, then at most limit (default 50) items as label, description, kind, detail, insert. filter is a case-insensitive regular expression on the label, applied before the limit. trigger is an optional trigger character.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' }, filter: { type: 'string' }, limit: { type: 'number' }, trigger: { type: 'string' } }, required: ['path'] },
        run: async (a) => {
            const uri = fileUri(a.path);
            await vscode.workspace.openTextDocument(uri);
            const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(a.line || 0, a.character || 0), a.trigger);
            const re = a.filter ? new RegExp(a.filter, 'i') : null;
            let items = ((list && list.items) || []).map((i) => {
                const obj = typeof i.label === 'object' && i.label;
                const ins = i.insertText && typeof i.insertText === 'object' ? i.insertText.value : i.insertText;
                return { label: obj ? obj.label : i.label, description: obj ? obj.description : undefined, kind: vscode.CompletionItemKind[i.kind], detail: i.detail, insert: ins };
            });
            if (re) items = items.filter((i) => re.test(i.label));
            return { total: items.length, items: items.slice(0, a.limit || 50) };
        },
    },
    {
        name: 'hover',
        description: 'Hover text at a position (path, 0-based line and character): the markdown/plain strings of every hover provider, joined.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const uri = fileUri(a.path);
            await vscode.workspace.openTextDocument(uri);
            const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(a.line || 0, a.character || 0))) || [];
            const parts = [];
            for (const h of hovers) for (const c of [].concat(h.contents)) parts.push(typeof c === 'string' ? c : c.value);
            return { hovers: hovers.length, text: cap(parts.join('\n---\n')) };
        },
    },
    {
        name: 'definitions',
        description: 'Go to definition at a position (path, 0-based line and character): the target locations as path, line, character.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const uri = fileUri(a.path);
            await vscode.workspace.openTextDocument(uri);
            const found = (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, new vscode.Position(a.line || 0, a.character || 0))) || [];
            return found.map((l) => { const u = l.uri || l.targetUri; const r = l.range || l.targetSelectionRange || l.targetRange; return { path: describeUri(u), line: r.start.line, character: r.start.character }; });
        },
    },
    {
        name: 'insert_text',
        description: 'Inserts text at a position (path, 0-based line and character; default end of file) in a file, opening it if needed. Does not save. Use to type a prefix before asking for completions.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path', 'text'] },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const at = a.line === undefined ? doc.lineAt(doc.lineCount - 1).range.end : posOf(doc, a.line, a.character || 0);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, at, a.text);
            const ok = await vscode.workspace.applyEdit(edit);
            return { ok, line: at.line, character: at.character, dirty: doc.isDirty };
        },
    },
    {
        name: 'discover',
        description: 'Finds tools by case-insensitive regular expression on name or description, over every tool INCLUDING the generated VS Code command tools (one per command id). Returns total and up to limit (default 30) matches as {name, generated, command, description}. This is how a 1000-tool surface stays usable: never scroll a list, search it.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
        run: async (a) => {
            const re = new RegExp(String(a.query), 'i');
            const limit = Math.min(a.limit || 30, 200);
            const matches = TOOLS.filter(t => re.test(t.name) || re.test(t.description || ''));
            return {
                total: matches.length,
                tools: matches.slice(0, limit).map(t => ({
                    name: t.name,
                    generated: !!t.generated,
                    command: t.commandId,
                    description: (t.description || '').slice(0, 160),
                })),
            };
        },
    },
    {
        name: 'wait_for',
        description: 'Waits until a file exists, contains text, or is absent (absent:true) - no fixed sleeps. Polls every interval_ms (default 150) up to timeout_ms (default 10000). Put it between an action and get_text in one batch: the test continues the moment the effect lands.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, contains: { type: 'string' }, absent: { type: 'boolean' }, timeout_ms: { type: 'number' }, interval_ms: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const started = Date.now();
            const timeout = Math.min(a.timeout_ms || 10000, 120000);
            const interval = Math.max(a.interval_ms || 150, 20);
            for (;;) {
                let exists = false;
                let text = '';
                try { text = fs.readFileSync(String(a.path), 'utf8'); exists = true; } catch (e) { exists = false; }
                let ok;
                if (a.absent) ok = !exists;
                else ok = exists && (a.contains ? text.includes(String(a.contains)) : true);
                if (ok) return { ok: true, waited_ms: Date.now() - started, exists, chars: exists ? text.length : 0 };
                if (Date.now() - started >= timeout) return { ok: false, timed_out: true, waited_ms: Date.now() - started, exists, chars: exists ? text.length : 0 };
                await new Promise((r) => setTimeout(r, interval));
            }
        },
    },
    {
        name: 'wait_config',
        description: 'Waits until a setting has a given value (JSON compare), so a settings.json write can be followed straight by the test instead of a 3-4 s sleep for the watcher. key is the full dotted key, e.g. code-runner.ignoreSelection; value is any JSON value, null to wait for unset.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: {}, timeout_ms: { type: 'number' } }, required: ['key'] },
        run: async (a) => {
            const started = Date.now();
            const timeout = Math.min(a.timeout_ms || 10000, 120000);
            const want = JSON.stringify(a.value === undefined ? null : a.value);
            for (;;) {
                const actual = vscode.workspace.getConfiguration().get(a.key);
                if (JSON.stringify(actual === undefined ? null : actual) === want) {
                    return { ok: true, waited_ms: Date.now() - started, value: actual };
                }
                if (Date.now() - started >= timeout) return { ok: false, timed_out: true, waited_ms: Date.now() - started, actual };
                await new Promise((r) => setTimeout(r, 100));
            }
        },
    },
    {
        name: 'expect',
        description: 'Asserts a file\'s text and returns pass/fail instead of the text: the content of the open document if that file is open (unsaved edits included), otherwise the file on disk. Give exactly one of equals (whole text), contains, not_contains, or matches (regular expression). Line endings are normalised unless ignore_line_endings is false. On failure it reports the first differing line with the expected and the actual line, so a whole phase of a test can run as one batch and only the mismatches need reading.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                equals: { type: 'string' },
                contains: { type: 'string' },
                not_contains: { type: 'string' },
                matches: { type: 'string' },
                ignore_line_endings: { type: 'boolean', description: 'default true' },
            },
            required: ['path'],
        },
        run: async (a) => {
            const modes = ['equals', 'contains', 'not_contains', 'matches'].filter((k) => a[k] !== undefined);
            if (modes.length !== 1) throw new Error('give exactly one of equals, contains, not_contains, matches');
            const mode = modes[0];
            const uri = fileUri(a.path);
            let actual, source;
            const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            if (open) { actual = open.getText(); source = 'document'; }
            else {
                try { actual = fs.readFileSync(String(a.path), 'utf8'); source = 'disk'; }
                catch (e) { return { ok: false, missing: true, path: String(a.path), mode }; }
            }
            const norm = (s) => (a.ignore_line_endings === false ? String(s) : String(s).replace(/\r\n/g, '\n'));
            const A = norm(actual);
            const needle = a[mode];
            const E = mode === 'matches' ? String(needle) : norm(needle);
            let ok;
            if (mode === 'equals') ok = A === E;
            else if (mode === 'contains') ok = A.includes(E);
            else if (mode === 'not_contains') ok = !A.includes(E);
            else ok = new RegExp(E, 'm').test(A);
            const out = { ok, mode, path: String(a.path), source, chars: A.length };
            if (ok) return out;
            if (mode === 'matches') { out.pattern = E; return out; }
            if (mode === 'contains' || mode === 'not_contains') { out.needle = cap(E, 300); out.head = cap(A, 400); return out; }
            const al = A.split('\n'), el = E.split('\n');
            let i = 0;
            while (i < al.length && i < el.length && al[i] === el[i]) i++;
            out.first_difference = { line: i, expected: cap(el[i] === undefined ? '' : el[i], 300), actual: cap(al[i] === undefined ? '' : al[i], 300) };
            out.lines = { expected: el.length, actual: al.length };
            return out;
        },
    },
    {
        name: 'batch',
        description: 'Runs several tool calls in order in ONE request and returns one result per call: calls is a list of {tool, arguments} or {sleep: milliseconds}. Stops at the first error unless keep_going is true. Saves the round trip of every step of a test (create, open, edit, complete, diagnostics).',
        inputSchema: { type: 'object', properties: { calls: { type: 'array', items: { type: 'object' } }, keep_going: { type: 'boolean' } }, required: ['calls'] },
        run: async (a) => {
            const results = [];
            for (const c of a.calls || []) {
                if (c && typeof c.sleep === 'number') { await new Promise((r) => setTimeout(r, Math.min(c.sleep, 30000))); results.push({ slept: c.sleep }); continue; }
                const tool = TOOLS.find((t) => t.name === (c && c.tool));
                if (!tool || tool.name === 'batch' || tool.name === 'reload_window') { results.push({ error: 'cannot batch tool ' + (c && c.tool) }); if (!a.keep_going) break; continue; }
                try { results.push(await tool.run((c && c.arguments) || {})); } catch (e) {
                    results.push({ error: String((e && e.message) || e) });
                    if (!a.keep_going) break;
                }
            }
            return results;
        },
    },
    {
        name: 'activate_extension',
        description: 'Forces an installed extension to activate now (whatever its activation events) and reports ok or the error it throws, with the time taken. Gives up after 30 s (timed_out:true; the extension may still be starting). A smoke test that an extension starts, not that its features work.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async (a) => {
            const ext = vscode.extensions.getExtension(a.id);
            if (!ext) throw new Error('extension not installed or not visible yet (reload the window after install_extension)');
            const t0 = Date.now();
            if (ext.isActive) return { ok: true, already_active: true, ms: 0 };
            try {
                const done = await Promise.race([ext.activate().then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
                return done ? { ok: true, active: ext.isActive, ms: Date.now() - t0 } : { ok: false, timed_out: true, ms: Date.now() - t0 };
            } catch (e) {
                return { ok: false, error: String((e && e.message) || e).slice(0, 500), ms: Date.now() - t0 };
            }
        },
    },
    {
        name: 'read_log',
        description: 'Reads this window\'s extension host log (default exthost.log; file may be another plain file name in the same folder, list:true shows the folder). Returns only lines matching pattern (a regular expression, default error|fail|exception, case-insensitive) from line from_line on (0-based), at most max lines (default 100). The result also gives total_lines, so a later call can pass from_line to see only new lines. Use it to find "Activating extension ... failed".',
        inputSchema: { type: 'object', properties: { file: { type: 'string' }, pattern: { type: 'string' }, from_line: { type: 'number' }, max: { type: 'number' }, list: { type: 'boolean' } } },
        run: async (a) => {
            if (!logDir) throw new Error('log folder unknown');
            if (a.list) return { dir: logDir, files: fs.readdirSync(logDir) };
            const file = path.join(logDir, path.basename(String(a.file || 'exthost.log')));
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            const re = new RegExp(a.pattern || 'error|fail|exception', 'i');
            const hits = [];
            for (let i = a.from_line || 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i + ': ' + lines[i]);
            const max = a.max || 100;
            return { file, total_lines: lines.length, matches: hits.length, lines: cap(hits.slice(-max).join('\n')) };
        },
    },
    {
        name: 'reload_window',
        description: 'Reloads the VS Code window (workbench.action.reloadWindow). The call answers first and the reload follows about half a second later, so the server restarts: wait several seconds, then call again. Use it after install_extension so a new extension becomes active.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            setTimeout(() => { vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 500);
            return { ok: true, note: 'reloading in about 0.5 s; reconnect after a few seconds' };
        },
    },
    {
        name: 'close_file',
        description: 'Closes ONE tab chosen by path, name (label) or group+index. Never closes "the active tab". Refuses a dirty tab unless discard is true.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, group: { type: 'number' }, index: { type: 'number' }, discard: { type: 'boolean' } } },
        run: async (a) => {
            if (!a.path && !a.name && a.index === undefined) throw new Error('give path, name, or group and index');
            const tab = findTab(a);
            if (tab.isDirty && !a.discard) throw new Error('tab has unsaved changes; save it or pass discard:true');
            if (tab.isDirty && a.discard) {
                // tabGroups.close cannot discard: a dirty tab raises VS Code's native
                // save dialog, which blocks the workbench behind the MCP call (found
                // 2026-11-11 in the extension audit). Revert the editor first, then
                // the close is silent.
                const uri = tab.input && tab.input.uri;
                if (uri) {
                    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
                    if (!ed) await vscode.window.showTextDocument(uri, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                }
            }
            const label = tab.label;
            const ok = await vscode.window.tabGroups.close(tab, true);
            return { ok, closed: label };
        },
    },
    {
        name: 'list_dialogs',
        description: 'Lists the native OS dialogs (class #32770) of this VS Code instance: hwnd, title and the labelled buttons of each. This is the tool for "a dialog is up and nothing answers": file open/save dialogs, confirmations and message boxes of the editor itself. Empty list means no native dialog is up (workbench quick picks and input boxes are NOT visible to any API - they are recorded as a gap). Costs one PowerShell round trip, about 1-2 s.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const r = await runPowerShell(PS_ENUM_DIALOGS);
            if (r.error) return { dialogs: [], error: r.error };
            return { dialogs: parseDialogs(r.stdout) };
        },
    },
    {
        name: 'dismiss_dialog',
        description: 'Closes a native dialog of this VS Code instance: clicks the button matching cancel_re (default /cancel|no|don.t save|close|discard/i - cancel is the safe answer), or sends WM_CLOSE when no labelled button matches. hwnd defaults to the first dialog from list_dialogs. Workbench quick picks and input boxes are not native dialogs - they are unreachable.',
        inputSchema: { type: 'object', properties: { hwnd: { type: 'number' }, cancel_re: { type: 'string' } } },
        run: async (a) => {
            const enumOut = await runPowerShell(PS_ENUM_DIALOGS);
            const dialogs = parseDialogs(enumOut.stdout || '[]');
            if (!dialogs.length) return { ok: false, note: 'no native dialog is up' };
            let dlg = dialogs[0];
            if (a.hwnd !== undefined) {
                const found = dialogs.find((d) => d.hwnd === Number(a.hwnd));
                if (!found) return { ok: false, note: 'hwnd ' + a.hwnd + ' is not a dialog of this instance', dialogs };
                dlg = found;
            }
            let re = CANCEL_RE;
            if (a.cancel_re) {
                try { re = new RegExp(a.cancel_re, 'i'); } catch (e) { return { ok: false, error: 'bad cancel_re: ' + e.message }; }
            }
            const cancel = (dlg.buttons || []).find((b) => re.test(b.text || ''));
            if (cancel) {
                const r = await runPowerShell(psDismiss(cancel.hwnd, 0x00F5));
                return { ok: !r.error, via: 'button: ' + cancel.text, button_hwnd: cancel.hwnd, error: r.error };
            }
            const r = await runPowerShell(psDismiss(dlg.hwnd, 0x0010));
            return { ok: !r.error, via: 'WM_CLOSE', hwnd: dlg.hwnd, error: r.error };
        },
    },
    {
        name: 'get_diagnostics',
        description: 'Problems (errors, warnings) for a file, or for all files when path is omitted.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, source: { type: 'string', description: 'keep only diagnostics whose source matches this case-insensitive regular expression' } } },
        run: async (a) => {
            const sev = ['error', 'warning', 'info', 'hint'];
            const src = a.source ? new RegExp(a.source, 'i') : null;
            const shape = (uri, list) => list.filter(d => !src || src.test(d.source || '')).map(d => ({ path: describeUri(uri), line: d.range.start.line, character: d.range.start.character, end_line: d.range.end.line, end_character: d.range.end.character, severity: sev[d.severity], source: d.source, code: d.code && typeof d.code === 'object' ? d.code.value : d.code, message: d.message }));
            if (a.path) return shape(fileUri(a.path), vscode.languages.getDiagnostics(fileUri(a.path)));
            const out = [];
            for (const [uri, list] of vscode.languages.getDiagnostics()) out.push(...shape(uri, list));
            return out.slice(0, 200);
        },
    },
    {
        name: 'list_extensions',
        description: 'Lists installed extensions (id, version, active, builtin), optionally filtered by id substring. Built-in ones are hidden unless builtin is true.',
        inputSchema: { type: 'object', properties: { filter: { type: 'string' }, builtin: { type: 'boolean' }, active_only: { type: 'boolean' }, ids_only: { type: 'boolean', description: 'return just the id strings' } } },
        run: async (a) => {
            const f = a.filter ? String(a.filter).toLowerCase() : '';
            const list = vscode.extensions.all.map(extInfo)
                .filter(e => (a.builtin || !e.builtin) && e.id.toLowerCase().includes(f) && (!a.active_only || e.active));
            return a.ids_only ? list.map(e => e.id) : list;
        },
    },
    {
        name: 'install_extension',
        description: 'Installs an extension with VS Code\'s own CLI: from the marketplace by id (publisher.name), or from a .vsix file already downloaded (give vsix: path) - that skips the marketplace round trip, which is the slowest part of a test round. The command "workbench.extensions.installExtension" is not used: it opens a "Do you trust the publisher?" dialog that nothing can answer. The running window may list the new extension only after a reload (run_command workbench.action.reloadWindow).',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, description: 'Several ids installed by ONE CLI process (much faster than one call each); results holds ok and version per id.' }, vsix: { type: 'string', description: 'Absolute path to a .vsix on disk (e.g. the file a triage download already produced). Takes precedence over id/ids.' } } },
        run: async (a) => {
            if (a.vsix) {
                const p = String(a.vsix);
                const out = await runCli(['--install-extension', p, '--force']);
                // For a .vsix the CLI names the FILE, not the extension id: "Extension 'ext.vsix' was successfully installed".
                const m = /Extension '([^']+)' was successfully installed/i.exec(out);
                return { ok: !!m, vsix: p, cli_says: m ? m[1] : '', note: 'the CLI reports the file name for a .vsix; confirm the id with list_extensions after a reload', cli: out.trim() };
            }
            const ids = a.ids && a.ids.length ? a.ids.map(String) : (a.id ? [String(a.id)] : []);
            if (!ids.length) throw new Error('give id or ids');
            const args = [];
            for (const id of ids) args.push('--install-extension', id);
            args.push('--force');
            const out = await runCli(args);
            const results = {};
            for (const id of ids) {
                const m = new RegExp("Extension '" + escapeRe(id) + "' v([^ ]+) was successfully installed", 'i').exec(out);
                results[id] = { ok: !!m, version: m ? m[1] : '', visible_now: !!vscode.extensions.getExtension(id) };
            }
            return { ok: ids.every((id) => results[id].ok), results, cli: out.trim(), visible_now: ids.length === 1 ? results[ids[0]].visible_now : undefined };
        },
    },
    {
        name: 'uninstall_extension',
        description: 'Uninstalls an extension by id with VS Code\'s own CLI. The running window may keep it listed until a reload.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, description: 'Several ids removed by ONE CLI process.' } } },
        run: async (a) => {
            const ids = a.ids && a.ids.length ? a.ids.map(String) : (a.id ? [String(a.id)] : []);
            if (!ids.length) throw new Error('give id or ids');
            const args = [];
            for (const id of ids) args.push('--uninstall-extension', id);
            const out = await runCli(args);
            const results = {};
            for (const id of ids) results[id] = { ok: new RegExp("Extension '" + escapeRe(id) + "' was successfully uninstalled", 'i').test(out), still_listed: !!vscode.extensions.getExtension(id) };
            return { ok: ids.every((id) => results[id].ok), results, cli: out.trim(), still_listed: ids.length === 1 ? results[ids[0]].still_listed : undefined };
        },
    },
    {
        name: 'show_message',
        description: 'Shows a notification in VS Code (info, warning or error) so the person at the keyboard can see what the agent is doing. Does not wait for a click.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' }, level: { type: 'string' } }, required: ['text'] },
        run: async (a) => {
            const fn = a.level === 'error' ? vscode.window.showErrorMessage : a.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
            fn(String(a.text));
            return { ok: true };
        },
    },
];

function ok(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return ok(id, {
            protocolVersion: (params && params.protocolVersion) || '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'vscode-mcp', version: VERSION },
            instructions: 'Call get_help first. Close tabs by name, path or group+index only.',
        });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
        return ok(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (method === 'tools/call') {
        const tool = TOOLS.find(t => t.name === (params && params.name));
        if (!tool) return rpcError(id, -32602, 'unknown tool ' + (params && params.name));
        try {
            const value = await tool.run((params && params.arguments) || {});
            return ok(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
        } catch (e) {
            return ok(id, { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] });
        }
    }
    if (id === undefined || id === null) return null; // a notification needs no answer
    return rpcError(id, -32601, 'method not found: ' + method);
}

function startServer(output) {
    const config = vscode.workspace.getConfiguration('vscodeMcp');
    const port = config.get('port', 9560);
    const bind = config.get('bind', '127.0.0.1');
    const srv = http.createServer((req, res) => {
        // No browser pages: a page on the web must not be able to drive the editor. A Host header that is a
        // name other than localhost is refused (DNS rebinding needs a name); an IP address is accepted so
        // that a bind other than loopback (a disposable sandbox) can be reached by IP.
        const host = String(req.headers.host || '');
        if (!/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) || req.headers.origin) {
            res.writeHead(403).end('forbidden');
            return;
        }
        if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
            res.writeHead(405, { Allow: 'POST' }).end('POST JSON-RPC to /mcp');
            return;
        }
        let body = '';
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) { req.destroy(); return; }
            body += chunk;
        });
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(rpcError(null, -32700, 'bad JSON')));
                return;
            }
            const batch = Array.isArray(parsed);
            const replies = [];
            for (const msg of (batch ? parsed : [parsed])) {
                const reply = await handleRpc(msg);
                if (reply) replies.push(reply);
            }
            if (replies.length === 0) { res.writeHead(202).end(); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(batch ? replies : replies[0]));
        });
    });
    srv.on('error', (e) => {
        output.appendLine('server error: ' + e.message);
        statusItem.text = '$(error) MCP';
        statusItem.tooltip = 'vscode-mcp: ' + e.message;
    });
    srv.listen(port, bind, () => {
        output.appendLine('listening on http://' + bind + ':' + port + '/mcp');
        statusItem.text = '$(plug) MCP ' + port;
        statusItem.tooltip = 'vscode-mcp listening on http://' + bind + ':' + port + '/mcp';
    });
    return srv;
}

// The generated VS Code command tools: one wrapper per command id in this window's
// command list, named after the command (dots become underscores; very long ids get a
// hash suffix; collisions get a counter). Arguments are forwarded as in run_command.
// This is the sublime-commander pattern: the editor's own command surface, as tools.
function hash6(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) + s.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
}

function commandToolName(id, used) {
    let base = String(id).replace(/[^A-Za-z0-9-]/g, '_');
    if (base.length > 58) base = base.slice(0, 50) + '_' + hash6(String(id));
    let name = base;
    for (let n = 2; used.has(name); n++) name = base + '_' + n;
    used.add(name);
    return name;
}

async function buildCommandTools() {
    const used = new Set(TOOLS.map(t => t.name));
    const ids = await vscode.commands.getCommands(true);
    const out = [];
    for (const id of ids) {
        const name = commandToolName(id, used);
        let description = 'VS Code command `' + id + '` (generated from this window\'s command list; dispatched as-is, like run_command). Pass {"args": [...]}; {"$uri"}, {"$pos"} and {"$range"} items revive to real VS Code objects.';
        const b = COMMAND_BEHAVIOR && COMMAND_BEHAVIOR.commands ? COMMAND_BEHAVIOR.commands[id] : null;
        if (b && b.note) {
            description += ' Observed on VS Code ' + (COMMAND_BEHAVIOR.vscode || '') + ': ' + b.note;
        } else if (b && b.outcome === 'ok') {
            description += ' Observed on VS Code ' + (COMMAND_BEHAVIOR.vscode || '') + ': ran with no arguments and returned cleanly.';
        }
        out.push({
            name,
            generated: true,
            commandId: id,
            description,
            inputSchema: { type: 'object', properties: { args: { type: 'array', description: 'Forwarded to the command unchanged, in run_command\'s {"args": [...]} shape.' } } },
            run: async (a) => {
                const args = (a && Array.isArray(a.args) ? a.args : []).map(reviveArg);
                const result = await vscode.commands.executeCommand(id, ...args);
                if (result === undefined) return { ok: true, result: null };
                const text = JSON.stringify(result);
                if (text && text.length > MAX_TEXT) return { ok: true, truncated: true, result: cap(text) };
                return { ok: true, result };
            },
        });
    }
    return out;
}

function activate(context) {
    logDir = path.dirname(context.logUri.fsPath);
    const output = vscode.window.createOutputChannel('VS Code MCP');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    statusItem.show();
    server = startServer(output);
    buildCommandTools().then((gen) => {
        TOOLS.push(...gen);
        output.appendLine('generated ' + gen.length + ' command tools; ' + TOOLS.length + ' tools in all');
    }, (e) => output.appendLine('command tool generation failed: ' + String((e && e.message) || e)));
    context.subscriptions.push(
        output,
        statusItem,
        vscode.commands.registerCommand('vscodeMcp.restart', () => {
            if (server) server.close();
            server = startServer(output);
        })
    );
}

function deactivate() {
    if (server) server.close();
}

module.exports = { activate, deactivate };
