'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, buildPokemonFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { calculateDamage, getModifiedBasePower } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { createCache } = require('../../../dist/server/npc/ai/cfru/util/cache');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');

describe('AI item-dependent move types', () => {
	for (const [id, item, type, format] of [
		['judgment', 'skyplate', 'Flying', 'gen5pokemmorandombattle'],
		['multiattack', 'fightingmemory', 'Fighting', 'gen7customgame'],
		['technoblast', 'dousedrive', 'Water', 'gen5pokemmorandombattle'],
	]) {
		it(`scores ${id} with its held-item type and respects item suppression`, () => {
			for (const suppressed of [false, true]) {
				const ability = suppressed ? 'Klutz' : 'Synchronize';
				const battle = new Battle({
					formatid: format, seed: [1, 2, 3, 4],
					p1: { name: 'Attacker', team: [{ species: 'Mew', ability, item, moves: [id] }] },
					p2: { name: 'Target', team: [{ species: 'Tyranitar', ability: 'Unnerve', moves: ['splash'] }] },
				});
				try {
					if (battle.requestState === 'teampreview') battle.makeChoices('team 1', 'team 1');
					battle.makeChoices('move 1', 'move 1');
					const attacker = { ...pokemon(), ability, item, types: [type] };
					const target = { ...pokemon(), types: ['Rock', 'Dark'] };
					const state = {
						turn: 1, isDoubles: false, field,
						self: { active: [attacker], reserve: [], team: [attacker], conditions: {} },
						opponent: { active: [target], reserve: [], team: [target], conditions: {} },
					};
					const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: format }, createAICache(1));
					const move = buildAIMove({ id }, 1, format);
					const score = engine.scoreMove(state, attacker, move, target);
					assert.equal(score.move.type, suppressed ? 'Normal' : type);
					assert.equal(score.flags.isSuperEffective, battle.log.some(line => line.startsWith('|-supereffective|')));
					assert.equal(score.breakdown.details.some(d => /STAB bonus/.test(d.reason)), !suppressed);
					const damage = calculateDamage(attacker, target, move, field);
					assert.equal(damage.effectiveness > 1, score.flags.isSuperEffective);
				} finally {
					battle.destroy();
				}
			}
		});
	}

	it('Judgment hits Ghosts with a Plate but not a Z-Crystal or suppressed Plate', () => {
		const move = buildAIMove({ id: 'judgment' }, 1);
		const target = { ...pokemon(), types: ['Ghost'] };
		const attacker = { ...pokemon(), item: 'skyplate' };
		const cache = createCache(1);
		assert(calculateDamage(attacker, target, move, field, cache).average > 0);
		attacker.item = 'flyiniumz';
		assert.equal(calculateDamage(attacker, target, move, field, cache).average, 0);
		attacker.item = 'skyplate';
		assert.equal(calculateDamage(attacker, target, move, { ...field, magicroom: true }).average, 0);
		attacker.volatiles.add('embargo');
		assert.equal(calculateDamage(attacker, target, move, field).average, 0);
	});
});

