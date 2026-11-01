import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
for (const file of ['src/app.js', 'src/state.js']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

const html = read('index.html');
for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  assert(existsSync(resolve(root, match[1])), `Missing resource: ${match[1]}`);
}
assert(!html.includes('<!--APP_MARKUP-->'), 'Page markup was not generated.');
const app = read('src/app.js');
assert(!app.includes('window.openai'), 'Host-only state API must not ship.');
assert(!app.includes('15500'), 'The conversation state size limit must not apply locally.');
assert(app.includes('people:[]') && app.includes('tasks:[]'), 'The starting template must be empty.');

// Verify the browser adapter with a state large enough to exceed the old host limit.
const entries = new Map();
const localStorage = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => entries.set(key, value),
};
const context = vm.createContext({ window: { localStorage }, console });
vm.runInContext(read('src/state.js'), context);
const state = { privateContent: { data: { version: 5, tasks: Array.from({ length: 700 }, (_, i) => ({ id: `task-${i}`, title: `本地保存验证 ${i}` })) } } };
assert(Buffer.byteLength(JSON.stringify(state)) > 16000);
assert(JSON.stringify(state).length > 15500);
context.window.projectState.write(state);
const reloaded = vm.createContext({ window: { localStorage }, console });
vm.runInContext(read('src/state.js'), reloaded);
assert.equal(JSON.stringify(reloaded.window.projectState.read()), JSON.stringify(state));
assert.equal(entries.size, 1);
console.log('PASS: JavaScript syntax, resources, empty template, and local state round-trip.');
