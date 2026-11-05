'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {capture: nativeCapture} = require('./lib/capture.cjs');
const {inTemp, replay, materialize} = require('./lib/runner.cjs');
const cli = path.join(__dirname, 'cli.cjs');
const name = '@hidden-company/undisclosed-package';

test('the bundled report downloads the exact standalone example shipped alongside it', () => {
  const examples = path.join(__dirname, 'examples');
  const html = fs.readFileSync(path.join(examples, 'sdk-2273.html'), 'utf8');
  const embedded = html.match(/href="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/);
  assert.ok(embedded, 'missing embedded script');
  assert.deepEqual(Buffer.from(embedded[1], 'base64'), fs.readFileSync(path.join(examples, 'sdk-2273.cjs')));
});

// The test runner itself supplies Node flags. All fixtures explicitly model stock resolution.
function capture(spec, options) { return nativeCapture(spec, {clean: true, ...options}); }
function run(root, ...args) {
  return spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8', timeout: 15000});
}
function setup(root, exports, files = []) {
  const pkg = path.join(root, 'node_modules', name);
  fs.mkdirSync(pkg, {recursive: true});
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name, exports, scripts: {postinstall: 'private-script'}}));
  for (const file of files) {
    const target = path.join(pkg, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, 'require("node:fs").writeFileSync("executed", "sentinel-confidential");');
  }
  return pkg;
}

test('conditional wildcard: maintain discrepancy and anonymize scope, condition, files and contents', () => inTemp(root => {
  setup(root, {'./private-*': {'client-secret-mode': './absent/*.cjs', default: './valid/*.cjs'}}, ['valid/confidential.cjs']);
  const cap = capture(name + '/private-confidential', {from: root, condition: 'client-secret-mode'});
  const text = JSON.stringify(cap);
  for (const value of [name, root, 'confidential', 'client-secret-mode', 'private-', './absent', './valid', 'private-script'])
    assert(!text.includes(value), value);
  assert.equal(cap.rows[0].expected.import, cap.rows[0].expected.require);
  assert.equal(cap.rows[1].expected.import, 'ERR_MODULE_NOT_FOUND');
  assert.equal(cap.rows[1].expected.require, 'MODULE_NOT_FOUND');
  assert(Object.keys(cap.manifest.exports)[0].endsWith('/*'));
  assert.equal(fs.existsSync(path.join(root, 'executed')), false);
  cap.rows[0].expected.import = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  assert.throws(() => replay(cap, () => {}), /mismatch/);
}));

test('deep import denied + public root: separate errors from missing targets', () => inTemp(root => {
  setup(root, {'.': './allowed.cjs', './forbidden': null, './*': './missing/*.js'}, ['allowed.cjs']);
  const cap = capture(name + '/forbidden', {from: root});
  assert.equal(cap.rows[0].expected.import, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  assert.equal(cap.rows[1].expected.require, cap.rows[1].expected.import);
  assert(Object.values(cap.manifest.exports).includes(null));
}));

test('reject all-pass, all-fail and ambiguous patterns; never emit an unverified report', () => inTemp(root => {
  setup(root, {'.': './absent.mjs', './good': './ok.cjs', './f*': './ok.cjs', './*z': './absent.mjs'}, ['ok.cjs']);
  assert.throws(() => capture(name + '/good', {from: root}), /all observed modes/);
  assert.throws(() => capture(name, {from: root}), /passing control/);
  assert.throws(() => capture(name, {from: root, control: name}), /Control never resolves/);
  assert.throws(() => capture(name, {from: root, control: 'other/good'}), /same package/);
  const result = run(root, cli, 'capture', name + '/fizz', '--from', root, '--clean');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Overlapping/);
  assert(!fs.existsSync(path.join(root, 'repro.cjs')));
}));

test('same runnable artifact inside HTML, editable fixture without the tool, no overwritten files', () => inTemp(root => {
  const out = path.join(root, 'report.cjs');
  let result = run(root, cli, 'demo', '--out', out);
  assert.equal(result.status, 0, result.stderr);
  const original = fs.readFileSync(out);
  const inspect = JSON.parse(run(root, out, '--inspect').stdout);
  assert.equal(inspect.rows[0].expected.import, 'ERR_MODULE_NOT_FOUND');
  assert(!original.includes('secret-implementation'));
  assert.notEqual(run(root, cli, 'demo', '--out', out).status, 0);
  assert(original.equals(fs.readFileSync(out)));
  assert.match(run(root, out, '--markdown').stdout, /CommonJS require/);
  assert.equal(run(root, out, '--card', 'case.html').status, 0);
  const card = fs.readFileSync(path.join(root, 'case.html'), 'utf8');
  assert(!card.includes('<script'));
  assert(original.equals(Buffer.from(card.match(/base64,([A-Za-z0-9+/=]+)"/)[1], 'base64')));
  assert.notEqual(run(root, out, '--card', 'case.html').status, 0);
  assert.equal(run(root, out, '--unpack', 'scratch').status, 0);
  assert.notEqual(run(root, out, '--unpack', 'scratch').status, 0);
  result = run(path.join(root, 'scratch'), 'run.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
}));

test('explicit working control and different successful file identities survive projection', () => inTemp(root => {
  const dir = setup(root, {'.': {import: './absent.mjs', require: './absent.cjs'},
    './control': {import: './folder/one.mjs', require: './folder/two.cjs'}}, ['folder/one.mjs', 'folder/two.cjs']);
  // Capture from inside the package itself, as well as the external consumer.
  for (const from of [root, dir]) {
    const cap = capture(name, {from, control: name + '/control'});
    assert.equal(cap.rows.length, 2);
    assert.notEqual(cap.rows[1].expected.import, cap.rows[1].expected.require);
  }
  assert(!fs.existsSync(path.join(root, 'executed')));
}));

test('reject altered capsule entries and empty evidence before any filesystem writes', () => inTemp(root => {
  setup(root, {'.': {import: './absent.mjs', require: './ok.cjs'}}, ['ok.cjs']);
  const original = capture(name, {from: root});
  const output = path.join(root, 'empty');
  fs.mkdirSync(output);
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'unchanged');
  for (const change of [cap => cap.entries.push(['../../../victim.txt', 'file']), cap => {cap.rows = [];}]) {
    const edited = structuredClone(original);
    change(edited);
    assert.throws(() => materialize(output, edited), /Invalid capsule/);
    assert.throws(() => replay(edited, () => {}), /Invalid capsule/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(output), []);
  }
}));

test('ambient conditions require explicit stock-mode opt-in', () => inTemp(root => {
  setup(root, {'.': {development: './ok.cjs', import: './missing.mjs', require: './ok.cjs'}}, ['ok.cjs']);
  const args = [cli, 'capture', name];
  const env = {...process.env, NODE_OPTIONS: '--conditions=development'};
  let result = spawnSync(process.execPath, args, {cwd: root, env, encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ambient Node options/);
  assert(!fs.existsSync(path.join(root, 'repro.cjs')));
  result = spawnSync(process.execPath, [...args, '--clean', '--condition', 'development'],
    {cwd: root, env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(run(root, 'repro.cjs', '--inspect').stdout);
  assert.equal(data.rows[1].expected.import, data.rows[1].expected.require);
}));
