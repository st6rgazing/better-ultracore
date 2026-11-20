// After a round ends: no hints, nobody ready, and the next round does not start by itself.
const assert = require('node:assert');
const { Game } = require(require('node:path').join(process.argv[2], 'game'));
const g = new Game(['a', 'b']);
g.setReady('a');
g.start();
g.addHint('x');
g.endRound();
assert.deepStrictEqual(g.hints, []);
assert.ok(g.players.every((p) => !p.ready));
assert.notStrictEqual(g.phase, 'playing');
