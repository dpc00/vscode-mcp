'use strict';
// vscode-mcp: an MCP server inside VS Code's extension host. It exposes the
// editor's own commands, tabs, text and extensions to an agent, the way
// sublime-mcp does for Sublime Text. Plain JavaScript, no dependencies.
const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

const VERSION = '0.9.6';
const STARTED_AT = Date.now();
const MAX_TEXT = 20000;
const MAX_BODY = 4 * 1024 * 1024;

let server = null;
let statusItem = null;
let logDir = null; // this window's extension host log folder (parent of this extension's own log folder)
let boundPort = null; // the port this instance actually holds (configured, or the next free one)

// Every window runs its own extension host and its own server. One client (the harness) mounts one
// of them, so a sibling window - a second window, or a remote one whose host runs in WSL - is only
// reachable if the mounted instance knows where it is. Each instance therefore publishes itself in
// this registry, and any tool call may name another window with {"window": <port|"pid:N"|folder>};
// the request is then forwarded over the loopback to that instance and its answer relayed back.
const REGISTRY_FILE_DEFAULT = path.join(os.tmpdir(), 'vscode-mcp-instances.json');

// A remote extension host has its own /tmp, so two instances on one machine do not see each other's
// registry. vscodeMcp.registryFile points both at one file - a remote window can write the Windows
// temp through /mnt/c, and then the mounted instance lists it and can forward to it.
function registryDir() {
    const configured = vscode.workspace.getConfiguration('vscodeMcp').get('registryDir', '');
    if (configured) return String(configured);
    return path.join(os.tmpdir(), 'vscode-mcp-instances');
}

// One FILE per instance, in one directory. Two writers sharing one file lost each other's entries:
// each read-modify-write dropped whatever the other had written between the read and the write, and
// that is how the Windows and the WSL instance kept deleting each other.
function readRegistry() {
    const dir = registryDir();
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (entry && entry.id && entry.port) out.push(entry);
        } catch (e) { /* a half-written or foreign file: skip it */ }
    }
    return out;
}

function writeSelf(entry) {
    const dir = registryDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
    try { fs.writeFileSync(path.join(dir, entry.id + '.json'), JSON.stringify(entry, null, 1)); } catch (e) { /* the registry is a convenience, never a requirement */ }
}

function removeSelf() {
    try { fs.unlinkSync(path.join(registryDir(), INSTANCE_ID + '.json')); } catch (e) { /* already gone */ }
}

const HOST_NAME = os.hostname();
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const PLATFORM = process.platform;
const INSTANCE_ID = PLATFORM + '-' + HOST_NAME + '-' + process.pid + '-' + Date.now().toString(36);

// The registry is a list of announcements, not a source of truth about liveness: WSL2 hands the
// guest the Windows hostname, so "same host" cannot be inferred and kill(pid, 0) would prune the
// other side's live entry (it did - each instance deleted the other). Entries age out after a day;
// `instances` decides who is actually alive by probing the port.
function liveEntries() {
    return readRegistry().filter(e => Date.now() - (e.started_at || 0) < ENTRY_TTL_MS);
}

function upsertSelfEntry() {
    writeSelf(selfEntry());
}

function selfEntry() {
    return {
        id: INSTANCE_ID,
        pid: process.pid,
        host: HOST_NAME,
        platform: PLATFORM,
        port: boundPort,
        vscode: vscode.version,
        folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
        started_at: STARTED_AT,
        self: true,
    };
}

function registerSelf() {
    if (!boundPort) return;
    upsertSelfEntry();
}

function unregisterSelf() {
    removeSelf();
}

// Resolve a window specification against this instance and the registry. Numbers are a port first
// and a pid second (ports are what a user sees in the status bar); "pid:N" is explicit; anything
// else is matched against the workspace folders, case-insensitively.
function instanceFor(spec) {
    const s = String(spec == null ? '' : spec).trim();
    if (!s || s === 'self') return selfEntry();
    const entries = [selfEntry(), ...liveEntries().filter(e => e.pid !== process.pid).map(e => ({ ...e, self: false }))];
    const byPid = (pid) => entries.find(e => e.pid === Number(pid)) || null;
    const byPort = (port) => entries.find(e => e.port === Number(port)) || null;
    let m = /^pid:(\d+)$/i.exec(s);
    if (m) return byPid(m[1]);
    if (/^\d+$/.test(s)) return byPort(s) || byPid(s);
    const needle = s.toLowerCase();
    return entries.find(e => (e.folders || []).some(f => String(f).toLowerCase().includes(needle))) || null;
}

function probeInstance(port, timeoutMs) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vscode-mcp-registry', version: '0' } },
        });
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST', timeout: timeoutMs || 1200,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const reply = JSON.parse(data);
                    const inst = reply && reply.result && reply.result.serverInfo && reply.result.serverInfo.instance;
                    resolve(inst ? { reachable: true, ...inst } : { reachable: true });
                } catch (e) { resolve({ reachable: true }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ reachable: false, reason: 'timeout' }); });
        req.on('error', (e) => resolve({ reachable: false, reason: e.code || e.message }));
        req.end(body);
    });
}

function forwardTo(entry, msg, timeoutMs) {
    return new Promise((resolve) => {
        const body = JSON.stringify(msg);
        const req = http.request({
            host: entry.host || '127.0.0.1', port: entry.port, path: '/mcp', method: 'POST', timeout: timeoutMs || 60000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(rpcError(msg.id, -32603, 'window ' + entry.port + ' answered non-JSON')); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(rpcError(msg.id, -32603, 'forwarded call to window ' + entry.port + ' timed out')); });
        req.on('error', (e) => resolve(rpcError(msg.id, -32603, 'forwarding to window ' + entry.port + ' failed: ' + (e.code || e.message))));
        req.end(body);
    });
}

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

// The workbench's own breakpoint store, flattened to JSON. The adapter's verification of each
// breakpoint is a DAP answer (setBreakpoints), not a property here.
function breakpointList() {
    return vscode.debug.breakpoints.map((b) => {
        const base = { enabled: b.enabled !== false };
        if (b.condition) base.condition = b.condition;
        if (b.hitCondition) base.hitCondition = b.hitCondition;
        if (b.logMessage) base.logMessage = b.logMessage;
        if (b.location) {
            base.path = describeUri(b.location.uri);
            base.line = b.location.range.start.line;
            base.character = b.location.range.start.character;
            base.kind = 'source';
        } else {
            base.kind = 'function';
            if (b.functionName) base.functionName = b.functionName;
        }
        return base;
    });
}

// A notebook is a document, not a text tab: openNotebookDocument goes straight to the
// notebook serializer (vscode.open resolves an .ipynb to the text editor on this build even
// with vscode.ipynb active), then showNotebookDocument puts it in an editor so cells can run.
async function notebookDocument(p) {
    const uri = fileUri(p);
    const find = () => vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString());
    let doc = find();
    if (doc) return doc;
    let openError = null;
    try {
        doc = await vscode.workspace.openNotebookDocument(uri);
    } catch (e) {
        openError = e && e.message ? e.message : String(e);
        doc = null;
    }
    if (!doc) {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
        for (let i = 0; i < 50 && !doc; i++) { await new Promise((r) => setTimeout(r, 100)); doc = find(); }
    }
    if (!doc) throw new Error('no notebook document for ' + p + (openError ? ' (' + openError + ')' : '') + ' - no notebook serializer claims it; check that the notebook extension (ms-toolsai.jupyter) is installed and enabled');
    return doc;
}

async function showNotebook(doc) {
    const active = vscode.window.activeNotebookEditor;
    if (active && active.notebook.uri.toString() === doc.uri.toString()) return active;
    try {
        return await vscode.window.showNotebookDocument(doc, { preview: false });
    } catch (e) {
        return null;
    }
}

// NotebookCellOutput items carry mime data; text/plain is the human-readable one and is what a
// test can assert on. Binary mime types are named, not dumped.
function cellOutputs(cell) {
    const out = [];
    for (const o of cell.outputs || []) {
        for (const item of o.items || []) {
            if (item.mime === 'text/plain' || item.mime === 'application/vnd.code.notebook.stdout' || item.mime === 'application/vnd.code.notebook.stderr' || item.mime === 'application/vnd.code.notebook.error' || item.mime === 'text/html') {
                out.push({ mime: item.mime, text: cap(Buffer.from(item.data).toString('utf8'), 2000) });
            } else {
                out.push({ mime: item.mime, bytes: item.data ? item.data.length : 0 });
            }
        }
    }
    return out;
}

// Which VS Code window this server lives in. tabGroups.all covers only THIS window's
// groups, and viewColumn repeats across windows, so a window is identified by its SET of
// view columns; windows are numbered by the lowest column each owns, sorted. Tabs carry
// `win` so a caller can tell which window a tab (and therefore a command target) belongs to.
function windowMap() {
    const groups = vscode.window.tabGroups.all;
    const colToWin = new Map();
    const cols = [];
    for (const g of groups) {
        if (g.viewColumn === undefined || g.viewColumn === null) continue;
        if (!cols.includes(g.viewColumn)) cols.push(g.viewColumn);
    }
    cols.sort((a, b) => a - b);
    // One window owns columns 1..N contiguously in practice; with several windows open each
    // still has its own column 1, so column alone cannot separate them. tabGroups.all is
    // per-window, so every group here IS this window: win is always this window's index.
    // The honest answer is one window per extension host; report that instead of guessing.
    return { groups, columns: cols };
}

// What get_help/initialize report so a client can tell WHICH VS Code instance answered:
// pid, version, workspace folders, port. Without it, three instances on one port look alike.
function instanceInfo() {
    const config = vscode.workspace.getConfiguration('vscodeMcp');
    const { columns } = windowMap();
    return {
        pid: process.pid,
        vscode: vscode.version,
        port: boundPort || config.get('port', 9560),
        workspace_folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
        window_count: vscode.window.tabGroups.all.length ? 1 : 0, // this extension host serves exactly one window
        view_columns: columns,
    };
}

