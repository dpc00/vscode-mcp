'use strict';
// Checks the tool surface without a VS Code window: the extension module is loaded with a
// stubbed `vscode`, the generated command tools are made here from a command-id list, and the
// JSON-RPC entry point is driven directly.
//
//     node tools/test_surface.js
//
// What it is guarding (2026-11-13): tools/list used to present every tool, 2800+ of them. A
// client connecting with a limited context filled to 100% before the first message and could
// not compact while the server was attached. The surface is now a dozen tools plus discover,
// with everything else callable through batch.

const Module = require('module');
const path = require('path');

const COMMAND_IDS = [
    'workbench.action.files.newUntitledFile',
    'workbench.action.files.save',
    'workbench.action.files.saveAs',
    'workbench.action.showCommands',
    'workbench.action.quickOpen',
    'workbench.action.quickOpenSelectNext',
    'workbench.action.acceptSelectedQuickOpenItem',
    'workbench.action.closeQuickOpen',
    'workbench.action.reloadWindow',
    'workbench.extensions.installExtension',
    'workbench.extensions.action.listExtensions',
    'editor.action.formatDocument',
    'editor.action.selectAll',
    'editor.action.fold',
    'editor.action.unfold',
    'editor.action.foldAll',
    'editor.action.unfoldAll',
    'editor.action.commentLine',
    'editor.action.triggerSuggest',
    'editor.action.rename',
    'git.commit',
    'git.stage',
    'addRootFolder',
    'vscode.executeHoverProvider',
    'vscode.executeDefinitionProvider',
];

let configValues = {};
const gen = [];
const toolIds = new Map(); // generated tool name -> command id

const vscodeStub = {
    version: '1.99.0-test',
    Uri: { file: (p) => ({ fsPath: String(p), toString: () => 'file:///' + String(p) }), parse: (s) => ({ toString: () => s }) },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Range: class { constructor(a, b, c, d) { this.start = a; this.end = b; } },
    Selection: class {},
    WorkspaceEdit: class { replace() {} insert() {} },
    workspace: {
        workspaceFolders: [],
        textDocuments: [],
        getConfiguration: () => ({ get: (key, dflt) => (key in configValues ? configValues[key] : dflt) }),
        openTextDocument: async (uri) => { throw new Error('not available in the harness: ' + uri); },
        applyEdit: async () => true,
    },
    window: {
        activeTextEditor: undefined,
        tabGroups: { all: [], close: async () => true },
        showInformationMessage: () => undefined,
        showWarningMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
    commands: {
        getCommands: async () => COMMAND_IDS.slice(),
        executeCommand: async () => undefined,
    },
    languages: { getDiagnostics: () => [] },
    env: { appRoot: 'C:/fake' },
    extensions: { getExtension: () => undefined, all: [] },
};

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return vscodeStub;
    if (request === 'koffi') throw new Error('koffi stubbed out: no FFI in the harness');
    return originalLoad.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));

// Same shape buildCommandTools() produces, from the command list above.
for (const id of COMMAND_IDS) {
    const name = id.replace(/[^A-Za-z0-9-]/g, '_');
    toolIds.set(name, id);
    gen.push({
        name,
        generated: true,
        commandId: id,
        description: 'VS Code command `' + id + '` (generated from this window\'s command list; dispatched as-is, like run_command). Pass {"args": [...]}; {"$uri"}, {"$pos"} and {"$range"} items revive to real VS Code objects.',
        inputSchema: { type: 'object', properties: { args: { type: 'array' } } },
        run: async () => ({ ok: true, result: null }),
    });
}
ext.TOOLS.push(...gen);

const failures = [];
function check(name, fn) {
    try {
        const detail = fn();
        console.log('ok   ' + name + (detail ? ' - ' + detail : ''));
    } catch (e) {
        failures.push(name + ': ' + e.message);
        console.log('FAIL ' + name + ' - ' + e.message);
    }
}
function must(cond, message) { if (!cond) throw new Error(message); }
async function checkAsync(name, fn) {
    try {
        const detail = await fn();
        console.log('ok   ' + name + (detail ? ' - ' + detail : ''));
    } catch (e) {
        failures.push(name + ': ' + e.message);
        console.log('FAIL ' + name + ' - ' + e.message);
    }
}
function textOf(reply) { return reply.result.content[0].text; }
function jsonOf(reply) { return JSON.parse(textOf(reply)); }

