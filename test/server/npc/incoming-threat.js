'use strict';

const assert = require('assert').strict;
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, buildPokemonFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');

function pokemon(species, hp, maxHp = hp, moves = ['surf']) {
	return {
		ident: `p2: ${species}`, details: `${species}, L100`, condition: `${hp}/${maxHp}`,
		active: false, stats: { atk: 200, def: 200, spa: 250, spd: 200, spe: 200 },
		moves, baseAbility: 'Torrent', item: '', pokeball: 'pokeball',
	};
}

/** Haunter has no preset attacks. Level 70 Night Shade gives exact 70% / 40% boundaries without mocking damage or scoring. */
function decision({ hp = 100, reserves = [pokemon('Swampert', 175)], revealed = true, weak = false, trapped = false, forced = false, toxicTicks = 0, rocks = false } = {}) {
	const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.getTracker().parseMessage('|switch|p1a: Haunter|Haunter, L70|100/100');
	if (revealed) ai.getTracker().parseMessage('|move|p1a: Haunter|Night Shade|p2a: Blastoise');
	const move = weak ? 'Tackle' : 'Surf'; // Haunter is immune to Tackle.
	const current = { ...pokemon('Blastoise', hp, 200, [move.toLowerCase()]), active: true };
	current.stats.spa = 100; // Keep Haunter outside KO range so these fixtures exercise the threat thresholds.
	if (toxicTicks) {
		current.condition += ' tox';
		ai.getTracker().parseMessage(`|switch|p2a: Blastoise|Blastoise, L100|${current.condition}`);
		for (let i = 0; i < toxicTicks; i++) {
			ai.getTracker().parseMessage(`|-damage|p2a: Blastoise|${current.condition}|[from] psn`);
		}
	}
	if (rocks) ai.getTracker().parseMessage('|-sidestart|p2: NPC|Stealth Rock');
	const request = {
		side: { id: 'p2', pokemon: [current, ...reserves] },
		active: [{ trapped, moves: [{ move, id: move.toLowerCase(), pp: 10, maxpp: 10, target: weak ? 'normal' : 'allAdjacent' }] }],
	};
	if (forced) {
		current.condition = '0 fnt';
		delete request.active;
		request.forceSwitch = [true];
	}
	let choice;
	ai.choose = value => { choice = value; };
	ai.receiveRequest(request);
	return { ai, choice };
}