function listTabs() {
    const out = [];
    vscode.window.tabGroups.all.forEach((group, g) => {
        group.tabs.forEach((tab, i) => {
            out.push({
                group: g,
                index: i,
                win: 0, // this server's window; other VS Code instances have their own port and their own server
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

// The caller may spell a path with forward slashes, a lower-case drive or a
// different case; compare it with uri.fsPath in the one form VS Code uses.
function wantFsPath(p) {
    try { return vscode.Uri.file(String(p)).fsPath.toLowerCase(); } catch (e) { return String(p).toLowerCase(); }
}

function findTab(args) {
    const matches = [];    vscode.window.tabGroups.all.forEach((group, g) => {
        group.tabs.forEach((tab, i) => {
            const p = describeUri(tab.input && tab.input.uri);
            if (args.index !== undefined && args.group !== undefined) {
                if (g === args.group && i === args.index) matches.push(tab);
            } else if (args.path && p && (p.toLowerCase() === String(args.path).toLowerCase() || p.toLowerCase() === wantFsPath(args.path))) {
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
// dialog uses, and no VS Code editor window uses. Implemented with koffi, a prebuilt FFI
// that ships inside the extension: plain user32 calls, the same ones sublime-commander's
// dialog watcher uses. No PowerShell, no compiler, nothing for the user's machine to build.
let KOFFI_ERROR = null;
let koffi = null;
let user32 = null;
try {
    koffi = require('koffi');
    koffi.alias('HWND', 'uintptr_t'); // handles are pointer-sized; koffi hands them back as BigInt
    user32 = koffi.load('user32.dll');
} catch (e) { KOFFI_ERROR = String((e && e.message) || e).slice(0, 200); }

const u32 = (h) => (h === null || h === undefined) ? 0 : Number(h);
const GetTopWindow = user32 && user32.func('HWND __stdcall GetTopWindow(HWND hWnd)');
const GetWindow = user32 && user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)');
const IsWindowVisible = user32 && user32.func('bool __stdcall IsWindowVisible(HWND hWnd)');
const GetWindowThreadProcessId = user32 && user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *pid)');
const GetClassNameW = user32 && user32.func('int __stdcall GetClassNameW(HWND hWnd, _Out_ uint16_t *name, int max)');
const GetWindowTextW = user32 && user32.func('int __stdcall GetWindowTextW(HWND hWnd, _Out_ uint16_t *text, int max)');
const PostMessageW = user32 && user32.func('bool __stdcall PostMessageW(HWND hWnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');

function windowText(h, max) {
    const buf = Buffer.allocUnsafe(max * 2);
    const n = GetWindowTextW(h, buf, max);
    return n > 0 ? koffi.decode(buf, 'char16_t', n) : '';
}

function windowClass(h) {
    const buf = Buffer.allocUnsafe(256 * 2);
    const n = GetClassNameW(h, buf, 256);
    return n > 0 ? koffi.decode(buf, 'char16_t', n) : '';
}

// Buttons at ANY depth: classic dialogs keep Buttons as direct children, but Task
// Dialogs and IFileDialogs virtualize their controls inside child containers, so
// only walking direct children misses them. Depth-capped so a weird tree cannot
// spin forever.
function walkButtons(h, depth, list) {
    if (depth > 4) return;
    let c = u32(GetWindow(h, 5)); // GW_CHILD
    while (c) {
        if (windowClass(c) === 'Button') {
            const text = windowText(c, 256);
            if (text) list.push({ hwnd: c, text });
        }
        walkButtons(c, depth + 1, list);
        c = u32(GetWindow(c, 2)); // GW_HWNDNEXT
    }
}

// The main process (parent of this extension host) owns the native dialogs; this
// extension host owns none, but is included so nothing is missed.
const DIALOG_PIDS = new Set([process.ppid, process.pid].filter((p) => Number.isFinite(p)));

function enumDialogs() {
    if (!user32) return { dialogs: [], error: KOFFI_ERROR || 'user32.dll not loaded' };
    const dialogs = [];
    let h = u32(GetTopWindow(0));
    while (h) {
        const pid = [0];
        if (GetWindowThreadProcessId(h, pid) && DIALOG_PIDS.has(pid[0]) && IsWindowVisible(h)) {
            if (windowClass(h) === '#32770') {
                const buttons = [];
                walkButtons(h, 0, buttons);
                dialogs.push({ hwnd: h, pid: pid[0], title: windowText(h, 512), buttons });
            }
        }
        h = u32(GetWindow(h, 2));
    }
    return { dialogs };
}

function postMessage(h, msg, wParam) {
    PostMessageW(h, msg, u32(wParam), 0);
}

// -- OS input primitives (0.9.4) --------------------------------------------------------------
// Chromium takes input only from the system input queue, so a DOM widget with no API (a quick
// input box, a toast button) needs SendInput through user32. These are the raw primitives:
// activate_window, send_keys, click_at. Which one to use, in what order, is a caller decision.
const GetForegroundWindow = user32 && user32.func('HWND __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32 && user32.func('bool __stdcall SetForegroundWindow(HWND hWnd)');
const SwitchToThisWindow = user32 && user32.func('void __stdcall SwitchToThisWindow(HWND hWnd, bool fUnknown)');
const SendInput = user32 && user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, void *pInputs, int cbSize)');

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const SetCursorPos = user32 && user32.func('bool __stdcall SetCursorPos(int x, int y)');
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const VK = {
    enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, space: 0x20,
    backspace: 0x08, delete: 0x2E, insert: 0x2D, home: 0x24, end: 0x23,
    pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
    f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
    // Punctuation, as the VK_OEM_* codes: a chord like "ctrl+shift+-" is a real binding in
    // extensions (Jupyter Keymap's split-cell) and used to throw "unknown key name: -".
    '-': 0xBD, '=': 0xBB, plus: 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC, ';': 0xBA,
    "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF, '`': 0xC0,
    minus: 0xBD, equal: 0xBB, semicolon: 0xBA, quote: 0xDE, comma: 0xBC, period: 0xBE,
    slash: 0xBF, backslash: 0xDC, backquote: 0xC0,
};

// One INPUT record: type=KEYBOARD(1) then the KEYBDINPUT union member at offset 8. The union is
// 32 bytes on x64 (MOUSEINPUT is the widest member), so the record is 40 bytes.
function keyRecord(vk, scan, flags) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(1, 0);
    b.writeUInt16LE(vk, 8);
    b.writeUInt16LE(scan, 10);
    b.writeUInt32LE(flags, 12);
    return b;
}

function sendRecords(records) {
    const buf = Buffer.concat(records);
    return SendInput(records.length, buf, 40);
}

// One mouse INPUT: type=MOUSE(0), then MOUSEINPUT at offset 8 (dx, dy, mouseData, dwFlags).
function mouseRecord(flags) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(flags, 8 + 12);
    return b;
}

function vkOf(name) {
    const k = String(name).toLowerCase();
    if (VK[k] !== undefined) return VK[k];
    if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
    throw new Error('unknown key name: ' + name);
}

// "ctrl+shift+p" -> modifiers down, key down/up, modifiers up. "enter" -> one key.
function chordRecords(chord) {
    const parts = String(chord).split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return [];
    const key = parts.pop();
    const mods = parts.map(vkOf);
    const recs = [];
    for (const m of mods) recs.push(keyRecord(m, 0, 0));
    const vk = vkOf(key);
    recs.push(keyRecord(vk, 0, 0), keyRecord(vk, 0, KEYEVENTF_KEYUP));
    for (const m of mods.slice().reverse()) recs.push(keyRecord(m, 0, KEYEVENTF_KEYUP));
    return recs;
}

// Typed text: every character goes as a unicode key event, which is what makes arbitrary text
// (paths, names, non-ASCII) reach a DOM input regardless of the keyboard layout.
function textRecords(text) {
    const recs = [];
    for (const ch of String(text)) {
        if (ch === '\n') { recs.push(...chordRecords('enter')); continue; }
        if (ch === '\t') { recs.push(...chordRecords('tab')); continue; }
        const code = ch.codePointAt(0);
        if (code > 0xFFFF) throw new Error('character outside the BMP cannot be sent as one key event: ' + ch);
        recs.push(keyRecord(0, code, KEYEVENTF_UNICODE), keyRecord(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    return recs;
}

// Raw activation: find a top-level window whose title contains `title` and call ONE activation
// API on it - SwitchToThisWindow, the call the taskbar itself uses, because SetForegroundWindow is
// routinely refused for a process that does not own the foreground. No chain, no retry: the result
// reports the foreground window afterwards and the caller decides.
function activateWindowByTitle(title) {
    if (!user32) throw new Error('user32 unavailable: ' + (KOFFI_ERROR || 'koffi not loaded'));
    const want = String(title).toLowerCase();
    let found = null;
    let h = u32(GetTopWindow(0));
    while (h) {
        if (IsWindowVisible(h)) {
            const t = windowText(h, 512);
            if (t && t.toLowerCase().includes(want)) { found = { hwnd: h, title: t }; break; }
        }
        h = u32(GetWindow(h, 2));
    }
    if (!found) throw new Error('no visible window title contains ' + JSON.stringify(title));
    const before = u32(GetForegroundWindow());
    SwitchToThisWindow(found.hwnd, true);
    const after = u32(GetForegroundWindow());
    return {
        hwnd: found.hwnd,
        title: found.title,
        ok: after === found.hwnd,
        foreground_before: before ? windowText(before, 256) : null,
        foreground_after: after ? windowText(after, 256) : null,
    };
}

// A command that opens a modal never returns until someone answers it, and the workbench
// is blocked behind it meanwhile - awaiting it hangs the MCP call for as long as the
// dialog sits there (2026-11-12: a user was left waiting minutes on the Configure Default
// Formatter dialog). Race the dispatch against a timer; the command keeps running and
// finishes once the dialog is answered, and the caller gets the dialog list back so
// dismiss_dialog is one call away instead of a blind wait.
const COMMAND_TIMEOUT_MS = 12000;
async function dispatchCommand(id, args) {
    const running = vscode.commands.executeCommand(id, ...(args || []))
        .then((r) => ({ settled: true, result: r }))
        .catch((e) => ({ settled: true, error: String((e && e.message) || e) }));
    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS); });
    const winner = await Promise.race([running, timedOut]);
    clearTimeout(timer);
    if (!winner) {
        const d = enumDialogs();
        return {
            ok: false,
            pending: true,
            note: 'the command has not returned after ' + Math.round(COMMAND_TIMEOUT_MS / 1000) + ' s - a native dialog probably has the workbench blocked. It is still running: answer or dismiss the dialog and it continues. This call answers now instead of waiting.',
            dialogs: d.dialogs || [],
            dialogs_error: d.error,
        };
    }
    if (winner.error) throw new Error(winner.error);
    return winner.result;
}

// -- loop guard ------------------------------------------------------------------------------
// The 2026-11-13 vscode-extension-audit report: an agent installed tomoki1207.pdf, then
// repeated install_extension/reload_window/list_extensions/activate_extension/run_command
// for ~2 hours - every call looked reasonable alone, the set never progressed, and nothing
// in the tool surface could say "stop, this is a loop". The guard fingerprints every tool
// call (name + arguments); the same call failing the same way LOOP_BREAK_AFTER times inside
// LOOP_WINDOW_MS answers loop_breaker instead of running again. Success, a different
// result, or different arguments ends the streak; a pending:true result (a dialog is up -
// waiting is the point) neither counts nor clears. batch calls are guarded too: each item
// goes through the same wrapped run.
const LOOP_BREAK_AFTER = 4;
const LOOP_WINDOW_MS = 15 * 60 * 1000;
const loopState = new Map(); // name + '|' + argsKey -> { sig, streak, last }

function stableString(v) {
    if (Array.isArray(v)) return '[' + v.map(stableString).join(',') + ']';
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableString(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
}

function failureSignature(result, thrown) {
    if (thrown) return 'thrown:' + String(thrown && thrown.message || thrown).slice(0, 160);
    if (result && typeof result === 'object') {
        if (typeof result.error === 'string') return 'error:' + result.error.slice(0, 160);
        if (result.ok === false && !result.pending) {
            const shape = {};
            for (const k of Object.keys(result).sort()) {
                if (k === 'ms' || k === 'dialogs' || k === 'dialogs_error') continue;
                shape[k] = result[k] && typeof result[k] === 'object' ? '[obj]' : result[k];
            }
            return 'notok:' + stableString(shape).slice(0, 160);
        }
    }
    return null;
}

function guarded(tool) {
    if (!tool || tool.guarded) return tool;
    const inner = tool.run;
    tool.run = async (a) => {
        const args = a || {};
        const key = tool.name + '|' + stableString(args).slice(0, 500);
        const now = Date.now();
        const prior = loopState.get(key);
        const live = prior && now - prior.last <= LOOP_WINDOW_MS ? prior : null;
        if (live && live.streak >= LOOP_BREAK_AFTER) {
            return {
                loop_breaker: true,
                tool: tool.name,
                note: 'this exact call has already failed ' + live.streak + ' times in a row with the same result. '
                    + 'Repeating it cannot produce a different answer - change the approach: read the error, try a '
                    + 'different tool or command, inspect state with get_help/list_extensions/read_log, or report '
                    + 'the blocker. loop_reset({tool:"' + tool.name + '"}) clears this if the situation genuinely changed.',
                last_error: live.sig,
                streak: live.streak,
            };
        }
        let result, thrown = null;
        try { result = await inner(args); } catch (e) { thrown = e; }
        const sig = failureSignature(result, thrown);
        if (sig) {
            const streak = (live && live.sig === sig) ? live.streak + 1 : 1;
            loopState.set(key, { sig, streak, last: now });
        } else if (live) {
            // A success ends any failure streak for this exact call. A pending:true result
            // (dialog up) is a success-shaped non-failure: it neither counts nor clears.
            loopState.delete(key);
        }
        if (loopState.size > 400) {
            for (const [k, e] of loopState) if (now - e.last > LOOP_WINDOW_MS) loopState.delete(k);
        }
        if (thrown) throw thrown;
        return result;
    };
    tool.guarded = true;
    return tool;
}

function guardClear(name) {
    let n = 0;
    for (const k of Array.from(loopState.keys())) {
        if (!name || k.startsWith(name + '|')) { loopState.delete(k); n++; }
    }
    return n;
}

// PostMessage queues; the modal loop needs a beat to process the click before the
// verification re-enumeration runs (the PowerShell version got this delay for free
// from its process spawn).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANCEL_RE = /cancel|no\b|don.?t save|close|discard/i;

// Observed behaviour of VS Code commands, recorded by tools/probe_vscode_commands.js on a
// disposable profile and shipped beside the extension. When present, each generated command
// tool's description gains an "Observed on VS Code ..." line (the sublime-commander pattern).
let COMMAND_BEHAVIOR = null;
try { COMMAND_BEHAVIOR = JSON.parse(fs.readFileSync(path.join(__dirname, 'commands_behavior.json'), 'utf8')); } catch (e) {}

const TOOLS = [
    {
        name: 'get_help',
        description: 'Describes this server and its tools, and the gaps compared with sublime-mcp. Also reports what tools/list presents and what stays callable behind discover, plus pid, started_at and uptime_ms so a client can tell a restarted extension host from the one it was talking to before reload_window:',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const listed = listedTools();
            return {
                server: 'vscode-mcp ' + VERSION,
                pid: process.pid,
                started_at: STARTED_AT,
                uptime_ms: Date.now() - STARTED_AT,
                vscode: vscode.version,
                instance: instanceInfo(),
                what: 'Runs inside the VS Code extension host. Every VS Code command is reachable; discover finds them.',
                surface: {
                    listed: listed.map(t => t.name),
                    listed_count: listed.length,
                    hidden_count: TOOLS.length - listed.length,
                    generated_count: TOOLS.filter(t => t.generated).length,
                    expose_all_tools: exposeAllTools(),
                    why: 'tools/list presents only the core tools. The rest are callable by name through batch, found with discover - a full list would be thousands of tool schemas in the client context before the first message, which a limited-context model cannot afford (and cannot compact around).',
                },
                loop_guard: 'Every tool call is fingerprinted; the same call failing identically ' + LOOP_BREAK_AFTER + ' times inside 15 minutes answers loop_breaker instead of running again. Change approach, or call loop_reset({tool}) once the situation has genuinely changed.',
                gaps: [
                    'No tool reads or *picks items* in a quick pick opened by another extension (API limit). Quick picks are drivable: workbench.action.quickOpen + quickOpenSelectNext/accept/closeQuickOpen (see README and self_test).',
                    'No screenshots from inside the extension host (use external tool).',
                    'Cannot read *content* of other extensions\' output channels (API limit). Drive showOutputChannels; use read_log for host logs.',
                ],
                tools_hand_written: TOOLS.filter(t => !t.generated).map(t => t.name),
                tools_count: TOOLS.length,
                generated: 'Every VS Code command is a GENERATED tool, one per command id. discover({"query":"<words>"}) finds one; run it with {"args": [...]} exactly like run_command, through batch.',
            };
        },
    },
    {
        name: 'lm_tools',
        description: 'Lists the language-model tools contributed in this window, straight from vscode.lm.tools: name, tags and description, optionally filtered by a substring of the name. Read-only, and the lister for lm_tool. Every extension that contributes languageModelTools in its package.json appears here, which is how those tools can be tested without an AI client in the window.',
        inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'case-insensitive substring of the tool name' }, limit: { type: 'number' } } },
        run: async (a) => {
            const lm = vscode.lm;
            if (!lm || !Array.isArray(lm.tools)) throw new Error('vscode.lm.tools is unavailable in this build');
            const f = a && a.filter ? String(a.filter).toLowerCase() : '';
            const all = lm.tools.filter((t) => !f || String(t.name).toLowerCase().includes(f));
            return {
                count: all.length,
                tools: all.slice(0, (a && a.limit) || 100).map((t) => ({
                    name: t.name,
                    tags: Array.from(t.tags || []),
                    description: t.description || '',
                })),
            };
        },
    },
    {
        name: 'lm_tool',
        description: 'Invokes one language-model tool by name through vscode.lm.invokeTool and returns its content parts as text. This is the only way to exercise a tool an extension contributes as a languageModelTool when the window has no AI client: no chat participant is needed, and the call is the same one a model would make. A consent prompt may appear on the first call - answer it with list_dialogs and dismiss_dialog. Pair with lm_tools to see what exists.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'exact tool name from lm_tools' },
                input: { type: 'object', description: 'the tool input object; omit for tools that take none' },
            },
            required: ['name'],
        },
        run: async (a) => {
            const lm = vscode.lm;
            if (!lm || typeof lm.invokeTool !== 'function') throw new Error('vscode.lm.invokeTool is unavailable in this build');
            const cts = new vscode.CancellationTokenSource();
            try {
                const res = await lm.invokeTool(a.name, { input: a.input || {} }, cts.token);
                const parts = Array.isArray(res && res.content) ? res.content : [];
                const text = parts.map((p) => {
                    if (p && typeof p.value === 'string') return p.value;
                    if (p && p.value != null) return JSON.stringify(p.value);
                    return JSON.stringify(p);
                }).join('\n');
                return { name: a.name, parts: parts.length, text };
            } finally {
                cts.dispose();
            }
        },
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
            // A single argument is common (workbench.action.quickOpen "file"), and JSON callers
            // send it as a string: wrap it instead of failing on .map (2026-11-15: "(a.args || []).map
            // is not a function" made every one-argument command look unsupported).
            const rawArgs = a.args === undefined || a.args === null ? [] : (Array.isArray(a.args) ? a.args : [a.args]);
            const result = await dispatchCommand(a.command, rawArgs.map(reviveArg));
            if (result && typeof result === 'object' && result.pending) return result;
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
        description: 'Opens a file the way a click does (vscode.open, so workbench.editorAssociations and files.associations apply - a .ipynb becomes a Notebook Editor) and reports which editor came up. Falls back to the text editor only if the resource has no other editor. Optionally places the cursor at a 0-based line.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const uri = fileUri(a.path);
            // showTextDocument always forces the text editor, which is why a notebook used to
            // arrive as JSON (2026-11-15). vscode.open goes through the same resolution as a
            // double-click, so the association decides.
            await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
            for (let i = 0; i < 30; i++) {
                const activeNb = vscode.window.activeNotebookEditor;
                if (activeNb && activeNb.notebook.uri.toString() === uri.toString()) {
                    return { ok: true, path: describeUri(uri), editor: 'notebook', cells: activeNb.notebook.cellCount };
                }
                const activeText = vscode.window.activeTextEditor;
                if (activeText && activeText.document.uri.toString() === uri.toString()) break;
                await sleep(100);
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (a.line !== undefined) {
                const p = posOf(doc, a.line, a.character || 0);
                ed.selection = new vscode.Selection(p, p);
                ed.revealRange(new vscode.Range(p, p));
            }
            return { ok: true, path: describeUri(uri), editor: 'text' };
        },
    },
    {
        name: 'notebook_open',
        description: 'Opens a notebook file in the Notebook Editor (never the text editor) and waits for the document, returning the cell count. Throws when the file resolves to no notebook type, which is the signal that the editor association is missing.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async (a) => {
            const doc = await notebookDocument(a.path);
            return { ok: true, path: describeUri(doc.uri), editor: 'notebook', cells: doc.cellCount };
        },
    },
    {
        name: 'notebook_cells',
        description: 'Lists the cells of a notebook: index, kind, language, source (capped) and the execution summary after a run.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, max: { type: 'number' }, outputs: { type: 'boolean' } }, required: ['path'] },
        run: async (a) => {
            const doc = await notebookDocument(a.path);
            return doc.getCells().map((c, i) => ({
                index: i,
                kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
                language: c.document.languageId,
                source: cap(c.document.getText(), a.max || 400),
                order: c.executionSummary ? c.executionSummary.executionOrder : null,
                success: c.executionSummary ? c.executionSummary.success : null,
                outputs: a.outputs ? cellOutputs(c) : undefined,
            }));
        },
    },
    {
        name: 'notebook_set_cell',
        description: 'Replaces the source of one cell (0-based index) and saves the notebook: the way to put code into a notebook, since a cell is not a text editor tab.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'number' }, source: { type: 'string' } }, required: ['path', 'index', 'source'] },
        run: async (a) => {
            const doc = await notebookDocument(a.path);
            const cells = doc.getCells();
            const i = Number(a.index);
            if (!(i >= 0 && i < cells.length)) throw new Error('index out of range: ' + i + ' of ' + cells.length);
            const edit = new vscode.WorkspaceEdit();
            edit.set(doc.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(i, i + 1), [new vscode.NotebookCellData(cells[i].kind, String(a.source), cells[i].document.languageId)])]);
            const ok = await vscode.workspace.applyEdit(edit);
            await doc.save();
            return { ok, index: i, cells: doc.cellCount };
        },
    },
    {
        name: 'notebook_execute',
        description: 'Runs cells of a notebook and waits for the run to settle (all cells when indices is omitted), returning per-cell execution order, success and captured text output. The kernel comes from whichever editor extension provides it (ms-python.python for Python).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, indices: { type: 'array' }, timeout_ms: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const doc = await notebookDocument(a.path);
            let editor = vscode.window.activeNotebookEditor;
            if (!editor || editor.notebook.uri.toString() !== doc.uri.toString()) {
                editor = await showNotebook(doc);
                await sleep(300);
            }
            const indices = Array.isArray(a.indices) && a.indices.length ? a.indices.map(Number) : doc.getCells().map((c, i) => i);
            const perCellMs = a.timeout_ms || 30000;
            const results = [];
            // One cell per command: a single execute with several ranges runs them in PARALLEL
            // (both got execution order 1 on 2026-11-15, so cell 2 saw no state from cell 1).
            // Awaiting each cell reproduces what Run All does and keeps the notebook's own
            // ordering guarantee.
            for (const i of indices) {
                const before = doc.getCells()[i];
                const beforeOrder = before && before.executionSummary ? before.executionSummary.executionOrder : 0;
                if (editor) editor.selection = new vscode.NotebookRange(i, i + 1);
                await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [new vscode.NotebookRange(i, i + 1)], document: doc.uri });
                const deadline = Date.now() + perCellMs;
                let cells = doc.getCells();
                const ran = () => cells[i] && cells[i].executionSummary && cells[i].executionSummary.executionOrder > beforeOrder;
                while (!ran() && Date.now() < deadline) { await sleep(150); cells = doc.getCells(); }
                const cell = cells[i];
                results.push({
                    index: i,
                    order: cell && cell.executionSummary ? cell.executionSummary.executionOrder : null,
                    success: cell && cell.executionSummary ? cell.executionSummary.success : null,
                    outputs: cell ? cellOutputs(cell) : null,
                });
            }
            await doc.save();
            return { ok: true, ran: indices.length, settled: results.every((r) => r.order !== null), cells: results };
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
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === vscode.Uri.file(String(a.path)).fsPath.toLowerCase());
            if (!doc) throw new Error('file is not open');
            return { ok: await doc.save() };
        },
    },
    {
        name: 'create_file',
        description: 'Creates a text file (and its folders) with the given content. Refuses to replace an existing file unless overwrite is true. If the file is already open in an editor, the write goes through the document so an unsaved buffer cannot shadow it (a disk write under a dirty buffer is how "create then open" used to show the OLD text). Writes to disk directly when the file is not open; open it afterwards with open_file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } }, required: ['path'] },
        run: async (a) => {
            if (!path.isAbsolute(String(a.path))) throw new Error('path must be absolute');
            const uri = fileUri(a.path);
            const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            let exists = true;
            try { await vscode.workspace.fs.stat(uri); } catch (e) { exists = false; }
            if (exists && !a.overwrite && !open) throw new Error('file exists; pass overwrite:true to replace it');
            if (open) {
                // Route through the document: a dirty buffer would otherwise keep serving the
                // old text to get_text/get_active_file/expect after the disk write.
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), open.lineAt(open.lineCount - 1).range.end), String(a.content || ''));
                const okEdit = await vscode.workspace.applyEdit(edit);
                if (!okEdit) throw new Error('applyEdit failed');
                return { ok: true, path: describeUri(uri), bytes: Buffer.byteLength(String(a.content || ''), 'utf8'), replaced: exists, via: 'document' };
            }
            await vscode.workspace.fs.createDirectory(fileUri(path.dirname(String(a.path))));
            const bytes = Buffer.from(String(a.content || ''), 'utf8');
            await vscode.workspace.fs.writeFile(uri, bytes);
            return { ok: true, path: describeUri(uri), bytes: bytes.length, replaced: exists, via: 'disk' };
        },
    },
    {
        name: 'complete',
        description: 'Completions at a position (path, 0-based line and character), without the 20000-character cap of run_command: returns total, then at most limit (default 50) items as label, description, kind, detail, insert. filter is a case-insensitive regular expression on the label and kind is a CompletionItemKind filter (e.g. "Snippet"), both applied before the limit - so a snippet pack can be listed in one call even where the provider offers thousands of other items. trigger is an optional trigger character.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, character: { type: 'number' }, filter: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' }, trigger: { type: 'string' } }, required: ['path'] },
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
            if (a.kind) { const k = String(a.kind).toLowerCase(); items = items.filter((i) => String(i.kind || '').toLowerCase() === k); }
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
        name: 'insert_snippet',
        description: 'Inserts a snippet the way editor.action.insertSnippet does - by name with langId, or literal text - into the active editor, then answers with the result: matches/first_difference when expect is given, else chars (and text with include_text). revert:true reverts the document afterwards so the next insert starts from the file on disk. One call per snippet instead of insert + get_text + revert.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                text: { type: 'string' },
                langId: { type: 'string' },
                expect: { type: 'string' },
                revert: { type: 'boolean' },
                include_text: { type: 'boolean' },
            },
        },
        run: async (a) => {
            if (!a.name && a.text === undefined) throw new Error('give name or text');
            if (!vscode.window.activeTextEditor) throw new Error('no active editor');
            const arg = a.text !== undefined ? { snippet: a.text } : (a.langId ? { name: a.name, langId: a.langId } : { name: a.name });
            const before = vscode.window.activeTextEditor.document.getText();
            await vscode.commands.executeCommand('editor.action.insertSnippet', arg);
            const doc = vscode.window.activeTextEditor.document;
            const got = doc.getText();
            const norm = (x) => String(x).replace(/\r\n/g, '\n');
            const out = { ok: true, chars: got.length, changed: got !== before };
            if (a.expect !== undefined) {
                if (norm(got) === norm(a.expect)) out.matches = true;
                else {
                    out.matches = false;
                    const e = norm(a.expect).split('\n'), g = norm(got).split('\n');
                    let i = 0;
                    while (i < e.length && i < g.length && e[i] === g[i]) i++;
                    out.first_difference = { line: i, expected: e[i], actual: g[i] };
                }
            }
            if (a.include_text) out.text = cap(got);
            if (a.revert) await vscode.commands.executeCommand('workbench.action.files.revert');
            return out;
        },
    },
    {
        name: 'verify_snippets',
        description: 'Runs a list of snippet assertions in ONE call, generically. For each item it inserts the snippet twice into the active editor - once BY NAME (the registered snippet) and once from its BODY text - reads both results and compares them, so the check is "does the registered snippet expand to its manifest body", with no expansion model on the client side. expect may be given instead of body for a fixed string. Reverts between steps when revert is true (default). Returns total/pass/fail and the failures in detail.',
        inputSchema: {
            type: 'object',
            properties: {
                langId: { type: 'string' },
                items: { type: 'array', items: { type: 'object' } },
                revert: { type: 'boolean' },
                stop_on_failure: { type: 'boolean' },
                max_failures: { type: 'number' },
            },
            required: ['items'],
        },
        run: async (a) => {
            if (!vscode.window.activeTextEditor) throw new Error('no active editor');
            const norm = (x) => String(x).replace(/\r\n/g, '\n');
            const read = async (arg) => {
                await vscode.commands.executeCommand('editor.action.insertSnippet', arg);
                const t = vscode.window.activeTextEditor.document.getText();
                if (a.revert !== false) await vscode.commands.executeCommand('workbench.action.files.revert');
                return t;
            };
            const results = [];
            let pass = 0, fail = 0;
            const maxFail = Math.max(1, Number(a.max_failures) || 20);
            for (let i = 0; i < a.items.length; i++) {
                const it = a.items[i] || {};
                const label = it.name !== undefined ? it.name : ('#' + i);
                try {
                    const byName = await read(a.langId ? { name: it.name, langId: a.langId } : { name: it.name });
                    let wanted;
                    if (it.body !== undefined) {
                        const body = Array.isArray(it.body) ? it.body.join('\n') : String(it.body);
                        wanted = await read({ snippet: body });
                    } else if (it.expect !== undefined) {
                        wanted = it.expect;
                    } else { throw new Error('item needs body or expect'); }
                    if (norm(byName) === norm(wanted)) { pass++; continue; }
                    fail++;
                    const e = norm(wanted).split('\n'), g = norm(byName).split('\n');
                    let k = 0;
                    while (k < e.length && k < g.length && e[k] === g[k]) k++;
                    if (results.length < maxFail) results.push({ index: i, name: label, first_difference: { line: k, manifest: e[k], registered: g[k] } });
                } catch (e) {
                    fail++;
                    if (results.length < maxFail) results.push({ index: i, name: label, error: String((e && e.message) || e).slice(0, 200) });
                }
                if (fail && a.stop_on_failure) break;
            }
            return { total: a.items.length, pass, fail, failures: results };
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
        name: 'set_selection',
        description: 'Puts the cursor in a file at a 0-based line and character, or selects a range with end_line/end_character, and makes that editor the active one. Commands that act on the selection or the cursor - Go: Add Tags, Generate Interface Stubs, Test Function At Cursor, format selection - need this: nothing else in the surface can move the cursor.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                line: { type: 'number' },
                character: { type: 'number' },
                end_line: { type: 'number', description: 'omit for a collapsed cursor' },
                end_character: { type: 'number' },
                reveal: { type: 'boolean', description: 'default true; scroll the position into view' },
            },
            required: ['path', 'line'],
        },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const start = posOf(doc, a.line, a.character || 0);
            if (a.end_line === undefined) {
                const sel = new vscode.Selection(start, start);
                const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: sel });
                ed.selection = sel;
                if (a.reveal !== false) ed.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                return { ok: true, path: a.path, line: start.line, character: start.character, selection: [ed.selection.start.line, ed.selection.start.character, ed.selection.end.line, ed.selection.end.character] };
            }
            const end = posOf(doc, a.end_line, a.end_character || 0);
            const sel = new vscode.Selection(start, end);
            const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: sel });
            ed.selection = sel;
            if (a.reveal !== false) ed.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            return { ok: true, path: a.path, line: start.line, character: start.character, selection: [ed.selection.start.line, ed.selection.start.character, ed.selection.end.line, ed.selection.end.character] };
        },
    },
    {
        name: 'discover',
        description: 'Finds tools. Give query (case-insensitive regular expression over name, VS Code command id and description) to search the whole catalogue - including the thousands of generated command tools, one per VS Code command - or category to browse it (omit both for the top-level map). Each hit carries its inputSchema, so the next call is right the first time. Run a hit through batch, even for one call: batch({"calls":[{"tool":"<name>","arguments":{...}}]}). This is how a thousand-tool surface stays usable in a small context: never scroll a list, search it.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Regular expression, e.g. "fold" or "git.*commit".' },
                category: { type: 'string', description: 'A path from the map: "hand-written", or a command-id prefix such as "workbench" / "workbench/action".' },
                limit: { type: 'number', description: 'default 30 for a query, 40 for a category; max 200' },
                include_schema: { type: 'boolean', description: 'default true' },
            },
        },
        run: async (a) => {
            const isQuery = a.category === undefined && a.query !== undefined && String(a.query).trim() !== '';
            const limit = Math.max(1, Math.min(Number(a.limit) || (isQuery ? 30 : 40), 200));
            const includeSchema = a.include_schema !== false;
            if (!isQuery) return discoverByCategory(a.category, limit, includeSchema);
            return findTools(String(a.query).trim(), limit, includeSchema);
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
        description: 'Runs several tool calls in order in ONE request and returns one result per call: calls is a list of {tool, arguments} or {sleep: milliseconds}. Runs ANY tool by name, including the thousands that tools/list does not present, so it is also the way to call what discover just found. Stops at the first error unless keep_going is true. Saves the round trip of every step of a test (create, open, edit, complete, diagnostics).',
        inputSchema: { type: 'object', properties: { calls: { type: 'array', items: { type: 'object' } }, keep_going: { type: 'boolean' } }, required: ['calls'] },
        run: async (a) => {
            const results = [];
            const calls = a.calls || [];
            for (let i = 0; i < calls.length; i++) {
                const c = calls[i];
                if (c && typeof c.sleep === 'number') { await new Promise((r) => setTimeout(r, Math.min(c.sleep, 30000))); results.push({ slept: c.sleep }); continue; }
                const tool = TOOLS.find((t) => t.name === (c && c.tool));
                if (!tool || tool.name === 'batch') { results.push({ error: 'cannot batch tool ' + (c && c.tool) }); if (!a.keep_going) break; continue; }
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
        description: 'Reloads the VS Code window (workbench.action.reloadWindow). Answers first; the reload follows about half a second later and the server restarts, so the next call has to wait for the new host. Place it last in a batch - anything after it does not run.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            setTimeout(() => { vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 500);
            return { ok: true, note: 'reloading in about 0.5 s; reconnect after a few seconds' };
        },
    },
    {
        name: 'send_keys',
        description: 'Sends keystrokes to whatever window currently has the keyboard focus, through the OS input queue (user32 SendInput). text goes as unicode key events (any layout, \\n = Enter, \\t = Tab); keys is a list of named chords ("enter", "tab", "escape", "ctrl+shift+p", "f1"). Pass window (a title substring) to make it fail closed: the foreground window is re-read immediately before every keystroke and the call throws, sending nothing further, when a focus steal put another window in front. Without window it types wherever focus is - only for a window you just activated and own.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                keys: { type: ['string', 'array'], items: { type: 'string' } },
                interval_ms: { type: 'number' },
                window: { type: 'string', description: 'Title substring the foreground window must match before every keystroke; a mismatch throws instead of typing elsewhere.' },
            },
        },
        run: async (a) => {
            if (!user32 || !SendInput) throw new Error('user32/SendInput unavailable: ' + (KOFFI_ERROR || 'koffi not loaded'));
            const keys = Array.isArray(a.keys) ? a.keys : (a.keys ? [String(a.keys)] : []);
            if (!a.text && !keys.length) throw new Error('give text, keys, or both');
            const want = a.window ? String(a.window).toLowerCase() : null;
            // The guard: Chromium routes OS input to the foreground window, so a focus steal between
            // activate_window and the keys types into whatever the person brought forward. Re-read the
            // foreground before EVERY record batch and throw before sending anything else (2026-11-15:
            // "JDD" and "j" landed in the user's own terminal when this was checked only afterwards).
            const guard = () => {
                if (!want) return;
                const h = u32(GetForegroundWindow());
                const title = h ? windowText(h, 256) : null;
                if (!title || !title.toLowerCase().includes(want)) {
                    throw new Error('refused: foreground window is "' + (title || '(none)') + '", not matching "' + a.window + '" - nothing was sent');
                }
            };
            const gap = Math.max(0, Math.min(Number(a.interval_ms) || 0, 1000));
            const before = u32(GetForegroundWindow());
            let chars = 0;
            let chords = 0;
            if (a.text) {
                guard();
                const recs = textRecords(a.text);
                const accepted = sendRecords(recs);
                if (accepted !== recs.length) throw new Error('SendInput accepted ' + accepted + ' of ' + recs.length + ' records');
                chars = String(a.text).length;
                if (gap) await new Promise((r) => setTimeout(r, gap));
            }
            for (const k of keys) {
                guard();
                // A modifier and its letter in ONE SendInput batch arrives with the modifier still
                // unseen, so Chromium dispatches the keydown with shiftKey=false and an uppercase
                // binding ("B", "J", "D D") never matches - measured 2026-11-15 on Jupyter Keymap:
                // j/k/l fired, shift+j/shift+b/shift+d did not, shift+enter (a named key) did.
                // Send the modifier state, let the input queue drain, then the key.
                const parts = String(k).split('+').map((p) => p.trim()).filter(Boolean);
                const keyName = parts.pop();
                const modVks = parts.map(vkOf);
                for (const m of modVks) { guard(); sendRecords([keyRecord(m, 0, 0)]); }
                if (modVks.length) await new Promise((r) => setTimeout(r, 40));
                guard();
                sendRecords(chordRecords(keyName));
                if (modVks.length) {
                    await new Promise((r) => setTimeout(r, 30));
                    guard();
                    for (const m of modVks.slice().reverse()) sendRecords([keyRecord(m, 0, KEYEVENTF_KEYUP)]);
                }
                chords++;
                if (gap) await new Promise((r) => setTimeout(r, gap));
            }
            const after = u32(GetForegroundWindow());
            return {
                ok: true,
                chars,
                chords,
                foreground_before: before ? windowText(before, 256) : null,
                foreground_after: after ? windowText(after, 256) : null,
            };
        },
    },
    {
        name: 'activate_window',
        description: 'Brings the first visible window whose title contains `title` to the foreground with one user32 activation call (SwitchToThisWindow) and reports the foreground window afterwards. Alone it decides nothing: check ok before sending input anywhere.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        run: async (a) => activateWindowByTitle(a.title),
    },
    {
        name: 'click_at',
        description: 'Moves the pointer to a screen position and clicks (user32 SetCursorPos + SendInput). No window logic, no focus change: x and y are absolute screen pixels. button is "left" (default) or "right"; count repeats the click.',
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                button: { type: 'string' },
                count: { type: 'number' },
            },
            required: ['x', 'y'],
        },
        run: async (a) => {
            if (!user32 || !SetCursorPos) throw new Error('user32 unavailable: ' + (KOFFI_ERROR || 'koffi not loaded'));
            const sx = Math.round(Number(a.x));
            const sy = Math.round(Number(a.y));
            const right = String(a.button || 'left').toLowerCase() === 'right';
            const down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
            const up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
            const count = Math.min(Math.max(Number(a.count) || 1, 1), 5);
            if (!SetCursorPos(sx, sy)) throw new Error('SetCursorPos refused ' + sx + ',' + sy);
            for (let i = 0; i < count; i++) {
                sendRecords([mouseRecord(down), mouseRecord(up)]);
                if (i + 1 < count) await new Promise((r) => setTimeout(r, 80));
            }
            return { ok: true, x: sx, y: sy, button: right ? 'right' : 'left', count };
        },
    },

    {
        name: 'run_shell',
        description: 'Runs one shell command (cmd.exe /d /s /c on Windows, /bin/sh -c elsewhere) in the workspace folder and returns exit code, stdout and stderr in the same call: the way to read a program\'s effects (files it wrote, exit codes, a server it started) without opening a terminal or a second shell. Pipelines and redirects work because it is a real shell; timeout default 60 s, output capped at 20000 characters.',
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'number' } },
            required: ['command'],
        },
        run: (a) => new Promise((resolve) => {
            const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const cwd = a.cwd ? path.resolve(String(a.cwd)) : (root ? root.uri.fsPath : process.cwd());
            const timeout = Math.min(Math.max(Number(a.timeout_ms) || 60000, 1000), 600000);
            const win = process.platform === 'win32';
            const exe = win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
            const args = win ? ['/d', '/s', '/c', String(a.command)] : ['-c', String(a.command)];
            const t0 = Date.now();
            execFile(exe, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                const code = err && typeof err.code === 'number' ? err.code : (err ? null : 0);
                resolve({
                    ok: !err,
                    code,
                    timed_out: !!(err && (err.killed || err.signal)),
                    ms: Date.now() - t0,
                    cwd,
                    stdout: cap(String(stdout || '')),
                    stderr: cap(String(stderr || '')),
                    error: err && typeof err.code !== 'number' ? String(err.message || err).slice(0, 400) : undefined,
                });
            });
        }),
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
        name: 'self_test',
        description: 'Runs a battery of checks against the running VS Code build and this server: version and command count, create_file/get_text/replace_text/expect round trip, open_file/get_active_file, save_file/close_file, run_command dispatch, completions, list_dialogs (the FFI dialog layer), get_diagnostics and a nested batch. Run it after a VS Code update: one call says which capabilities still work, instead of a wrong assumption surfacing halfway through a test round.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const by = new Map(TOOLS.map((t) => [t.name, t]));
            const dir = path.join(os.tmpdir(), 'vscode-mcp-self-test-' + process.pid);
            const f = path.join(dir, 'probe.txt');
            const js = path.join(dir, 'probe.js');
            const checks = [];
            const must = (cond, what) => { if (!cond) throw new Error(what); };
            const check = async (name, fn) => {
                const t0 = Date.now();
                try {
                    const detail = await fn();
                    checks.push({ name, ok: true, ms: Date.now() - t0, detail });
                } catch (e) {
                    checks.push({ name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) });
                }
            };
            await check('version', async () => {
                const cmds = await vscode.commands.getCommands(true);
                must(cmds.length > 500, 'only ' + cmds.length + ' commands');
                return vscode.version + ', ' + cmds.length + ' commands';
            });
            await check('default_surface', async () => {
                // The regression guard for the context bomb: a client must never be handed the
                // whole catalogue, and a tool it was NOT handed must still run through batch.
                const list = await handleRpc({ id: 1, method: 'tools/list' });
                const names = list.result.tools.map((t) => t.name);
                must(names.length > 0 && names.length <= DEFAULT_TOOL_NAMES.length,
                    'tools/list presents ' + names.length + ' tools');
                must(names.includes('batch') && names.includes('discover'), 'discover and batch must be listed');
                const d = await by.get('discover').run({ query: 'selectAll', limit: 5 });
                must(d && d.tools && d.tools.length > 0, 'discover found no selectAll tool');
                const hit = d.tools[0];
                must(hit.inputSchema, 'discover returned no inputSchema');
                must(names.indexOf(hit.name) < 0, 'the probe tool is already listed; pick a hidden one');
                const r = await by.get('batch').run({ calls: [{ tool: hit.name, arguments: {} }] });
                must(Array.isArray(r) && r[0] && !r[0].error,
                    'batch could not run a discovered tool: ' + JSON.stringify(r).slice(0, 160));
                return names.length + ' listed, ' + TOOLS.length + ' callable';
            });
            await check('create_file', async () => {
                const r = await by.get('create_file').run({ path: f, content: 'one two three', overwrite: true });
                must(r && r.ok, 'create_file failed: ' + JSON.stringify(r));
                return r.bytes + ' bytes';
            });
            await check('get_text', async () => {
                const r = await by.get('get_text').run({ path: f });
                must(r && r.text === 'one two three', 'text mismatch: ' + JSON.stringify(r && r.text));
                return 'round trip';
            });
            await check('replace_text + expect', async () => {
                await by.get('replace_text').run({ path: f, old_string: 'one', new_string: 'zero' });
                const r = await by.get('expect').run({ path: f, equals: 'zero two three' });
                must(r && r.ok, 'expect failed: ' + JSON.stringify(r && r.first_difference));
                return 'pass';
            });
            await check('open_file + get_active_file', async () => {
                await by.get('open_file').run({ path: f });
                await sleep(200);
                const r = await by.get('get_active_file').run({ max: 1 });
                must(r && r.path && r.path.toLowerCase().endsWith('probe.txt'), 'wrong active file: ' + (r && r.path));
                return r.language;
            });
            await check('save_file', async () => {
                const r = await by.get('save_file').run({ path: f });
                must(r && typeof r.ok === 'boolean', 'save_file did not answer: ' + JSON.stringify(r));
                return r.ok ? 'saved' : 'not dirty';
            });
            await check('run_command', async () => {
                const r = await by.get('run_command').run({ command: 'editor.action.selectAll' });
                must(r && !r.pending && r.ok, 'run_command failed: ' + JSON.stringify(r).slice(0, 160));
                return 'dispatched';
            });
            await check('complete', async () => {
                await by.get('create_file').run({ path: js, content: 'const v = 1;\n', overwrite: true });
                await by.get('open_file').run({ path: js, line: 0, character: 6 });
                await sleep(300);
                const r = await by.get('complete').run({ path: js, line: 0, character: 6, limit: 5 });
                must(r && Array.isArray(r.items), 'no completion items array: ' + JSON.stringify(r).slice(0, 160));
                return r.items.length + ' items';
            });
            await check('list_dialogs', async () => {
                const r = await by.get('list_dialogs').run({});
                must(r && Array.isArray(r.dialogs) && !r.error, 'list_dialogs failed: ' + JSON.stringify(r).slice(0, 160));
                return r.dialogs.length + ' open';
            });
            await check('get_diagnostics', async () => {
                const r = await by.get('get_diagnostics').run({ path: f });
                must(Array.isArray(r), 'diagnostics not an array: ' + JSON.stringify(r).slice(0, 160));
                return r.length + ' diagnostics';
            });
            await check('quick_pick_drive', async () => {
                // Drive a quick open picker using standard commands (items themselves are not readable via API - known gap)
                await by.get('run_command').run({ command: 'workbench.action.quickOpen' });
                await sleep(400);
                await by.get('run_command').run({ command: 'workbench.action.quickOpenSelectNext' });
                await by.get('run_command').run({ command: 'workbench.action.closeQuickOpen' });
                return 'opened, navigated, closed';
            });
            await check('output_channel_show', async () => {
                // Drive showing output channels (content of other extensions' channels remains unreadable via API - known gap)
                await by.get('run_command').run({ command: 'workbench.action.showOutputChannels' });
                await sleep(300);
                await by.get('run_command').run({ command: 'workbench.action.closeQuickOpen' }); // in case it opened as picker
                return 'show driven';
            });
            await check('batch', async () => {
                const r = await by.get('batch').run({ calls: [{ tool: 'get_help', arguments: {} }] });
                must(Array.isArray(r) && r.length === 1 && r[0] && r[0].server, 'batch failed: ' + JSON.stringify(r).slice(0, 160));
                return 'nested call ok';
            });
            await check('loop_guard', async () => {
                // The 2026-11-13 report: an agent repeated a failing call for hours because
                // nothing in the surface could say stop. run_command THROWS on an unknown
                // command (the MCP layer turns that into isError), so the check collects
                // thrown errors as the failures they are; the guard must still trip on the
                // 4th identical one and loop_reset must clear it.
                const bad = { command: 'vscode-mcp.selftest.no-such-command' };
                const attempt = async () => {
                    try { return await by.get('run_command').run(bad); }
                    catch (e) { return { thrown: String((e && e.message) || e) }; }
                };
                let last;
                for (let i = 0; i < 5; i++) last = await attempt();
                must(last && last.loop_breaker === true, '5th identical failure did not trip the guard: ' + JSON.stringify(last).slice(0, 160));
                const cleared = await by.get('loop_reset').run({ tool: 'run_command' });
                must(cleared && cleared.ok, 'loop_reset failed: ' + JSON.stringify(cleared));
                const again = await attempt();
                must(again && !again.loop_breaker, 'guard still tripped after loop_reset');
                await by.get('loop_reset').run({});
                return 'tripped, reset clears';
            });
            await check('close + cleanup', async () => {
                try { await by.get('close_file').run({ path: js, discard: true }); } catch (e) {}
                try { await by.get('close_file').run({ path: f, discard: true }); } catch (e) {}
                try { await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true }); } catch (e) {}
                return 'fixtures removed';
            });
            const failed = checks.filter((c) => !c.ok);
            return {
                vscode: vscode.version,
                pass: checks.length - failed.length,
                fail: failed.length,
                checks,
                note: failed.length
                    ? 'a failed check names the capability that changed with this editor build'
                    : 'all capabilities present',
            };
        },
    },
    {
        name: 'list_dialogs',
        description: 'Lists the native OS dialogs (class #32770) of this VS Code instance: hwnd, title and the labelled buttons of each (buttons are walked at every child depth, but Task Dialogs and file pickers virtualize their controls, so buttons may be empty even when the dialog has them). This is the tool for "a dialog is up and nothing answers": file open/save dialogs, confirmations and message boxes of the editor itself. Empty list means no native dialog is up (workbench quick picks and input boxes are NOT visible to any API - they are recorded as a gap). Instant: a direct user32 walk through the extension\'s bundled FFI (koffi), no PowerShell and no compiler involved.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const r = enumDialogs();
            return r;
        },
    },
    {
        name: 'dismiss_dialog',
        description: 'Closes a native dialog of this VS Code instance, cancel-first: clicks the button matching cancel_re (default /cancel|no|don.t save|close|discard/i) when one is visible, otherwise posts WM_COMMAND IDCANCEL (the dialog\'s own cancel press), then WM_CLOSE (on Task Dialogs WM_CLOSE IS cancel). Verifies the close by re-enumerating and reports dismissed/still_up, so no second list_dialogs call is needed. hwnd defaults to the first dialog from list_dialogs. Workbench quick picks and input boxes are not native dialogs - they are unreachable.',
        inputSchema: { type: 'object', properties: { hwnd: { type: 'number' }, cancel_re: { type: 'string' }, button: { type: 'string', description: 'Label or /regex/ of the button to press instead of cancelling. When given, no cancel fallback is used: an unknown label is an error listing the buttons, so a confirmation dialog is never answered by accident.' } } },
        run: async (a) => {
            const enumOut = enumDialogs();
            if (enumOut.error) return { ok: false, error: enumOut.error };
            const dialogs = enumOut.dialogs;
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
            // Cancel-first ladder, safest press available:
            //   1. a labelled button matching cancel_re (BM_CLICK),
            //   2. WM_COMMAND IDCANCEL (the dialog's own cancel press - works on
            //      classic dialogs whose buttons are virtualized and invisible),
            //   3. WM_CLOSE (on Task Dialogs this IS cancel).
            // Then re-enumerate once and report whether it really went away, so the
            // caller does not need a second list_dialogs round trip.
            const cancel = (dlg.buttons || []).find((b) => re.test(b.text || ''));
            const WM_COMMAND_IDCANCEL = 0x0111, IDCANCEL = 2, WM_CLOSE = 0x0010, BM_CLICK = 0x00F5;
            let via;
            if (a.button) {
                // An explicit button replaces the whole cancel ladder: a caller that names
                // "Install" or "Save" means it, and answering with Cancel instead is a silent
                // wrong action (2026-11-15: the ipykernel prompt's Install could not be pressed).
                const label = String(a.button);
                // Win32 labels carry an ampersand before the mnemonic ("Do&n't Save") and use
                // typographic apostrophes; neither is part of what the caller means. Compare on
                // letters and digits only, and keep the /regex/ form for anything unusual.
                const flat = (s) => String(s || '').replace(/&/g, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
                const exact = /^\/.*\/[a-z]*$/i.test(label) ? new RegExp(label.slice(1, label.lastIndexOf('/')), label.slice(label.lastIndexOf('/') + 1) || 'i') : null;
                const hit = exact
                    ? (dlg.buttons || []).find((b) => exact.test(String(b.text || '')))
                    : (dlg.buttons || []).find((b) => flat(b.text) === flat(label));
                const loose = hit || (dlg.buttons || []).find((b) => flat(b.text).includes(flat(label)));
                if (!loose) return { ok: false, error: 'no button matching ' + label, buttons: (dlg.buttons || []).map((b) => b.text), hwnd: dlg.hwnd };
                postMessage(loose.hwnd, BM_CLICK);
                await sleep(200);
                const afterNamed = enumDialogs().dialogs;
                const stillNamed = afterNamed.some((d) => d.hwnd === dlg.hwnd);
                return { ok: !stillNamed, via: 'button: ' + loose.text, hwnd: dlg.hwnd, dismissed: !stillNamed, still_up: stillNamed, note: stillNamed ? 'dialog is still up - the button may open another dialog' : undefined };
            }
            if (cancel) {
                postMessage(cancel.hwnd, BM_CLICK);
                via = 'button: ' + cancel.text;
            } else {
                postMessage(dlg.hwnd, WM_COMMAND_IDCANCEL, IDCANCEL);
                via = 'WM_COMMAND(IDCANCEL)';
                postMessage(dlg.hwnd, WM_CLOSE);
            }
            await sleep(200);
            const after = enumDialogs().dialogs;
            const still = after.some((d) => d.hwnd === dlg.hwnd);
            return { ok: !still, via, hwnd: dlg.hwnd, dismissed: !still, still_up: still, note: still ? 'dialog is still up - it may belong to a command that keeps raising it' : undefined };
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
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, description: 'Several ids installed by ONE CLI process (much faster than one call each); results holds ok and version per id.' }, vsix: { type: 'string', description: 'Absolute path to a .vsix on disk (e.g. the file a triage download already produced). Takes precedence over id/ids.' }, remote: { type: 'string', description: 'Install into a remote target instead of this machine, as the CLI knows it: "wsl+Ubuntu", "ssh-remote+host". The extension then runs in the remote extension host, which is the only way a remote window gets it.' } } },
        run: async (a) => {
            const remoteArgs = a.remote ? ['--remote', String(a.remote)] : [];
            if (a.vsix) {
                const p = String(a.vsix);
                const out = await runCli(['--install-extension', p, '--force', ...remoteArgs]);
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
        name: 'instances',
        description: 'Every VS Code window running vscode-mcp on this machine, from a registry each instance writes to the temp folder (pid, port, VSCode version, workspace folders) - including windows this client is not mounted on, such as a plain second window or a remote WSL/SSH window whose extension host runs elsewhere. Pass the port, "pid:<n>" or a workspace-folder substring as {"window": ...} to ANY tool call and it runs in that window instead of this one; the answer comes back through this server.',
        inputSchema: { type: 'object', properties: { probe: { type: 'boolean', description: 'default true: POST initialize to each foreign port to prove it answers' } } },
        run: async (a) => {
            const mine = selfEntry();
            const others = liveEntries().filter(e => e.pid !== process.pid).map(e => ({ ...e, self: false }));
            if (a.probe !== false) {
                for (const e of others) {
                    const probe = await probeInstance(e.port);
                    e.reachable = probe.reachable;
                    if (!probe.reachable) e.reason = probe.reason;
                    else if (probe.workspace_folders) e.folders = probe.workspace_folders;
                }
            }
            return {
                self: mine,
                others,
                count: 1 + others.length,
                registry_dir: registryDir(),
                usage: '{"window": <port | "pid:<n>" | folder substring>} on any tool call, including inside batch',
            };
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
    {
        name: 'loop_reset',
        description: 'Clears the loop guard\'s failure streaks so a tool that kept failing can be tried again after the situation changed (an extension finished installing, a dialog was answered, a reload happened). Without a tool name every streak is cleared. The guard itself is not a failure: it fires only after the same call fails identically LOOP_BREAK_AFTER times inside 15 minutes, and the loop_breaker result names loop_reset as the way through.',
        inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'clear only this tool\'s streaks' } } },
        run: async (a) => ({ ok: true, cleared: guardClear(a && a.tool) }),
    },

    // -- debugging ---------------------------------------------------------------------------
    // A debugger is otherwise untestable through the API: breakpoints live in the workbench and
    // the stack, scopes and variables live behind DAP, and everything else is a tree view. These
    // five tools reach all of it without focus, keystrokes or captures.
    {
        name: 'debug_state',
        description: 'The active debug session (id, type, name) and, with details, its threads and the top stack frames - read through DAP customRequest, so no Variables or Call Stack view is involved. Without a session it says so and reports how many breakpoints are held.',
        inputSchema: { type: 'object', properties: { details: { type: 'boolean', description: 'also ask the adapter for threads and stack frames' }, thread: { type: 'number', description: 'threadId to read the stack of (default: the first thread)' }, levels: { type: 'number', description: 'stack frames to ask for (default 20)' } } },
        run: async (a) => {
            const s = vscode.debug.activeDebugSession;
            const bps = breakpointList();
            if (!s) return { active: false, breakpoints: bps };
            const out = { active: true, id: s.id, type: s.type, name: s.name, breakpoints: bps };
            if (!a.details) return out;
            try {
                const threads = await s.customRequest('threads');
                out.threads = (threads && threads.threads) || [];
                const id = a.thread != null ? a.thread : (out.threads[0] && out.threads[0].id);
                if (id != null) {
                    const stack = await s.customRequest('stackTrace', { threadId: id, startFrame: 0, levels: a.levels || 20 });
                    out.stack = (stack && stack.stackFrames || []).map((f) => ({ id: f.id, name: f.name, line: f.line, path: f.source && f.source.path }));
                }
            } catch (e) {
                out.error = String((e && e.message) || e);
            }
            return out;
        },
    },
    {
        name: 'debug_request',
        description: 'Sends one DAP request to the active debug session and returns the adapter\'s answer: continue, next, stepIn, stepOut, pause, stackTrace, scopes, variables, evaluate, setVariable, setBreakpoints, exceptionInfo, ... This is how a debugger is driven and read: it is the same channel the Debug view uses, with no UI.',
        inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'the DAP request name, e.g. "next" or "variables"' }, args: { type: 'object', description: 'the request arguments, e.g. {"threadId":1} or {"threadId":1,"frameId":2}' } }, required: ['request'] },
        run: async (a) => {
            const s = vscode.debug.activeDebugSession;
            if (!s) throw new Error('no active debug session');
            const r = await s.customRequest(String(a.request), a.args || {});
            return r === undefined ? { ok: true, request: a.request } : r;
        },
    },
    {
        name: 'breakpoints',
        description: 'Lists the breakpoints the workbench holds: path and line (0-based) for source breakpoints, plus enabled, condition, hitCondition and logMessage. Verified/unverified state is the adapter\'s answer to setBreakpoints, asked separately or read from debug_request.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => breakpointList(),
    },
    {
        name: 'set_breakpoints',
        description: 'Creates source breakpoints through vscode.debug.addBreakpoints - no editor focus, no keypress. items: [{path, line (0-based), enabled?, condition?, hitCondition?, logMessage?}]. An existing breakpoint at the same path and line is replaced, so the same call is idempotent. Returns the resulting list.',
        inputSchema: { type: 'object', properties: { items: { type: 'array', description: 'breakpoints to create', items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, enabled: { type: 'boolean' }, condition: { type: 'string' }, hitCondition: { type: 'string' }, logMessage: { type: 'string' } }, required: ['path', 'line'] } } }, required: ['items'] },
        run: async (a) => {
            if (!a.items || !a.items.length) throw new Error('give items');
            const made = [];
            for (const it of a.items) {
                const uri = fileUri(String(it.path));
                const line = Math.max(0, parseInt(it.line, 10) || 0);
                const stale = vscode.debug.breakpoints.filter((b) => b.location && b.location.uri.toString() === uri.toString() && b.location.range.start.line === line);
                if (stale.length) vscode.debug.removeBreakpoints(stale);
                made.push(new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line, 0)), it.enabled !== false, it.condition, it.hitCondition, it.logMessage));
            }
            vscode.debug.addBreakpoints(made);
            return { ok: true, added: made.length, breakpoints: breakpointList() };
        },
    },
    {
        name: 'clear_breakpoints',
        description: 'Removes every breakpoint, or only the source breakpoints in one path. Returns what is left.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'remove only breakpoints in this file' } } },
        run: async (a) => {
            const all = vscode.debug.breakpoints;
            let gone = all;
            if (a.path) {
                const want = fileUri(String(a.path)).toString();
                gone = all.filter((b) => b.location && b.location.uri.toString() === want);
            }
            if (gone.length) vscode.debug.removeBreakpoints(gone);
            return { ok: true, removed: gone.length, breakpoints: breakpointList() };
        },
    },
];