describe('AI format-specific move damage', () => {
	for (const format of ['gen5customgame', 'gen5pokemmorandombattle', 'gen7randombattle', 'gen9randombattle']) {
		it(`uses ${format} Knock Off power with and without an item`, () => {
			const move = buildAIMove({ id: 'knockoff', basePower: 65 }, 1, format);
			const oldPower = format.startsWith('gen5');
			assert.equal(move.basePower, oldPower ? 20 : 65);
			const attacker = pokemon();
			const defender = pokemon();
			for (const item of ['', 'leftovers']) {
				defender.item = item;
				assert.equal(getModifiedBasePower(attacker, defender, move, field),
					oldPower ? 20 : item ? 97 : 65);
			}
		});
	}

	it('Normal does not mistake MMO Knock Off for a reliable KO over Power Whip', () => {
		const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
		ai.setBattle({ format: 'gen5pokemmorandombattle' });
		ai.getTracker().parseMessage('|switch|p1a: Claydol|Claydol, L86|42/100');
		ai.getTracker().parseMessage('|-enditem|p1a: Claydol|Leftovers|[from] move: Knock Off');
		let choice;
		ai.choose = value => { choice = value; };
		const moves = ['powerwhip', 'knockoff', 'sleeppowder', 'synthesis'];
		ai.receiveRequest({
			side: { id: 'p2', pokemon: [{
				ident: 'p2: Carnivine', details: 'Carnivine, L100', condition: '276/310', active: true,
				stats: { atk: 257, def: 200, spa: 237, spd: 200, spe: 149 },
				moves, ability: 'Levitate', item: 'leftovers',
			}] },
			active: [{ moves: moves.map(id => ({ id, move: id, pp: 10, maxpp: 10, target: 'normal' })) }],
		});
		assert.equal(choice, 'move 1');
		const knockOff = ai.lastMoveScores.find(s => s.move.id === 'knockoff');
		assert.equal(knockOff.move.basePower, 20);
		assert.equal(knockOff.flags.canKO, false);
	});
});

