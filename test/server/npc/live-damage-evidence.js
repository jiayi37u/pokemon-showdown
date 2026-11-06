'use strict';
const assert = require('assert').strict;
const fixture = require('./fixtures/gen6-live-evidence.json');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');

function replay(frame, events = frame.events) {
	const tracker = createBattleTracker('p2');
	tracker.setFormat(fixture.format);
	tracker.parseMessage(frame.protocol.join('\n'));
	buildBattleStateFromRequests([{ side: 'p2', request: frame.request }], tracker,
		{ ...DEFAULT_AI_CONFIG, formatId: fixture.format }, frame.turn);
	tracker.parseMessage(events.join('\n'));
	return tracker.evidence.getHistory().filter(e => e.kind === 'damage');
}

describe('Live battle damage evidence after public state changes', () => {
	for (const [turn, species, before, after, spd] of [
		[8, 'Rotom-Wash', 99, 75, 250],
		[17, 'Heatran', 100, 42, 342],
		[18, 'Clefable', 100, 54, 216],
	]) {
		it(`records T${turn} Steam Eruption with the actual recipient and pre-hit state`, () => {
			const [hit] = replay(fixture.frames.find(f => f.turn === turn));
			assert(hit);
			assert.equal(hit.move, 'steameruption');
			assert.equal(hit.opponent, 'p1:Volcanion');
			assert.equal(hit.before, before);
			assert.equal(hit.after, after);
			assert.equal(hit.context.self[0].species, species);
			assert.equal(hit.context.self[0].baseStats.spd, spd);
			assert.equal(hit.context.self[0].status, '');
			assert.equal(hit.context.self[0].boosts.spd, 0);
			if (turn === 17) assert.equal(hit.context.opponentConditions.stealthrock, true);
			if (turn === 8) assert.equal(hit.context.self[0].item, '');
			const foe = hit.context.opponents[0];
			assert.equal(foe.presetModels, undefined);
			assert.equal(foe.baseStats.spa, 0);
		});
	}
	it('still rejects critical-hit damage instead of fitting it as ordinary damage', () => {
		const frame = fixture.frames.find(f => f.turn === 18);
		const events = frame.events.flatMap(line => line.startsWith('|-damage|') ?
			['|-crit|p2a: Clefable', line] : [line]);
		assert.deepEqual(replay(frame, events), []);
	});
});