// Every tool accepts the cross-window selector that handleRpc acts on, so it must be DECLARED in
// the schema: a client validates arguments against the schema and drops what is not declared (the
// first version of the forwarding looked broken - {"window": 9561} was silently stripped and the
// call ran locally, answering with this instance's pid).
const WINDOW_PROP = {
    type: ['string', 'number'],
    description: 'run this call in another VS Code window: its port, "pid:<n>", a workspace-folder substring, or host:port. instances lists them. Omit to run it here.',
};

function declareWindowParam(tools) {
    for (const t of tools) {
        if (!t.inputSchema) t.inputSchema = { type: 'object', properties: {} };
        if (!t.inputSchema.properties) t.inputSchema.properties = {};
        if (!t.inputSchema.properties.window) t.inputSchema.properties.window = WINDOW_PROP;
    }
}

declareWindowParam(TOOLS);

// -- the default tool surface ----------------------------------------------------------------
// tools/list answers with this list and nothing else. Every other tool - the rest of the
// hand-written ones and every generated VS Code command tool (thousands of them) - stays
// callable by name, found with discover. Presenting all of them costs a whole context window
// before the first message (2824 generated tools on VS Code 1.144, each an object with a
// schema) and leaves a limited-context client no room to compact: the 2026-11-13 report was a
// session that hit 100% as soon as this server connected and could not compact while it was.
// sublime-commander's default surface is the pattern being followed: a dozen tools in the list,
// the rest behind one discovery tool, called through batch.
//
// A client that refuses a tool it was not told about does not need vscodeMcp.exposeAllTools:
// batch IS listed and takes any tool name, so a discovered tool always has a way in. The
// setting exists only for a client whose batch-style call is itself unusable.
const DEFAULT_TOOL_NAMES = [
    'get_help',
    'discover',
    'batch',
    'run_command',
    'get_open_files',
    'get_active_file',
    'get_text',
    'open_file',
    'notebook_open',
    'notebook_cells',
    'notebook_set_cell',
    'notebook_execute',
    'create_file',
    'replace_text',
    'save_file',
    'expect',
    // The host restart, and the two OS input primitives. A client whose only surface is
    // tools/list has no other way to reach them, and no API covers what they do.
    'reload_window',
    'activate_window',
    'send_keys',
    'loop_reset',
];

