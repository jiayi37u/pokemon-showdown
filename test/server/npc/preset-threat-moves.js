'use strict';

const assert = require('assert').strict;
const { Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const {
	getOpponentPreset, getOpponentThreatMoves, computeStatsFromPreset, getOpponentMoveKnowledge, canHaveOpponentMoves,
} = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');

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
		const preset = getOpponentPreset('Darmanitan');
		const moves = preset.moves;
		try {
			delete preset.moves;
			assert.deepEqual(getOpponentThreatMoves('Darmanitan', ['Earthquake']), ['earthquake']);
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
		for (const species of ['Scrafty', 'Charizard']) {
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

	it('keeps 2 revealed moves and 3 candidates separate with only 2 unobserved slots', () => {
		const first = getOpponentMoveKnowledge('Hawlucha', ['Taunt']);
		assert.deepEqual(first.revealedMoves, ['taunt']);
		assert.equal(first.remainingSlots, 3);
		assert(canHaveOpponentMoves(first, ['swordsdance', 'acrobatics', 'highjumpkick']));
		const second = getOpponentMoveKnowledge('Hawlucha', ['Taunt', 'Close Combat', 'taunt']);
		assert.deepEqual(second, { revealedMoves: ['taunt', 'closecombat'],
			presetCandidates: ['swordsdance', 'acrobatics', 'highjumpkick'], remainingSlots: 2 });
		assert(canHaveOpponentMoves(second, ['swordsdance', 'acrobatics']));
		assert(canHaveOpponentMoves(second, ['closecombat', 'highjumpkick']));
		assert(!canHaveOpponentMoves(second, ['swordsdance', 'acrobatics', 'highjumpkick']));
		const third = getOpponentMoveKnowledge('Hawlucha', ['Taunt', 'Close Combat', 'Acrobatics']);
		assert.equal(third.remainingSlots, 1);
		assert.deepEqual(third.presetCandidates, ['swordsdance', 'highjumpkick']);
		assert(!canHaveOpponentMoves(third, ['swordsdance', 'highjumpkick']));
		const fourth = getOpponentMoveKnowledge('Hawlucha', ['Taunt', 'Close Combat', 'Acrobatics', 'Roost']);
		assert.equal(fourth.remainingSlots, 0);
		assert.deepEqual(fourth.presetCandidates, []);
	});

	it('excludes future generation assumptions without discarding observed evidence', () => {
		assert(!getOpponentThreatMoves('Clefable', [], 'gen4ou').includes('moonblast'));
		assert(getOpponentThreatMoves('Clefable', [], 'gen9ou').includes('moonblast'));
		assert.equal(getOpponentPreset('Chansey', 'gen4ou').item, undefined);
		assert.equal(getOpponentPreset('Chansey', 'gen5pokemmoou').item, 'Eviolite');
	});

	it('ships reviewed defaults with valid fields, Chinese names and National Dex ordering', () => {
		const data = require('../../../data/npc/opponent-presets.json');
		let previousNum = 0;
		for (const [id, preset] of Object.entries(data)) {
			if (id.startsWith('_')) continue;
			const species = Dex.species.get(id);
			assert(species.exists, id);
			assert(species.num >= previousNum, `${id} must follow National Dex order`);
			previousNum = species.num;
			assert(/[\u3400-\u9fff]/.test(preset.nameZh), `${id} needs a Chinese name`);
			if (preset.nature) assert(Dex.natures.get(preset.nature).exists, id);
			if (preset.item) {
				const item = Dex.items.get(preset.item);
				assert(item.exists, id);
				if (item.megaStone) assert.equal(item.megaStone[species.baseSpecies], species.name);
			}
			for (const [field, max] of [['evs', 252], ['ivs', 31]]) {
				for (const [stat, value] of Object.entries(preset[field] || {})) {
					assert(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(stat), id);
					assert(Number.isInteger(value) && value >= 0 && value <= max, id);
				}
			}
			assert(Object.values(preset.evs || {}).reduce((a, b) => a + b, 0) <= 510, id);
			assert(preset.moves.length > 0 && preset.moves.length <= 4, id);
			assert.equal(new Set(preset.moves).size, preset.moves.length, id);
			for (const move of preset.moves) assert(Dex.moves.get(move).exists, `${id}: ${move}`);
		}
		assert.equal(data.ferrothorn.nameZh, '坚果哑铃');
		assert.equal(data.hawlucha.nameZh, '摔角鹰人');
		assert.equal(data.hawlucha.item, undefined);
		assert(data.scrafty.moves.includes('drainpunch'));
		assert(data.venusaur && data.venusaurmega);
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
