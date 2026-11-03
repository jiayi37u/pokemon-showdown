'use strict';
const assert = require('assert').strict;
const { serialize, deserialize } = require('v8');
const { Battle } = require('../../../dist/sim');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { buildBattleStateWithTracker } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { replay } = require('../../npc/sim-battle/replay-decision');
const { summarize } = require('../../npc/sim-battle/summarize-decisions');

describe('Hard production decision snapshots', () => {
	it('replays the same choice with public opponent knowledge and preserved state references', () => {
		const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Opponent', team: [{ species: 'Magikarp', moves: ['splash'], item: 'Choice Scarf' }] },
			p2: { name: 'Self', team: [{ species: 'Pikachu', moves: ['thunderbolt', 'quickattack'] }] } });
		try {
			battle.makeChoices();
			const ai = new HardAI({ write() {} }, { seed: '1,2,3,4' });
			ai.setBattle({ format: battle.format.id });
			ai.getTracker().parseMessage('|switch|p1a: Magikarp|Magikarp, L100|100/100\n|turn|1');
			const request = battle.p2.activeRequest;
			const state = buildBattleStateWithTracker(request, null, ai.getTracker(), ai.configCFRU);
			assert.equal(state.opponent.active[0].itemKnown, false);
			assert.deepEqual(state.opponent.active[0].moves, []);
			const buffer = serialize({ difficulty: 'hard', request, state, args: [], seed: ai.prng.getSeed(),
				config: ai.configCFRU, lastSwitchTurn: ai.lastSwitchTurn,
				sacrificePlans: ai.sacrificePlans, lastMoves: [] });
			const restored = deserialize(buffer);
			assert.equal(restored.state.self.active[0], restored.state.self.team[0]);
			assert(restored.state.self.active[0].volatiles instanceof Set);
			let choice;
			ai.choose = value => { choice = value; };
			ai.receiveRequestWithState(request, state);
			assert.equal(replay(buffer).choice, choice);
			assert.equal(replay(buffer).choice, choice);
		} finally { battle.destroy(); }
	});
	it('separates sides, fallback decisions and actual searches in timing summaries', () => {
		const result = summarize([
			{ difficulty: 'hard', side: 'p1', kind: 'action', milliseconds: 10, reasoning: ['Two-turn search (2 nodes)'] },
			{ difficulty: 'hard', side: 'p2', kind: 'action', milliseconds: 2, reasoning: ['Search fallback: unavailable'] },
			{ difficulty: 'hard', side: 'p1', kind: 'action', milliseconds: 1, reasoning: ['only retained action'] },
			{ kind: 'process', milliseconds: 100 },
		]);
		assert.equal(result.groups.length, 3);
		assert.equal(result.slowest.length, 3);
		assert.equal(result.groups.find(g => g.group.endsWith('/search')).median, 10);
	});
});
