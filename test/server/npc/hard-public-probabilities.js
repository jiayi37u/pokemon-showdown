'use strict';
const assert = require('assert').strict;
const fixture = require('./fixtures/gen6-live-t3-public.json');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { CandidateSelector } = require('../../../dist/server/npc/ai/hard/candidates');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { searchOpponentModels } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { beginTurn, continueTurn, clonePosition, bindOpponent } = require('../../../dist/server/npc/ai/hard/projection');

function position() {
	const tracker = createBattleTracker('p2');
	tracker.setFormat(fixture.format);
	tracker.parseMessage(fixture.protocol.join('\n'));
	const state = buildBattleStateFromRequests([{ side: 'p2', request: fixture.request }], tracker,
		{ ...DEFAULT_AI_CONFIG, formatId: fixture.format }, fixture.turn);
	const evaluator = new HardEvaluation(state, fixture.format);
	state.opponent.team.push(...state.opponent.preview);
	state.opponent.reserve.push(...state.opponent.preview);
	for (const p of state.opponent.team) {
		p.presetModels = searchOpponentModels(evaluator.opponentModels(p), fixture.format);
	}
	const foe = state.opponent.active[0], model = foe.presetModels[0];
	bindOpponent(state, foe, model);
	state.opponent.active[0].presetModels = [{ ...model, weight: 1 }];
	return state;
}
const probabilities = replies => replies.map(r => [r.action.id, r.probability]);
const sum = values => values.reduce((a, b) => a + b, 0);

describe('Hard public response probabilities in live T3', () => {
	it('does not expose private request moves, item or stats to the responder', () => {
		const state = position(), changed = clonePosition(state);
		const p = changed.self.active[0];
		p.moves = ['hydropump']; p.item = 'choicespecs'; p.ability = 'pressure';
		p.baseStats = { ...p.baseStats, spa: 999, spe: 1 };
		const original = new CandidateSelector(new MatchupEvaluator()).responseProbabilities(state);
		const modified = new CandidateSelector(new MatchupEvaluator()).responseProbabilities(changed);
		assert(Math.abs(sum(original.map(r => r.probability)) - 1) < 1e-12);
		assert.deepEqual(probabilities(modified), probabilities(original));
	});
	it('uses the same U-turn entry distribution before each unrevealed Rotom action', () => {
		const state = position(), evaluator = new MatchupEvaluator();
		const selector = new CandidateSelector(evaluator);
		const distributions = ['hydropump', 'voltswitch', 'painsplit'].map(move => {
			const turn = beginTurn(state, { id: `move ${move}`, move, prior: 0 },
				{ id: 'move uturn', move: 'uturn', prior: 0 });
			assert.equal(continueTurn(turn, 'mean', evaluator.damageCache), undefined);
			assert.equal(turn.pending.cause, 'pivot');
			assert.deepEqual(turn.state.self.active[0].publicKnowledge.moves, []);
			const distribution = [...selector.entryProbabilities(turn.state, turn.state.opponent.reserve)];
			assert(Math.abs(sum(distribution.map(([, p]) => p)) - 1) < 1e-12);
			return distribution;
		});
		assert.deepEqual(distributions[0], distributions[1]);
		assert.deepEqual(distributions[0], distributions[2]);
	});
});
