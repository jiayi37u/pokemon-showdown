'use strict';

const assert = require('assert').strict;
const { Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { getOpponentPreset, getOpponentThreatMoves, computeStatsFromPreset } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');

function partyPokemon(species, moves, hp = 400) {
	return {
		ident: `p2: ${species}`, details: `${species}, L100`, condition: `${hp}/${hp}`,
		active: false, moves, baseAbility: '', item: '',
		stats: { atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
	};
}

function scenario(revealed, { safeReserve = true } = {}) {
	const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.getTracker().parseMessage('|switch|p1a: Darmanitan|Darmanitan, L100|100/100');
	for (const move of revealed) ai.getTracker().parseMessage(`|move|p1a: Darmanitan|${Dex.moves.get(move).name}|p2a: Scizor`);
	const request = {
		side: { id: 'p2', pokemon: [
			{ ...partyPokemon('Scizor', ['rockslide'], 300), active: true },
			partyPokemon(safeReserve ? 'Slowbro' : 'Venusaur', ['surf']),
		] },
		active: [{ moves: [{ move: 'Rock Slide', id: 'rockslide', pp: 10, maxpp: 10, target: 'allAdjacentFoes' }] }],
	};
	let choice;
	ai.choose = value => { choice = value; };
	ai.receiveRequest(request);
	return { ai, choice };
}

describe('Opponent preset threat moves', () => {
	it('should merge and normalize common moves without changing revealed moves', () => {
		const revealed = ['Stone Edge', 'Ice Punch'];
		assert.deepEqual(getOpponentThreatMoves('Tyranitar', revealed), ['stoneedge', 'icepunch', 'crunch']);
		assert.deepEqual(revealed, ['Stone Edge', 'Ice Punch']);
	});

	it('should keep presets with zero, one, two or three unique revealed moves', () => {
		for (const revealed of [[], ['splash'], ['splash', 'growl'], ['splash', 'growl', 'leer']]) {
			assert.deepEqual(getOpponentThreatMoves('Darmanitan', revealed), [...revealed, 'flareblitz']);
		}
		assert.deepEqual(getOpponentThreatMoves('Darmanitan', ['splash', 'Splash', 'growl', 'leer']),
			['splash', 'growl', 'leer', 'flareblitz']);
	});

	it('should stop assuming preset moves after four reveals but retain actually revealed preset moves', () => {
		const revealed = ['splash', 'growl', 'leer', 'tailwhip'];
		assert.deepEqual(getOpponentThreatMoves('Darmanitan', revealed), revealed);
		const withFlareBlitz = ['splash', 'growl', 'leer', 'flareblitz'];
		assert.deepEqual(getOpponentThreatMoves('Darmanitan', withFlareBlitz), withFlareBlitz);
	});

	it('should accept an absent preset, an omitted move list and an empty move list', () => {
		assert.deepEqual(getOpponentThreatMoves('Pikachu', ['Thunderbolt']), ['thunderbolt']);
		assert.deepEqual(getOpponentThreatMoves('Hydreigon', ['Dragon Pulse']), ['dragonpulse']);
		const preset = getOpponentPreset('Darmanitan');
		const moves = preset.moves;
		try {
			preset.moves = [];
			assert.deepEqual(getOpponentThreatMoves('Darmanitan', ['Earthquake']), ['earthquake']);
		} finally {
			preset.moves = moves;
		}
	});

	it('should ignore invalid move names without disabling stat presets', () => {
		const preset = getOpponentPreset('Tyranitar');
		const moves = preset.moves;
		try {
			preset.moves = ['Stone Edge', '', 'notamove', 'stoneedge'];
			assert.deepEqual(getOpponentThreatMoves('Tyranitar', []), ['stoneedge']);
			assert.equal(computeStatsFromPreset(Dex.species.get('Tyranitar').baseStats, 100, preset).atk, 403);
		} finally {
			preset.moves = moves;
		}
	});

	it('should preserve 31 IV / 85 EV defaults for move-only presets', () => {
		for (const species of ['Scizor', 'Rotom-Wash']) {
			const preset = getOpponentPreset(species);
			assert(preset.moves.length > 0);
			assert.equal(preset.evs, undefined);
			const baseStats = Dex.species.get(species).baseStats;
			const stats = computeStatsFromPreset(baseStats, 100, preset);
			for (const stat of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
				assert.equal(stats[stat], 2 * baseStats[stat] + 31 + 21 + (stat === 'hp' ? 110 : 5));
			}
		}
		assert.deepEqual(getOpponentThreatMoves('Scizor', []), ['bulletpunch', 'uturn']);
		assert.equal(computeStatsFromPreset(Dex.species.get('Scizor').baseStats, 100, { evs: {} }).atk, 296);
	});

	for (const revealed of [[], ['splash'], ['splash', 'growl', 'leer']]) {
		it(`should switch away from preset Flare Blitz with ${revealed.length} revealed moves`, () => {
			const { ai, choice } = scenario(revealed);
			assert.equal(choice, 'switch 2');
			const observedNames = revealed.map(move => Dex.moves.get(move).name);
			assert.deepEqual(ai.battleState.opponent.active[0].moves, observedNames);
			assert.deepEqual(ai.getTracker().getActiveOpponent().knownMoves, observedNames);
			assert.equal(ai.battleState.opponent.active[0].baseStats.atk, 379);
		});
	}

	it('should apply preset attacks to reserve admission as well', () => {
		const { choice } = scenario([], { safeReserve: false });
		assert(choice.startsWith('move '), choice);
	});

	it('should stop switching for an unconfirmed preset after the fourth reveal', () => {
		const { choice } = scenario(['splash', 'growl', 'leer', 'tailwhip']);
		assert(choice.startsWith('move '), choice);
		assert.equal(scenario(['splash', 'growl', 'leer', 'flareblitz']).choice, 'switch 2');
	});
});
