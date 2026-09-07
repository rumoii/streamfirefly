import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function assertAcyclic(graph) {
  const done = new Set(), visiting = new Set();
  function visit(node, chain) { if (visiting.has(node)) throw new Error(`Circular module dependency: ${[...chain, node].join(' -> ')}`); if (done.has(node)) return; visiting.add(node); for (const dependency of graph.get(node) || []) visit(dependency, [...chain, node]); visiting.delete(node); done.add(node); }
  for (const node of graph.keys()) visit(node, []);
}
assert.throws(() => assertAcyclic(new Map([['first', ['second']], ['second', ['first']]])), /Circular/);
assert.doesNotThrow(() => assertAcyclic(new Map([['first', ['second']], ['second', []]])));
const rustRoot = path.join(root, 'native-host/src');
const rust = new Map();
for (const file of fs.readdirSync(rustRoot).filter(name => name.endsWith('.rs') && name !== 'spec_tests.rs')) {
  const source = fs.readFileSync(path.join(rustRoot, file), 'utf8').split('#[cfg(test)]')[0];
  assert.ok(!/^use (?:super|crate)::\*;/m.test(source), `${file}: root wildcard import`);
  rust.set(file.slice(0, -3), [...source.matchAll(/\bcrate::(\w+)::/g)].map(match => match[1]));
}
assertAcyclic(rust);
const repository = fs.readFileSync(path.join(rustRoot, 'repository.rs'), 'utf8');
assert.ok(!/\b(?:Child|TaskRuntime|QueueState|TcpListener)\b/.test(repository), 'Repository must not own execution resources');
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(?:ts|js|vue)$/.test(entry.name) && !entry.name.includes('.test.') ? [path.join(directory, entry.name)] : []); }
const frontend = new Map();
const frontendFiles = ['extension/src', 'extension-ui/src', 'shared'].flatMap(directory => files(path.join(root, directory)));
const visibleFiles = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'extension/src', 'extension-ui/src', 'shared'], { cwd: root, encoding: 'utf8' }).split('\0'));
for (const file of frontendFiles) {
  const relativeFile = path.relative(root, file).split(path.sep).join('/');
  assert.ok(visibleFiles.has(relativeFile), `${relativeFile}: source is excluded from Git; fix the ignore rule before packaging`);
  const source = fs.readFileSync(file, 'utf8');
  const dependencies = [];
  for (const match of source.matchAll(/(?:import|export)\s+(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
    const relative = path.resolve(path.dirname(file), match[1].split('?', 1)[0]);
    const target = ['', '.ts', '.js', '.vue'].map(extension => relative + extension).find(candidate => fs.existsSync(candidate));
    assert.ok(target, `${file}: unresolved import ${match[1]}`); dependencies.push(target);
  }
  frontend.set(file, dependencies);
  if (file.startsWith(path.join(root, 'shared'))) assert.ok(!/\b(?:window|document|chrome|browser|localStorage)\s*\./.test(source), `${file}: domain code depends on platform`);
  if (file.startsWith(path.join(root, 'extension/src'))) assert.ok(!/\bimportScripts\s*\(/.test(source), `${file}: global script dependency`);
}
assertAcyclic(frontend);
for (const file of ['background-native.js', 'background-resources.js', 'background-workspace.js', 'background-preview.js', 'background.js']) assert.ok(!fs.existsSync(path.join(root, 'extension', file)), `Obsolete background entry: ${file}`);
console.log(`Module boundary checks passed: ${rust.size} Rust modules and ${frontend.size} frontend/domain modules; cycle negative control passed`);
