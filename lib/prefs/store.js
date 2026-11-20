'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
  return process.env.BUC_HOME || path.join(os.homedir(), '.claude', 'better-ultracore');
}

function dirFor(repoRoot) {
  return repoRoot ? path.join(repoRoot, '.claude') : homeDir();
}

function filesFor(repoRoot) {
  const dir = dirFor(repoRoot);
  return repoRoot
    ? { prefs: path.join(dir, 'buc-prefs.json'), tombstones: path.join(dir, 'tombstones.json') }
    : { prefs: path.join(dir, 'prefs.json'), tombstones: path.join(dir, 'tombstones.json') };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const FORBIDDEN = /allow|permission|tools|deny|grant/i;
const KINDS = ['instruction', 'output', 'check'];
const STATUSES = ['suggested', 'confirmed', 'blocker'];

function validate(rec) {
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN.test(key)) throw new Error(`prefs: forbidden field "${key}"`);
  }
  if (!rec.id || typeof rec.correction !== 'string' || rec.correction.length > 200) {
    throw new Error('prefs: invalid id or correction');
  }
  if (!KINDS.includes(rec.kind)) throw new Error(`prefs: invalid kind "${rec.kind}"`);
  if (!STATUSES.includes(rec.status)) throw new Error(`prefs: invalid status "${rec.status}"`);
  if (!/^(global|project:.+|path:.+)$/.test(rec.scope)) throw new Error(`prefs: invalid scope "${rec.scope}"`);
  return rec;
}

function rootFor(scope, repoRoot) {
  return scope === 'global' ? null : repoRoot;
}

function load(repoRoot) {
  return readJson(filesFor(repoRoot).prefs, []);
}

function loadAll(repoRoot) {
  return repoRoot ? [...load(repoRoot), ...load(null)] : load(null);
}

function tombstones(repoRoot) {
  const roots = repoRoot ? [repoRoot, null] : [null];
  return new Set(roots.flatMap((r) => readJson(filesFor(r).tombstones, [])));
}

function save(rec, repoRoot) {
  validate(rec);
  const root = rootFor(rec.scope, repoRoot);
  const list = load(root).filter((r) => r.id !== rec.id);
  list.push(rec);
  writeJson(filesFor(root).prefs, list);
}

function remove(id, root) {
  const list = load(root);
  const rest = list.filter((r) => r.id !== id);
  if (rest.length === list.length) return false;
  writeJson(filesFor(root).prefs, rest);
  return true;
}

function forget(id, repoRoot) {
  let found = false;
  for (const root of repoRoot ? [repoRoot, null] : [null]) {
    if (!remove(id, root)) continue;
    found = true;
    const { tombstones: file } = filesFor(root);
    writeJson(file, [...new Set([...readJson(file, []), id])]);
  }
  return found;
}

module.exports = { homeDir, filesFor, readJson, writeJson, validate, load, loadAll, tombstones, save, remove, forget };