(async () => {
    const written = ext.TOOLS.filter((t) => !t.generated).length;

    // ── the surface ────────────────────────────────────────────────────────────────────────
    const listReply = await ext.handleRpc({ id: 1, method: 'tools/list' });
    const listed = listReply.result.tools;
    const listedNames = listed.map((t) => t.name);

    check('tools/list presents only the core surface', () => {
        must(listed.length === ext.DEFAULT_TOOL_NAMES.length, listed.length + ' listed, expected ' + ext.DEFAULT_TOOL_NAMES.length);
        return listed.length + ' of ' + ext.TOOLS.length + ' tools';
    });
    check('every listed tool carries a schema', () => {
        for (const t of listed) must(t.inputSchema && t.inputSchema.type === 'object', t.name + ' has no object schema');
        return 'all ' + listed.length;
    });
    check('no generated tool is listed', () => {
        must(!listed.some((t) => toolIds.has(t.name)), 'a generated tool leaked into the list');
        return 'generated tools stay behind discover';
    });
    check('the entry points are listed', () => {
        for (const n of ['discover', 'batch', 'get_help']) must(listedNames.includes(n), n + ' is not listed');
        return 'discover, batch, get_help';
    });
    check('the list is cheap', () => {
        const bytes = Buffer.byteLength(JSON.stringify(listReply.result.tools));
        // Roughly a quarter of a token per character of JSON: the point is the order of magnitude.
        must(bytes < 20000, 'tools/list is ' + bytes + ' bytes');
        return bytes + ' bytes (' + listed.length + ' tools); the full catalogue is '
            + Buffer.byteLength(JSON.stringify(ext.TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))) + ' bytes';
    });

    // ── initialize tells the model how to work ────────────────────────────────────────────
    const init = await ext.handleRpc({ id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    check('initialize instructions teach the discovery loop', () => {
        const text = init.result.instructions;
        must(/discover/.test(text) && /batch/.test(text), 'instructions do not name discover and batch');
        must(text.length < 800, 'instructions are ' + text.length + ' characters');
        return text.length + ' characters';
    });

    // ── discover: search ──────────────────────────────────────────────────────────────────
    const fold = jsonOf(await ext.handleRpc({ id: 3, method: 'tools/call', params: { name: 'discover', arguments: { query: 'fold' } } }));
    check('discover finds generated tools by query', () => {
        must(fold.total >= 4, 'only ' + fold.total + ' fold hits');
        for (const t of fold.tools) must(t.name.indexOf('fold') >= 0 || /fold/i.test(t.description), 'unrelated hit ' + t.name);
        return fold.total + ' hits';
    });
    check('discover ranks name matches above description-only matches', () => {
        must(/fold/.test(fold.tools[0].name), 'first hit is ' + fold.tools[0].name);
        const nameHits = fold.tools.filter((t) => /fold/i.test(t.name));
        const rest = fold.tools.filter((t) => !/fold/i.test(t.name));
        must(nameHits.length >= 4, 'only ' + nameHits.length + ' name hits');
        must(rest.length > 0, 'the harness lost its description-only hits');
        const lastNameHit = fold.tools.indexOf(nameHits[nameHits.length - 1]);
        const firstRest = fold.tools.indexOf(rest[0]);
        must(lastNameHit < firstRest, 'a description-only hit outranked a name hit: ' + fold.tools.map((t) => t.name).join(','));
        must(fold.tools.findIndex((t) => t.name === 'editor_action_fold') < fold.tools.findIndex((t) => t.name === 'addRootFolder'),
            'a whole-segment match did not beat a substring: ' + fold.tools.map((t) => t.name).join(','));
        return fold.tools.map((t) => t.name).join(', ');
    });
    check('discover carries the input schema', () => {
        for (const t of fold.tools) must(t.inputSchema && t.inputSchema.type === 'object', t.name + ' has no schema');
        return 'schema on every hit';
    });
    const schemaOff = jsonOf(await ext.handleRpc({ id: 4, method: 'tools/call', params: { name: 'discover', arguments: { query: 'fold', include_schema: false } } }));
    check('include_schema:false drops the schemas', () => {
        must(schemaOff.tools.every((t) => t.inputSchema === undefined), 'a schema survived');
        return 'off';
    });
    const noHit = jsonOf(await ext.handleRpc({ id: 5, method: 'tools/call', params: { name: 'discover', arguments: { query: 'zzz_no_such_tool' } } }));
    check('a query with no hits says so', () => {
        must(noHit.total === 0 && noHit.tools.length === 0, 'unexpected hits: ' + noHit.total);
        return 'total 0';
    });

    // ── discover: browse ─────────────────────────────────────────────────────────────────
    const map = jsonOf(await ext.handleRpc({ id: 6, method: 'tools/call', params: { name: 'discover', arguments: {} } }));
    check('discover without arguments returns the map', () => {
        must(Array.isArray(map.categories), 'no categories');
        must(map.categories[0].path === 'hand-written', 'hand-written is not first');
        must(map.total === ext.TOOLS.length, 'total is ' + map.total);
        return map.categories.map((c) => c.path + '(' + c.tools + ')').join(' ');
    });
    const hand = jsonOf(await ext.handleRpc({ id: 7, method: 'tools/call', params: { name: 'discover', arguments: { category: 'hand-written' } } }));
    check('hand-written lists every hand-written tool', () => {
        must(hand.total === written, hand.total + ' != ' + written);
        must(hand.tools.length === written, 'truncated at ' + hand.tools.length);
        return written + ' tools';
    });
    const workbench = jsonOf(await ext.handleRpc({ id: 8, method: 'tools/call', params: { name: 'discover', arguments: { category: 'workbench' } } }));
    check('a category descends into subcategories', () => {
        const paths = (workbench.subcategories || []).map((s) => s.path);
        must(paths.includes('workbench/action'), 'no workbench/action in ' + paths.join(','));
        must((workbench.subcategories || []).reduce((n, s) => n + s.tools, 0) + (workbench.tools || []).length === workbench.total,
            'subcategory and direct counts do not add up to ' + workbench.total);
        return paths.join(' ');
    });
    const files = jsonOf(await ext.handleRpc({ id: 9, method: 'tools/call', params: { name: 'discover', arguments: { category: 'workbench/action' } } }));
    check('a leaf category lists tools', () => {
        must(Array.isArray(files.tools) && files.tools.length > 0, 'no tools at workbench/action');
        must(files.tools.every((t) => t.command.startsWith('workbench.action.')), 'a tool outside the path leaked in');
        return files.tools.length + ' of ' + files.total + ' direct, plus ' + (files.subcategories || []).length + ' deeper groups';
    });
    const deep = jsonOf(await ext.handleRpc({ id: 10, method: 'tools/call', params: { name: 'discover', arguments: { category: 'workbench/action/files' } } }));
    check('a three-segment path works', () => {
        must(deep.tools.length === 3, deep.tools.length + ' tools');
        return deep.tools.map((t) => t.name).join(' ');
    });
    const bad = jsonOf(await ext.handleRpc({ id: 11, method: 'tools/call', params: { name: 'discover', arguments: { category: 'no_such_namespace' } } }));
    check('an unknown category answers with the map', () => {
        must(bad.error && Array.isArray(bad.map), 'no error/map');
        return bad.error;
    });

    // ── calling what the list does not present ────────────────────────────────────────────
    await checkAsync('an unlisted tool runs through direct tools/call', async () => {
        const reply = await ext.handleRpc({ id: 12, method: 'tools/call', params: { name: 'editor_action_fold', arguments: {} } });
        must(reply.result && reply.result.content, 'no content');
        must(jsonOf(reply).ok === true, 'tool did not run: ' + textOf(reply));
        return 'editor_action_fold';
    });
    await checkAsync('an unlisted tool runs through batch', async () => {
        const reply = await ext.handleRpc({
            id: 13, method: 'tools/call',
            params: { name: 'batch', arguments: { calls: [{ tool: fold.tools[0].name, arguments: {} }, { sleep: 1 }, { tool: 'get_help', arguments: {} }] } },
        });
        const results = jsonOf(reply);
        must(Array.isArray(results) && results.length === 3, 'batch returned ' + JSON.stringify(results).slice(0, 120));
        must(!results[0].error, 'batch step 0 failed: ' + JSON.stringify(results[0]).slice(0, 120));
        must(results[2].surface && results[2].surface.listed_count === ext.DEFAULT_TOOL_NAMES.length, 'get_help did not report the surface');
        return 'batch ran ' + fold.tools[0].name + ' and get_help';
    });
    await checkAsync('an unknown name is answered with the way to find it', async () => {
        const reply = await ext.handleRpc({ id: 14, method: 'tools/call', params: { name: 'not_a_tool' } });
        must(reply.error && /discover/.test(reply.error.message), 'message does not point at discover');
        return 'error names discover';
    });

    // ── the escape hatch ─────────────────────────────────────────────────────────────────
    configValues = { exposeAllTools: true };
    const all = await ext.handleRpc({ id: 15, method: 'tools/list' });
    check('vscodeMcp.exposeAllTools restores the full list', () => {
        must(all.result.tools.length === ext.TOOLS.length, all.result.tools.length + ' != ' + ext.TOOLS.length);
        return all.result.tools.length + ' tools when switched on';
    });
    configValues = {};

    // ── get_help reports what is what ─────────────────────────────────────────────────────
    const help = jsonOf(await ext.handleRpc({ id: 16, method: 'tools/call', params: { name: 'get_help', arguments: {} } }));
    check('get_help describes the surface', () => {
        must(help.surface.listed_count === ext.DEFAULT_TOOL_NAMES.length, 'listed_count is ' + help.surface.listed_count);
        must(help.surface.hidden_count === ext.TOOLS.length - ext.DEFAULT_TOOL_NAMES.length, 'hidden_count is ' + help.surface.hidden_count);
        must(help.surface.expose_all_tools === false, 'expose_all_tools is ' + help.surface.expose_all_tools);
        return help.surface.listed_count + ' listed, ' + help.surface.hidden_count + ' hidden';
    });

    // ── self_test's own check list is wired to the live surface ──────────────────────────
    check('self_test includes the surface check', () => {
        const src = require('fs').readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
        must(/check\('default_surface'/.test(src), 'default_surface check is missing');
        return 'default_surface';
    });

    // ── loop guard: identical failures trip the breaker, loop_reset clears it ────────────
    await checkAsync('loop guard trips and resets', async () => {
        const fake = { name: 'zz_loop_probe', run: async () => ({ ok: false, error: 'always fails the same way' }) };
        ext.guarded(fake);
        let last;
        for (let i = 0; i < 5; i++) last = await fake.run({});
        must(last && last.loop_breaker === true, '5th identical failure did not trip: ' + JSON.stringify(last).slice(0, 160));
        const cleared = await ext.TOOLS.find((t) => t.name === 'loop_reset').run({ tool: 'zz_loop_probe' });
        must(cleared && cleared.cleared >= 1, 'loop_reset cleared nothing: ' + JSON.stringify(cleared));
        const again = await fake.run({});
        must(again && !again.loop_breaker, 'guard still tripped after loop_reset');
        // a different failure signature restarts the streak instead of tripping
        return 'tripped at 4, reset clears';
    });

    console.log('');
    if (failures.length) {
        console.log(failures.length + ' failed:');
        for (const f of failures) console.log('  - ' + f);
        process.exit(1);
    }
    console.log('all checks passed');
})();
