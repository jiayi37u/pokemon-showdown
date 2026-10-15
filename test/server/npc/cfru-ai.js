'use strict';

const assert = require('../../assert');
const { buildAIMove } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { rewardSetupMove, rewardEncore } = require('../../../dist/server/npc/ai/cfru/scoring/positives');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getBestKOMove } = require('../../../dist/server/npc/ai/cfru/util/knockout');

function pokemon(overrides = {}) {
	return {
		...makeAIPokemonSkeleton({
			slot: 1, species: 'Mew', hp: 300, maxHp: 300, hpPercent: 100, status: '', fainted: false,
			types: ['Psychic'], ability: '', item: '', moves: ['swordsdance', 'psychocut', 'psychic'],
			baseStats: { hp: 300, atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
			active: true, level: 100, gender: 'N',
		}),
		...overrides,
	};
}

function score(id, { actor = pokemon(), target = pokemon(), partner = false, field = {}, conditions = {}, positive } = {}) {
	const own = partner ? [actor, target] : [actor];
	const foes = partner ? [pokemon()] : [target];
	const state = {
		turn: 1, isDoubles: partner,
		self: { active: own, reserve: [], team: own, conditions },
		opponent: { active: foes, reserve: [], team: foes, conditions },
		field: { weather: '', terrain: '', trickroom: false, ...field },
	};
	const engine = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache(1));
	if (positive) engine.setScorers([], [positive]);
	return engine.scoreMove(state, actor, buildAIMove({ id }, 1), target);
}

const hasReason = (result, reason) => result.breakdown.details.some(detail => detail.reason.includes(reason));

