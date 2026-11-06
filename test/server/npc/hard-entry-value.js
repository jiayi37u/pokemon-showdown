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
		assert(result.answerValue > 0 && result.answerValue < result.check);
	});
	it('charges retaliation when a faster winning attack cannot knock out immediately', () => {
		const { state, actor, target } = fixture();
		assert(hit(state, actor, target) < target.hp);
		const result = matchup(state);
		assert.equal(result.check, 1);
		assert(result.answerValue > 0 && result.answerValue < result.check);
	});
	it('keeps the lower-cost winning move even after another move supplies check and pressure', () => {
		const { state, actor, target } = fixture(['tackle', 'quickattack']);
		actor.baseStats.spe = 100;
		target.hp = 1; target.hpPercent = 100 / target.maxHp;
		assert.equal(matchup(state).answerValue, 1);
	});
	it('charges a reserve answer for entry and its own first exchange', () => {
		const { state } = fixture();
		const result = matchup(state);
		assert.equal(result.counter, 1);
		assert(result.entryAnswerValue >= 0);
		assert(result.entryAnswerValue < result.answerValue);
	});
	for (const example of [
		{ name: 'cannot break passive recovery with weak attacks between heals', dealt: 80, item: 'Leftovers', check: 0 },
		{ name: 'can progress against a target without passive recovery', dealt: 80, item: '', check: 1 },
		{ name: 'can break passive recovery with stronger attacks', dealt: 200, item: 'Leftovers', check: 1 },
		{ name: 'can attack twice before healing instead of alternating every turn', dealt: 100, item: 'Leftovers', check: 1 },
		{ name: 'uses its own passive recovery to spend more turns attacking', dealt: 80,
			item: 'Leftovers', ownItem: 'Leftovers', check: 1 },
		{ name: 'keeps an immediate knockout without needing sustainable recovery', dealt: 120,
			item: 'Leftovers', targetHP: 100, check: 1 },
	]) {
		it(example.name, () => {
			const { state, actor, target } = fixture(['tackle', 'recover']);
			Object.assign(actor, { hp: 600, maxHp: 600, hpPercent: 100, item: example.ownItem || '' });
			Object.assign(target, { hp: example.targetHP || 1000, maxHp: 1000,
				hpPercent: example.targetHP ? 10 : 100, item: example.item });
			// Isolate recovery cadence: 300 HP per recovery, 100 HP incoming per turn,
			// and 62 HP passive healing on the target, independent of damage rolls.
			const evaluator = new MatchupEvaluator();
			evaluator.attack = (view, source) => ({ damage: source.ownerSide === 'p1' ? example.dealt : 100, delay: 0 });
			assert.equal(evaluator.assess(state).matrix[0][0].self.check > 0, example.check > 0);
		});
	}
	for (const faster of [false, true]) {
		it(`values established poison plus ${faster ? 'faster' : 'slower'} recovery by its net HP cost`, () => {
			const { state, actor, target } = fixture(['recover']);
			actor.baseStats.spe = faster ? 300 : 100;
			target.moves = ['seismictoss']; target.status = 'psn';
			const result = matchup(state);
			assert(result.check > 0);
			if (faster) assert(result.answerValue < result.check);
			else assert.equal(result.answerValue, result.check);
		});
	}
});
