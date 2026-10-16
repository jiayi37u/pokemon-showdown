'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, buildBattleStateWithTracker } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');
const { calculateDamage, getModifiedBasePower, getAttackStat, getDefenseStat } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { getEffectiveSpeed } = require('../../../dist/server/npc/ai/cfru/util/speed');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { itemMoveFailure, itemAllowsRemoval, itemRemovalFailure } = require('../../../dist/server/npc/ai/cfru/util/items');
const { statusFailure } = require('../../../dist/server/npc/ai/cfru/util/move-effects');

// Exact oracle inputs isolate mechanical calculations. Public information ingestion is tested separately.
function snapshot(p) {
	const result = makeAIPokemonSkeleton({ slot: 1, species: p.species.name,
		hp: p.hp, maxHp: p.maxhp, hpPercent: 100 * p.hp / p.maxhp,
		status: p.status, fainted: p.fainted, types: p.getTypes(), ability: p.ability, item: p.item,
		baseStats: { hp: p.maxhp, ...p.storedStats }, boosts: { ...p.boosts }, moves: p.moveSlots.map(m => m.id),
		active: true, level: p.level, gender: p.gender,
	});
	result.itemKnown = true;
	result.baseSpecies = p.baseSpecies.name;
	result.volatiles = new Set(Object.keys(p.volatiles));
	return result;
}
function stateFor(actor, target, field, conditions = {}) {
	return { turn: 1, isDoubles: false, field,
		self: { active: [actor], reserve: [], team: [actor], conditions: {} },
		opponent: { active: [target], reserve: [], team: [target], conditions },
	};
}
function evaluate(state, actor, target, move) {
	return new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createAICache(1))
		.scoreMove(state, actor, move, target);
}

