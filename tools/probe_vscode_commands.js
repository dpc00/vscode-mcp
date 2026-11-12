'use strict';
// Probe every generated VS Code command tool once, with no arguments, and record what
// each one does. This is the vscode-mcp counterpart of sublime-commander's
// tools/probe_st_commands.py. The results land in commands_behavior.json (the file the
// extension loads at activation to append "Observed on VS Code ..." notes to tool
// descriptions) and tools/vscode_commands_probe_raw.json (the full log).
//
// The probe is resumable: commands already recorded are skipped unless --redo. It runs
// for --budget milliseconds (default 90000) or until the list is exhausted, then exits,
// so a caller can run it in foreground chunks. Nothing here is a session script; it is
// repo tooling that drives the MCP server over its HTTP endpoint.
//
// *** NEVER RUN THIS against Donald's working editor. *** (Donald, 2026-11-12: run against
// the portable, it flooded his machine with VS Code instances, ~60 dialogs, 13+ browser
// tabs and a VS Code zip download, continuing after he said stop.) Wholesale probes of
// editor commands run ONLY on a disposable throwaway profile (--user-data-dir +
// --extensions-dir pointing at empty temp folders), in small supervised chunks, with him
// told before each chunk. This script must refuse to run until that guard exists.
//
// Usage: node tools/probe_vscode_commands.js [--budget 90000] [--redo] [--timeout 5000]

const fs = require('fs');
const path = require('path');

const SERVER = process.env.VSCODE_MCP_URL || 'http://127.0.0.1:9560/mcp';
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'tools', 'vscode_commands_probe_raw.json');
const FINAL = path.join(ROOT, 'commands_behavior.json');

const args = process.argv.slice(2);
const budgetMs = Number((args.find((a, i) => args[i - 1] === '--budget') || 90000));
const callTimeout = Number((args.find((a, i) => args[i - 1] === '--timeout') || 5000));
const redo = args.includes('--redo');

// Window lifecycle and dialog families are skipped, and recorded as skipped, because
// they would end the window or block on a native dialog the probe cannot answer.
const SKIP = /reloadWindow|quit|closeWindow|closeFolder|closeWorkspace|restart|vscodeMcp\.|prompt|saveAs|installExtension|installExtensions|installFromVSIX|openUrl|openReleaseNotes|issueReporter|processExplorer|survey|twitter|feedback|extension\.bisect\.|openFolder|openFileFolder|addFolder/i;

let callId = 0;

async function rpc(method, params, timeoutMs) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++callId, method, params: params || {} });
    const res = await fetch(SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs || 30000),
    });
    if (!res.ok && res.status !== 202) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!text) return null;
    const reply = JSON.parse(text);
    if (reply.error) throw new Error(reply.error.message || 'rpc error');
    return reply.result;
}

async function callTool(name, argsObj, timeoutMs) {
    const started = Date.now();
    try {
        const result = await rpc('tools/call', { name, arguments: argsObj || {} }, timeoutMs);
        const ms = Date.now() - started;
        if (result && result.isError) {
            return { outcome: 'error', ms, detail: String(result.content[0].text).slice(0, 140) };
        }
        const text = result && result.content && result.content[0] ? String(result.content[0].text) : 'null';
        return { outcome: 'ok', ms, detail: text.slice(0, 140) };
    } catch (e) {
        const ms = Date.now() - started;
        const msg = String((e && e.message) || e);
        if (/timed out|aborted|TimeoutError/i.test(msg)) return { outcome: 'timeout', ms, detail: 'no answer in ' + timeoutMs + ' ms (may open a dialog or need arguments)' };
        return { outcome: 'error', ms, detail: msg.slice(0, 140) };
    }
}

// Dialog guard: the 2026-11-12 disaster came from commands that raise native dialogs and
// nobody answered them. After timeouts and every N commands, look; if a dialog of this
// instance is up, record it against the command being probed and cancel it (the safe
// answer - never OK on an unread dialog).
async function dialogSweep(currentId) {
    const seen = await callTool('list_dialogs', {}, 25000);
    let dialogs = [];
    try { dialogs = JSON.parse(seen.detail || '[]'); } catch (e) { return { cleared: false }; }
    if (!Array.isArray(dialogs) || !dialogs.length) return { cleared: true, dialogs: 0 };
    for (const d of dialogs) {
        await callTool('dismiss_dialog', { hwnd: d.hwnd }, 25000);
        raw.push({ command: currentId, tool: 'dismiss_dialog', outcome: 'dialog', ms: 0, detail: 'cancelled native dialog: ' + (d.title || '(untitled)'), at: new Date().toISOString() });
    }
    if (currentId && behavior.commands[currentId]) {
        behavior.commands[currentId].note = (behavior.commands[currentId].note ? behavior.commands[currentId].note + '; ' : '') + 'opens a native dialog (cancelled by the guard)';
        behavior.commands[currentId].outcome = 'opens_dialog';
    }
    return { cleared: true, dialogs: dialogs.length };
}