const field = { weather: '', terrain: '', trickroom: false };
function pokemon(hp = 480, maxHp = 480) {
	return buildPokemonFromRequest({
		details: 'Mew, L100', condition: `${hp}/${maxHp}`, moves: [],
		stats: { atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
	}, 1, true);
}

/** Use the simulator's own callbacks as an independent reference for power and rounding. */
const callbackContext = {
	debug() {}, add() {},
	clampIntRange(value, min) { return Math.max(min, Math.floor(value)); },
};
function simulatedPokemon(mon) {
	return {
		hp: mon.hp, maxhp: mon.maxHp,
		getUndynamaxedHP() { return this.hp; }, faint() {},
		volatiles: Object.fromEntries([...mon.volatiles].map(v => [v, {}])),
		side: { getSideCondition() { return false; } },
	};
}

describe('AI HP-dependent damage', () => {
	for (const id of ['waterspout', 'eruption', 'dragonenergy', 'flail', 'reversal', 'crushgrip', 'wringout', 'hardpress']) {
		it(`should match simulator power for ${id} across HP values and threshold boundaries`, () => {
			const dexMove = Dex.moves.get(id);
			const move = buildAIMove({ id }, 1);
			for (const maxHp of [480, 481]) {
				for (let hp = 1; hp <= maxHp; hp++) {
					const attacker = pokemon(hp, maxHp);
					const defender = pokemon(hp, maxHp);
					const nativePower = dexMove.basePowerCallback.call(callbackContext,
						simulatedPokemon(attacker), simulatedPokemon(defender), dexMove);
					assert.equal(getModifiedBasePower(attacker, defender, move, field),
						Math.max(1, Math.floor(nativePower)), `${id} at ${hp}/${maxHp}`);
				}
			}
			assert(calculateDamage(pokemon(), pokemon(), move, field).average > 0, 'Static power 0 must not skip dynamic power');
		});
	}

	it('should use the attacker HP for Water Spout and the defender HP for Crush Grip', () => {
		const attacker = pokemon(240);
		const defender = pokemon(120);
		assert.equal(getModifiedBasePower(attacker, defender, buildAIMove({ id: 'waterspout' }, 1), field), 75);
		assert.equal(getModifiedBasePower(attacker, defender, buildAIMove({ id: 'crushgrip' }, 1), field), 30);
	});

	it('should double Brine at or below half target HP', () => {
		const move = buildAIMove({ id: 'brine' }, 1);
		for (const [hp, expected] of [[239, 130], [240, 130], [241, 65]]) {
			assert.equal(getModifiedBasePower(pokemon(), pokemon(hp), move, field), expected);
		}
	});

	it('should apply Technician after resolving Flail power', () => {
		const move = buildAIMove({ id: 'flail' }, 1);
		assert.equal(getModifiedBasePower({ ...pokemon(), ability: 'Technician' }, pokemon(), move, field), 30);
		assert.equal(getModifiedBasePower({ ...pokemon(1), ability: 'Technician' }, pokemon(), move, field), 200);
	});

	for (const id of ['superfang', 'naturesmadness', 'ruination', 'guardianofalola', 'endeavor', 'finalgambit']) {
		it(`should match simulator current-HP damage for ${id}`, () => {
			const dexMove = Dex.moves.get(id);
			const move = buildAIMove({ id }, 1);
			for (const hp of [1, 2, 3, 49, 101, 200, 400]) {
				const attacker = pokemon(100);
				const defender = pokemon(hp);
				const expected = Math.max(0, dexMove.damageCallback.call(callbackContext,
					simulatedPokemon(attacker), simulatedPokemon(defender)));
				const result = calculateDamage(attacker, defender, move, field);
				assert.equal(result.min, expected, `${id} against ${hp} HP`);
				assert.equal(result.max, expected);
			}
		});
	}

	it('should reduce Guardian of Alola damage through known protection', () => {
		for (const status of ['protect', 'banefulbunker', 'kingsshield', 'spikyshield']) {
			const defender = pokemon(101);
			defender.volatiles.add(status);
			const move = Dex.moves.get('guardianofalola');
			const expected = move.damageCallback.call(callbackContext, simulatedPokemon(pokemon()), simulatedPokemon(defender));
			assert.equal(calculateDamage(pokemon(), defender, buildAIMove(move, 1), field).average, expected);
		}
	});

	for (const id of ['waterspout', 'flail', 'crushgrip', 'superfang', 'endeavor', 'finalgambit']) {
		it(`should not reuse stale HP-dependent cached damage for ${id}`, () => {
			const cache = createCache(1);
			const move = buildAIMove({ id }, 1);
			const attacker = pokemon();
			const defender = pokemon();
			const before = calculateDamage(attacker, defender, move, field, cache);
			attacker.hp = 1;
			attacker.hpPercent = 100 / attacker.maxHp;
			defender.hp = 240;
			defender.hpPercent = 50;
			const after = calculateDamage(attacker, defender, move, field, cache);
			assert.deepEqual(after, calculateDamage(attacker, defender, move, field));
			assert.notEqual(after.average, before.average);
		});
	}
});

describe('NormalAI HP-dependent moves after switching in', () => {
	it('should score Wailord using damage taken after switching in, then prefer Surf over Water Spout', () => {
		const battle = new Battle({
			formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Blissey', ability: 'Natural Cure', moves: ['nightshade'] }] },
			p2: { name: 'NPC', team: [
				{ species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] },
				{ species: 'Wailord', ability: 'Water Veil', moves: ['waterspout', 'surf'] },
			] },
		});
		const stream = { push() {}, write() {} };
		const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
		ai.setBattle({ stream, format: 'gen9customgame' });
		let choice;
		ai.choose = value => { choice = value; };
		try {
			battle.makeChoices();
			battle.makeChoices('move 1', 'switch 2');
			while (battle.p2.active[0].hp > battle.p2.active[0].maxhp / 2) battle.makeChoices('move 1', 'move 2');
			stream.push(battle.log.join('\n'));
			ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
			const state = ai.battleState;
			const attacker = state.self.active[0];
			assert.equal(attacker.hp, battle.p2.active[0].hp);
			assert(attacker.hpPercent < 50);
			const move = buildAIMove({ id: 'waterspout' }, 1);
			assert.equal(getModifiedBasePower(attacker, state.opponent.active[0], move, state.field), 56);
			const scores = ai.lastMoveScores;
			assert(scores.find(s => s.move.id === 'surf').score > scores.find(s => s.move.id === 'waterspout').score);
			assert.equal(choice, 'move 2');
			assert(battle.choose('p2', choice), battle.p2.choice.error);
		} finally {
			battle.destroy();
		}
	});
});