function exposeAllTools() {
    try { return vscode.workspace.getConfiguration('vscodeMcp').get('exposeAllTools', false) === true; } catch (e) { return false; }
}

// The tools tools/list presents, in DEFAULT_TOOL_NAMES order. Never throws and never returns
// an empty list: a surface that forgot its own entry points is worse than a big one.
function listedTools() {
    if (exposeAllTools()) return TOOLS.slice();
    const out = [];
    for (const name of DEFAULT_TOOL_NAMES) {
        const tool = TOOLS.find((t) => t.name === name);
        if (tool) out.push(tool);
    }
    return out;
}

function toolListing(tool) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    };
}

const SURFACE_USAGE = 'Call a discovered tool through batch, even for a single call: '
    + 'batch({"calls":[{"tool":"<name>","arguments":{...}}]}). discover returns each hit\'s inputSchema, so the call is right the first time.';

// -- discovery -------------------------------------------------------------------------------
// The catalogue is one flat list of a few thousand tools; browsing it as a tree is what keeps
// it navigable without a query. Two families: 'hand-written' (the tools written for this
// server) and one category per leading command-id segment ('workbench', 'editor', 'git', ...),
// descending a dot at a time ('workbench/action', 'workbench/action/files').

const DISCOVER_DESCRIPTION_CHARS = 200;
const MAP_CATEGORIES = 24;

