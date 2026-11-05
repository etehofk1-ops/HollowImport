'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {isBuiltin} = require('node:module');
const {probe, replay} = require('./runner.cjs');

const fail = message => { throw new Error(message); };
const modes = ['import', 'require'];
const knownErrors = new Set(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);
const publicConditions = new Set(['default', 'import', 'require', 'node', 'node-addons', 'module-sync']);

function splitSpecifier(spec) {
  if (typeof spec !== 'string' || isBuiltin(spec) ||
      !/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(spec) ||
      spec.split('/').some(s => s === '.' || s === '..' || s === 'node_modules'))
    fail('Use an installed bare package or a package subpath. Builtins and relative paths are outside this probe.');
  const size = spec.startsWith('@') ? 2 : 1;
  const parts = spec.split('/');
  return {name: parts.slice(0, size).join('/'), sub: ['.', ...parts.slice(size)].join('/')};
}

function readManifest(file) {
  if (fs.statSync(file).size > 1024 * 1024) fail('Manifest exceeds the 1 MiB capture limit.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function locate(dir, name) {
  let inScope = true;
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const own = path.join(cur, 'package.json');
    if (path.basename(cur) === 'node_modules') inScope = false;
    if (inScope && fs.existsSync(own)) {
      const manifest = readManifest(own);
      if (manifest.name === name && manifest.exports != null) return {root: cur, manifest};
      inScope = false;
    }
    if (path.dirname(cur) === cur) break;
  }
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const pkg = path.join(cur, 'node_modules', name);
    if (fs.existsSync(path.join(pkg, 'package.json'))) {
      return {root: fs.realpathSync(pkg), manifest: readManifest(path.join(pkg, 'package.json'))};
    }
    if (path.dirname(cur) === cur) fail('Package manifest not found from that directory.');
  }
}

function exportMap(value) {
  if (value == null) fail('This package has no active exports map.');
  if (typeof value !== 'object' || Array.isArray(value)) return {'.': value};
  const keys = Object.keys(value);
  if (keys.some(k => k.startsWith('.')) && keys.some(k => !k.startsWith('.')))
    fail('Mixed subpaths and conditions are unsupported.');
  return keys.some(k => k.startsWith('.')) ? value : {'.': value};
}

function routeFor(map, sub) {
  // Node checks exact subpaths before pattern matching, including null targets.
  if (Object.hasOwn(map, sub)) return {key: sub, star: null};
  const matches = [];
  for (const key of Object.keys(map)) {
    if (!key.includes('*')) continue;
    const [prefix, suffix, extra] = key.split('*');
    if (extra !== undefined) fail('Multiple stars in an export key are unsupported.');
    if (sub.length > prefix.length + suffix.length && sub.startsWith(prefix) && sub.endsWith(suffix))
      matches.push({key, star: sub.slice(prefix.length, sub.length - suffix.length)});
  }
  if (matches.length > 1) fail('Overlapping export routes need their precedence preserved; no capsule was emitted.');
  return matches[0];
}

function label(map, value, stem) {
  if (!map.has(value)) map.set(value, stem + (map.size + 1));
  return map.get(value);
}