describe('CFRU scoring with production move metadata', () => {
	for (const [ability, species, types, field, reason] of [
		['Flower Veil', 'Florges', ['Grass'], {}, 'Flower Veil protects'],
		['Shields Down', 'Minior-Meteor', ['Rock', 'Flying'], {}, 'Shields Down blocks status'],
		['Leaf Guard', 'Leafeon', ['Grass'], { weather: 'sun' }, 'Leaf Guard blocks status'],
	]) {
		it(`penalizes direct status against ${ability}, without penalizing ordinary attacks`, () => {
			const target = pokemon({ ability, species, types });
			assert(hasReason(score('toxic', { target, field }), reason));
			assert(!hasReason(score('tackle', { target, field }), reason));
			assert(!hasReason(score('toxic', { target: pokemon({ species, types }), field }), reason));
		});
	}

	it('limits the status protections to Grass types, meteor form and sun respectively', () => {
		assert(!hasReason(score('toxic', { target: pokemon({ ability: 'Flower Veil' }) }), 'Flower Veil protects'));
		assert(!hasReason(score('toxic', { target: pokemon({ ability: 'Shields Down', species: 'Minior', hpPercent: 40 }) }), 'Shields Down blocks'));
		assert(!hasReason(score('toxic', { target: pokemon({ ability: 'Leaf Guard' }) }), 'Leaf Guard blocks'));
	});

	it('rejects stat-lowering moves on a partner while allowing Coaching', () => {
		const target = pokemon({ slot: 2 });
		const harmful = score('tickle', { target, partner: true });
		assert.equal(harmful.score, 0);
		assert(hasReason(harmful, 'Lowering partner stats'));
		const helpful = score('coaching', { target, partner: true });
		assert(helpful.score > 0);
		assert(!hasReason(helpful, 'Lowering partner stats'));
	});

	it('retains poison utility against Magic Guard when the attacker has Venoshock', () => {
		const target = pokemon({ ability: 'Magic Guard' });
		const withVenoshock = score('toxic', { target, actor: pokemon({ moves: ['toxic', 'venoshock'] }) });
		const withoutVenoshock = score('toxic', { target, actor: pokemon({ moves: ['toxic', 'sludgebomb'] }) });
		assert(!hasReason(withVenoshock, 'Magic Guard prevents poison damage'));
		assert(hasReason(withoutVenoshock, 'Magic Guard prevents poison damage'));
	});

	it('penalizes reflected status moves but not ordinary attacks against Magic Bounce', () => {
		const target = pokemon({ ability: 'Magic Bounce' });
		assert(hasReason(score('thunderwave', { target }), 'Magic Bounce'));
		assert(!hasReason(score('earthquake', { target }), 'Magic Bounce'));
	});

	for (const [move, status] of [['thunderwave', 'par'], ['spore', 'slp'], ['toxic', 'tox']]) {
		it(`reduces ${move} value when the target already has ${status}`, () => {
			assert(score(move, { target: pokemon({ status }) }).score < score(move).score);
		});
	}

	for (const [move, conditions] of [
		['stealthrock', { stealthrock: true }], ['spikes', { spikes: 3 }], ['toxicspikes', { toxicspikes: 2 }],
		['reflect', { reflect: 5 }], ['lightscreen', { lightscreen: 5 }], ['auroraveil', { auroraveil: 5 }],
	]) {
		it(`reduces ${move} value when already fully established`, () => {
			assert(score(move, { conditions, field: { weather: 'snow' } }).score < score(move, { field: { weather: 'snow' } }).score);
		});
	}

	it('penalizes Aurora Veil without snow or hail', () => {
		assert(score('auroraveil', { field: { weather: 'sun' } }).score < score('auroraveil', { field: { weather: 'snow' } }).score);
	});

	it('applies Dazzling checks to priority attacks, not regular attacks or self protection', () => {
		const target = pokemon({ ability: 'Dazzling' });
		assert(hasReason(score('quickattack', { target }), 'blocks priority moves'));
		assert(!hasReason(score('tackle', { target }), 'blocks priority moves'));
		assert(!hasReason(score('protect', { target }), 'blocks priority moves'));
	});

	it('uses actual setup scoring for diminishing returns, exhausted boosts and critical HP', () => {
		const actor = pokemon();
		const rewards = [0, 2, 4, 6].map(atk => score('swordsdance', {
			actor: { ...actor, boosts: { ...actor.boosts, atk } }, positive: rewardSetupMove,
		}).score);
		assert(rewards[0] > rewards[1] && rewards[1] > rewards[2]);
		assert.equal(rewards[3], 100); // No setup reward when Attack cannot rise.
		assert.equal(score('swordsdance', { actor: pokemon({ hp: 60, hpPercent: 20 }), positive: rewardSetupMove }).score, 100);
		const target = pokemon();
		assert(score('swordsdance', {
			target: { ...target, boosts: { ...target.boosts, def: 2 } }, positive: rewardSetupMove,
		}).score > rewards[0]);
	});

	it('recognizes type immunity when rewarding Encore', () => {
		for (const [move, type] of [
			['earthquake', 'Flying'], ['thunderbolt', 'Ground'], ['tackle', 'Ghost'], ['shadowball', 'Normal'],
			['psychic', 'Dark'], ['dragonclaw', 'Fairy'], ['sludgebomb', 'Steel'], ['nightshade', 'Normal'],
		]) {
			const target = pokemon({ lastMove: move });
			const neutral = score('encore', { target, actor: pokemon({ types: ['Water'] }), positive: rewardEncore });
			const immune = score('encore', { target, actor: pokemon({ types: [type] }), positive: rewardEncore });
			assert(immune.score > neutral.score, `${move} into ${type}`);
		}
	});

	it('uses recoil metadata for Reckless damage and reliable KO selection', () => {
		const actor = pokemon({ types: ['Normal'], moves: ['doubleedge', 'return'] });
		const target = pokemon();
		const move = buildAIMove({ id: 'doubleedge' }, 1);
		const field = { weather: '', terrain: '', trickroom: false };
		const normal = calculateDamage(actor, target, move, field);
		const reckless = calculateDamage({ ...actor, ability: 'Reckless' }, target, move, field);
		assert(reckless.average > normal.average);
		const best = getBestKOMove(actor, { ...target, hp: 1, hpPercent: 100 / target.maxHp }, [move, buildAIMove({ id: 'return' }, 2)], field);
		assert.equal(best.id, 'return');
	});
});
