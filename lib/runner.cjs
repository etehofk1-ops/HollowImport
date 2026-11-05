/* HollowImport | MIT | Copyright 2026 HollowImport contributors */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// This function is sent verbatim to a fresh Node process based in the consumer.
async function childProbe(specifier) {
  const {registerHooks, createRequire} = await import('node:module');
  const {resolve} = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const found = new Error('resolution complete');
  const result = {};
  const localRequire = createRequire(resolve('hollow-consumer.cjs'));
  try {
    result.require = {file: localRequire.resolve(specifier)};
  } catch (error) {
    result.require = {error: error.code};
  }
  const hook = registerHooks({
    resolve(id, context, nextResolve) {
      const target = nextResolve(id, context);
      if (id !== specifier) throw new Error('unexpected secondary resolution');
      result.import = {file: fileURLToPath(target.url)};
      throw found; // After native resolution, before load, parse or evaluation.
    },
    load() { throw new Error('unexpected attempt to load a module'); }
  });
  try {
    await import(specifier);
  } catch (error) {
    if (error !== found) result.import = {error: error.code};
  } finally {
    hook.deregister();
  }
  process.stdout.write(JSON.stringify(result));
}

function probe(directory, specifier, condition) {
  const args = ['--no-warnings', '--input-type=module'];
  if (condition) args.push('--conditions=' + condition);
  args.push('-e', 'await (' + childProbe.toString() + ')(process.argv[1])', '--', specifier);
  const env = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawnSync(process.execPath, args, {cwd: directory, env, encoding: 'utf8',
    timeout: 10000, windowsHide: true});
  if (child.status !== 0) throw new Error('Native probe unavailable. Use Node 22.15+ with registerHooks.');
  return JSON.parse(child.stdout);
}

function inTemp(action) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hollow-import-'));
  try { return action(temp); }
  finally { fs.rmSync(temp, {recursive: true, force: true}); }
}

function validateCapsule(capsule) {
  function insist(ok) { if (!ok) throw new Error('Invalid capsule data. No fixture was written.'); }
  const filePattern = /^file-[1-9]\d*(?:-part-[1-9]\d*)?(?:\.(?:js|mjs|cjs|json|node|ts|mts|cts))?$/;
  const errors = new Set(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);
  const flags = /^(?:default|import|require|node|node-addons|module-sync|flag-[1-9]\d*)$/;
  insist(capsule && typeof capsule.node === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(capsule.node));
  insist(Array.isArray(capsule.entries) && capsule.entries.length <= 1024);
  const files = new Map();
  for (const entry of capsule.entries) {
    insist(Array.isArray(entry) && entry.length === 2);
    const [file, kind] = entry;
    insist(typeof file === 'string' && filePattern.test(file) && !files.has(file));
    insist(['file', 'missing', 'directory'].includes(kind));
    files.set(file, kind);
  }
  const manifest = capsule.manifest;
  insist(manifest?.name === 'sample-lib' && Object.keys(manifest).length === 2);
  insist(manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports));
  function branch(value, depth) {
    insist(depth <= 18);
    if (value === null) return;
    if (typeof value === 'string') {
      insist(/^\.\/file-[1-9]\d*(?:-\*)?(?:\.(?:js|mjs|cjs|json|node|ts|mts|cts))?$/.test(value));
    } else if (Array.isArray(value)) {
      value.forEach(v => branch(v, depth + 1));
    } else {
      insist(typeof value === 'object');
      for (const [key, v] of Object.entries(value)) {
        insist(flags.test(key)); branch(v, depth + 1);
      }
    }
  }
  for (const [key, value] of Object.entries(manifest.exports)) {
    insist(key === '.' || /^\.\/entry-[1-9]\d*(?:\/\*)?$/.test(key)); branch(value, 0);
  }
  insist(Array.isArray(capsule.rows) && capsule.rows.length >= 1 && capsule.rows.length <= 4);
  let passed = 0, failed = 0;
  const seen = new Set();
  for (const row of capsule.rows) {
    insist(typeof row?.spec === 'string' && /^sample-lib(?:\/(?:entry|unlisted)-[1-9]\d*(?:\/part-[1-9]\d*)?)?$/.test(row.spec));
    insist(typeof row.condition === 'string' && (row.condition === '' || flags.test(row.condition)));
    const key = row.spec + ':' + row.condition;
    insist(!seen.has(key)); seen.add(key);
    for (const mode of ['import', 'require']) {
      const result = row.expected?.[mode];
      if (errors.has(result)) failed++;
      else { insist(files.get(result) === 'file'); passed++; }
    }
  }
  insist(passed > 0 && failed > 0);
}

function materialize(root, capsule) {
  validateCapsule(capsule);
  const pkg = path.join(root, 'node_modules', 'sample-lib');
  fs.mkdirSync(path.dirname(pkg));
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(capsule.manifest, null, 2), {flag: 'wx'});
  for (const [name, kind] of capsule.entries) {
    const dest = path.join(pkg, name);
    if (kind === 'directory') fs.mkdirSync(dest);
    if (kind === 'file') fs.writeFileSync(dest, '', {flag: 'wx'});
  }
}

function replay(capsule, log = console.log) {
  return inTemp(root => {
    materialize(root, capsule);
    for (const row of capsule.rows) {
      const actual = probe(root, row.spec, row.condition);
      for (const mode of ['import', 'require']) {
        const observed = actual[mode].file ? path.basename(actual[mode].file) : actual[mode].error;
        const expected = row.expected[mode];
        if (observed !== expected) throw new Error('Replay mismatch: ' + mode + ' ' + row.spec
          + ' expected ' + expected + ', observed ' + observed);
        log(mode.padEnd(8) + row.spec.padEnd(22) + (row.condition || 'default').padEnd(15)
          + (actual[mode].file ? 'OK -> ' : '') + observed);
      }
    }
  });
}

module.exports = {inTemp, probe, replay, materialize, validateCapsule};