describe('Shared status eligibility against PS', () => {
	for (const spec of [
		{ move: 'fling', attackerItem: 'Light Ball', species: 'Garchomp' },
		{ move: 'fling', attackerItem: 'Light Ball', species: 'Pikachu' },
		{ move: 'fling', attackerItem: 'Flame Orb', species: 'Charizard' },
		{ move: 'fling', attackerItem: 'Toxic Orb', ability: 'Shield Dust' },
		{ move: 'fling', attackerItem: 'Toxic Orb', item: 'Covert Cloak' },
		{ move: 'fling', attackerItem: 'Toxic Orb', attackerAbility: 'Sheer Force' },
		{ move: 'spore', species: 'Venusaur', format: 'gen5customgame' },
		{ move: 'spore', species: 'Venusaur', format: 'gen6customgame' },
		{ move: 'spore', species: 'Venusaur', format: 'gen5pokemmorandombattle' },
		{ move: 'glare', species: 'Pikachu', format: 'gen5customgame' },
		{ move: 'glare', species: 'Pikachu', format: 'gen6customgame' },
		{ move: 'thunderwave', species: 'Garchomp' },
		{ move: 'thunderwave', ability: 'Volt Absorb' },
		{ move: 'glare', ability: 'Limber', attackerAbility: 'Mold Breaker' },
		{ move: 'glare', ability: 'Limber', attackerAbility: 'Mold Breaker', item: 'Ability Shield' },
		{ move: 'toxic', species: 'Magnezone', attackerAbility: 'Corrosion' },
		{ move: 'toxic', species: 'Gengar', attackerAbility: 'Corrosion' },
		{ move: 'toxic', ability: 'Immunity', attackerAbility: 'Mold Breaker' },
		{ move: 'willowisp', ability: 'Water Veil', attackerAbility: 'Mold Breaker' },
		{ move: 'willowisp', ability: 'Flash Fire' },
		{ move: 'spore', ability: 'Overcoat' },
		{ move: 'spore', ability: 'Overcoat', attackerAbility: 'Mold Breaker' },
		{ move: 'spore', item: 'Safety Goggles' },
		{ move: 'spore', item: 'Safety Goggles', magicroom: true },
		{ move: 'spore', item: 'Safety Goggles', ability: 'Klutz' },
		{ move: 'hypnosis', terrain: 'electric' },
		{ move: 'hypnosis', terrain: 'electric', item: 'Air Balloon' },
		{ move: 'hypnosis', terrain: 'misty' },
		{ move: 'glare', terrain: 'misty' },
		{ move: 'willowisp', terrain: 'misty' },
		{ move: 'toxic', terrain: 'misty' },
		{ move: 'confuseray', terrain: 'misty', format: 'gen6customgame' },
		{ move: 'confuseray', terrain: 'misty', format: 'gen7customgame' },
		{ move: 'confuseray', ability: 'Comatose' },
		{ move: 'toxic', ability: 'Leaf Guard', sun: true },
		{ move: 'toxic', ability: 'Leaf Guard', sun: true, attackerAbility: 'Mold Breaker' },
		{ move: 'toxic', ability: 'Good as Gold' },
		{ move: 'toxic', species: 'Minior', ability: 'Shields Down' },
		{ move: 'toxic', ability: 'Good as Gold', attackerAbility: 'Mold Breaker' },
		{ move: 'toxic', safeguard: true },
		{ move: 'toxic', safeguard: true, attackerAbility: 'Infiltrator' },
		{ move: 'toxic', substitute: true },
		{ move: 'toxic', substitute: true, attackerAbility: 'Infiltrator' },
		{ move: 'nuzzle', status: 'brn' },
		{ move: 'nuzzle', ability: 'Limber' },
		{ move: 'nuzzle', item: 'Covert Cloak' },
		{ move: 'nuzzle', item: 'Covert Cloak', magicroom: true },
		{ move: 'inferno', ability: 'Water Veil' },
		{ move: 'relicsong', ability: 'Insomnia' },
		{ move: 'poisonfang', status: 'tox' },
	]) {
		it(JSON.stringify(spec), () => {
			const formatId = spec.format || 'gen9customgame';
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: spec.attackerAbility || 'Pressure', item: spec.attackerItem || '', moves: [spec.move] }] },
				p2: { name: 'Target', team: [{ species: spec.species || 'Mew', ability: spec.ability || 'Pressure',
					item: spec.item || '', moves: ['splash'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				battle.p1.active[0].boosts.accuracy = 6;
				if (spec.terrain) battle.field.setTerrain(`${spec.terrain}terrain`, battle.p1.active[0]);
				if (spec.sun) battle.field.setWeather('sunnyday', battle.p1.active[0]);
				if (spec.magicroom) battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
				if (spec.safeguard) battle.p2.addSideCondition('safeguard', battle.p2.active[0]);
				if (spec.substitute) battle.p2.active[0].addVolatile('substitute', battle.p2.active[0]);
				if (spec.status) battle.p2.active[0].setStatus(spec.status);
				const actor = snapshot(battle.p1.active[0]);
				const target = snapshot(battle.p2.active[0]);
				const field = { formatId, weather: spec.sun ? 'sun' : '', terrain: spec.terrain || '', magicroom: !!spec.magicroom };
				const state = stateFor(actor, target, field, { safeguard: spec.safeguard ? 5 : 0 });
				const move = buildAIMove({ id: spec.move }, 1, formatId);
				const failure = statusFailure(state, actor, target, move);
				const result = evaluate(state, actor, target, move);
				const cursor = battle.log.length;
				battle.makeChoices('move 1', 'move 1');
				const statusApplied = battle.log.slice(cursor).some(line => line.startsWith('|-status|p2') ||
					(line.startsWith('|-start|p2') && line.includes('|confusion')));
				if (move.category === 'Status' || failure) assert.equal(statusApplied, !failure, battle.log.slice(cursor).join('\n'));
				if (move.category === 'Status' && failure) {
					assert.equal(result.score, 0);
					assert.equal(result.breakdown.positives, 0);
				} else if (move.category !== 'Status') {
					assert.equal(result.flags.hasNoEffect, false, 'Secondary failure must not invalidate damage');
					assert(calculateDamage(actor, target, move, field).average > 0);
					if (failure) assert(!result.breakdown.details.some(d => /Paralysis (on|for)|Burn (on|for)|Sleep is disruptive/.test(d.reason)));
				}
			} finally { battle.destroy(); }
		});
	}
});

