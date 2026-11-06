'use strict';

const assert = require('assert').strict;
const { Dex } = require('../../../dist/sim');
const { createScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { buildAIMove } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { makeAIPokemonSkeleton } = require('../../../dist/server/npc/ai/cfru/util/pokemon-builder');

function pokemon(boosts = {}, slot = 1) {
	return makeAIPokemonSkeleton({
		slot, species: 'Blissey', hp: 100, maxHp: 100, hpPercent: 100,
		status: '', fainted: false, types: ['Normal'], ability: '', item: '', moves: ['haze'],
		baseStats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
		boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...boosts },
		active: true, level: 100, gender: 'N',
	});
}

function score(self, opponents, targetIndex = 0, reserve = []) {
	const engine = createScoringEngine(DEFAULT_AI_CONFIG, createAICache(1));
	const state = {
		turn: 1, isDoubles: self.length > 1 || opponents.length > 1,
		self: { active: self, reserve, conditions: {} },
		opponent: { active: opponents, reserve: [], conditions: {} },
		field: { weather: '', terrain: '', trickroom: false },
	};
	const result = engine.scoreMove(state, self[0], buildAIMove(Dex.moves.get('haze'), 1), opponents[targetIndex]);
	assert.equal(result.breakdown.base + result.breakdown.negatives + result.breakdown.positives, result.score);
	return result;
}

describe('Haze scoring', () => {
	it('should charge for clearing partner boosts and score the whole field regardless of target', () => {
		const self = [pokemon(), pokemon({ atk: 2 }, 2)];
		const opponents = [pokemon(), pokemon({ atk: 2, spe: 2 }, 2)];
		assert.equal(score(self, opponents, 0).score, score(self, opponents, 1).score);
		assert(score(self, opponents).score < score([pokemon(), pokemon({}, 2)], opponents).score);
	});

	it('should include partner drops and boosts from both opponents', () => {
		const result = score([pokemon(), pokemon({ spe: -1 }, 2)], [pokemon({ atk: 2 }), pokemon({ spa: 2 }, 2)]);
		assert(result.score > score([pokemon(), pokemon({}, 2)], [pokemon(), pokemon({}, 2)]).score);
	});

	it('should ignore fainted Pokemon and reserves', () => {
		const fainted = { ...pokemon({ atk: 6 }, 2), fainted: true };
		const reserve = { ...pokemon({ spa: -6 }, 3), active: false };
		assert.equal(score([pokemon()], [pokemon(), fainted], 0, [reserve]).score,
			score([pokemon()], [pokemon()]).score);
	});

	it('should not treat Haze as a targeted status move blocked by abilities', () => {
		const opponent = { ...pokemon({ atk: 2, spe: 2 }), ability: 'Magic Bounce' };
		assert.equal(score([pokemon()], [opponent]).score, score([pokemon()], [{ ...opponent, ability: '' }]).score);
	});
});
