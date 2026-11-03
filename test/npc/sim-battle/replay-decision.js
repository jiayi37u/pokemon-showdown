'use strict';
// Replay a trusted, locally captured production input; v8 retains Sets, Maps and shared references.
const fs = require('fs');
const { deserialize } = require('v8');
const { performance } = require('perf_hooks');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

function replay(buffer) {
	const frame = deserialize(buffer);
	if (frame.difficulty !== 'hard') throw new Error('This diagnostic currently replays Hard decisions only');
	const ai = new HardAI({ write() {} }, { seed: frame.seed, cfruConfig: frame.config });
	ai.tracker = createBattleTracker(frame.request.side.id);
	ai.setBattle({ format: frame.state.field.formatId });
	ai.lastSwitchTurn = frame.lastSwitchTurn;
	ai.sacrificePlans = frame.sacrificePlans;
	const lastMoves = new Map(frame.lastMoves);
	ai.tracker.getOurLastMove = position => lastMoves.get(position) || '';
	let choice;
	ai.choose = value => { choice = value; };
	const started = performance.now();
	ai.receiveRequestWithState(frame.request, frame.state, ...frame.args);
	return { choice, milliseconds: performance.now() - started,
		cache: 'cold', side: frame.request.side.id, turn: frame.state.turn,
		entry: ai.getLogger().getEntries().at(-1) };
}

if (require.main === module) {
	if (!process.argv[2]) throw new Error('Usage: node test/npc/sim-battle/replay-decision.js SNAPSHOT.bin');
	console.log(JSON.stringify(replay(fs.readFileSync(process.argv[2])), null, 2));
}
module.exports = { replay };