describe('Shared numerical modifiers against PS', () => {
	for (const moveId of ['gyroball', 'electroball']) {
		for (const setup of ['boosts', 'paralysis', 'tailwind', 'magicroom', 'trickroom']) {
			it(`${moveId}: ${setup} uses actual effective speeds`, () => {
				const formatId = 'gen9customgame';
				const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
					p1: { name: 'Actor', team: [{ species: 'Mew', ability: 'Pressure', item: 'Choice Scarf', moves: [moveId] }] },
					p2: { name: 'Target', team: [{ species: 'Electrode', ability: 'Soundproof', moves: ['splash'] }] },
				});
				try {
					if (battle.requestState === 'teampreview') battle.makeChoices();
					const actor = battle.p1.active[0];
					const target = battle.p2.active[0];
					if (setup === 'boosts') actor.boosts.spe = -2;
					if (setup === 'paralysis') actor.setStatus('par');
					if (setup === 'tailwind') battle.p2.addSideCondition('tailwind', target);
					if (['magicroom', 'trickroom'].includes(setup)) battle.field.addPseudoWeather(setup, actor);
					const move = buildAIMove({ id: moveId }, 1, formatId);
					const field = { formatId, weather: '', terrain: '', magicroom: setup === 'magicroom', trickroom: setup === 'trickroom' };
					const context = { isDoubles: false, numAliveTargets: 1, defenderSideConditions: { tailwind: setup === 'tailwind' ? 4 : 0 } };
					const expected = battle.dex.moves.get(moveId).basePowerCallback.call(battle, actor, target, move);
					assert.equal(getModifiedBasePower(snapshot(actor), snapshot(target), move, field, context), expected);
				} finally { battle.destroy(); }
			});
		}
	}
	for (const item of ['Choice Band', 'Choice Specs', 'Assault Vest', 'Eviolite', 'Life Orb', 'Expert Belt', 'Occa Berry']) {
		it(`${item}: Magic Room restores the same damage estimate as no item`, () => {
			const formatId = 'gen9customgame';
			const defensive = ['Assault Vest', 'Eviolite', 'Occa Berry'].includes(item);
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: 'Pressure', item: defensive ? '' : item, moves: ['flamethrower', 'firepunch'] }] },
				p2: { name: 'Target', team: [{ species: 'Ivysaur', ability: 'Pressure', item: defensive ? item : '', moves: ['splash'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				const actor = snapshot(battle.p1.active[0]);
				const target = snapshot(battle.p2.active[0]);
				const move = buildAIMove({ id: item === 'Choice Band' ? 'firepunch' : 'flamethrower' }, 1, formatId);
				const field = { formatId, weather: '', terrain: '' };
				const regular = calculateDamage(actor, target, move, field).average;
				const suppressed = calculateDamage(actor, target, move, { ...field, magicroom: true }).average;
				assert.notEqual(regular, suppressed);
				assert.equal(suppressed, calculateDamage({ ...actor, item: '' }, { ...target, item: '' }, move, field).average);
				battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
				assert.equal(battle.p1.active[0].ignoringItem(), true);
				assert.equal(battle.p2.active[0].ignoringItem(), true);
			} finally { battle.destroy(); }
		});
	}
});

describe('Sleep clauses from public origins and format rules', () => {
	for (const formatId of ['gen7ou', 'gen5pokemmorandombattle', 'gen9customgame']) {
		for (const rest of [true, false]) {
			it(`${formatId}: ${rest ? 'Rest' : 'opponent sleep'} persists after switching`, () => {
				const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
					p1: { name: 'Target', team: [
						{ species: 'Mew', ability: 'Pressure', moves: ['rest', 'splash'] },
						{ species: 'Snorlax', ability: 'Pressure', moves: ['splash'] },
					] },
					p2: { name: 'Actor', team: [{ species: 'Mew', ability: 'Pressure', moves: ['hypnosis', 'splash'] }] },
				});
				try {
					if (battle.requestState === 'teampreview') battle.makeChoices();
					battle.p1.active[0].hp--;
					battle.p2.active[0].boosts.accuracy = 6;
					battle.makeChoices(rest ? 'move 1' : 'move 2', rest ? 'move 2' : 'move 1');
					battle.makeChoices('switch 2', 'move 2');
					const tracker = createBattleTracker('p2');
					tracker.setFormat(formatId);
					tracker.parseMessage(battle.log.join('\n'));
					const state = buildBattleStateWithTracker(battle.p2.activeRequest, { turn: battle.turn }, tracker,
						{ ...DEFAULT_AI_CONFIG, formatId });
					const sleeper = state.opponent.reserve.find(p => p.status === 'slp');
					assert(sleeper, battle.log.join('\n'));
					assert.equal(sleeper.sleepSelfInflicted, rest);
					assert.equal(sleeper.ownerSide, 'p1');
					const move = buildAIMove({ id: 'hypnosis' }, 1, formatId);
					const score = evaluate(state, state.self.active[0], state.opponent.active[0], move);
					const blocked = formatId === 'gen5pokemmorandombattle' || (formatId === 'gen7ou' && !rest);
					assert.equal(score.flags.hasNoEffect, blocked);
					const cursor = battle.log.length;
					battle.makeChoices('move 1', 'move 1');
					assert.equal(battle.log.slice(cursor).some(line => line.startsWith('|-status|p1')), !blocked);
				} finally { battle.destroy(); }
			});
		}
	}
});

