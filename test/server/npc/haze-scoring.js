'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
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
	assert.equal(100 + result.breakdown.details.reduce((sum, detail) => sum + detail.amount, 0), result.score);
	return result;
}

describe('Haze scoring', () => {
	for (const [name, enemy, own, expected, noEffect] of [
		['no stat changes', {}, {}, 60, false],
		['one Attack stage', { atk: 1 }, {}, 85, false],
		['one Dragon Dance', { atk: 1, spe: 1 }, {}, 90, false],
		['one Swords Dance', { atk: 2 }, {}, 100, false],
		['two Dragon Dances', { atk: 2, spe: 2 }, {}, 120, false],
		['three Dragon Dances', { atk: 3, spe: 3 }, {}, 136, false],
		['maximum boosts', { atk: 6, spe: 6 }, {}, 140, false],
		['own stat drops without enemy boosts', {}, { spa: -2, spe: -2 }, 120, false],
		['enemy stat drops', { def: -2 }, {}, 60, false],
		['own boosts', {}, { spa: 2 }, 60, false],
		['equal benefits and costs', { atk: 2 }, { spa: 2 }, 60, false],
		['mixed boosts and drops', { atk: 2, def: -1 }, { spa: -2, spe: 1 }, 110, false],
		['accuracy and evasion', { accuracy: 2, evasion: 2 }, {}, 120, false],
	]) {
		it(`should value ${name}`, () => {
			const result = score([pokemon(own)], [pokemon(enemy)]);
			assert.equal(result.score, expected);
			assert.equal(result.flags.hasNoEffect, noEffect);
		});
	}

	it('should charge for clearing partner boosts and score the whole field regardless of target', () => {
		const self = [pokemon(), pokemon({ atk: 2 }, 2)];
		const opponents = [pokemon(), pokemon({ atk: 2, spe: 2 }, 2)];
		assert.equal(score(self, opponents, 0).score, 100);
		assert.equal(score(self, opponents, 1).score, 100);
	});

	it('should include partner drops and boosts from both opponents', () => {
		const result = score([pokemon(), pokemon({ spe: -1 }, 2)], [pokemon({ atk: 2 }), pokemon({ spa: 2 }, 2)]);
		assert.equal(result.score, 125);
	});

	it('should ignore fainted Pokemon and reserves', () => {
		const fainted = { ...pokemon({ atk: 6 }, 2), fainted: true };
		const reserve = { ...pokemon({ spa: -6 }, 3), active: false };
		assert.equal(score([pokemon()], [pokemon(), fainted], 0, [reserve]).score, 60);
	});

	it('should not treat Haze as a targeted status move blocked by abilities', () => {
		const opponent = { ...pokemon({ atk: 2, spe: 2 }), ability: 'Magic Bounce' };
		assert.equal(score([pokemon()], [opponent]).score, 120);
	});
});

describe('NormalAI Haze decisions from public battle protocol', () => {
	for (const doubles of [false, true]) {
		it(`should clear two Dragon Dances then stop using Haze in ${doubles ? 'doubles' : 'singles'}`, () => {
			const format = doubles ? 'gen9doublescustomgame' : 'gen9customgame';
			const playerTeam = [{ species: 'Dragonite', ability: 'Inner Focus', moves: ['dragondance', 'splash'] }];
			const npcTeam = [{ species: 'Blissey', ability: 'Natural Cure', moves: ['haze', 'dazzlinggleam', 'splash'] }];
			if (doubles) {
				playerTeam.push({ species: 'Lanturn', ability: 'Volt Absorb', moves: ['splash'] });
				npcTeam.push({ species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] });
			}
			const battle = new Battle({
				formatid: format, seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: playerTeam }, p2: { name: 'NPC', team: npcTeam },
			});
			try {
				const stream = { push() {}, write() {} };
				const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
				ai.setBattle({ stream, format });
				let choice;
				ai.choose = value => { choice = value; };
				let cursor = 0;
				const decide = () => {
					stream.push(battle.log.slice(cursor).join('\n'));
					cursor = battle.log.length;
					ai.receiveRequest(JSON.parse(JSON.stringify(battle.p2.activeRequest)));
					return choice;
				};
				const partnerChoice = doubles ? ', move 1' : '';
				battle.makeChoices();
				battle.makeChoices(`move 1${partnerChoice}`, `move 3${partnerChoice}`);
				const afterOneDance = decide();
				assert(afterOneDance.startsWith('move 2'), afterOneDance);
				battle.makeChoices(`move 1${partnerChoice}`, `move 3${partnerChoice}`);
				const afterTwoDances = decide();
				assert.equal(afterTwoDances.split(', ')[0], 'move 1');
				assert(battle.choose('p2', afterTwoDances), battle.p2.choice.error);
				assert(battle.choose('p1', `move 2${partnerChoice}`), battle.p1.choice.error);
				assert(battle.log.slice(cursor).includes('|-clearallboost'));
				const afterHaze = decide();
				assert(afterHaze.startsWith('move 2'), afterHaze);
				for (const target of ai.battleState.opponent.active) {
					const result = ai.scoringEngine.scoreMove(ai.battleState, ai.battleState.self.active[0], buildAIMove(Dex.moves.get('haze'), 1), target);
					assert.equal(result.score, 60);
					assert.equal(result.flags.hasNoEffect, false);
				}
				assert(battle.choose('p2', afterHaze), battle.p2.choice.error);
			} finally {
				battle.destroy();
			}
		});
	}
});