describe('NormalAI incoming threat switching', () => {
	for (const mode of ['doubles', 'multi']) it(`${mode}: adds each opponent's strongest attack`, () => {
		const { ai } = decision();
		const state = ai.battleState;
		state.isDoubles = true;
		const foe = state.opponent.active[0];
		const partner = { ...foe, slot: 2, ownerSide: mode === 'multi' ? 'p3' : 'p1', ident: 'p1b: Haunter' };
		state.opponent.active.push(partner);
		const actor = state.self.active[0];
		assert.equal(ai.getIncomingThreat(actor, [foe]), 0.7);
		assert.equal(ai.getIncomingThreat(actor, state.opponent.active), 1.4);
	});

	it('does not retreat from an attack during confirmed sleep or recharge', () => {
		const { ai } = decision();
		const actor = ai.battleState.self.active[0], foe = ai.battleState.opponent.active[0];
		foe.volatiles.add('mustrecharge');
		assert.equal(ai.getIncomingThreat(actor, [foe]), 0);
		foe.volatiles.delete('mustrecharge'); foe.status = 'slp'; foe.sleepTurns = 2;
		assert.equal(ai.getIncomingThreat(actor, [foe]), 0);
		foe.sleepTurns = undefined;
		assert.equal(ai.getIncomingThreat(actor, [foe]), 0.7, 'Unknown wake time remains a threat');
	});

	it('distinguishes neutral damage, resistance and immunity when ranking replacements', () => {
		const ai = new NormalAI({ write() {} });
		ai.setBattle({ format: 'gen5pokemmorandombattle' });
		const target = { types: ['Electric', 'Ground'], moves: ['discharge', 'earthpower'] };
		const neutral = ai.scoreSwitchOption(pokemon('Persian', 300, 300, []), target);
		assert.equal(neutral.score, 10, 'Neutral hits only receive the full-HP bonus');
		assert(!neutral.reasons.some(reason => /Immune|Resists/.test(reason)));
		const immune = ai.scoreSwitchOption(pokemon('Swampert', 300, 300, []), target);
		assert(immune.reasons.includes('Immune to 1 move(s)'));
		const resisted = ai.scoreSwitchOption(pokemon('Tangrowth', 300, 300, []), target);
		assert(resisted.reasons.includes('Resists 2 move(s)'));
		const weak = ai.scoreSwitchOption(pokemon('Charizard', 300, 300, []), {
			types: ['Water'], moves: ['surf'],
		});
		assert(!weak.reasons.some(reason => /Immune|Resists/.test(reason)), 'Neutral Flying does not erase Fire weakness');
		const attack = ai.scoreSwitchOption(pokemon('Swampert', 300, 300, ['surf']), {
			types: ['Fire', 'Normal'], moves: [],
		});
		assert(attack.reasons.includes('STAB super effective (Surf)'), 'Neutral second type does not erase weakness');
	});

	for (const [format, type] of [['gen5pokemmorandombattle', 'Normal'], ['gen9customgame', 'Fairy']]) {
		it(`uses ${type} for active, reserve and opposing Granbull in ${format}`, () => {
			const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
			ai.setBattle({ format });
			ai.getTracker().parseMessage('|switch|p1a: Granbull|Granbull, L100|100/100');
			const own = { ...pokemon('Granbull', 300, 300, ['return']), active: true };
			ai.choose = () => {};
			ai.receiveRequest({
				side: { id: 'p2', pokemon: [own, pokemon('Granbull', 300)] },
				active: [{ moves: [{ id: 'return', move: 'Return', pp: 10, maxpp: 10, target: 'normal' }] }],
			});
			for (const mon of [...ai.battleState.self.team, ...ai.battleState.opponent.active]) {
				assert.deepEqual(mon.types, [type]);
			}
			const details = ai.lastMoveScores[0].breakdown.details;
			assert.equal(details.some(detail => detail.reason === 'STAB bonus'), type === 'Normal');
			assert.deepEqual(buildPokemonFromRequest(own, 1, false, format).types, [type]);
		});
	}

	it('should use average damage, not the highest roll or accuracy, for the KO threshold', () => {
		const { ai } = decision();
		const state = ai.battleState;
		const actor = state.self.active[0];
		const target = state.opponent.active[0];
		actor.baseStats.spe = target.baseStats.spe + 1;
		const move = buildAIMove({ id: 'hydropump' }, 1);
		const damage = calculateDamage(actor, target, move, state.field);
		assert(damage.max > damage.average);
		target.hp = damage.average;
		target.hpPercent = target.hp / target.maxHp * 100;
		assert.equal(ai.canKOFirst(actor, target, move), true);
		target.hp++;
		target.hpPercent = target.hp / target.maxHp * 100;
		assert.equal(ai.canKOFirst(actor, target, move), false);
	});

	it('should require first strike, accounting for ties, Trick Room, Tailwind and known priority', () => {
		const { ai } = decision();
		const state = ai.battleState;
		const actor = state.self.active[0];
		const target = state.opponent.active[0];
		const move = buildAIMove({ id: 'surf' }, 1);
		target.hp = 1;
		target.hpPercent = 100 / target.maxHp;
		actor.baseStats.spe = target.baseStats.spe;
		assert.equal(ai.canKOFirst(actor, target, move), false, 'A speed tie is not a first strike');
		actor.baseStats.spe--;
		assert.equal(ai.canKOFirst(actor, target, move), false, 'Slower');
		state.field.trickroom = true;
		assert.equal(ai.canKOFirst(actor, target, move), true, 'Slower in Trick Room');
		state.field.trickroom = false;
		state.self.conditions.tailwind = 3;
		assert.equal(ai.canKOFirst(actor, target, move), true, 'Faster with Tailwind');
		target.moveKnowledge = { revealedMoves: ['protect'], presetCandidates: ['tackle'], remainingSlots: 3 };
		assert.equal(ai.canKOFirst(actor, target, move), true, 'Protect is not an opposing attack');
		target.moveKnowledge = { revealedMoves: ['suckerpunch'], presetCandidates: [], remainingSlots: 3 };
		assert.equal(ai.canKOFirst(actor, target, move), false, 'Opponent has priority');
	});

	it('should not invent unrevealed attacks', () => {
		const { ai } = decision({ revealed: false });
		assert.deepEqual(ai.battleState.opponent.active[0].moves, []);
	});

	it('cannot switch with no reserves or while trapped', () => {
		assert(decision({ reserves: [] }).choice.startsWith('move '));
		assert(decision({ trapped: true }).choice.startsWith('move '));
	});

	it('allows the sole legal forced replacement despite incoming damage', () => {
		assert.equal(decision({ forced: true, reserves: [pokemon('Swampert', 1, 400)] }).choice, 'switch 2');
	});

	it('should reuse preset stats and the 31 IV / 85 EV fallback, keeping preset candidates separate from revealed moves', () => {
		const { ai } = decision();
		ai.getTracker().parseMessage('|switch|p1a: Hydreigon|Hydreigon, L100|100/100');
		const request = {
			side: { id: 'p2', pokemon: [{ ...pokemon('Blastoise', 300), active: true }] },
			active: [{ moves: [{ move: 'Surf', id: 'surf', pp: 10, target: 'allAdjacent' }] }],
		};
		ai.receiveRequest(request);
		assert.equal(ai.battleState.opponent.active[0].baseStats.spa, 349); // Timid, 252 SpA EVs.
		assert(ai.getIncomingThreat(ai.battleState.self.active[0], ai.battleState.opponent.active) > 0);
		assert.deepEqual(ai.battleState.opponent.active[0].moves, []);
		ai.getTracker().parseMessage('|switch|p1a: Charizard|Charizard, L100|100/100');
		ai.getTracker().parseMessage('|move|p1a: Charizard|Flamethrower|p2a: Blastoise');
		ai.receiveRequest(request);
		assert.equal(ai.battleState.opponent.active[0].baseStats.spa, 275); // Neutral, 31 IV / 85 EV.
		const scizor = buildPokemonFromRequest(pokemon('Scizor', 300), 1, true);
		assert(ai.getIncomingThreat(scizor, ai.battleState.opponent.active) >= 1);
	});
});