describe('Successful-hit damage versus move failure', () => {
	for (const lastMove of ['', 'swordsdance', 'tackle']) {
		it(`Sucker Punch can hit an attack after prior move '${lastMove}'`, () => {
			const formatId = 'gen9customgame';
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Bisharp', ability: 'Pressure', moves: ['suckerpunch'] }] },
				p2: { name: 'Target', team: [{ species: 'Mew', ability: 'Pressure', moves: ['tackle'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				const actor = snapshot(battle.p1.active[0]);
				const target = snapshot(battle.p2.active[0]);
				target.lastMove = lastMove;
				const move = buildAIMove({ id: 'suckerpunch' }, 1, formatId);
				assert(calculateDamage(actor, target, move, { formatId }).average > 0);
				const wounded = { ...target, hp: 1, hpPercent: 100 / target.maxHp };
				const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
				ai.battleState = stateFor(actor, wounded, { formatId });
				assert.equal(ai.canKOWithAverageDamage(actor, wounded, move), false,
					'Conditional damage cannot provide a reliable KO override for switching');
				battle.makeChoices('move 1', 'move 1');
				assert(battle.p2.active[0].hp < target.hp);
			} finally { battle.destroy(); }
		});
	}
	for (const status of ['', 'slp']) {
		it(`Dream Eater shares its ${status || 'awake'} target eligibility with damage and scoring`, () => {
			const actor = makeAIPokemonSkeleton({ slot: 1, species: 'Mew', active: true, hp: 300, maxHp: 300,
				hpPercent: 100, status: '', fainted: false, types: ['Psychic'], ability: 'Pressure', item: '',
				moves: ['dreameater'], baseStats: { hp: 300, atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
				level: 100, gender: 'N' });
			const target = { ...actor, status, hp: 1, hpPercent: 100 / 300, types: ['Normal'], ability: 'Pressure' };
			const field = { formatId: 'gen9customgame' };
			const move = buildAIMove({ id: 'dreameater' }, 1, field.formatId);
			const damage = calculateDamage(actor, target, move, field);
			const score = evaluate(stateFor(actor, target, field), actor, target, move);
			assert.equal(damage.canKO, status === 'slp');
			assert.equal(score.flags.hasNoEffect, !status);
		});
	}
	for (const item of ['', 'Covert Cloak']) {
		it(`Salt Cure retains damage but only rewards an applicable secondary with ${item || 'no item'}`, () => {
			const formatId = 'gen9customgame';
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Garganacl', ability: 'Pressure', moves: ['saltcure'] }] },
				p2: { name: 'Target', team: [{ species: 'Mew', ability: 'Pressure', item, moves: ['splash'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				const actor = snapshot(battle.p1.active[0]);
				const target = snapshot(battle.p2.active[0]);
				const field = { formatId };
				const move = buildAIMove({ id: 'saltcure' }, 1, formatId);
				const score = evaluate(stateFor(actor, target, field), actor, target, move);
				assert.equal(score.flags.hasNoEffect, false);
				assert.equal(score.breakdown.details.some(d => d.amount > 0 && d.reason.includes('Salt Cure')), !item);
				battle.makeChoices('move 1', 'move 1');
				assert.equal(!!battle.p2.active[0].volatiles.saltcure, !item);
				assert(battle.p2.active[0].hp < target.hp);
			} finally { battle.destroy(); }
		});
	}
});

describe('Defensive stat modifiers against PS', () => {
	for (const spec of [
		{ species: 'Furfrou', ability: 'Fur Coat', move: 'tackle' },
		{ species: 'Milotic', ability: 'Marvel Scale', status: 'par', move: 'tackle' },
		{ species: 'Gogoat', ability: 'Grass Pelt', terrain: 'grassy', move: 'tackle' },
		{ species: 'Blissey', ability: 'Pressure', room: true, move: 'tackle' },
		{ species: 'Blissey', ability: 'Pressure', room: true, move: 'psychic' },
		{ species: 'Blissey', ability: 'Pressure', room: true, move: 'psyshock' },
		{ species: 'Sneasel', ability: 'Klutz', item: 'Iron Ball', move: 'tackle' },
	]) {
		it(JSON.stringify(spec), () => {
			const formatId = 'gen9customgame';
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: 'Pressure', moves: [spec.move] }] },
				p2: { name: 'Target', team: [{ species: spec.species, ability: spec.ability, item: spec.item, moves: ['splash'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				const target = battle.p2.active[0];
				if (spec.status) target.setStatus(spec.status);
				if (spec.terrain) battle.field.setTerrain(`${spec.terrain}terrain`, target);
				if (spec.room) battle.field.addPseudoWeather('wonderroom', target);
				target.boosts.def = 2;
				target.boosts.spd = -1;
				const move = buildAIMove({ id: spec.move }, 1, formatId);
				const field = { formatId, wonderroom: !!spec.room, terrain: spec.terrain || '' };
				const stat = move.category === 'Physical' || spec.move === 'psyshock' ? 'def' : 'spd';
				const base = target.calculateStat(stat, target.boosts[stat]);
				const expected = battle.runEvent(stat === 'def' ? 'ModifyDef' : 'ModifySpD', target, battle.p1.active[0],
					battle.dex.moves.get(spec.move), base);
				assert.equal(getDefenseStat(snapshot(target), move, field), expected);
				assert.equal(getEffectiveSpeed(snapshot(target), field), target.getStat('spe'));
				assert.equal(getAttackStat(snapshot(battle.p1.active[0]), move, field),
					battle.p1.active[0].getStat(move.category === 'Physical' ? 'atk' : 'spa'));
			} finally { battle.destroy(); }
		});
	}
});

describe('Shared item rules against PS', () => {
	for (const formatId of ['gen4customgame', 'gen5customgame', 'gen5pokemmorandombattle', 'gen7customgame', 'gen9customgame']) {
		for (const spec of [
			{ move: 'naturalgift', item: 'Oran Berry' },
			{ move: 'naturalgift', item: 'Oran Berry', magicroom: true },
			{ move: 'naturalgift', item: 'Oran Berry', ability: 'Klutz' },
			{ move: 'naturalgift', item: 'Leftovers' },
			{ move: 'trick', item: 'Leftovers', targetItem: 'Charizardite X', targetSpecies: 'Charizard', magicroom: true },
			{ move: 'fling', item: 'Eviolite' },
			{ move: 'fling', item: 'Choice Band' },
			{ move: 'fling', item: 'Iron Ball', ability: 'Klutz' },
			{ move: 'fling', item: 'Iron Ball', magicroom: true },
			{ move: 'fling', item: 'Leftovers', embargo: true },
			{ move: 'fling', item: 'Charizardite X' },
			{ move: 'fling', item: 'Charizardite X', species: 'Charizard' },
			{ move: 'fling', item: 'Normalium Z' },
			{ move: 'fling' },
			{ move: 'trick' },
			{ move: 'trick', item: 'Leftovers', targetItem: 'Leftovers' },
			{ move: 'trick', item: 'Leftovers', targetAbility: 'Sticky Hold' },
			{ move: 'trick', item: 'Leftovers', targetAbility: 'Sticky Hold', ability: 'Mold Breaker' },
			{ move: 'trick', item: 'Charizardite X', targetSpecies: 'Charizard' },
			{ move: 'trick', item: 'Rusted Sword', targetSpecies: 'Zacian' },
			{ move: 'trick', item: 'Rusted Sword' },
			{ move: 'switcheroo', targetItem: 'Flame Plate', targetSpecies: 'Arceus', targetAbility: 'Multitype' },
		]) {
			it(`${formatId}: ${JSON.stringify(spec)}`, () => {
				const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
					p1: { name: 'Actor', team: [{ species: spec.species || 'Mew', ability: spec.ability || 'Pressure',
						item: spec.item || '', moves: [spec.move] }] },
					p2: { name: 'Target', team: [{ species: spec.targetSpecies || 'Mew', ability: spec.targetAbility || 'Pressure',
						item: spec.targetItem || '', moves: ['splash'] }] },
				});
				try {
					if (battle.requestState === 'teampreview') battle.makeChoices();
					if (spec.magicroom) battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
					if (spec.embargo) battle.p1.active[0].addVolatile('embargo');
					const actor = snapshot(battle.p1.active[0]), target = snapshot(battle.p2.active[0]);
					const field = { formatId, magicroom: !!spec.magicroom };
					const move = buildAIMove({ id: spec.move }, 1, formatId);
					const failure = itemMoveFailure(actor, target, move, field);
					const scored = evaluate(stateFor(actor, target, field), actor, target, move);
					const cursor = battle.log.length;
					battle.makeChoices('move 1', 'move 1');
					const log = battle.log.slice(cursor).join('\n');
					const failed = log.includes('|-fail|p1') || log.includes('|-immune|p2');
					assert.equal(!!failure, failed, `${failure}\n${log}`);
					if (failure) {
						assert.equal(scored.score, 0);
						assert.equal(scored.breakdown.positives, 0);
					} else if (['fling', 'naturalgift'].includes(move.id)) {
						assert(calculateDamage(actor, target, move, field).max > 0);
						assert.equal(getModifiedBasePower(actor, target, move, field), battle.dex.items.get(spec.item)[move.id === 'fling' ? 'fling' : 'naturalGift'].basePower);
					}
				} finally { battle.destroy(); }
			});
		}
	}

	it('item predicates can read only projected public facts in audited item tables', () => {
		const restricted = object => new Proxy(object, { get(target, key) {
			assert(Object.hasOwn(target, key), `Unexpected item predicate input: ${String(key)}`);
			return target[key];
		} });
		for (const formatId of ['gen4customgame', 'gen5pokemmorandombattle', 'gen7customgame', 'gen9customgame']) {
			const dex = Dex.forFormat(formatId);
			for (const item of dex.items.all()) {
				if (typeof item.onTakeItem !== 'function') continue;
				for (const species of ['Mew', ...(item.itemUser || []), ...Object.keys(item.megaStone || {})]) {
					const subject = restricted({ baseSpecies: dex.species.get(species) });
					const result = item.onTakeItem.call(restricted({ activeMove: restricted({ id: 'trick' }) }), item, subject, subject);
					const mon = { species, item: item.id };
					assert.equal(itemAllowsRemoval(mon, mon, { id: 'trick' }, { formatId }), result !== false);
				}
			}
		}
	});

	for (const spec of [
		{ item: 'Leftovers', removable: true, power: 97 },
		{ item: 'Leftovers', ability: 'Sticky Hold', removable: false, power: 97 },
		{ item: 'Leftovers', ability: 'Sticky Hold', attackerAbility: 'Mold Breaker', removable: true, power: 97 },
		{ item: 'Normalium Z', removable: false, power: 65 },
		{ item: 'Charizardite X', species: 'Charizard', removable: false, power: 65 },
		{ item: 'Charizardite X', removable: true, power: 97 },
		{ item: '', removable: false, power: 65 },
	]) {
		it(`Knock Off separates power from removal: ${JSON.stringify(spec)}`, () => {
			const battle = new Battle({ formatid: 'gen7customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: spec.attackerAbility || 'Pressure', moves: ['knockoff'] }] },
				p2: { name: 'Target', team: [{ species: spec.species || 'Mew', ability: spec.ability || 'Pressure',
					item: spec.item, moves: ['splash'] }] },
			});
			try {
				if (battle.requestState === 'teampreview') battle.makeChoices();
				const actor = snapshot(battle.p1.active[0]), target = snapshot(battle.p2.active[0]);
				const field = { formatId: 'gen7customgame' }, move = buildAIMove({ id: 'knockoff' }, 1, field.formatId);
				assert.equal(getModifiedBasePower(actor, target, move, field), spec.power);
				assert.equal(!itemRemovalFailure(actor, target, move, field), spec.removable);
				const score = evaluate(stateFor(actor, target, field), actor, target, move);
				assert.equal(score.breakdown.details.some(a => a.reason === 'Knock Off item removal utility'), spec.removable);
				const cursor = battle.log.length;
				battle.makeChoices('move 1', 'move 1');
				assert.equal(battle.log.slice(cursor).some(l => l.startsWith('|-enditem|p2')), spec.removable);
			} finally { battle.destroy(); }
		});
	}
});