function hitOf(tool, includeSchema) {
    const text = String(tool.description || '');
    const hit = {
        name: tool.name,
        description: text.length > DISCOVER_DESCRIPTION_CHARS
            ? text.slice(0, DISCOVER_DESCRIPTION_CHARS) + '...'
            : text,
        generated: !!tool.generated,
    };
    if (tool.commandId) hit.command = tool.commandId;
    if (includeSchema) hit.inputSchema = tool.inputSchema || { type: 'object', properties: {} };
    return hit;
}

function commandSegments(tool) {
    return tool.generated ? String(tool.commandId || '').split('.') : [];
}

// Tools whose command id starts with every segment of `parts` (exactly or followed by a dot).
function commandToolsUnder(parts) {
    return TOOLS.filter((tool) => {
        const segs = commandSegments(tool);
        if (segs.length < parts.length) return false;
        for (let i = 0; i < parts.length; i++) if (segs[i] !== parts[i]) return false;
        return true;
    });
}

function catalogMap() {
    const written = TOOLS.filter((t) => !t.generated).length;
    const counts = new Map();
    for (const tool of TOOLS) {
        const segs = commandSegments(tool);
        if (!segs.length || !segs[0]) continue;
        counts.set(segs[0], (counts.get(segs[0]) || 0) + 1);
    }
    // A machine with many extensions contributes a namespace each; the biggest few are the map,
    // and a query is the way to reach the rest. A map of 200 namespaces would cost more context
    // than it saves.
    const ordered = Array.from(counts).sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]));
    const shown = ordered.slice(0, MAP_CATEGORIES);
    const categories = [{
        path: 'hand-written',
        tools: written,
        description: 'the tools written for this server: files, tabs, text, commands, dialogs, tests',
    }];
    for (const [seg, n] of shown) {
        categories.push({ path: seg, tools: n, description: 'generated command tools whose command id starts with ' + seg + '.' });
    }
    return {
        total: TOOLS.length,
        hand_written: written,
        generated: TOOLS.length - written,
        categories,
        namespaces_omitted: ordered.length - shown.length,
        usage: 'discover({"category":"<path>"}) lists a category and descends with "/" (e.g. workbench/action); '
             + 'discover({"query":"<words>"}) searches every tool, generated ones included. ' + SURFACE_USAGE,
    };
}