function inspectKind(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    fail('Special filesystem target is unsupported.');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

class Projection {
  constructor(root, manifest) {
    this.root = root;
    this.original = exportMap(manifest.exports);
    this.exports = Object.create(null);
    this.routes = new Map();
    this.conditions = new Map();
    this.targets = new Map();
    this.files = new Map();
    this.identities = new Map();
    this.captures = new Map();
  }
  condition(value) {
    return publicConditions.has(value) ? value : label(this.conditions, value, 'flag-');
  }
  target(value, star, alias) {
    if (typeof value !== 'string' || !value.startsWith('./') ||
        /[%?#:\\]/.test(value) || value.slice(2).split('/').some(p => ['.', '..', 'node_modules'].includes(p)) ||
        (value.includes('*') && star === null)) fail('Unsupported exports target; capture stopped.');
    const raw = star === null ? value : value.replaceAll('*', () => star);
    const file = path.resolve(this.root, raw);
    const kind = inspectKind(file);
    const ext = path.extname(file);
    const safeExt = ['.js', '.mjs', '.cjs', '.json', '.node', '.ts', '.cts', '.mts'].includes(ext) ? ext : '';
    const base = label(this.targets, value, 'file-') + (value.includes('*') ? '-*' : '') + safeExt;
    const publicFile = base.replace('*', alias || '');
    this.files.set(publicFile, kind);
    if (kind === 'file') {
      const key = fs.realpathSync(file);
      if (this.identities.has(key) && this.identities.get(key) !== publicFile)
        fail('Multiple aliases of the same target would lose identity; capture stopped.');
      this.identities.set(key, publicFile);
    }
    return './' + base;
  }
  tree(value, star, alias, depth = 0) {
    if (depth > 16) fail('Export tree is too deep.');
    if (value === null) return null;
    if (typeof value === 'string') return this.target(value, star, alias);
    if (Array.isArray(value)) return value.map(v => this.tree(v, star, alias, depth + 1));
    if (typeof value !== 'object') fail('Unknown export target.');
    const result = Object.create(null);
    for (const [key, branch] of Object.entries(value)) {
      if (/^\d+$/.test(key) || key.startsWith('.')) fail('Unsupported condition key.');
      result[this.condition(key)] = this.tree(branch, star, alias, depth + 1);
    }
    return result;
  }
  add(sub) {
    const route = routeFor(this.original, sub);
    if (!route) return sub === '.' ? 'sample-lib' : 'sample-lib/' + label(this.routes, sub, 'unlisted-');
    const {key, star} = route;
    const routeKey = key === '.' ? '.' : './' + label(this.routes, key, 'entry-') + (star === null ? '' : '/*');
    const alias = star === null ? null : label(this.captures, star, 'part-');
    const branch = this.tree(this.original[key], star, alias);
    if (Object.hasOwn(this.exports, routeKey) && JSON.stringify(this.exports[routeKey]) !== JSON.stringify(branch))
      fail('A pattern changes target shape across requests; capture stopped.');
    this.exports[routeKey] = branch;
    return routeKey === '.' ? 'sample-lib' : 'sample-lib/' + routeKey.slice(2).replace('*', alias || '');
  }
}

function capture(spec, options) {
  if (!options.clean && (process.env.NODE_OPTIONS?.trim() || process.env.NODE_PATH?.trim() || process.execArgv.length)) {
    fail('Ambient Node options detected. Rerun without them or use --clean to explicitly test stock resolution.');
  }
  const dir = fs.realpathSync(options.from);
  if (!fs.statSync(dir).isDirectory()) fail('--from must name the consumer directory.');
  const {name, sub} = splitSpecifier(spec);
  if (options.control && splitSpecifier(options.control).name !== name) fail('Control must use the same package.');
  if (options.condition && !/^[A-Za-z][\w-]*$/.test(options.condition)) fail('Unsupported condition name.');
  const {root, manifest} = locate(dir, name);
  const project = new Projection(root, manifest);
  const profiles = options.condition ? ['', options.condition] : [''];
  const rows = [];
  function observe(input, subpath) {
    const publicSpec = project.add(subpath);
    let good = 0, bad = 0;
    for (const condition of profiles) {
      const original = probe(dir, input, condition);
      const expected = {};
      for (const mode of modes) {
        const {file, error} = original[mode];
        if (file) {
          const id = project.identities.get(fs.realpathSync(file));
          if (!id) fail('Resolved target falls outside the projected exports branch.');
          expected[mode] = id;
          good++;
        } else {
          if (!knownErrors.has(error)) fail('Outside supported native resolution errors.');
          expected[mode] = error;
          bad++;
        }
      }
      rows.push({spec: publicSpec, condition: condition ? project.condition(condition) : '', expected});
    }
    return {good, bad};
  }
  const primary = observe(spec, sub);
  if (!primary.bad) fail('Native Node resolves the requested entry in all observed modes. No failure capsule.');
  if (options.control) {
    const control = options.control === spec ? primary : observe(options.control, splitSpecifier(options.control).sub);
    if (!control.good) fail('Control never resolves.');
  } else if (!primary.good && (spec === name || !observe(name, '.').good)) {
    fail('No observed passing control. Add --control with a known working subpath of this package.');
  }
  const capsule = {node: process.versions.node, manifest: {name: 'sample-lib', exports: project.exports},
    entries: [...project.files], rows};
  replay(capsule, () => {}); // Deliberately reject any loss of native behavior.
  return capsule;
}

module.exports = {capture};