async function main() {
    // Guard: refuse to probe a profile that looks like a real working editor. The probe
    // must run against a disposable profile (empty extensions dir, throwaway user data).
    const help = await rpc('tools/call', { name: 'get_help', arguments: {} });
    const helpValue = JSON.parse(help.content[0].text);
    const folders = await rpc('tools/call', { name: 'get_workspace_folders', arguments: {} });
    const folderList = JSON.parse(folders.content[0].text);
    if (!/tmp|temp|sandbox|throwaway|disposable/i.test(folderList.join(' '))) {
        console.error('REFUSED: the workspace is not a disposable folder. Run this probe only against a throwaway profile (fresh --user-data-dir and --extensions-dir). Donald, 2026-11-12: never again against a working editor.');
        process.exit(1);
    }
    const started = Date.now();
    const handWritten = new Set(helpValue.tools_hand_written || []);
    const list = await rpc('tools/list', {});
    const targets = (list.tools || [])
        .map((t) => t.name)
        .filter((name) => !handWritten.has(name));

    // The generated wrappers carry the real command id in their description.
    const idOf = new Map();
    for (const t of (list.tools || [])) {
        const m = /VS Code command `([^`]+)`/.exec(t.description || '');
        if (m) idOf.set(t.name, m[1]);
    }

    const behavior = fs.existsSync(FINAL)
        ? JSON.parse(fs.readFileSync(FINAL, 'utf8'))
        : { vscode: helpValue.vscode, probed_at: new Date().toISOString(), counts: {}, commands: {} };
    behavior.vscode = helpValue.vscode;

    let raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : [];
    const done = new Set(Object.keys(behavior.commands).filter((k) => !behavior.commands[k].skipped));

    const queue = targets.filter((name) => {
        const id = idOf.get(name) || name;
        if (SKIP.test(id)) return false;
        if (!redo && done.has(id)) return false;
        return true;
    });

    const skippedCount = targets.length - queue.length;
    for (const name of targets) {
        const id = idOf.get(name) || name;
        if (SKIP.test(id) && !behavior.commands[id]) {
            behavior.commands[id] = { outcome: 'skipped', note: 'not probed: window lifecycle or dialog family' };
        }
    }

    console.log('generated tools: ' + targets.length + ', already recorded: ' + done.size + ', skipped families: ' + skippedCount + ', to probe this run: up to ' + queue.length);

    let probed = 0;
    for (const name of queue) {
        if (Date.now() - started > budgetMs) { console.log('budget reached after ' + probed + ' commands'); break; }
        const id = idOf.get(name) || name;
        const r = await callTool(name, { args: [] }, callTimeout);
        behavior.commands[id] = {
            outcome: r.outcome,
            ms: r.ms,
            note: r.outcome === 'ok'
                ? (r.detail === 'null' ? '' : 'returns: ' + r.detail)
                : (r.outcome === 'timeout' ? r.detail : 'error: ' + r.detail),
        };
        raw.push({ command: id, tool: name, outcome: r.outcome, ms: r.ms, detail: r.detail, at: new Date().toISOString() });
        probed++;
        if (r.outcome === 'timeout' || r.outcome === 'error') await dialogSweep(id);
        else if (probed % 20 === 0) await dialogSweep(null);
        if (probed % 25 === 0) {
            fs.writeFileSync(RAW, JSON.stringify(raw, null, 1));
            fs.writeFileSync(FINAL, JSON.stringify(behavior, null, 1));
            console.log('  ' + probed + ' probed, last: ' + id + ' -> ' + r.outcome);
        }
    }

    const counts = {};
    for (const k of Object.keys(behavior.commands)) counts[behavior.commands[k].outcome] = (counts[behavior.commands[k].outcome] || 0) + 1;
    behavior.counts = counts;
    behavior.finished_at = new Date().toISOString();
    fs.writeFileSync(RAW, JSON.stringify(raw, null, 1));
    fs.writeFileSync(FINAL, JSON.stringify(behavior, null, 1));
    console.log('done: ' + probed + ' this run; recorded in all: ' + Object.keys(behavior.commands).length + '; counts: ' + JSON.stringify(counts));
}

main().catch((e) => { console.error('probe failed: ' + String((e && e.message) || e)); process.exit(1); });
