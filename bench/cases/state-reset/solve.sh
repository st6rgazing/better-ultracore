#!/bin/sh
cd "$1" && sed -i.bak "s/endRound() { this.start(); }/endRound() { this.hints = []; this.players.forEach((p) => { p.ready = false; }); this.phase = 'lobby'; }/" game.js && rm game.js.bak
