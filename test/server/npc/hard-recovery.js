'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { Search } = require('../../../dist/server/npc/ai/hard/search');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { DEFAULT_AI_CONFIG, DISCOURAGED_SCORE } = require('../../../dist/server/npc/ai/cfru/types');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { createCache } = require('../../../dist/server/npc/ai/cfru/util/cache');
const battles = [];
function fixture() {
	const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Self', team: [{ species: 'Chansey', ability: 'Natural Cure', item: 'Eviolite',
			moves: ['seismictoss', 'softboiled'] }] },
		p2: { name: 'Foe', team: [{ species: 'Mew', moves: ['psychic'] }] } });
	battles.push(battle); battle.makeChoices();
	const state = projectedState(battle), actor = state.self.active[0], foe = state.opponent.active[0];
	const model = { name: 'known', pokemon: foe, weight: 1, matched: true,
		moves: [{ id: 'psychic', availability: 1 }] };
	const evaluator = new HardEvaluation(state, state.field.formatId, new Map([[foe, [model]]]));
	const recovery = hardMove('softboiled', 1, state.field.formatId);
	const attack = hardMove('psychic', 1, state.field.formatId);
	const predictions = new Map([[foe, [{ move: attack, weight: 1 }]]]);
	return { state, actor, foe, evaluator, recovery, predictions };
}

describe('Hard direct recovery scoring', () => {
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	it('keeps high-HP recovery that restores damage taken before the user acts', () => {
		const { state, actor, foe, evaluator, recovery, predictions } = fixture();
		actor.hp = Math.floor(actor.maxHp * 0.88); actor.hpPercent = 100 * actor.hp / actor.maxHp;
		const score = evaluator.scoreMoves(actor, [recovery], foe, predictions)[0];
		assert(score.score >= 100);
		assert(score.breakdown.details.some(d => d.reason === 'Recovery value across surviving action branches' && d.amount > 0));
		assert(new Search(new MatchupEvaluator()).choices(state, 'self').some(a => a.move === 'softboiled'));
		assert(evaluator.baseScores(state, actor, [recovery], foe, true)[0].score < 100,
			'Opponent prediction retains its existing high-HP heuristic');
		const normal = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createCache(state.turn));
		assert(normal.scoreMoves(state, actor, [recovery], foe)[0].score < 100, 'Shared Normal scoring is unchanged');
	});
	it('still discourages full-HP healing that acts before damage arrives', () => {
		const { actor, foe, evaluator, recovery, predictions } = fixture();
		actor.baseStats = { ...actor.baseStats, spe: 1000 };
		const score = evaluator.scoreMoves(actor, [recovery], foe, predictions)[0];
		assert(score.score <= DISCOURAGED_SCORE);
		assert(score.breakdown.details.some(d => d.reason === 'Recovery has no HP or status benefit'));
	});
	it('still discourages healing when the user is knocked out before acting', () => {
		const { actor, foe, evaluator, recovery, predictions } = fixture();
		actor.hp = 1; actor.hpPercent = 100 / actor.maxHp;
		const score = evaluator.scoreMoves(actor, [recovery], foe, predictions)[0];
		assert(score.score <= DISCOURAGED_SCORE);
		assert(score.breakdown.details.some(d => d.reason === 'Recovery is unsafe across predicted actions and residual damage'));
	});
	it('retains high-HP recovery in opponent response candidates', () => {
		const { state, actor } = fixture();
		actor.hp = Math.floor(actor.maxHp * 0.88); actor.hpPercent = 100 * actor.hp / actor.maxHp;
		const reversed = { ...state, self: state.opponent, opponent: state.self };
		const replies = new Search(new MatchupEvaluator()).choices(reversed, 'opponent');
		assert(replies.some(a => a.move === 'softboiled'));
		assert(replies.some(a => a.move === 'seismictoss'));
	});
});
