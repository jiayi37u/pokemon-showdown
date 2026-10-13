'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, buildPokemonFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { calculateDamage, getModifiedBasePower } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { createCache } = require('../../../dist/server/npc/ai/cfru/util/cache');

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
