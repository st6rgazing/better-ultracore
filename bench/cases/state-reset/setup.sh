#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > game.js <<'JS'
class Game {
  constructor(names) {
    this.players = names.map((name) => ({ name, ready: false }));
    this.hints = [];
    this.round = 0;
    this.phase = 'lobby';
  }
  setReady(name) { this.players.find((p) => p.name === name).ready = true; }
  start() { this.round += 1; this.phase = 'playing'; }
  addHint(text) { this.hints.push(text); }
  endRound() { this.start(); }
}
module.exports = { Game };
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const { Game } = require('./game');
const g = new Game(['a', 'b']);
g.start();
g.addHint('x');
assert.deepStrictEqual(g.hints, ['x']);
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
