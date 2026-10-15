'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
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
function decision({ hp = 100, reserves = [pokemon('Swampert', 175)], revealed = true, weak = false, trapped = false, forced = false } = {}) {
	const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.getTracker().parseMessage('|switch|p1a: Haunter|Haunter, L70|100/100');
	if (revealed) ai.getTracker().parseMessage('|move|p1a: Haunter|Night Shade|p2a: Blastoise');
	const move = weak ? 'Tackle' : 'Surf'; // Haunter is immune to Tackle.
	const current = { ...pokemon('Blastoise', hp, 200, [move.toLowerCase()]), active: true };
	current.stats.spa = 100; // Keep Haunter outside KO range so these fixtures exercise the threat thresholds.
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
	it('should keep Victini in to finish Slowking with Bolt Strike despite lethal incoming Scald', () => {
		const battle = new Battle({
			formatid: 'gen7customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Slowking', ability: 'Regenerator', item: 'Leftovers',
				nature: 'Calm', evs: { hp: 252, def: 4, spd: 252 }, moves: ['scald'] }] },
			p2: { name: 'NPC', team: [
				{ species: 'Victini', ability: 'Victory Star', nature: 'Jolly', evs: { atk: 252, spe: 252 },
					moves: ['boltstrike'] },
				{ species: 'Wigglytuff', ability: 'Frisk', item: 'Leftovers', moves: ['hypervoice'] },
			] },
		});
		const stream = { push() {}, write() {} };
		const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
		ai.setBattle({ stream, format: 'gen7customgame' });
		let choice;
		ai.choose = value => { choice = value; };
		try {
			battle.makeChoices();
			battle.makeChoices('move 1', 'move 1');
			assert(battle.p1.active[0].hp > 0);
			stream.push(battle.log.join('\n'));
			ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
			const state = ai.battleState;
			assert(ai.getIncomingThreat(state.self.active[0], state.opponent.active) >= 1);
			assert.equal(choice, 'move 1');
			assert(battle.choose('p2', choice), battle.p2.choice.error);
			assert(battle.choose('p1', 'move 1'), battle.p1.choice.error);
			assert.equal(battle.p1.active[0].hp, 0);
		} finally {
			battle.destroy();
		}
	});

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
		target.moveKnowledge = { revealedMoves: ['suckerpunch'], presetCandidates: [], remainingSlots: 3 };
		assert.equal(ai.canKOFirst(actor, target, move), false, 'Opponent has priority');
	});

	it('should switch at exactly 70% threat and admit a replacement at exactly 40%', () => {
		assert.equal(decision().choice, 'switch 2');
	});

	it('should keep attacking below 70% threat when its move is useful', () => {
		assert(decision({ hp: 101 }).choice.startsWith('move '));
	});

	it('should reject a replacement just above 40% even when the active Pokemon is threatened', () => {
		assert(decision({ reserves: [pokemon('Swampert', 174)] }).choice.startsWith('move '));
	});

	it('should use current HP rather than maximum HP for admission', () => {
		assert(decision({ reserves: [pokemon('Swampert', 100, 400)] }).choice.startsWith('move '));
	});

	it('should apply admission to low move scores too', () => {
		assert.equal(decision({ hp: 200, weak: true }).choice, 'switch 2');
		assert(decision({ hp: 200, weak: true, reserves: [pokemon('Swampert', 174)] }).choice.startsWith('move '));
	});

	it('should rank eligible replacements with existing scores, not by lowest threat', () => {
		const reserves = [pokemon('Swampert', 350, 700), pokemon('Blastoise', 175)];
		assert.equal(decision({ reserves }).choice, 'switch 3');
	});

	it('should exclude an unsafe replacement even if its existing score is higher', () => {
		const reserves = [pokemon('Swampert', 174), pokemon('Blastoise', 175, 350)];
		assert.equal(decision({ reserves }).choice, 'switch 3');
	});

	it('should retain the score > 5 requirement for eligible replacements', () => {
		// Without revealed attacks or useful coverage, only the HP bonus contributes.
		assert(decision({ revealed: false, weak: true, reserves: [pokemon('Swampert', 50, 100, ['splash'])] }).choice.startsWith('move '));
		assert.equal(decision({ revealed: false, weak: true, reserves: [pokemon('Swampert', 60, 100, ['splash'])] }).choice, 'switch 2');
	});

	it('should not invent unrevealed attacks', () => {
		assert(decision({ revealed: false }).choice.startsWith('move '));
	});

	it('should stay in with no safe reserves or while trapped', () => {
		assert(decision({ reserves: [] }).choice.startsWith('move '));
		assert(decision({ reserves: [pokemon('Swampert', 1, 400)] }).choice.startsWith('move '));
		assert(decision({ trapped: true }).choice.startsWith('move '));
	});

	it('should allow forced replacements above 40% threat', () => {
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

	for (const activeIndex of [0, 1]) {
		it(`should switch threatened doubles slot ${activeIndex + 1} using attacks revealed by either opponent`, () => {
			const { ai } = decision();
			ai.getTracker().parseMessage('|switch|p1a: Magikarp|Magikarp, L100|100/100');
			ai.getTracker().parseMessage('|switch|p1b: Haunter|Haunter, L70|100/100');
			ai.getTracker().parseMessage('|move|p1b: Haunter|Night Shade|p2a: Blastoise');
			const party = [pokemon('Blastoise', 300), pokemon('Blastoise', 300), pokemon('Swampert', 175)];
			party[0].active = party[1].active = true;
			party[activeIndex].condition = '100/300';
			let choice;
			ai.choose = value => { choice = value; };
			ai.receiveRequest({
				side: { id: 'p2', pokemon: party },
				active: [0, 1].map(() => ({ moves: [{ move: 'Surf', id: 'surf', pp: 10, target: 'allAdjacent' }] })),
			});
			const actions = choice.split(', ');
			assert.equal(actions[activeIndex], 'switch 3');
			assert(actions[1 - activeIndex].startsWith('move '));
		});
	}

	it('should switch Scizor out of revealed Flamethrower and let the safe replacement act', () => {
		const battle = new Battle({
			formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Charizard', ability: 'Blaze', moves: ['flamethrower'] }] },
			p2: { name: 'NPC', team: [
				{ species: 'Scizor', ability: 'Technician', moves: ['protect', 'rockslide'] },
				{ species: 'Slowbro', ability: 'Regenerator', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['surf'] },
			] },
		});
		const stream = { push() {}, write() {} };
		const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
		ai.setBattle({ stream, format: 'gen9customgame' });
		let choice;
		let cursor = 0;
		ai.choose = value => { choice = value; };
		const decide = () => {
			stream.push(battle.log.slice(cursor).join('\n'));
			cursor = battle.log.length;
			ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
			return choice;
		};
		try {
			battle.makeChoices();
			battle.makeChoices('move 1', 'move 1'); // Protect reveals Flamethrower without losing Scizor.
			assert.equal(decide(), 'switch 2');
			assert(battle.choose('p2', choice), battle.p2.choice.error);
			assert(battle.choose('p1', 'move 1'), battle.p1.choice.error);
			assert.equal(battle.p2.active[0].species.id, 'slowbro');
			assert(decide().startsWith('move '), choice);
			assert(battle.choose('p2', choice), battle.p2.choice.error);
			assert(battle.choose('p1', 'move 1'), battle.p1.choice.error);
		} finally {
			battle.destroy();
		}
	});
});
