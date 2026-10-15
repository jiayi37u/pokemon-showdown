'use strict';

const assert = require('../../assert');
const { Battle } = require('../../../dist/sim');
const { buildAIMove, trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
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

function score(id, {
	actor = pokemon(), target = pokemon(), partner = false, field = {}, conditions = {}, positive, formatId = '',
} = {}) {
	const own = partner ? [actor, target] : [actor];
	const foes = partner ? [pokemon()] : [target];
	const state = {
		turn: 1, isDoubles: partner,
		self: { active: own, reserve: [], team: own, conditions },
		opponent: { active: foes, reserve: [], team: foes, conditions },
		field: { weather: '', terrain: '', trickroom: false, ...field },
	};
	const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(1));
	if (positive) engine.setScorers([], [positive]);
	return engine.scoreMove(state, actor, buildAIMove({ id }, 1), target);
}

const hasReason = (result, reason) => result.breakdown.details.some(detail => detail.reason.includes(reason));

describe('CFRU scoring with production move metadata', () => {
	it('assigns zero damage and no KO rewards to Ground attacks blocked by Air Balloon', () => {
		const actor = pokemon({ types: ['Ground'], moves: ['earthquake'], baseStats: {
			hp: 300, atk: 400, def: 200, spa: 200, spd: 200, spe: 300,
		} });
		const target = pokemon({ species: 'Bastiodon', types: ['Rock', 'Steel'], item: 'Air Balloon' });
		const result = score('earthquake', { actor, target });
		assert.equal(result.score, 0);
		assert.equal(result.flags.canKO, false);
		assert.equal(result.flags.can2HKO, false);
		assert.equal(result.flags.isImmune, true);
		assert.equal(result.flags.hasNoEffect, true);
		assert.equal(result.breakdown.positives, 0);
		assert.equal(calculateDamage(actor, target, buildAIMove({ id: 'earthquake' }, 1), {}).average, 0);
		for (const overrides of [
			{ field: { gravity: true } }, { field: { magicroom: true } },
			{ target: { ...target, item: '', itemLost: true } },
			{ target: { ...target, ability: 'Klutz' } },
			...['embargo', 'ingrain', 'smackdown'].map(id => ({ target: { ...target, volatiles: new Set([id]) } })),
		]) {
			const grounded = score('earthquake', { actor, target, ...overrides });
			assert(!hasReason(grounded, 'Air Balloon'));
			assert.equal(grounded.flags.canKO, true);
		}
		assert(!hasReason(score('thousandarrows', { actor, target }), 'Air Balloon'));
	});

	for (const id of ['gigadrain', 'drainpunch']) {
		it(`logs every drain reward for ${id}`, () => {
			for (const hpPercent of [100, 70, 50, 25]) {
				const result = score(id, { actor: pokemon({ hp: hpPercent * 3, hpPercent }) });
				assert.equal(result.breakdown.details.reduce((sum, d) => sum + d.amount, 100), result.score);
				if (hpPercent === 100) assert(hasReason(result, 'Drain move at high HP'));
			}
		});
	}

	for (const [formatId, immune] of [
		['gen5customgame', false], ['gen6customgame', false], ['gen7customgame', true],
		['gen8customgame', true], ['gen9customgame', true], ['gen5pokemmoou', true],
		['gen5pokemmouu', true], ['gen5pokemmonu', true], ['gen5pokemmorandombattle', true],
		['gen5pokemmomultirandombattle', true],
	]) {
		it(`matches actual Prankster immunity in ${formatId}`, () => {
			const actor = pokemon({ species: 'Liepard', ability: 'Prankster', types: ['Dark'] });
			const target = pokemon({ species: 'Weavile', types: ['Dark', 'Ice'] });
			for (const id of ['thunderwave', 'taunt', 'toxic']) {
				const result = score(id, { actor, target, formatId });
				assert.equal(hasReason(result, 'Dark target immune to Prankster'), immune);
				if (immune) {
					assert.equal(result.score, 0);
					assert.equal(result.breakdown.negatives, -100);
					assert.equal(result.breakdown.positives, 0);
					assert.equal(result.flags.hasNoEffect, true);
					assert.equal(result.flags.isImmune, true);
				} else {
					assert(result.score > 0);
				}
			}
			// Validate against a real battle, including format/ruleset onBattleStart hooks.
			const multi = formatId.includes('multi');
			const partner = { species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] };
			const battle = new Battle({
				formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [{ species: 'Weavile', ability: 'Pressure', moves: ['splash'] }] },
				p2: { name: 'NPC', team: [{ species: 'Liepard', ability: 'Prankster', moves: ['taunt'] }] },
				...(multi ? { p3: { name: 'Ally1', team: [partner] }, p4: { name: 'Ally2', team: [partner] } } : {}),
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				if (multi) battle.makeChoices('move 1', 'move 1 1', 'move 1', 'move 1');
				else battle.makeChoices('move 1', 'move 1');
				assert.equal(!!battle.p1.active[0].volatiles.taunt, !immune);
				assert.equal(battle.log.some(line => line.startsWith('|-immune|p1a: Weavile')), immune);
			} finally {
				battle.destroy();
			}
		});
	}

	it('does not apply Prankster immunity to attacks, self/field moves, allies or a different ability', () => {
		const actor = pokemon({ ability: 'Prankster' });
		const target = pokemon({ types: ['Dark'] });
		for (const id of ['darkpulse', 'protect', 'swordsdance', 'curse', 'sunnyday', 'electricterrain', 'stealthrock', 'haze']) {
			assert(!hasReason(score(id, { actor, target }), 'Dark target immune to Prankster'), id);
		}
		assert(!hasReason(score('thunderwave', { actor: pokemon({ ability: 'Limber' }), target }), 'Prankster'));
		assert(!hasReason(score('thunderwave', { actor, target: pokemon({ types: ['Water'] }) }), 'Prankster'));
		assert(!hasReason(score('swagger', { actor, target, partner: true }), 'Prankster'));
	});

	for (const status of ['psn', 'tox', 'par', 'brn', 'slp', 'frz']) {
		it(`does not reward inflicting status against a target with ${status}`, () => {
			for (const id of ['toxic', 'willowisp', 'thunderwave', 'stunspore', 'glare', 'sleeppowder', 'spore']) {
				const result = score(id, { target: pokemon({ status }) });
				assert.equal(result.breakdown.positives, 0, id);
				assert.equal(100 + result.breakdown.details.reduce((sum, d) => sum + d.amount, 0), result.score);
			}
		});
	}

	it('does not reward Toxic when the target is immune to poison', () => {
		for (const target of [pokemon({ types: ['Steel'] }), pokemon({ ability: 'Immunity' })]) {
			const result = score('toxic', { target });
			assert.equal(result.breakdown.positives, 0);
			assert.equal(result.flags.hasNoEffect, true);
		}
	});

	it('logs every paralysis bonus and does not reward burning or paralyzing immune targets', () => {
		const result = score('thunderwave');
		assert.equal(result.breakdown.positives, 6);
		assert(hasReason(result, 'Reliable accuracy for paralysis'));
		assert.equal(100 + result.breakdown.details.reduce((sum, d) => sum + d.amount, 0), result.score);
		for (const [id, target] of [
			['willowisp', pokemon({ types: ['Fire'] })], ['willowisp', pokemon({ ability: 'Water Veil' })],
			['thunderwave', pokemon({ types: ['Ground'] })], ['thunderwave', pokemon({ ability: 'Limber' })],
		]) {
			assert.equal(score(id, { target }).breakdown.positives, 0);
		}
	});

	it('requires evidence of no recovery, including Wish, before rewarding Toxic', () => {
		for (const [moves, expected] of [
			[['tackle'], 108], [['recover'], 108], [['wish'], 108],
			[['tackle', 'psychic', 'psychocut', 'swordsdance'], 111],
			[['tackle', 'psychic', 'psychocut', 'wish'], 108],
		]) {
			const result = score('toxic', { target: pokemon({ moves }) });
			assert.equal(result.score, expected);
			assert.equal(hasReason(result, 'No recovery in'), expected === 111);
			assert.equal(100 + result.breakdown.details.reduce((sum, d) => sum + d.amount, 0), result.score);
		}
	});

	it('uses compatible preset candidates for recovery without filling unknown slots', () => {
		const revealedMoves = ['tackle'];
		const target = pokemon({ moves: revealedMoves, moveKnowledge: {
			revealedMoves, presetCandidates: ['wish'], remainingSlots: 3,
		} });
		assert.equal(score('toxic', { target }).score, 108);
		target.moveKnowledge.presetCandidates = ['psychic'];
		assert.equal(score('toxic', { target }).score, 108, 'A partial preset does not rule out recovery');
		target.moveKnowledge.movePools = [['tackle', 'psychic', 'psychocut', 'swordsdance']];
		assert.equal(score('toxic', { target }).score, 111, 'A bounded pool can rule out recovery');
		assert.equal(score('saltcure', { target }).score,
			score('saltcure', { target: pokemon({ moves: revealedMoves }) }).score + 2);
	});

	it('recognizes recovery in both Gen5 random Blissey roles before a healing move is revealed', () => {
		for (const moves of [[], ['protect'], ['softboiled']]) {
			const tracker = createBattleTracker('p2');
			tracker.parseMessage('|switch|p1a: Foe|Blissey, L84|100/100');
			for (const move of moves) tracker.parseMessage(`|move|p1a: Foe|${move}|p1a: Foe`);
			const target = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen5pokemmorandombattle');
			assert.equal(target.presetModels.length, moves.length ? 1 : 2);
			assert.equal(score('toxic', { target }).score, 108);
			assert(!hasReason(score('saltcure', { target }), 'No recovery in'));
			assert.deepEqual(target.moves, moves);
		}
	});

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
