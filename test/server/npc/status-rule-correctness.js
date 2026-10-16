'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { buildAIMove, trackedPokemonToAIPokemon } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
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

function score(id, { actor = pokemon(), target = pokemon(), reserve = [], formatId = 'gen5pokemmorandombattle' } = {}) {
	const state = {
		turn: 1, isDoubles: false,
		self: { active: [actor], reserve, team: [actor, ...reserve], conditions: {} },
		opponent: { active: [target], reserve: [], team: [target], conditions: {} },
		field: { weather: '', terrain: '', trickroom: false },
	};
	const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId }, createAICache(1));
	return engine.scoreMove(state, actor, buildAIMove({ id }, 1, formatId), target);
}

describe('NPC team cures and opponent stat-drop effects', () => {
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
