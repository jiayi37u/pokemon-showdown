'use strict';

const assert = require('../../assert');
const { Battle } = require('../../../dist/sim');
const { buildAIMove, trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { rewardSetupMove, rewardDefensiveSetup, rewardEncore } = require('../../../dist/server/npc/ai/cfru/scoring/positives');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getBestKOMove } = require('../../../dist/server/npc/ai/cfru/util/knockout');
const { resolveMove } = require('../../../dist/server/npc/ai/cfru/util/type-calc');
const { canRestoreUserHp, recoveryKind, painSplitRecovery } = require('../../../dist/server/npc/ai/cfru/util/move-effects');
const { getOpponentPreset, computeStatsFromPreset } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
const { Dex } = require('../../../dist/sim');

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
	actor = pokemon(), target = pokemon(), partner = false, field = {}, conditions = {}, positive, formatId = '', reserve = [],
} = {}) {
	const own = partner ? [actor, target] : [actor];
	const foes = partner ? [pokemon()] : [target];
	const state = {
		turn: 1, isDoubles: partner,
		self: { active: own, reserve, team: [...own, ...reserve], conditions },
		opponent: { active: foes, reserve: [], team: foes, conditions },
		field: { weather: '', terrain: '', trickroom: false, ...field },
	};
	const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(1));
	if (positive) engine.setScorers([], [positive]);
	return engine.scoreMove(state, actor, buildAIMove({ id }, 1), target);
}

const hasReason = (result, reason) => result.breakdown.details.some(detail => detail.reason.includes(reason));

