'use strict';
// vscode-mcp: an MCP server inside VS Code's extension host. It exposes the
// editor's own commands, tabs, text and extensions to an agent, the way
// sublime-mcp does for Sublime Text. Plain JavaScript, no dependencies.
const vscode = require('vscode');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const VERSION = '0.1.0';
const MAX_TEXT = 20000;
const MAX_BODY = 4 * 1024 * 1024;

let server = null;
let statusItem = null;

function cap(text, limit) {
    const n = limit || MAX_TEXT;
    return text.length > n ? text.slice(0, n) + '\n[truncated, ' + text.length + ' characters in all]' : text;
}

function fileUri(p) {
    return vscode.Uri.file(p);
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
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [cli, '--ms-enable-electron-run-as-node', ...cliArgs],
            { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), timeout: 5 * 60 * 1000, windowsHide: true },
            (err, stdout, stderr) => {
                const text = String(stdout || '') + String(stderr || '');
                if (err && !text) reject(err); else resolve(text);
            });
    });
}

const TOOLS = [
    {
        name: 'get_help',
        description: 'Describes this server and its tools, and the gaps compared with sublime-mcp.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({
            server: 'vscode-mcp ' + VERSION,
            vscode: vscode.version,
            what: 'Runs inside the VS Code extension host. Every VS Code command is reachable with run_command; list_commands finds them.',
            gaps: [
                'No tool reads or picks items in a quick pick opened by another extension (the API does not expose it).',
                'No screenshots from inside the extension host; use an external screenshot tool.',
                'Output channels of other extensions cannot be read through the API.',
            ],
            tools: TOOLS.map(t => t.name),
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
        description: 'Runs a VS Code command by id with optional arguments, like choosing it from the command palette. Returns the command result (JSON) or an error.',
        inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array' } }, required: ['command'] },
        run: async (a) => {
            const result = await vscode.commands.executeCommand(a.command, ...(a.args || []));
            return { ok: true, result: result === undefined ? null : result };
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
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' } }, required: ['path'] },
        run: async (a) => {
            const doc = await vscode.workspace.openTextDocument(fileUri(a.path));
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (a.line !== undefined) {
                const p = posOf(doc, a.line, 0);
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
        name: 'close_file',
        description: 'Closes ONE tab chosen by path, name (label) or group+index. Never closes "the active tab". Refuses a dirty tab unless discard is true.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, group: { type: 'number' }, index: { type: 'number' }, discard: { type: 'boolean' } } },
        run: async (a) => {
            if (!a.path && !a.name && a.index === undefined) throw new Error('give path, name, or group and index');
            const tab = findTab(a);
            if (tab.isDirty && !a.discard) throw new Error('tab has unsaved changes; save it or pass discard:true');
            const label = tab.label;
            const ok = await vscode.window.tabGroups.close(tab, true);
            return { ok, closed: label };
        },
    },
    {
        name: 'get_diagnostics',
        description: 'Problems (errors, warnings) for a file, or for all files when path is omitted.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        run: async (a) => {
            const sev = ['error', 'warning', 'info', 'hint'];
            const shape = (uri, list) => list.map(d => ({ path: describeUri(uri), line: d.range.start.line, severity: sev[d.severity], source: d.source, message: d.message }));
            if (a.path) return shape(fileUri(a.path), vscode.languages.getDiagnostics(fileUri(a.path)));
            const out = [];
            for (const [uri, list] of vscode.languages.getDiagnostics()) out.push(...shape(uri, list));
            return out.slice(0, 200);
        },
    },
    {
        name: 'list_extensions',
        description: 'Lists installed extensions (id, version, active, builtin), optionally filtered by id substring. Built-in ones are hidden unless builtin is true.',
        inputSchema: { type: 'object', properties: { filter: { type: 'string' }, builtin: { type: 'boolean' } } },
        run: async (a) => {
            const f = a.filter ? String(a.filter).toLowerCase() : '';
            return vscode.extensions.all.map(extInfo)
                .filter(e => (a.builtin || !e.builtin) && e.id.toLowerCase().includes(f));
        },
    },
    {
        name: 'install_extension',
        description: 'Installs an extension from the marketplace by id (publisher.name) with VS Code\'s own CLI. The command "workbench.extensions.installExtension" is not used: it opens a "Do you trust the publisher?" dialog that nothing can answer. The running window may list the new extension only after a reload (run_command workbench.action.reloadWindow).',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async (a) => {
            const out = await runCli(['--install-extension', a.id, '--force']);
            return { ok: /successfully installed/i.test(out), cli: out.trim(), visible_now: !!vscode.extensions.getExtension(a.id) };
        },
    },
    {
        name: 'uninstall_extension',
        description: 'Uninstalls an extension by id with VS Code\'s own CLI. The running window may keep it listed until a reload.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async (a) => {
            const out = await runCli(['--uninstall-extension', a.id]);
            return { ok: /successfully uninstalled/i.test(out), cli: out.trim(), still_listed: !!vscode.extensions.getExtension(a.id) };
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
            return ok(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
        } catch (e) {
            return ok(id, { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] });
        }
    }
    if (id === undefined || id === null) return null; // a notification needs no answer
    return rpcError(id, -32601, 'method not found: ' + method);
}

function startServer(output) {
    const port = vscode.workspace.getConfiguration('vscodeMcp').get('port', 9560);
    const srv = http.createServer((req, res) => {
        // Loopback only, and no browser pages: a page on the web must not be able to drive the editor.
        const host = String(req.headers.host || '');
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.headers.origin) {
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
    srv.listen(port, '127.0.0.1', () => {
        output.appendLine('listening on http://127.0.0.1:' + port + '/mcp');
        statusItem.text = '$(plug) MCP ' + port;
        statusItem.tooltip = 'vscode-mcp listening on http://127.0.0.1:' + port + '/mcp';
    });
    return srv;
}

function activate(context) {
    const output = vscode.window.createOutputChannel('VS Code MCP');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    statusItem.show();
    server = startServer(output);
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
