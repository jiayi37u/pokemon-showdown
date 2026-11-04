'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { beginTurn, continueTurn } = require('../../../dist/server/npc/ai/hard/projection');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { createCache } = require('../../../dist/server/npc/ai/cfru/util/cache');
const battles = [];
function fixture(move = 'uturn', target = { species: 'Keldeo' }) {
	const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Self', team: [{ species: 'Mew', moves: [move, 'tackle'] },
			{ species: 'Mew', moves: ['psychic'] }] },
		p2: { name: 'Foe', team: [{ ...target, moves: ['splash'] }] } });
	battles.push(battle); battle.makeChoices();
	const state = projectedState(battle), actor = state.self.active[0], foe = state.opponent.active[0];
	actor.baseStats = { ...actor.baseStats, atk: 1, spa: 1 };
	const model = { name: 'known', pokemon: foe, weight: 1, matched: true,
		moves: [{ id: 'splash', availability: 1 }] };
	const evaluator = new HardEvaluation(state, state.field.formatId, new Map([[foe, [model]]]));
	return { state, actor, foe, evaluator, move: hardMove(move, 1, state.field.formatId) };
}
const lowDamage = score => score.breakdown.details.some(d => /low damage/i.test(d.reason));
describe('Hard pivot scoring', () => {
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	it('retains a weak pivot purpose in scoring and prediction while ordinary weak attacks retain their penalty', () => {
		const f = fixture();
		for (const prediction of [false, true]) {
			const scores = f.evaluator.baseScores(f.state, f.actor,
				[f.move, hardMove('tackle', 2, f.state.field.formatId)], f.foe, prediction);
			assert(!lowDamage(scores[0]));
			assert(lowDamage(scores[1]));
			assert(scores[0].breakdown.details.some(d => d.reason.includes('Resisted')),
				'Resistance still affects direct damage scoring');
		}
		const normal = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: f.state.field.formatId }, createCache(f.state.turn));
		assert(lowDamage(normal.scoreMoves(f.state, f.actor, [f.move], f.foe)[0]));
	});
	it('retains the damage penalty when no living recipient remains', () => {
		const f = fixture();
		f.state.self.reserve[0].hp = 0; f.state.self.reserve[0].fainted = true;
		assert(lowDamage(f.evaluator.baseScores(f.state, f.actor, [f.move], f.foe)[0]));
	});
	for (const [move, target] of [
		['voltswitch', { species: 'Garchomp' }],
		['voltswitch', { species: 'Lanturn', ability: 'Volt Absorb' }],
		['uturn', { species: 'Shedinja', ability: 'Wonder Guard' }],
	]) {
		it(`gives no pivot benefit when ${target.species} blocks ${move}`, () => {
			const f = fixture(move, target);
			const predictions = new Map([[f.foe, [{ move: hardMove('splash', 1, f.state.field.formatId),
				weight: 1, switching: false }]]]);
			const score = f.evaluator.scoreMoves(f.actor, [f.move], f.foe, predictions, [])[0];
			assert(score.flags.isImmune || score.flags.hasNoEffect);
			assert.equal(score.score, 0);
			assert(!score.breakdown.details.some(d => d.reason.includes('CFRU pivot')));
			const turn = beginTurn(f.state, { id: 'move 1', move, prior: 0 }, { id: 'pass', prior: 0 });
			assert(continueTurn(turn), 'The move finishes without a pivot request');
			assert(!turn.pending);
			assert.equal(turn.state.self.active[0].ident, f.actor.ident);
		});
	}
});
