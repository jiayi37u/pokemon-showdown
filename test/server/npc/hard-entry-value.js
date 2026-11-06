'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');

describe('Hard executable matchup answers', () => {
	let battle;
	afterEach(() => battle?.destroy());
	function fixture(moves = ['tackle']) {
		battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Own', team: [{ species: 'Mew', ability: 'Synchronize', moves }] },
			p2: { name: 'Foe', team: [{ species: 'Mew', ability: 'Synchronize', moves: ['tackle'] }] },
		});
		battle.makeChoices();
		const state = projectedState(battle);
		const actor = state.self.active[0], target = state.opponent.active[0];
		Object.assign(actor.baseStats, { atk: 600, def: 500, spe: 300 });
		Object.assign(target.baseStats, { atk: 100, def: 200, spe: 200 });
		return { state, actor, target };
	}
	function matchup(state) { return new MatchupEvaluator().assess(state).matrix[0][0].self; }
	function hit(state, actor, target, id = 'tackle') {
		return calculateDamage(actor, target, hardMove(id, 1, state.field.formatId), state.field).average;
	}
	it('charges no retaliation for a faster knockout', () => {
		const { state, target } = fixture();
		target.hp = 1; target.hpPercent = 100 / target.maxHp;
		const result = matchup(state);
		assert.equal(result.check, 1);
		assert.equal(result.answerValue, 1);
	});
	it('charges a slower winner for the attack it must receive', () => {
		const { state, actor, target } = fixture();
		actor.baseStats.spe = 100;
		target.hp = 1; target.hpPercent = 100 / target.maxHp;
		const result = matchup(state);
		assert.equal(result.check, 1);
		assert.equal(result.answerValue, 1 - hit(state, target, actor) / actor.maxHp);
	});
	it('charges retaliation when a faster winning attack cannot knock out immediately', () => {
		const { state, actor, target } = fixture();
		assert(hit(state, actor, target) < target.hp);
		const result = matchup(state);
		assert.equal(result.check, 1);
		assert.equal(result.answerValue, 1 - hit(state, target, actor) / actor.maxHp);
	});
	it('keeps the lower-cost winning move even after another move supplies check and pressure', () => {
		const { state, actor, target } = fixture(['tackle', 'quickattack']);
		actor.baseStats.spe = 100;
		target.hp = 1; target.hpPercent = 100 / target.maxHp;
		assert.equal(matchup(state).answerValue, 1);
	});
	it('charges a reserve answer for entry and its own first exchange', () => {
		const { state, actor, target } = fixture();
		const result = matchup(state);
		assert.equal(result.counter, 1);
		assert.equal(result.entryAnswerValue, 1 - 2 * hit(state, target, actor) / actor.maxHp);
		assert(result.entryAnswerValue < result.answerValue);
	});
	for (const faster of [false, true]) {
		it(`values established poison plus ${faster ? 'faster' : 'slower'} recovery by its net HP cost`, () => {
			const { state, actor, target } = fixture(['recover']);
			actor.baseStats.spe = faster ? 300 : 100;
			target.moves = ['seismictoss']; target.status = 'psn';
			const result = matchup(state);
			assert.equal(result.check, 0.75);
			assert.equal(result.answerValue, faster ? 0.75 - 100 / actor.maxHp : 0.75);
		});
	}
});
