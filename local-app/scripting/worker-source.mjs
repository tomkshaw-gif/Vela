import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function declarations(parsed) {
    return parsed.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
}

/** Keep the official transport class intact while excluding its unused in-process engine. */
export function extractPineHostSource(source, entry = 'vela-pine-host.js') {
    const parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = declarations(parsed).filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'PineWorkerEngine');
    if (found.length !== 1 || !found[0].initializer || !ts.isClassExpression(found[0].initializer)) throw new Error('The installed Pine worker transport class changed shape.');
    const classSource = found[0].initializer.getText(parsed);
    const isolated = `const PineWorkerEngine = ${classSource};`;
    const filename = '/vela-pine-transport.js';
    const isolatedFile = ts.createSourceFile(filename, isolated, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const host = {
        getSourceFile: (file) => file === filename ? isolatedFile : undefined,
        getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/', getDirectories: () => [],
        fileExists: (file) => file === filename, readFile: (file) => file === filename ? isolated : undefined,
        getCanonicalFileName: (file) => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    };
    const program = ts.createProgram([filename], { noLib: true, allowJs: true, checkJs: true, noEmit: true }, host);
    const checker = program.getTypeChecker();
    const allowed = new Set(['Map', 'Promise', 'Math', 'Error', 'String', 'spawnWorker', 'undefined']);
    const unknown = new Set();
    function visit(node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) unknown.add('dynamic import');
        if (ts.isIdentifier(node)) {
            const parent = node.parent;
            const property = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
                || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node));
            const symbol = parent && ts.isShorthandPropertyAssignment(parent)
                ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
            if (!property && !allowed.has(node.text) && !symbol) unknown.add(node.text);
        }
        ts.forEachChild(node, visit);
    }
    visit(isolatedFile);
    if (unknown.size) throw new Error(`The installed Pine worker transport needs unreviewed dependencies: ${[...unknown].sort().join(', ')}.`);
    return `/*! LuxAlgo Vela-PineTS worker transport. AGPL-3.0-only; see the installed addon LICENSE. */\n${isolated}\nfunction spawnWorker(url) { if (!url) throw new Error('A hosted Pine worker URL is required.'); return new Worker(url); }\nexport { PineWorkerEngine };\n`;
}

export async function loadPineHostSource() {
    const entry = require.resolve('@luxalgo/vela-pinets');
    return extractPineHostSource(await readFile(entry, 'utf8'), entry);
}

/** Read the addon's shipped worker verbatim without evaluating its host bundle. */
export async function loadPineWorkerSource() {
    const entry = require.resolve('@luxalgo/vela-pinets');
    const source = await readFile(entry, 'utf8');
    const parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const declaration of declarations(parsed)) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === 'worker_default'
                && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
                const worker = declaration.initializer.text;
                if (worker.length < 1000 || !worker.includes('postMessage')) throw new Error('The installed Pine worker source is invalid.');
                return worker;
            }
    }
    throw new Error('The installed Pine addon no longer exposes its embedded worker. Update the worker integration before starting scripts.');
}