function discoverByCategory(pathText, limit, includeSchema) {
    const parts = String(pathText || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return catalogMap();
    if (parts[0] === 'hand-written') {
        if (parts.length > 1) return { error: 'unknown category ' + pathText, categories: ['hand-written'] };
        const written = TOOLS.filter((t) => !t.generated);
        return {
            path: 'hand-written',
            total: written.length,
            tools: written.slice(0, limit).map((t) => hitOf(t, includeSchema)),
            usage: SURFACE_USAGE,
        };
    }
    const under = commandToolsUnder(parts);
    if (!under.length) return { error: 'no command tools under ' + pathText, map: catalogMap().categories };
    const subs = new Map();
    const direct = [];
    for (const tool of under) {
        const segs = commandSegments(tool);
        // A command id is namespace.area...commandName: the LAST segment is the command, so a
        // tool sits directly at this path when only that one segment follows it
        // (workbench.action.showCommands is direct at workbench/action;
        // workbench.action.files.save is one level deeper, at workbench/action/files).
        if (segs.length === parts.length + 1) direct.push(tool);
        else subs.set(segs[parts.length], (subs.get(segs[parts.length]) || 0) + 1);
    }
    const out = { path: parts.join('/'), total: under.length };
    if (subs.size) {
        out.subcategories = Array.from(subs, ([seg, n]) => ({ path: parts.join('/') + '/' + seg, tools: n }))
            .sort((x, y) => (y.tools - x.tools) || x.path.localeCompare(y.path));
    }
    const shown = direct.slice(0, limit);
    if (shown.length) out.tools = shown.map((t) => hitOf(t, includeSchema));
    if (direct.length > shown.length) out.shown = shown.length;
    out.usage = subs.size
        ? 'descend into a subcategory path, or search with discover({"query":"<words>"}). ' + SURFACE_USAGE
        : SURFACE_USAGE;
    return out;
}

// A query hit scores by where it matched: a whole segment of the tool name (the `fold` of
// `editor_fold`) beats a segment that starts with it (`foldAll`), which beats a substring
// (`addRootFolder`), which beats the description - and the command id counts the same way, one
// tier lower. Without that, a one-word query is decided alphabetically across 2800 tools, and
// `addRootFolder` comes before `editor_fold`.
function findTools(queryText, limit, includeSchema) {
    let re;
    let exactSegment;
    try {
        re = new RegExp(queryText, 'i');
        exactSegment = new RegExp('^(?:' + queryText + ')$', 'i');
    } catch (e) { throw new Error('bad query regular expression: ' + e.message); }
    const qLower = queryText.toLowerCase();
    const tiers = (text, whole, prefix, any) => {
        if (!text) return 0;
        let best = re.test(text) ? any : 0;
        for (const seg of String(text).split(/[._]/)) {
            if (!seg) continue;
            if (exactSegment.test(seg)) best = Math.max(best, whole);
            else if (seg.toLowerCase().startsWith(qLower)) best = Math.max(best, prefix);
        }
        return best;
    };
    const scored = [];
    for (const tool of TOOLS) {
        const score = tiers(tool.name, 80, 60, 30)
            + tiers(String(tool.commandId || ''), 40, 30, 15)
            + (re.test(String(tool.description || '')) ? 3 : 0);
        if (score) scored.push({ score, tool });
    }
    scored.sort((x, y) => (y.score - x.score)
        || (x.tool.name.length - y.tool.name.length)
        || x.tool.name.localeCompare(y.tool.name));
    const tools = scored.slice(0, limit).map((entry) => hitOf(entry.tool, includeSchema));
    return {
        query: queryText,
        total: scored.length,
        shown: tools.length,
        tools,
        hint: scored.length > tools.length ? 'narrow the query, or raise limit (max 200)' : undefined,
        usage: SURFACE_USAGE,
    };
}

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
            serverInfo: { name: 'vscode-mcp', version: VERSION, instance: instanceInfo() },
            instructions: 'Call get_help first. Discovery-first surface: tools/list presents only the '
                + DEFAULT_TOOL_NAMES.length + ' core tools; every other tool (and the thousands of generated VS Code '
                + 'command tools, one per command id) is hidden from the list but callable. Find one with '
                + 'discover({"query":"<words>"}) or discover({"category":"<path>"}), then run it through '
                + 'batch({"calls":[{"tool":"<name>","arguments":{...}}]}) even for a single call. '
                + 'Close tabs by name, path or group+index only.',
        });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
        return ok(id, { tools: listedTools().map(toolListing), ttlMs: 0, cacheScope: 'private' });
    }
    if (method === 'tools/call') {
        const name = params && params.name;
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) {
            return rpcError(id, -32602, 'unknown tool ' + name + ' - find it with discover({"query":"<words>"}) or '
                + 'discover({"category":"hand-written"}), then call it through batch');
        }
        // A call may name another window: run it there instead. The forwarded copy carries no window
        // argument, so it cannot bounce back and forth.
        const rawArgs = (params && params.arguments) || {};
        if (rawArgs.window !== undefined && rawArgs.window !== null) {
            const target = instanceFor(rawArgs.window);
            if (!target) {
                // Not in the registry: a window whose registry this process cannot see - a remote
                // extension host in WSL or on another machine. A port or host:port is enough to try.
                const spec = String(rawArgs.window).trim();
                const m = /^(?:https?:\/\/)?([A-Za-z0-9_.-]+):(\d+)$/.exec(spec) || /^(\d+)$/.exec(spec);
                const rest0 = { ...rawArgs };
                delete rest0.window;
                if (m) {
                    const host = m[2] === undefined ? '127.0.0.1' : m[1];
                    const port = Number(m[2] === undefined ? m[1] : m[2]);
                    return forwardTo({ port, host }, { ...msg, params: { ...params, arguments: rest0 } });
                }
                return rpcError(id, -32602, 'no window matches ' + JSON.stringify(rawArgs.window)
                    + ' - call instances to list the windows this machine has, or give a port or host:port');
            }
            const rest = { ...rawArgs };
            delete rest.window;
            if (!target.self) return forwardTo(target, { ...msg, params: { ...params, arguments: rest } });
            params.arguments = rest;
        }
        // Dispatch is by name over the whole catalogue, not over the presented list: a tool that
        // discover found must run whether or not the client was told about it.
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