describe('CFRU scoring with production move metadata', () => {
	it('resolves Photon Geyser using staged stats, with special winning ties and no item/ability bias', () => {
		const actor = pokemon({ ability: 'Huge Power', item: 'Choice Band' });
		const target = pokemon();
		const field = { weather: '', terrain: '', formatId: 'gen9customgame' };
		const move = buildAIMove({ id: 'photongeyser' }, 1);
		assert.equal(resolveMove(actor, move, field).category, 'Special');
		const initial = calculateDamage(actor, target, move, field).average;
		actor.boosts.atk = 2;
		assert.equal(resolveMove(actor, move, field).category, 'Physical');
		assert(calculateDamage(actor, target, move, field).average > initial * 2);
		actor.moves = ['photongeyser', 'swordsdance'];
		assert(score('swordsdance', { actor: { ...actor, item: '' } }).score > 100,
			'Physical Photon Geyser benefits from Attack setup');
		actor.boosts.spa = 2;
		assert.equal(resolveMove(actor, resolveMove(actor, move, field), field).category, 'Special');
	});

	it('applies Tera Shell to all hits at full HP, retaining immunities, fixed damage and ability bypass', () => {
		const actor = pokemon();
		const target = pokemon({ species: 'Terapagos-Terastal', types: ['Normal'], ability: 'Tera Shell' });
		const field = { weather: '', terrain: '', formatId: 'gen9customgame' };
		const damage = (id, a = actor, d = target) => calculateDamage(a, d, buildAIMove({ id }, 1), field);
		assert.equal(damage('closecombat').effectiveness, 0.5);
		assert.equal(damage('shadowsneak').max, 0);
		assert.equal(damage('seismictoss').average, 100);
		assert.equal(damage('struggle').effectiveness, 1);
		assert.equal(damage('tackle', { ...actor, ability: 'Mold Breaker' }).effectiveness, 1);
		assert.equal(damage('tackle', actor, { ...target, hp: 299, hpPercent: 99.67 }).effectiveness, 1);
		const multi = damage('bulletseed');
		const noAbility = damage('bulletseed', actor, { ...target, ability: '' });
		assert(multi.average < noAbility.average * 0.55);
	});

	for (const formatId of ['gen5customgame', 'gen5pokemmorandombattle', 'gen9customgame']) {
		it(`${formatId}: Facade excludes sleep and gems apply before Acrobatics power`, () => {
			const field = { weather: '', terrain: '', formatId };
			const target = pokemon();
			const damage = (id, actor, extraField = {}) => calculateDamage(actor, target,
				buildAIMove({ id }, 1, formatId), { ...field, ...extraField }).average;
			const healthy = damage('facade', pokemon());
			assert.equal(damage('facade', pokemon({ status: 'slp' })), healthy);
			assert(damage('facade', pokemon({ status: 'par' })) > healthy * 1.9);
			const gem = pokemon({ item: 'Flying Gem', itemKnown: true });
			const held = damage('acrobatics', pokemon({ item: 'Leftovers' }));
			const empty = damage('acrobatics', pokemon({ itemKnown: true }));
			const boosted = damage('acrobatics', gem);
			assert(boosted > empty * (formatId === 'gen9customgame' ? 1.25 : 1.4));
			assert.equal(damage('acrobatics', gem, { magicroom: true }), held);
			assert.equal(damage('acrobatics', { ...gem, ability: 'Klutz' }), held);
			assert.equal(damage('acrobatics', { ...gem, item: 'Water Gem' }), held);
			assert.equal(damage('firepledge', { ...gem, item: 'Fire Gem' }), damage('firepledge', pokemon()),
				'Pledge moves are exempt from gems in the engine');
			assert.equal(gem.item, 'Flying Gem', 'Estimation must not consume the snapshot item');
		});
	}

	it('rewards Rest recovery at low HP while keeping delayed and sacrificial healing separate', () => {
		for (const [hp, expected] of [[144, 108], [57, 112], [300, 60]]) {
			const actor = pokemon({ hp, hpPercent: hp / 3, moves: ['rest', 'sleeptalk'] });
			assert.equal(score('rest', { actor }).score, expected);
		}
		assert(!hasReason(score('wish', { actor: pokemon({ hp: 60, hpPercent: 20 }) }), 'Healing at'));
		assert(!hasReason(score('healingwish', { actor: pokemon({ hp: 60, hpPercent: 20 }) }), 'Healing at'));
		const injured = pokemon({ hp: 60, hpPercent: 20 });
		assert.equal(score('rest', { actor: injured, field: { terrain: 'electric' } }).score, 0);
		assert.equal(score('rest', { actor: { ...injured, ability: 'Insomnia' } }).score, 0);
		assert.equal(score('rest', { actor: { ...injured, status: 'slp', sleepTurns: 1 } }).score, 112);
		assert.equal(score('rest', { actor: { ...injured, status: 'slp', sleepTurns: 2 } }).score, 0);
	});

	it('discourages Protect only when known residual damage remains lethal after recovery', () => {
		const actor = pokemon({ hp: 13, maxHp: 364, hpPercent: 13 / 364 * 100, status: 'psn', item: 'Leftovers' });
		assert.equal(score('protect', { actor }).score, 60);
		assert.equal(score('endure', { actor }).score, 60);
		assert(!hasReason(score('protect', { actor, conditions: { wishes: { 1: 1 } } }), 'lethal residual'));
		for (const ability of ['Magic Guard', 'Poison Heal']) {
			assert(!hasReason(score('protect', { actor: { ...actor, ability } }), 'lethal residual'));
		}
		assert(!hasReason(score('protect', { actor: { ...actor, hp: 100, hpPercent: 100 / 364 * 100 } }), 'lethal residual'));
	});

	it('Revival Blessing requires a fainted member belonging to this trainer', () => {
		const actor = pokemon({ ownerSide: 'p2' });
		const fainted = pokemon({ active: false, hp: 0, hpPercent: 0, fainted: true, ownerSide: 'p4' });
		assert.equal(score('revivalblessing', { actor }).score, 0);
		assert.equal(score('revivalblessing', { actor, reserve: [fainted] }).score, 0);
		assert(score('revivalblessing', { actor, reserve: [{ ...fainted, ownerSide: 'p2' }] }).score > 0);
	});

	it('separates speed benefits from Protect and attacking priority', () => {
		const actor = pokemon();
		actor.boosts.spe = 2;
		for (const response of ['protect', 'bulletpunch']) {
			const target = pokemon({ moves: [response, 'tackle'] });
			assert.equal(score('agility', { actor, target }).score, 60, response);
			assert(!hasReason(score('thunderwave', { actor, target }), 'Paralysis on faster target'), response);
			assert.equal(score('psychic', { actor, target }).flags.goesFirst, response === 'protect');
		}
		assert.equal(score('psychic', { actor, target: pokemon({ ability: 'Prankster', moves: ['naturepower'] }) })
			.flags.goesFirst, false, 'Nature Power is an attack with its source move priority');
		const slow = pokemon();
		slow.baseStats.spe = 100;
		assert(score('agility', { actor: slow }).score > 100);
		assert(hasReason(score('thunderwave', { actor: slow }), 'Paralysis on faster target'));
		assert.equal(score('agility', { actor: slow, field: { trickroom: true } }).score, 60);
		assert(!hasReason(score('thunderwave', { actor: slow, field: { trickroom: true } }), 'Paralysis on faster target'));
	});

	it('only rewards priority for an average-damage KO that overtakes a faster attacker', () => {
		const slow = pokemon();
		slow.baseStats.spe = 100;
		const target = pokemon({ hp: 1, hpPercent: 100 / 300, moves: ['protect', 'tackle'] });
		assert(hasReason(score('quickattack', { actor: slow, target }), 'Priority KO'));
		assert(!hasReason(score('quickattack', { target }), 'Priority KO'), 'A speed tie is not slower');
		const fast = pokemon();
		fast.baseStats.spe = 300;
		assert(!hasReason(score('quickattack', { actor: fast, target }), 'Priority KO'));
		assert(!hasReason(score('quickattack', { actor: slow, target: { ...target, moves: ['extremespeed'] } }), 'Priority KO'));
		const healthy = pokemon({ moves: ['tackle'] });
		assert(hasReason(score('quickattack', { actor: slow, target: healthy }), 'Low damage'));
		const damage = calculateDamage(slow, healthy, buildAIMove({ id: 'quickattack' }, 1), {});
		const hp = Math.floor(damage.average) + 1;
		const notReliable = { ...healthy, hp, hpPercent: hp / healthy.maxHp * 100 };
		assert(!hasReason(score('quickattack', { actor: slow, target: notReliable }), 'Priority KO'));
		const remaining = Math.ceil(damage.average * 1.5);
		const twoHits = score('quickattack', { actor: slow, target: { ...healthy, hp: remaining,
			hpPercent: remaining / healthy.maxHp * 100 } });
		assert(twoHits.flags.can2HKO);
		assert(!hasReason(twoHits, 'favorable 2HKO'), 'Priority alone gives no 2HKO speed reward');
	});

	it('rewards every setup stage with a nonincreasing curve', () => {
		for (const [id, stat, positive] of [
			['swordsdance', 'atk', rewardSetupMove], ['calmmind', 'spa', rewardSetupMove],
			['irondefense', 'def', rewardDefensiveSetup], ['amnesia', 'spd', rewardDefensiveSetup],
			['cosmicpower', 'def', rewardDefensiveSetup],
		]) {
			let previous = Infinity;
			for (const stage of [-6, -3, -1, 0, 1, 2, 3, 4, 5, 6]) {
				const actor = pokemon();
				actor.boosts[stat] = stage;
				const result = score(id, { actor, positive });
				assert(result.score <= previous, `${id} at ${stage}`);
				if (stage < 6) assert(result.score > 100, `${id} at ${stage}`);
				assert.equal(100 + result.breakdown.details.reduce((sum, detail) => sum + detail.amount, 0), result.score);
				previous = result.score;
			}
		}
	});

	it('only rewards pivoting into an available reserve owned by the acting trainer', () => {
		const actor = pokemon({ ownerSide: 'p2' });
		for (const id of ['uturn', 'voltswitch', 'flipturn']) {
			assert(!hasReason(score(id, { actor }), 'Pivot move'));
			for (const overrides of [{ ownerSide: 'p4' }, { fainted: true, hp: 0 }, { active: true }]) {
				const reserve = [pokemon({ slot: 2, active: false, ownerSide: 'p2', ...overrides })];
				assert(!hasReason(score(id, { actor, reserve }), 'Pivot move'));
			}
			const reserve = [pokemon({ slot: 2, active: false, ownerSide: 'p2' })];
			assert(hasReason(score(id, { actor, reserve }), 'Pivot move'));
		}
	});

	it('uses 60 for tactical discouragement and zero for confirmed failures', () => {
		for (const [id, options] of [
			['recover', {}], ['protect', { actor: pokemon({ lastMove: 'protect' }) }], ['haze', {}],
			['bellydrum', { actor: pokemon({ ability: 'Contrary' }) }],
			['swordsdance', { actor: pokemon({ ability: 'Contrary' }) }],
		]) {
			const result = score(id, options);
			assert.equal(result.score, 60, id);
			assert.equal(result.flags.hasNoEffect, false, id);
			assert.equal(result.breakdown.positives, 0, id);
		}
		assert.equal(score('bellydrum', { actor: pokemon({ hp: 120, hpPercent: 40, ability: 'Contrary' }) }).score, 0);
		assert.equal(score('toxic', { target: pokemon({ status: 'tox' }) }).score, 0);
		assert.equal(score('earthquake', { target: pokemon({ types: ['Flying'] }) }).score, 0);
	});

	it('discourages low-HP setup without declaring it ineffective or rewarding it again', () => {
		for (const id of ['swordsdance', 'nastyplot', 'dragondance', 'quiverdance', 'irondefense', 'cosmicpower', 'stockpile']) {
			for (const hpPercent of [20, 40]) {
				const result = score(id, { actor: pokemon({ hp: hpPercent * 3, hpPercent }) });
				assert.equal(result.score, 60, id);
				assert.equal(result.breakdown.positives, 0, id);
				assert.equal(result.flags.hasNoEffect, false, id);
				assert.equal(100 + result.breakdown.details.reduce((sum, detail) => sum + detail.amount, 0), result.score);
			}
		}
		assert(score('swordsdance', { actor: pokemon({ hp: 123, hpPercent: 41 }) }).score > 60);
		const actor = pokemon({ hp: 60, hpPercent: 20 });
		actor.boosts.atk = 6;
		assert.equal(score('swordsdance', { actor }).score, 0, 'Confirmed failure still scores zero');
		assert(!hasReason(score('recover', { actor }), 'Setup discouraged'));
		assert(!hasReason(score('tidyup', { actor }), 'Setup discouraged'), 'Clearing the field has independent value');
		assert(hasReason(score('curse', { actor: { ...actor, types: ['Normal'] } }), 'Setup discouraged'));
		assert(!hasReason(score('curse', { actor: { ...actor, types: ['Ghost'] } }), 'Setup discouraged'));
	});

	it('discourages offensive boosts without a matching attack, preserving indirect and variable-power benefits', () => {
		for (const [id, attack] of [['swordsdance', 'psychic'], ['nastyplot', 'psychocut'],
			['swordsdance', 'bodypress'], ['swordsdance', 'seismictoss'], ['swordsdance', 'foulplay']]) {
			assert.equal(score(id, { actor: pokemon({ moves: [id, attack] }) }).score, 60, attack);
		}
		for (const attack of ['lowkick', 'return', 'storedpower', 'powertrip', 'batonpass', 'naturepower']) {
			assert(!hasReason(score('swordsdance', { actor: pokemon({ moves: ['swordsdance', attack] }) }),
				'No attack benefits'), attack);
		}
		assert(!hasReason(score('calmmind', { actor: pokemon({ moves: ['calmmind', 'bodypress'] }) }),
			'No attack benefits'), 'Special Defense still has value');
	});

	it('discourages utility with no useful target without assuming unrevealed moves are absent', () => {
		assert.equal(score('disable').score, 60);
		assert(score('disable', { actor: pokemon({ ability: 'Prankster' }), target: pokemon({ lastMove: 'tackle' }) }).score > 100);
		for (const id of ['disable', 'taunt']) {
			assert.equal(score(id, { target: pokemon({ item: 'Mental Herb', lastMove: 'tackle' }), formatId: 'gen9customgame' }).score, 60);
			assert(!hasReason(score(id, { target: pokemon({ item: 'Mental Herb', lastMove: 'tackle' }),
				formatId: 'gen4customgame' }), 'Mental Herb'));
		}
		assert.equal(score('taunt', { target: pokemon({ moves: ['tackle', 'psychic', 'icebeam', 'thunderbolt'] }) }).score, 60);
		assert(score('taunt', { target: pokemon({ moves: ['tackle'] }) }).score >= 100);
		assert(score('taunt', { target: pokemon({ moves: ['tackle', 'psychic', 'recover', 'thunderbolt'] }) }).score > 100);
		for (const moves of [['recover', 'protect'], ['seismictoss', 'nightshade']]) {
			assert.equal(score('helpinghand', { partner: true, target: pokemon({ slot: 2, moves }) }).score, 60);
		}
		for (const moves of [['lowkick'], ['bulletseed'], ['naturepower']]) {
			assert(!hasReason(score('helpinghand', { partner: true, target: pokemon({ slot: 2, moves }) }), 'no partner attack'));
		}
	});

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
		assert.equal(result.breakdown.positives, 6); // A speed tie is not a faster target.
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

	for (const formatId of ['gen5customgame', 'gen5pokemmorandombattle', 'gen9customgame']) {
		it(`${formatId}: shares recovery knowledge across Toxic, Salt Cure and revealed/preset moves`, () => {
			const recovery = ['recover', 'softboiled', 'milkdrink', 'slackoff', 'roost', 'healorder', 'synthesis',
				'moonlight', 'morningsun', 'shoreup', 'rest', 'swallow', 'lifedew', 'junglehealing', 'lunarblessing',
				'wish', 'strengthsap', 'painsplit', 'purify', 'aquaring', 'ingrain', 'leechseed',
				'absorb', 'megadrain', 'gigadrain', 'drainpunch', 'drainingkiss', 'leechlife', 'hornleech',
				'paraboliccharge', 'oblivionwing', 'dreameater', 'bitterblade', 'matchagotcha', 'bouncybubble'];
			for (const id of recovery) {
				assert(canRestoreUserHp({ id }, { formatId }), id);
				for (const revealed of [true, false]) {
					const other = ['tackle', 'psychic', 'protect'];
					const moves = revealed ? [...other, id] : other;
					const target = pokemon({ moves, moveKnowledge: {
						revealedMoves: moves, presetCandidates: revealed ? [] : [id], remainingSlots: revealed ? 0 : 1,
						movePools: [[...other, id]],
					} });
					for (const attack of ['toxic', 'saltcure']) {
						assert(!hasReason(score(attack, { target, formatId }), 'No recovery in'), `${id}, ${attack}, ${revealed}`);
					}
				}
			}
			for (const id of ['healpulse', 'floralhealing', 'pollenpuff', 'healingwish', 'lunardance', 'revivalblessing',
				'healbell', 'aromatherapy', 'refresh', 'protect', 'swordsdance']) {
				assert(!canRestoreUserHp({ id }, { formatId }), `${id} does not heal the user`);
				const target = pokemon({ moves: ['tackle', 'psychic', 'growl', id] });
				assert(hasReason(score('toxic', { target, formatId }), 'No recovery in'), id);
			}
			for (const move of Dex.forFormat(formatId).moves.all()) {
				if (!move.isZ && !move.isMax && (move.heal || move.drain || move.flags.heal)) {
					assert(recoveryKind(move, { formatId }), `Unclassified recovery: ${move.id}`);
				}
			}
		});
	}

	it('uses preset or 85-EV maximum HP and public percentage for Pain Split', () => {
		for (const species of ['Bronzong', 'Swalot']) {
			const tracker = createBattleTracker('p2');
			tracker.parseMessage(`|switch|p1a: Foe|${species}, L80|60/100`);
			const target = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen9customgame');
			const base = Dex.species.get(species).baseStats, preset = getOpponentPreset(species);
			const max = preset ? computeStatsFromPreset(base, 80, preset).hp :
				Math.floor((2 * base.hp + 31 + Math.floor(85 / 4)) * 80 / 100) + 80 + 10;
			assert.equal(target.maxHp, max);
			const actor = pokemon({ hp: 50, maxHp: 400, hpPercent: 12.5 });
			target.hp = 1; // The calculation must use estimated max HP and the observed percentage.
			assert.equal(painSplitRecovery(actor, target), Math.floor((50 + Math.floor(max * 0.6)) / 2) - 50);
		}
	});

	it('keeps conditional recovery subject to effect eligibility', () => {
		const actor = pokemon({ hp: 20, hpPercent: 20 / 3 });
		assert.equal(score('purify', { actor }).score, 0);
		assert(score('purify', { actor, target: pokemon({ status: 'par' }) }).score > 100);
		const target = pokemon({ volatiles: new Set(['substitute']) });
		assert.equal(score('painsplit', { actor, target }).score, 0);
		assert(score('painsplit', { actor: { ...actor, ability: 'Infiltrator' }, target, formatId: 'gen9customgame' }).score > 100);
	});

	it('uses drain metadata for newer attacks and does not reward healing reversed by Liquid Ooze', () => {
		const actor = pokemon({ hp: 100, hpPercent: 100 / 3 });
		for (const id of ['bitterblade', 'matchagotcha', 'dreameater']) {
			const target = pokemon({ status: id === 'dreameater' ? 'slp' : '' });
			assert(hasReason(score(id, { actor, target }), 'Drain move'), id);
			target.ability = 'Liquid Ooze';
			assert(!hasReason(score(id, { actor, target }), 'Drain move'), id);
			assert(hasReason(score(id, { actor, target }), 'Liquid Ooze'), id);
			assert(!hasReason(score(id, { actor: { ...actor, ability: 'Mold Breaker' }, target }), 'Drain move'), id);
			target.volatiles.add('gastroacid');
			assert(hasReason(score(id, { actor, target }), 'Drain move'), id);
		}
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
		assert.equal(harmful.score, 60);
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

	it('does not reward Encore for an attacking last move, even if immune', () => {
		for (const [move, type] of [
			['earthquake', 'Flying'], ['thunderbolt', 'Ground'], ['tackle', 'Ghost'], ['shadowball', 'Normal'],
			['psychic', 'Dark'], ['dragonclaw', 'Fairy'], ['sludgebomb', 'Steel'], ['nightshade', 'Normal'],
		]) {
			const target = pokemon({ lastMove: move });
			const neutral = score('encore', { target, actor: pokemon({ types: ['Water'] }), positive: rewardEncore });
			const immune = score('encore', { target, actor: pokemon({ types: [type] }), positive: rewardEncore });
			assert.equal(immune.score, neutral.score, `${move} into ${type}`);
		}
	});

	it('requires strict speed or priority advantage to reward Encore', () => {
		const target = pokemon({ lastMove: 'swordsdance' });
		assert.equal(score('encore', { target }).score, 60, 'A speed tie is not reliable');
		const actor = pokemon({ ability: 'Prankster' });
		assert.equal(score('encore', { actor, target }).score, 120);
		assert.equal(score('encore', { actor, target, field: { trickroom: true } }).score, 120,
			'Trick Room does not reverse priority');
		assert.equal(score('encore', { actor, target: { ...target, moves: ['extremespeed', 'swordsdance'] } }).score, 60,
			'An opposing priority move can change the last move first');
		assert.equal(score('encore', { actor, target: { ...target, lastMove: 'encore' } }).score, 0,
			'Encore cannot lock Encore');
		const slow = pokemon({ baseStats: { ...actor.baseStats, spe: 100 } });
		assert.equal(score('encore', { actor: slow, target: { ...target, lastMove: '' } }).score, 60,
			'A slower Encore can succeed after the target acts');
	});

	it('does not invent a known remaining sleep duration for random sleep or Comatose', () => {
		const asleep = pokemon({ status: 'slp', sleepTurns: 0 });
		assert(score('psychic', { actor: asleep }).score > 0);
		assert.equal(score('sleeptalk', { actor: asleep }).score, 110);
		assert(score('psychic', { actor: pokemon({ ability: 'Comatose' }) }).score > 0);
		assert.equal(score('sleeptalk', { actor: pokemon({ ability: 'Comatose' }) }).score, 110);
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

describe('NPC public mechanics and utility regressions from random battles', () => {
	const field = { formatId: 'gen9customgame', weather: '', terrain: '', trickroom: false };
	const move = id => buildAIMove({ id }, 1, field.formatId);
	const damage = (actor, target, id, context) => calculateDamage(actor, target, move(id), field, undefined, context);
	const util = require('../../../dist/server/npc/ai/cfru/util/type-calc');
	const { effectivePriority } = require('../../../dist/server/npc/ai/cfru/util/mechanics');

	for (const [species, id, type] of [
		['Ogerpon', 'ivycudgel', 'Grass'], ['Ogerpon-Wellspring', 'ivycudgel', 'Water'],
		['Ogerpon-Wellspring-Tera', 'ivycudgel', 'Water'], ['Ogerpon-Hearthflame', 'ivycudgel', 'Fire'],
		['Ogerpon-Cornerstone', 'ivycudgel', 'Rock'], ['Tauros', 'ragingbull', 'Normal'],
		['Tauros-Paldea-Combat', 'ragingbull', 'Fighting'], ['Tauros-Paldea-Blaze', 'ragingbull', 'Fire'],
		['Tauros-Paldea-Aqua', 'ragingbull', 'Water'],
	]) {
		it(`resolves ${id} from the public ${species} forme`, () => {
			const actor = pokemon({ species });
			const resolved = util.resolveMove(actor, move(id), field);
			assert.equal(resolved.type, type);
			assert.equal(util.resolveMove(actor, resolved, field).type, type);
			if (type === 'Water') assert.equal(damage(actor, pokemon({ ability: 'Water Absorb' }), id).average, 0);
		});
	}

	it('Grassy Glide gains priority only while grounded in Grassy Terrain', () => {
		const actor = pokemon({ ability: '' });
		assert.equal(effectivePriority(actor, move('grassyglide'), field), 0);
		assert.equal(effectivePriority(actor, move('grassyglide'), { ...field, terrain: 'grassy' }), 1);
		assert.equal(effectivePriority({ ...actor, item: 'Air Balloon' }, move('grassyglide'), { ...field, terrain: 'grassy' }), 0);
		assert.equal(effectivePriority({ ...actor, item: 'Air Balloon' }, move('grassyglide'),
			{ ...field, terrain: 'grassy', gravity: true }), 1);
	});

	it('Unaware ignores both positive and negative relevant stages, while Mold Breaker bypasses it', () => {
		const actor = pokemon();
		const target = pokemon({ ability: 'Unaware' });
		const neutral = damage(actor, target, 'psychocut').average;
		for (const stage of [-4, 4]) {
			const boosted = { ...actor, boosts: { ...actor.boosts, atk: stage } };
			assert.equal(damage(boosted, target, 'psychocut').average, neutral);
			assert.notEqual(damage({ ...boosted, ability: 'Mold Breaker' }, target, 'psychocut').average, neutral);
			const defensive = { ...target, ability: '', boosts: { ...target.boosts, def: stage } };
			assert.equal(damage({ ...actor, ability: 'Unaware' }, defensive, 'psychocut').average, neutral);
			const press = { ...actor, boosts: { ...actor.boosts, def: stage } };
			assert.equal(damage(press, target, 'bodypress').average, damage(actor, target, 'bodypress').average);
		}
		assert.equal(score('swordsdance', { actor, target }).score, 60);
		assert.equal(score('calmmind', { actor, target }).score, 60);
		assert(score('swordsdance', { actor: { ...actor, ability: 'Mold Breaker' }, target }).score > 60);
		const indirect = { ...actor, moves: ['swordsdance', 'storedpower'] };
		assert(score('swordsdance', { actor: indirect, target }).score > 60);
	});

	it('Foul Play borrows target Attack and stages, but retains user ability and item modifiers', () => {
		const actor = pokemon();
		const target = pokemon({ types: ['Normal'] });
		const neutral = damage(actor, target, 'foulplay').average;
		assert.equal(damage({ ...actor, baseStats: { ...actor.baseStats, atk: 400 }, boosts: { ...actor.boosts, atk: 4 } },
			target, 'foulplay').average, neutral);
		assert(damage(actor, { ...target, baseStats: { ...target.baseStats, atk: 400 } }, 'foulplay').average > neutral * 1.8);
		assert(damage(actor, { ...target, boosts: { ...target.boosts, atk: 2 } }, 'foulplay').average > neutral * 1.8);
		assert.equal(damage(actor, { ...target, ability: 'Huge Power', item: 'Choice Band' }, 'foulplay').average, neutral);
		assert(damage({ ...actor, ability: 'Huge Power' }, target, 'foulplay').average > neutral * 1.8);
		assert.equal(damage(actor, { ...target, ability: 'Unaware' }, 'foulplay').average, neutral);
	});

	for (const id of ['tripleaxel', 'triplekick']) {
		it(`${id} sums increasing per-hit powers including Technician and first-hit protection`, () => {
			for (const ability of ['', 'Technician']) {
				const actor = pokemon({ ability });
				const target = pokemon({ types: ['Normal'] });
				const raw = move(id);
				const hits = [1, 2, 3].map(hit => calculateDamage(actor, target,
					{ ...raw, basePower: raw.basePower * hit, multihit: null }, field));
				const result = damage(actor, target, id);
				assert.equal(result.max, hits.reduce((n, h) => n + h.max, 0));
				const shield = damage(actor, { ...target, ability: 'Multiscale' }, id);
				assert.equal(shield.max, Math.floor(hits[0].max / 2) + hits[1].max + hits[2].max);
			}
		});
	}

	it('redirection respects suppression, bypass abilities, spread targets and the user itself', () => {
		const actor = pokemon();
		const target = pokemon({ types: ['Normal'] });
		const holder = pokemon({ ability: 'Lightning Rod' });
		const context = { isDoubles: true, numAliveTargets: 2, activePokemon: [actor, target, holder] };
		assert.equal(damage(actor, target, 'thunderbolt', context).average, 0);
		for (const ability of ['Mold Breaker', 'Stalwart', 'Propeller Tail']) {
			assert(damage({ ...actor, ability }, target, 'thunderbolt', context).average > 0);
		}
		assert(damage(actor, target, 'discharge', context).average > 0);
		assert(damage(actor, target, 'thunderbolt', { ...context, activePokemon: [actor, target,
			{ ...holder, volatiles: new Set(['gastroacid']) }] }).average > 0);
		assert(damage(actor, target, 'thunderbolt', { ...context, activePokemon: [actor, target,
			{ ...holder, fainted: true }] }).average > 0);
		const user = { ...actor, ability: 'Lightning Rod' };
		assert(damage(user, target, 'thunderbolt', { ...context, activePokemon: [user, target] }).average > 0);
	});

	it('Substitute is discouraged when its HP cost makes residual damage lethal, but immunity/recovery can save it', () => {
		const actor = pokemon({ hp: 85, maxHp: 272, hpPercent: 85 / 272 * 100, status: 'psn', item: 'Leftovers' });
		assert.equal(score('substitute', { actor }).score, 60);
		assert(score('substitute', { actor: { ...actor, ability: 'Magic Guard' } }).score > 60);
		assert(score('substitute', { actor: { ...actor, ability: 'Poison Heal' } }).score > 60);
		assert(score('substitute', { actor, field: { terrain: 'grassy' } }).score > 60);
		assert.equal(score('substitute', { actor: { ...actor, hp: 68, hpPercent: 25 } }).score, 0);
	});

	it('hazards are discouraged only with publicly confirmed absence of replacements, including Multi', () => {
		for (const count of [1, 2]) {
			const actor = pokemon();
			const foes = Array.from({ length: count }, () => pokemon());
			const state = { turn: 1, isDoubles: count === 2, field,
				self: { active: [actor], reserve: [], team: [actor], conditions: {} },
				opponent: { remaining: count, active: foes, reserve: [], team: foes, conditions: {} } };
			const engine = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache());
			for (const id of ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb']) {
				assert.equal(engine.scoreMove(state, actor, move(id), foes[0]).score, 60);
				for (const remaining of [undefined, count + 1]) {
					assert(engine.scoreMove({ ...state, opponent: { ...state.opponent, remaining } }, actor, move(id), foes[0]).score > 60);
				}
			}
		}
	});

	it('Defog with no immediate clearing benefit is discouraged, while hazards and evasion preserve its value', () => {
		assert.equal(score('defog').score, 60);
		assert(score('defog', { conditions: { stealthrock: true } }).score > 60);
		const target = pokemon(); target.boosts.evasion = 1;
		assert(score('defog', { target }).score > 60);
	});

	it('spread double-KO safety checks both targets independently', () => {
		const actor = pokemon({ baseStats: { ...pokemon().baseStats, spe: 200 } });
		const slow = pokemon({ hp: 1, hpPercent: 1 / 3, baseStats: { ...actor.baseStats, spe: 100 } });
		const fast = pokemon({ hp: 1, hpPercent: 1 / 3, baseStats: { ...actor.baseStats, spe: 300 } });
		const state = { turn: 1, isDoubles: true, field,
			self: { active: [actor], reserve: [], team: [actor], conditions: {} },
			opponent: { active: [slow, fast], reserve: [], team: [slow, fast], conditions: {} } };
		const engine = new ScoringEngine(DEFAULT_AI_CONFIG, createAICache());
		assert(!hasReason(engine.scoreMove(state, actor, move('sludgewave'), slow), 'Outspeeds for double KO'));
		const slower = { ...fast, baseStats: { ...fast.baseStats, spe: 150 } };
		assert(hasReason(engine.scoreMove({ ...state, opponent: { ...state.opponent, active: [slow, slower] } },
			actor, move('sludgewave'), slow), 'Outspeeds for double KO'));
	});
});
