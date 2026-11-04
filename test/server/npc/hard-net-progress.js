'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { getEffectiveHpAfterSecondary } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { projectedState } = require('./helpers/hard-state');

describe('Hard sustainable attack progress', () => {
	const battles = [];
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function fixture() {
		const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
			p1: { name: 'Self', team: [{ species: 'Excadrill', ability: 'Mold Breaker', moves: ['rapidspin'] }] },
			p2: { name: 'Foe', team: [{ species: 'Zapdos', ability: 'Pressure', moves: ['hurricane'] }] } });
		battles.push(battle); battle.makeChoices();
		const state = projectedState(battle), actor = state.self.active[0], target = state.opponent.active[0];
		Object.assign(actor, { hp: 296, maxHp: 415, hpPercent: 100 * 296 / 415,
			baseStats: { hp: 415, atk: 306, def: 156, spa: 122, spd: 229, spe: 244 } });
		Object.assign(target, { hp: 383, maxHp: 383, hpPercent: 100,
			baseStats: { hp: 383, atk: 194, def: 289, spa: 286, spd: 216, spe: 244 } });
		const evaluator = new MatchupEvaluator();
		const damage = (user, foe, id) => evaluator.attack(state, user, foe,
			hardMove(id, 1, state.field.formatId)).damage;
		return { state, actor, target, damage, matchup: () => evaluator.pairs(state, [[0, 0]])[0].self };
	}
	it('retains immediate switch pressure when end-of-turn recovery cancels every hit', () => {
		const { state, actor, target, damage, matchup } = fixture();
		target.item = 'leftovers';
		const dealt = damage(actor, target, 'rapidspin');
		assert.equal(dealt, 17.125);
		assert.equal(getEffectiveHpAfterSecondary({ ...target, hp: target.hp - dealt }, '', '', state.field), target.hp);
		const result = matchup();
		assert.equal(result.check, 0);
		assert.equal(result.counter, 0);
		assert.equal(result.pressure, 0);
		assert.equal(result.entryPressure, 0);
		assert.equal(result.switchPressure.rapidspin, dealt / target.hp);
	});
	it('does not turn a 361-hit race into an eight-turn winning matchup', () => {
		const { actor, target, damage, matchup } = fixture();
		actor.hp = 50; actor.hpPercent = 100 * actor.hp / actor.maxHp;
		actor.baseStats.atk = 1; target.baseStats.spa = 1;
		assert.equal(Math.ceil(target.hp / damage(actor, target, 'rapidspin')), 361);
		assert.equal(damage(target, actor, 'hurricane'), 1);
		const result = matchup();
		assert.equal(result.check, 0);
		assert.equal(result.counter, 0);
		assert(result.pressure > 0, 'A losing long race can still make some progress');
	});
	it('preserves a first-hit KO before passive recovery at full or low target HP', () => {
		for (const hp of [383, 10, 1]) {
			const { actor, target, damage, matchup } = fixture();
			target.item = 'leftovers'; target.hp = hp; target.hpPercent = 100 * hp / target.maxHp;
			if (hp === target.maxHp) { actor.moves = ['rockslide']; actor.boosts.atk = 6; }
			const move = actor.moves[0];
			assert(damage(actor, target, move) >= hp);
			const result = matchup();
			assert.equal(result.check, 1);
			assert.equal(result.switchPressure[move], 1);
			assert(result.pressure > 0.8);
		}
	});
	it('retains poison progress even when Leftovers cancels the direct hit', () => {
		const { target, matchup } = fixture();
		target.item = 'leftovers'; target.status = 'psn';
		const result = matchup();
		assert(result.pressure > result.switchPressure.rapidspin, 'Poison adds progress beyond immediate chip');
		assert(result.switchPressure.rapidspin > 0);
	});
	it('does not award sustained direct progress against recovery that cancels the attack', () => {
		const { target, matchup } = fixture();
		target.item = 'leftovers'; target.moves.push('roost');
		const result = matchup();
		assert.equal(result.check, 0);
		assert.equal(result.pressure, 0);
		assert(result.switchPressure.rapidspin > 0, 'Immediate chip retains its separate meaning');
	});
	it('keeps a sustainable Toxic route when the direct attack makes no net progress', () => {
		const { actor, target, matchup } = fixture();
		actor.moves.push('toxic', 'rest'); target.item = 'leftovers';
		const result = matchup();
		assert(result.check >= 0.75);
		assert(result.pressure >= 0.35);
	});
});