// When the configured port is already bound, find out WHO holds it before reporting:
// another VS Code window running this extension answers initialize with its own
// instance block (pid, workspace folders), which is exactly the collision the audit
// hit when three instances shared 127.0.0.1:9560.
function describePortSquatter(port, bind, output) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vscode-mcp-selfcheck', version: '0' } } });
    const req = http.request({ host: bind === '0.0.0.0' ? '127.0.0.1' : bind, port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1500 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
            try {
                const reply = JSON.parse(data);
                const inst = reply && reply.result && reply.result.serverInfo && reply.result.serverInfo.instance;
                output.appendLine('port ' + port + ' is held by another vscode-mcp instance'
                    + (inst ? ' pid=' + inst.pid + ' vscode=' + inst.vscode + ' folders=' + JSON.stringify(inst.workspace_folders) : ' (answered initialize but carried no instance block)'));
            } catch (e) {
                output.appendLine('port ' + port + ' is already bound by a non-vscode-mcp process');
            }
        });
    });
    req.on('timeout', () => { req.destroy(); output.appendLine('port ' + port + ' is already bound (probe timed out)'); });
    req.on('error', () => output.appendLine('port ' + port + ' is already bound'));
    req.end(body);
}

function startServer(output) {
    const config = vscode.workspace.getConfiguration('vscodeMcp');
    const wanted = Number(config.get('port', 9560)) || 9560;
    const fallback = config.get('portFallback', true) !== false;
    const candidates = fallback ? Array.from({ length: 21 }, (_, i) => wanted + i) : [wanted];
    let attempt = 0;
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
    const tryListen = () => {
        const port = candidates[attempt];
        srv.listen(port, bind, () => {
            boundPort = port;
            registerSelf();
            output.appendLine('listening on http://' + bind + ':' + port + '/mcp'
                + (port !== wanted ? ' (configured ' + wanted + ' was taken; ' + process.pid + ' took the next free one)' : ''));
            statusItem.text = '$(plug) MCP ' + port;
            statusItem.tooltip = 'vscode-mcp listening on http://' + bind + ':' + port + '/mcp (pid ' + process.pid + ')';
        });
    };
    srv.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < candidates.length - 1) {
            attempt++;
            tryListen();
            return;
        }
        boundPort = null;
        output.appendLine('server error: ' + e.message);
        statusItem.text = '$(error) MCP';
        const detail = e.code === 'EADDRINUSE'
            ? ' - every port from ' + candidates[0] + ' to ' + candidates[candidates.length - 1] + ' is taken; close a window or set vscodeMcp.port'
            : '';
        statusItem.tooltip = 'vscode-mcp: ' + e.message + detail;
        if (e.code === 'EADDRINUSE') describePortSquatter(candidates[attempt], bind, output);
    });
    tryListen();
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
                const result = await dispatchCommand(id, args);
                if (result && typeof result === 'object' && result.pending) return result;
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
        declareWindowParam(gen);
        for (const t of TOOLS) guarded(t);
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
    boundPort = null;
    unregisterSelf();
}

// handleRpc and TOOLS are exported so a plain Node process can drive the protocol without a
// VS Code window (tools/test_surface.js stubs the vscode module), and so self_test can assert the
// presented surface. They are not part of the extension API.
module.exports = { activate, deactivate, handleRpc, TOOLS, DEFAULT_TOOL_NAMES, listedTools, guarded, guardClear, loopState };
