'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { goesFirst } = require('../../../dist/server/npc/ai/cfru/util/speed');
const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');

function pokemon(overrides = {}) {
	return {
		...makeAIPokemonSkeleton({
			slot: 1, species: 'Mew', hp: 300, maxHp: 300, hpPercent: 100, status: '', fainted: false,
			types: ['Psychic'], ability: '', item: '', moves: ['psychic'],
			baseStats: { hp: 300, atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
			active: true, level: 100, gender: 'N',
		}),
		...overrides,
	};
}

function score(id, { actor = pokemon(), target = pokemon(), reserve = [], formatId = 'gen5pokemmorandombattle',
	field = { weather: '', terrain: '', trickroom: false } } = {}) {
	const state = {
		turn: 1, isDoubles: false,
		self: { active: [actor], reserve, team: [actor, ...reserve], conditions: {} },
		opponent: { active: [target], reserve: [], team: [target], conditions: {} },
		field,
	};
	const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(1));
	return engine.scoreMove(state, actor, buildAIMove({ id }, 1, formatId), target);
}

describe('NPC team cures and opponent stat-drop effects', () => {
	it('compares move priorities before speed, including revealed and candidate opposing priority moves', () => {
		const slow = pokemon({ baseStats: { ...pokemon().baseStats, spe: 50 } });
		const fast = pokemon({ baseStats: { ...pokemon().baseStats, spe: 300 } });
		assert.equal(score('iceshard', { actor: slow, target: fast }).flags.goesFirst, true);
		assert.equal(score('counter', { actor: fast, target: slow }).flags.goesFirst, false);
		assert.equal(score('tackle', { actor: fast, target: { ...slow, moves: ['iceshard'] } }).flags.goesFirst, false);
		assert.equal(score('tackle', { actor: fast, target: { ...slow, moves: [],
			moveKnowledge: { revealedMoves: [], presetCandidates: ['iceshard'], remainingSlots: 4 },
		} }).flags.goesFirst, false);
		assert.equal(goesFirst(fast, slow, buildAIMove({ id: 'counter' }, 1), [buildAIMove({ id: 'roar' }, 1)], {}), true,
			'Counter (-5) acts before Roar (-6)');
		const prankster = { ...fast, ability: 'Prankster', moves: ['thunderwave'] };
		assert.equal(goesFirst(slow, prankster, buildAIMove({ id: 'iceshard' }, 1),
			[buildAIMove({ id: 'thunderwave' }, 1)], {}), false, 'Exact action order retains Prankster priority');
		assert.equal(score('iceshard', { actor: slow, target: prankster }).flags.goesFirst, true,
			'Attack-race rewards do not compare against status candidates');
	});

	for (const id of ['explosion', 'selfdestruct', 'mistyexplosion']) {
		it(`${id} cannot earn a two-hit KO bonus, but retains a one-hit KO bonus`, () => {
			const actor = pokemon();
			const target = pokemon({ types: ['Normal'] });
			const field = { weather: '', terrain: '' };
			const move = buildAIMove({ id }, 1, 'gen9customgame');
			const damage = calculateDamage(actor, target, move, field);
			target.hp = target.maxHp = Math.ceil(damage.average * 1.5);
			const result = score(id, { actor, target, formatId: 'gen9customgame' });
			assert.equal(result.flags.canKO, false);
			assert.equal(result.flags.can2HKO, false);
			assert(!result.breakdown.details.some(d => /Can 2HKO/.test(d.reason)));
			target.hp = 1;
			target.hpPercent = 100 / target.maxHp;
			const lethal = score(id, { actor, target, formatId: 'gen9customgame' });
			assert.equal(lethal.flags.canKO, true);
			assert(lethal.breakdown.details.some(d => d.reason === 'Can knock out target'));
		});
	}

	for (const [move, type, ability] of [
		['earthquake', 'Ground', 'Levitate'], ['earthquake', 'Ground', 'Earth Eater'],
		['thunderbolt', 'Electric', 'Volt Absorb'], ['surf', 'Water', 'Storm Drain'],
		['flamethrower', 'Fire', 'Flash Fire'], ['energyball', 'Grass', 'Sap Sipper'],
	]) {
		it(`gives no bonuses against ${ability}, and allows Mold Breaker to bypass it`, () => {
			for (const bypass of [false, true]) {
				const actor = pokemon({ types: [type], ability: bypass ? 'Mold Breaker' : 'Synchronize' });
				const target = pokemon({ ability, types: ['Normal'] });
				const result = score(move, { actor, target, formatId: 'gen9customgame' });
				const damage = calculateDamage(actor, target, buildAIMove({ id: move }, 1), { weather: '', terrain: '' });
				assert.equal(result.flags.isImmune, !bypass);
				assert.equal(damage.average === 0, !bypass);
				const battle = new Battle({
					formatid: 'gen9customgame', seed: [1, 2, 3, 4],
					p1: { name: 'Attacker', team: [{ species: 'Mew', ability: actor.ability, moves: [move] }] },
					p2: { name: 'Target', team: [{ species: 'Mew', ability, moves: ['splash'] }] },
				});
				try {
					battle.makeChoices();
					battle.makeChoices('move 1', 'move 1');
					assert.equal(battle.p2.active[0].hp === battle.p2.active[0].maxhp, !bypass);
				} finally { battle.destroy(); }
				if (!bypass) {
					assert.equal(result.score, 0);
					assert.equal(result.flags.hasNoEffect, true);
					assert.equal(result.breakdown.positives, 0);
				}
			}
		});
	}

	it('respects public grounding and Ability Shield without treating Earth Eater as Levitate', () => {
		const cases = [
			{ gravity: true }, { item: 'Iron Ball' }, { volatile: 'smackdown' }, { volatile: 'ingrain' },
			{ move: 'thousandarrows' },
			{ item: 'Iron Ball', magicroom: true, immune: true },
			{ item: 'Ability Shield', attackerAbility: 'Mold Breaker', immune: true },
			{ item: 'Ability Shield', attackerAbility: 'Mold Breaker', magicroom: true },
			{ ability: 'Earth Eater', gravity: true, immune: true },
		];
		for (const scenario of cases) {
			const actor = pokemon({ ability: scenario.attackerAbility || 'Synchronize', types: ['Ground'] });
			const target = pokemon({ ability: scenario.ability || 'Levitate', item: scenario.item || '', types: ['Normal'],
				volatiles: new Set(scenario.volatile ? [scenario.volatile] : []),
			});
			const field = { weather: '', terrain: '', gravity: !!scenario.gravity, magicroom: !!scenario.magicroom };
			const move = scenario.move || 'earthquake';
			const result = score(move, { actor, target, field, formatId: 'gen9customgame' });
			assert.equal(result.flags.isImmune, !!scenario.immune, JSON.stringify(scenario));
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Attacker', team: [{ species: 'Mew', ability: actor.ability, moves: [move] }] },
				p2: { name: 'Target', team: [{ species: 'Mew', ability: target.ability, item: target.item, moves: ['splash'] }] },
			});
			try {
				battle.makeChoices();
				if (scenario.gravity) battle.field.addPseudoWeather('gravity', battle.p1.active[0]);
				if (scenario.magicroom) battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
				if (scenario.volatile) battle.p2.active[0].addVolatile(scenario.volatile, battle.p1.active[0]);
				battle.makeChoices('move 1', 'move 1');
				assert.equal(battle.p2.active[0].hp === battle.p2.active[0].maxhp, !!scenario.immune, JSON.stringify(scenario));
			} finally { battle.destroy(); }
		}
	});

	for (const [moveId, ability] of [['boomburst', 'Soundproof'], ['aurasphere', 'Bulletproof'], ['tackle', 'Wonder Guard']]) {
		it(`shares ${ability} immunity and Mold Breaker bypass between damage, scoring and PS`, () => {
			for (const bypass of [false, true]) {
				const actor = pokemon({ ability: bypass ? 'Mold Breaker' : 'Synchronize' });
				const target = pokemon({ ability, types: ['Normal'] });
				const field = { formatId: 'gen9customgame', weather: '', terrain: '' };
				const result = score(moveId, { actor, target, field, formatId: field.formatId });
				const damage = calculateDamage(actor, target, buildAIMove({ id: moveId }, 1), field);
				const battle = new Battle({ formatid: field.formatId, seed: [1, 2, 3, 4],
					p1: { name: 'Actor', team: [{ species: 'Mew', ability: actor.ability, moves: [moveId] }] },
					p2: { name: 'Target', team: [{ species: 'Snorlax', ability, moves: ['splash'] }] },
				});
				try {
					battle.makeChoices();
					battle.makeChoices('move 1', 'move 1');
					const hit = battle.p2.active[0].hp < battle.p2.active[0].maxhp;
					assert.equal(hit, bypass);
					assert.equal(damage.average > 0, hit);
					assert.equal(result.flags.isImmune, !hit);
					if (!hit) {
						assert.equal(result.score, 0);
						assert.equal(result.breakdown.positives, 0);
						assert.equal(result.flags.canKO, false);
						assert.equal(result.flags.can2HKO, false);
					}
				} finally { battle.destroy(); }
			}
		});
	}

	for (const scenario of [
		{ move: 'earthquake', species: 'Charizard', gravity: true, effect: 2 },
		{ move: 'earthquake', species: 'Charizard', item: 'Iron Ball', effect: 1 },
		{ move: 'earthquake', species: 'Charizard', item: 'Iron Ball', magicroom: true, effect: 0 },
		{ move: 'earthquake', species: 'Charizard', item: 'Ring Target', effect: 2 },
		{ move: 'earthquake', species: 'Mew', item: 'Air Balloon', effect: 0 },
		{ move: 'earthquake', species: 'Mew', item: 'Air Balloon', gravity: true, effect: 1 },
		{ move: 'earthquake', species: 'Mew', volatile: 'magnetrise', effect: 0 },
		{ move: 'thousandarrows', species: 'Charizard', effect: 1 },
		{ move: 'freezedry', species: 'Gyarados', effect: 4 },
		{ move: 'flyingpress', species: 'Tyranitar', effect: 2 },
		{ move: 'tackle', species: 'Gengar', ability: 'Scrappy', effect: 1 },
	]) {
		it(`matches PS move interaction: ${JSON.stringify(scenario)}`, () => {
			const { Dex } = require('../../../dist/sim');
			const actor = pokemon({ ability: scenario.ability || 'Synchronize' });
			const target = pokemon({ species: scenario.species, types: Dex.species.get(scenario.species).types,
				item: scenario.item || '', volatiles: new Set(scenario.volatile ? [scenario.volatile] : []),
			});
			const field = { formatId: 'gen9customgame', weather: '', terrain: '',
				gravity: !!scenario.gravity, magicroom: !!scenario.magicroom };
			const move = buildAIMove({ id: scenario.move }, 1, field.formatId);
			const damage = calculateDamage(actor, target, move, field);
			assert.equal(damage.effectiveness, scenario.effect);
			const result = score(scenario.move, { actor, target, field, formatId: field.formatId });
			assert.equal(result.flags.isImmune, !scenario.effect);
			assert.equal(result.flags.isSuperEffective, scenario.effect > 1);
			const battle = new Battle({ formatid: field.formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: actor.ability, moves: [scenario.move] }] },
				p2: { name: 'Target', team: [{ species: scenario.species, ability: 'Pressure', item: target.item, moves: ['splash'] }] },
			});
			try {
				battle.makeChoices();
				if (scenario.gravity) battle.field.addPseudoWeather('gravity', battle.p1.active[0]);
				if (scenario.magicroom) battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
				if (scenario.volatile) battle.p2.active[0].addVolatile(scenario.volatile, battle.p2.active[0]);
				battle.makeChoices('move 1', 'move 1');
				assert.equal(battle.p2.active[0].hp < battle.p2.active[0].maxhp, !!scenario.effect);
				assert.equal(battle.log.some(line => line.startsWith('|-supereffective|')), scenario.effect > 1);
			} finally { battle.destroy(); }
		});
	}

	for (const formatId of ['gen5customgame', 'gen6customgame', 'gen7customgame', 'gen5pokemmorandombattle']) {
		it(`matches PS paralysis speed and item suppression in ${formatId}`, () => {
			const { getEffectiveSpeed } = require('../../../dist/server/npc/ai/cfru/util/speed');
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: 'Synchronize', item: 'Choice Scarf', moves: ['splash'] }] },
				p2: { name: 'Target', team: [{ species: 'Mew', moves: ['splash'] }] },
			});
			try {
				battle.makeChoices();
				const actual = battle.p1.active[0];
				actual.setStatus('par');
				const actor = pokemon({ baseStats: { ...actual.storedStats }, status: 'par', item: 'Choice Scarf' });
				const field = { formatId, weather: '', terrain: '' };
				assert.equal(getEffectiveSpeed(actor, field), actual.getStat('spe'));
				battle.field.addPseudoWeather('magicroom', actual);
				assert.equal(getEffectiveSpeed(actor, { ...field, magicroom: true }), actual.getStat('spe'));
			} finally { battle.destroy(); }
		});
	}

	for (const formatId of ['gen6customgame', 'gen7customgame']) {
		it(`${formatId}: Normal and Hard agree with PS on damaged Gale Wings priority`, () => {
			const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
			const battle = new Battle({ formatid: formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Talonflame', ability: 'Gale Wings', moves: ['peck'] }] },
				p2: { name: 'Target', team: [{ species: 'Electrode', ability: 'Soundproof', moves: ['tackle'] }] },
			});
			try {
				battle.makeChoices();
				const actual = battle.p1.active[0];
				actual.hp = Math.floor(actual.maxhp / 2);
				const actor = pokemon({ species: 'Talonflame', types: ['Fire', 'Flying'], ability: 'Gale Wings',
					hpPercent: 50, baseStats: { ...actual.storedStats } });
				const target = pokemon({ moves: ['tackle'], baseStats: { ...battle.p2.active[0].storedStats } });
				const normal = score('peck', { actor, target, formatId }).flags.goesFirst;
				const state = { self: { active: [actor], team: [actor], conditions: {} },
					opponent: { active: [target], team: [target], conditions: {} }, field: { weather: '', terrain: '', trickroom: false } };
				const hard = new HardEvaluation(state, formatId).first(actor, target,
					buildAIMove({ id: 'peck' }, 1, formatId), buildAIMove({ id: 'tackle' }, 1, formatId));
				const cursor = battle.log.length;
				battle.makeChoices('move 1', 'move 1');
				const first = battle.log.slice(cursor).find(line => line.startsWith('|move|')).startsWith('|move|p1');
				assert.equal(normal, first);
				assert.equal(hard, first ? 1 : 0);
				assert.equal(first, formatId === 'gen6customgame');
			} finally { battle.destroy(); }
		});
	}

	it('uses the format type chart for damage and resistance scoring', () => {
		const actor = pokemon();
		const target = pokemon({ types: ['Steel'] });
		for (const [formatId, effect] of [['gen5customgame', 0.5], ['gen6customgame', 1]]) {
			const damage = calculateDamage(actor, target, buildAIMove({ id: 'shadowball' }, 1, formatId),
				{ formatId, weather: '', terrain: '' });
			assert.equal(damage.effectiveness, effect);
			const result = score('shadowball', { actor, target, formatId });
			assert.equal(result.breakdown.details.some(d => d.reason.startsWith('Resisted')), effect < 1);
		}
	});

	it('uses effective priority and grounding for Psychic Terrain without blocking allied priority support', () => {
		const { getMoveInteraction } = require('../../../dist/server/npc/ai/cfru/util/type-calc');
		const field = { formatId: 'gen9customgame', weather: '', terrain: 'psychic' };
		const actor = pokemon({ ability: 'Prankster' });
		for (const [types, item, gravity, blocked] of [
			[['Normal'], '', false, true], [['Flying'], '', false, false],
			[['Normal'], 'Air Balloon', false, false], [['Flying'], '', true, true],
		]) {
			const target = pokemon({ types, item });
			const result = score('taunt', { actor, target, field: { ...field, gravity }, formatId: field.formatId });
			assert.equal(result.flags.hasNoEffect, blocked);
			if (blocked) assert.equal(result.score, 0);
			const battle = new Battle({ formatid: field.formatId, seed: [1, 2, 3, 4],
				p1: { name: 'Actor', team: [{ species: 'Mew', ability: 'Prankster', moves: ['taunt'] }] },
				p2: { name: 'Target', team: [{ species: types[0] === 'Flying' ? 'Tornadus' : 'Mew',
					ability: 'Pressure', item, moves: ['splash'] }] },
			});
			try {
				battle.makeChoices();
				battle.field.setTerrain('psychicterrain', battle.p1.active[0]);
				if (gravity) battle.field.addPseudoWeather('gravity', battle.p1.active[0]);
				battle.makeChoices('move 1', 'move 1');
				assert.equal(!!battle.p2.active[0].volatiles.taunt, !blocked);
			} finally { battle.destroy(); }
		}
		assert.equal(getMoveInteraction(actor, pokemon({ ability: 'Armor Tail' }),
			buildAIMove({ id: 'helpinghand' }, 1), field, { isAllyTarget: true }).blockedBy, undefined);
	});

	it('uses the current generation when scoring the category of an opponent move', () => {
		const target = pokemon({ moves: ['crunch', 'protect', 'toxic', 'rest'] });
		for (const [formatId, expected] of [['gen3customgame', true], ['gen4customgame', false]]) {
			const result = score('counter', { target, formatId });
			assert.equal(result.breakdown.details.some(d => /target has no physical/.test(d.reason)), expected, formatId);
		}
	});

	it('rejects repeated Yawn from public drowsiness without blocking immediate sleep moves', () => {
		const tracker = createBattleTracker('p2');
		tracker.setFormat('gen5pokemmorandombattle');
		tracker.parseMessage('|switch|p1a: Granbull|Granbull, L90|100/100');
		tracker.parseMessage('|-start|p1a: Granbull|move: Yawn|[of] p2a: Torkoal');
		const target = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen5pokemmorandombattle');
		const result = score('yawn', { target });
		assert.equal(result.flags.hasNoEffect, true);
		assert(result.breakdown.details.some(d => /already drowsy/.test(d.reason) && d.amount < 0));
		assert(!result.breakdown.details.some(d => /Sleep is disruptive/.test(d.reason)));
		assert(score('flamethrower', { target }).score > result.score);
		assert.equal(score('hypnosis', { target }).flags.hasNoEffect, false);
		tracker.parseMessage('|-end|p1a: Granbull|move: Yawn|[silent]');
		const awake = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen5pokemmorandombattle');
		assert.equal(score('yawn', { target: awake }).flags.hasNoEffect, false);
	});

	for (const [id, attack, other] of [['counter', 'waterfall', 'surf'], ['mirrorcoat', 'surf', 'waterfall']]) {
		it(`${id} uses public candidates without treating unknown slots as empty`, () => {
			const noAttackReason = result => result.breakdown.details.some(d => /target has no/.test(d.reason));
			const revealed = ['protect', 'toxic', 'rest', other];
			assert.equal(noAttackReason(score(id, { target: pokemon({ moves: [] }) })), false);
			assert.equal(noAttackReason(score(id, { target: pokemon({ moves: revealed.slice(0, 3) }) })), false);
			assert.equal(noAttackReason(score(id, { target: pokemon({ moves: revealed }) })), true);
			const target = pokemon({
				moves: [], moveKnowledge: { revealedMoves: [], presetCandidates: [attack], remainingSlots: 4 },
			});
			assert.equal(noAttackReason(score(id, { target })), false);
			const field = { weather: '', terrain: '', trickroom: false };
			const actor = pokemon();
			const move = buildAIMove({ id }, 1);
			assert(calculateDamage(actor, target, move, field).average > 0);
			target.lastMove = other;
			assert(calculateDamage(actor, target, move, field).average > 0, 'A different last category does not exclude candidates');
			target.lastMove = '';
			target.moveKnowledge = { revealedMoves: revealed, presetCandidates: [attack], remainingSlots: 0 };
			target.moves = revealed;
			assert.equal(calculateDamage(actor, target, move, field).average, 0, 'Full revealed set excludes incompatible candidate');
		});
	}

	it('predicts Counter against an unrevealed Bibarel from the public random configuration', () => {
		const tracker = createBattleTracker('p2');
		tracker.setFormat('gen5pokemmorandombattle');
		tracker.parseMessage('|switch|p1a: Bibarel|Bibarel, L93|100/100');
		const target = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen5pokemmorandombattle');
		const result = score('counter', { target });
		assert(!result.breakdown.details.some(d => /target has no physical/.test(d.reason)));
		assert(calculateDamage(pokemon(), target, buildAIMove({ id: 'counter' }, 1), { weather: '', terrain: '' }).average > 0);
	});

	it('uses current weather for reflected damage and invents no attack for an unknown opponent', () => {
		const actor = pokemon();
		const move = buildAIMove({ id: 'mirrorcoat' }, 1);
		const target = pokemon({
			moves: [], moveKnowledge: { revealedMoves: [], presetCandidates: ['flamethrower'], remainingSlots: 4 },
		});
		const neutral = calculateDamage(actor, target, move, { weather: '', terrain: '' });
		const sun = calculateDamage(actor, target, move, { weather: 'sun', terrain: '' });
		assert(sun.average > neutral.average);
		target.moveKnowledge.presetCandidates = [];
		assert.equal(calculateDamage(actor, target, move, { weather: '', terrain: '' }).average, 0);
		target.moves = ['counter', 'mirrorcoat', 'metalburst'];
		assert.equal(calculateDamage(actor, target, move, { weather: '', terrain: '' }).average, 0);
	});

	for (const move of ['aromatherapy', 'healbell']) {
		it(`rejects ${move} without a living teammate to cure`, () => {
			for (const reserve of [[], [pokemon({ status: 'brn', fainted: true, hp: 0 })]]) {
				const result = score(move, { reserve });
				assert.equal(result.score, 0);
				assert.equal(result.flags.hasNoEffect, true);
				assert(result.breakdown.details.some(d => /no teammate has a status/.test(d.reason)));
			}
			for (const options of [
				{ actor: pokemon({ status: 'psn' }) },
				{ reserve: [pokemon({ status: 'slp', active: false })] },
			]) {
				assert.equal(score(move, options).flags.hasNoEffect, false);
			}
		});
	}

	it('Normal attacks instead of using Aromatherapy on a healthy team', () => {
		const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
		ai.setBattle({ format: 'gen5pokemmorandombattle' });
		ai.getTracker().parseMessage('|switch|p1a: Armaldo|Armaldo, L86|81/100 slp');
		let choice;
		ai.choose = value => { choice = value; };
		const moves = ['sludgebomb', 'sleeppowder', 'aromatherapy', 'synthesis'];
		ai.receiveRequest({
			side: { id: 'p2', pokemon: [{
				ident: 'p2: Vileplume', details: 'Vileplume, L88', condition: '275/275', active: true,
				stats: { atk: 150, def: 200, spa: 240, spd: 200, spe: 180 },
				moves, ability: 'Chlorophyll', item: 'blacksludge',
			}] },
			active: [{ moves: moves.map(id => ({ id, move: id, pp: 10, maxpp: 10, target: 'normal' })) }],
		});
		assert.equal(choice, 'move 1');
		assert.equal(ai.lastMoveScores.find(s => s.move.id === 'aromatherapy').score, 0);
	});

	for (const ability of ['Clear Body', 'White Smoke', 'Full Metal Body', 'Mirror Armor', 'Defiant', 'Competitive', 'Contrary']) {
		it(`does not treat self stat drops as effects on ${ability}`, () => {
			const target = pokemon({ ability });
			for (const id of ['leafstorm', 'closecombat', 'superpower', 'dracometeor', 'overheat', 'vcreate']) {
				const result = score(id, { target });
				assert(!result.breakdown.details.some(d => d.reason.includes(ability)), `${id}: ${JSON.stringify(result.breakdown)}`);
			}
			assert(score('charm', { target }).breakdown.details.some(d => d.reason.includes(ability)));
		});
	}

	it('matches Clear Body allowing Leaf Storm self drops in a real MMO battle', () => {
		const battle = new Battle({
			formatid: 'gen5pokemmorandombattle', seed: [1, 2, 3, 4],
			p1: { name: 'Plant', team: [{ species: 'Roserade', ability: 'Natural Cure', moves: ['leafstorm'] }] },
			p2: { name: 'Steel', team: [{ species: 'Klinklang', ability: 'Clear Body', moves: ['splash'] }] },
		});
		try {
			battle.makeChoices('move 1', 'move 1');
			assert.equal(battle.p1.active[0].boosts.spa, -2);
			assert(battle.p2.active[0].hp < battle.p2.active[0].maxhp);
		} finally {
			battle.destroy();
		}
	});
});
