'use strict';
const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { computeStatsFromPreset } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
const { refineOpponentModels } = require('../../../dist/server/npc/ai/hard/evidence');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { inferOpponent, alternativeOpponentModels, predictOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');

const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
let battles = [];
function game(own, foe, mode = 'singles', format = 'gen7customgame', partner = passive) {
	const multi = mode === 'multi', doubles = mode === 'doubles';
	const battle = new Battle({ format: { ...Dex.formats.get('gen7customgame'), gameType: mode, playerCount: multi ? 4 : 2 },
		seed: [8, 19, 27, 42], p1: { name: 'Foe', team: doubles ? [foe, passive] : [foe] },
		p2: { name: 'Own', team: doubles ? [own, passive] : [own] },
		...(multi ? { p3: { name: 'Foe2', team: [passive] }, p4: { name: 'Own2', team: [partner] } } : {}) });
	battles.push(battle);
	battle.makeChoices();
	const tracker = createBattleTracker('p2', multi); tracker.setFormat(format);
	let cursor = 0;
	const state = () => {
		tracker.parseMessage(battle.log.slice(cursor).join('\n')); cursor = battle.log.length;
		return buildBattleStateFromRequests((multi ? ['p2', 'p4'] : ['p2']).map(side =>
			({ side, request: structuredClone(battle[side].activeRequest) })), tracker,
		{ ...DEFAULT_AI_CONFIG, formatId: format, isDoubles: mode !== 'singles' });
	};
	state();
	return { battle, tracker, state, play() {
		const choice = side => {
			const target = battle[side].activeRequest.active[0].moves[0].target;
			return `move 1${['normal', 'any', 'adjacentFoe'].includes(target) ? ' 1' : ''}, move 1`;
		};
		battle.makeChoices(...(multi ? ['move 1', 'move 1', 'move 1', 'move 1'] : doubles ?
			[choice('p1'), choice('p2')] : ['move 1', 'move 1']));
		return state();
	} };
}
function candidates(pokemon, presets) {
	return presets.map((preset, i) => {
		const stats = computeStatsFromPreset(Dex.species.get(pokemon.species).baseStats, pokemon.level, preset);
		return { name: preset.name || String(i), matched: true, weight: 1 / presets.length,
			pokemon: { ...pokemon, presetModels: undefined, baseStats: stats, maxHp: stats.hp,
				hp: Math.floor(stats.hp * pokemon.hpPercent / 100), item: preset.item || '', ability: preset.ability || pokemon.ability },
			moves: pokemon.moves.map(id => ({ id, availability: 1 })) };
	});
}
function refine(state, presets) {
	const foe = state.opponent.active[0];
	return refineOpponentModels(foe, candidates(foe, presets), state.opponentEvidence);
}

describe('Hard inference from observed battle outcomes', () => {
	afterEach(() => { battles.forEach(b => b.destroy()); battles = []; });
	it('tests the known type of our Hidden Power instead of inventing Normal-type damage', () => {
		const special = { nature: 'Careful', evs: { hp: 252, spd: 252 }, ability: 'Poison Heal' };
		const g = game({ species: 'Mew', nature: 'Modest', evs: { spa: 252 }, moves: ['hiddenpowerice'] },
			{ species: 'Gliscor', ...special, moves: ['splash'] });
		const state = g.play();
		assert(state.opponentEvidence.some(e => e.move === 'hiddenpower'));
		const result = refine(state, [{ ...special, name: 'special' },
			{ name: 'physical', nature: 'Impish', evs: { hp: 252, def: 252 }, ability: 'Poison Heal' }]);
		assert.deepEqual(result.models.map(m => m.name), ['special']);
	});
	it('can explain a missing offensive item using typed Hidden Power damage without exposing it as fact', () => {
		const set = { nature: 'Modest', evs: { hp: 248, spa: 252 }, ability: 'Water Absorb' };
		const g = game({ species: 'Slowbro', nature: 'Calm', evs: { hp: 252, spd: 252 }, moves: ['splash'] },
			{ species: 'Volcanion', ...set, item: 'Choice Specs', moves: ['hiddenpowergrass'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [{ ...set, item: 'Leftovers', name: 'bulky' }]);
		models[0].moves = [{ id: 'hiddenpowergrass', availability: 1 }];
		const result = refineOpponentModels(foe, models, state.opponentEvidence);
		assert(result.models.some(m => m.pokemon.item === 'choicespecs'), JSON.stringify(result.notes));
		assert(result.notes.some(n => n.includes('inferred configurations')));
		assert(!foe.itemKnown); assert.equal(g.tracker.getActiveOpponent().item, '');
		assert.equal(models[0].pokemon.item, 'Leftovers');
	});
	it('keeps the typed Hidden Power available under a publicly named Choice lock', () => {
		const set = { nature: 'Modest', evs: { hp: 248, spa: 252 }, ability: 'Water Absorb' };
		const g = game({ species: 'Slowbro', nature: 'Calm', evs: { hp: 252, spd: 252 }, moves: ['splash'] },
			{ species: 'Volcanion', ...set, item: 'Choice Specs', moves: ['hiddenpowergrass'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [{ ...set, item: 'Choice Specs' }]);
		models[0].moves = [{ id: 'hiddenpowergrass', availability: 1 }, { id: 'steameruption', availability: 1 }];
		models[0].pokemon.moveKnowledge = { revealedMoves: ['hiddenpower'],
			presetCandidates: ['hiddenpowergrass', 'steameruption'], remainingSlots: 3 };
		const actions = predictOpponent(state, foe, state.self.active[0], 'gen7customgame',
			(s, actor, moves) => moves.map(move => ({ move, score: 110, flags: {} })), models);
		assert(actions.some(a => a.move?.id === 'hiddenpower' && a.move.type === 'Grass'));
		assert(actions.filter(a => !a.switching).every(a => a.move?.id === 'hiddenpower' && a.move.type === 'Grass'));
	});
	it('can infer an unlisted Scarf, but never expands a closed random-battle configuration pool', () => {
		const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Levitate' };
		const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', ...set, item: 'Choice Scarf', moves: ['dragonpulse'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [{ ...set, name: 'ordinary' }]);
		assert(refineOpponentModels(foe, models, state.opponentEvidence).models.every(m => m.pokemon.item === 'choicescarf'));
		foe.presetModels = models;
		assert.equal(refineOpponentModels(foe, models, state.opponentEvidence).models[0].pokemon.item, '');
	});
	it('tracks selected moves by identity for item reasoning and resets that evidence on switching', () => {
		const g = game(passive, { species: 'Scizor', moves: ['bulletpunch', 'bugbite'] });
		g.play();
		g.tracker.parseMessage('|move|p1a: Scizor|Bug Bite|p2a: Mew');
		const state = g.state(), foe = state.opponent.active[0];
		assert.deepEqual(foe.usedMoves.sort(), ['bugbite', 'bulletpunch']);
		assert.deepEqual(g.tracker.getUsedMoves(foe.ident).sort(), ['bugbite', 'bulletpunch']);
		g.tracker.parseMessage('|switch|p1a: Scizor|Scizor|100/100');
		assert.deepEqual(g.tracker.getUsedMoves(foe.ident), []);
	});
	it('does not reinterpret publicly observed Leftovers as an unlisted damage-boosting item', () => {
		const g = game(passive, { species: 'Scizor', item: 'Leftovers', ability: 'Technician', moves: ['bulletpunch'] });
		const state = g.play(), foe = state.opponent.active[0];
		g.tracker.parseMessage('|-item|p1a: Scizor|Leftovers');
		foe.itemKnown = true; foe.item = 'Leftovers';
		const evidence = structuredClone(state.opponentEvidence);
		for (const e of evidence.filter(e => e.kind === 'damage')) { e.before = 100; e.after = 15; }
		const result = refineOpponentModels(foe, candidates(foe, [{ name: 'observed', item: 'Leftovers' }]), evidence);
		assert(result.models.every(m => m.pokemon.item === 'Leftovers'));
	});
	it('infers an absent defensive spread while preserving a publicly revealed item', () => {
		const g = game({ species: 'Mew', nature: 'Modest', evs: { spa: 252 }, moves: ['surf'] },
			{ species: 'Gliscor', ability: 'Poison Heal', item: 'Leftovers', nature: 'Careful',
				evs: { hp: 252, spd: 252, def: 4 }, moves: ['earthquake'] });
		const state = g.play(), foe = state.opponent.active[0];
		assert(foe.itemKnown);
		const original = candidates(foe, [{ nature: 'Impish', evs: { hp: 252, def: 252 }, item: 'Leftovers' }]);
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		const expected = computeStatsFromPreset(Dex.species.get('Gliscor').baseStats, foe.level,
			{ nature: 'Careful', evs: { hp: 252, spd: 252, def: 4 } });
		assert(result.notes.some(n => n.includes('inferred configurations')), JSON.stringify(result.notes));
		assert(result.models.every(m => Dex.toID(m.pokemon.item) === 'leftovers'));
		assert(result.models.some(m => m.pokemon.baseStats.spd === expected.spd));
		assert(!result.models.some(m => m.pokemon.baseStats.spd === original[0].pokemon.baseStats.spd));
	});

	it('can change both the speed spread and item instead of keeping a refuted default', () => {
		const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', ability: 'Levitate', item: 'Choice Scarf', nature: 'Timid',
				evs: { spa: 252, spe: 252, spd: 4 }, moves: ['dragonpulse'] });
		const state = g.play(), foe = state.opponent.active[0];
		const original = candidates(foe, [{ nature: 'Quiet', evs: { hp: 252, spa: 252 }, item: 'Leftovers' }]);
		original[0].matched = false;
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert(result.models.every(m => m.pokemon.item === 'choicescarf'));
		assert(result.models.every(m => m.pokemon.baseStats.spe > original[0].pokemon.baseStats.spe));
		assert(result.models.length > 1, 'One observed order does not identify an exact EV spread');
	});

	it('keeps revealed move slots, legal stat budgets and the public forme in generated configurations', () => {
		const { completeMoves, projectBattle } = require('../../../dist/server/npc/ai/hard/projection');
		const g = game(passive, { species: 'Scizor', moves: ['bulletpunch', 'brickbreak', 'roost', 'defog'] });
		const state = g.play(), foe = state.opponent.active[0];
		foe.moves = ['bulletpunch', 'brickbreak', 'roost', 'defog'];
		const models = inferOpponent(foe, 'gen7customgame');
		assert(models.every(m => !m.matched));
		const snapshot = structuredClone(foe);
		const generated = [...alternativeOpponentModels(foe, models, 'gen7customgame')];
		assert(generated.length);
		for (const model of generated) {
			assert.equal(model.pokemon.species, 'Scizor');
			assert.notEqual(model.pokemon.item, 'assaultvest');
			assert.notEqual(model.pokemon.item, 'choicespecs');
			const moves = completeMoves(model, 0);
			assert.deepEqual([...moves].sort(), [...foe.moves].sort());
			const projection = projectBattle(state, [{ ...model.pokemon, moves }], 0);
			assert(projection, model.name);
			const set = projection.battle.p2.pokemon[0].set;
			assert(Object.values(set.evs).reduce((a, b) => a + b, 0) <= 510);
			projection.battle.destroy();
		}
		assert.deepEqual(foe, snapshot);
	});
	it('accepts an observed item even when it is a poor fit for the revealed moves', () => {
		const g = game(passive, { species: 'Scizor', moves: ['bulletpunch'] });
		const state = g.play(), foe = state.opponent.active[0];
		foe.moves = ['bulletpunch', 'brickbreak', 'roost', 'defog'];
		foe.itemKnown = true; foe.item = 'Choice Specs'; foe.originalItem = 'Choice Specs';
		const models = [...alternativeOpponentModels(foe, inferOpponent(foe, 'gen7customgame'), 'gen7customgame')];
		assert(models.length);
		assert(models.every(m => m.pokemon.item === 'choicespecs'));
	});
	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: removes non-Scarf Hydreigon after it outruns max-Speed Jolly Garchomp`, () => {
			const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Levitate' };
			const g = game({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
				{ species: 'Hydreigon', ...set, item: 'Choice Scarf', moves: ['dragonpulse'] }, mode);
			const state = g.play();
			assert(state.opponentEvidence.some(e => e.kind === 'speed'));
			const result = refine(state, [{ ...set, name: 'ordinary' }, { ...set, item: 'Choice Scarf', name: 'scarf' }]);
			assert.deepEqual(result.models.map(m => m.name), ['scarf']);
			assert.equal(state.opponent.active[0].itemKnown, false, 'Inference must not reveal an item as fact');
			assert(result.notes.some(note => note.startsWith('speed evidence')));
		});

		it(`${mode}: distinguishes Choice Band from ordinary Scizor using incoming damage`, () => {
			const set = { nature: 'Adamant', evs: { hp: 248, atk: 252 }, ability: 'Technician' };
			const g = game({ species: 'Vaporeon', ability: 'Water Absorb', moves: ['splash'] },
				{ species: 'Scizor', ...set, item: 'Choice Band', moves: ['bulletpunch'] }, mode);
			const state = g.play();
			assert(state.opponentEvidence.some(e => e.kind === 'damage'));
			const result = refine(state, [{ ...set, name: 'ordinary' }, { ...set, item: 'Choice Band', name: 'band' }]);
			assert.deepEqual(result.models.map(m => m.name), ['band']);
		});

		it(`${mode}: distinguishes specially defensive Gliscor from physical defense using Surf damage`, () => {
			const spdef = { nature: 'Careful', evs: { hp: 252, spd: 252 }, ability: 'Poison Heal' };
			const physdef = { nature: 'Impish', evs: { hp: 252, def: 252 }, ability: 'Poison Heal' };
			const g = game({ species: 'Vaporeon', ability: 'Water Absorb', moves: ['surf'], nature: 'Modest', evs: { spa: 252 } },
				{ species: 'Gliscor', ...spdef, moves: ['earthquake'] }, mode);
			const state = g.play();
			const result = refine(state, [{ ...spdef, name: 'special' }, { ...physdef, name: 'physical' }]);
			assert.deepEqual(result.models.map(m => m.name), ['special']);
		});
	}

	it('retains both speed ties and overlapping damage ranges', () => {
		const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', nature: 'Timid', evs: { spe: 252 }, item: 'Choice Scarf', moves: ['dragonpulse'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [{ name: 'equal' }, { name: 'faster' }]);
		models[0].pokemon.baseStats.spe = state.self.active[0].baseStats.spe;
		models[1].pokemon.baseStats.spe = state.self.active[0].baseStats.spe + 1;
		assert.equal(refineOpponentModels(foe, models, state.opponentEvidence.filter(e => e.kind === 'speed')).models.length, 2);
		const matching = candidates(foe, [{ item: 'Choice Scarf', nature: 'Timid', evs: { spe: 252 } },
			{ item: 'Choice Scarf', nature: 'Timid', evs: { spe: 252, def: 4 } }]);
		assert.equal(refineOpponentModels(foe, matching, state.opponentEvidence).models.length, 2);
	});

	it('shares a Multi partner\'s observed Surf damage through the same evidence pipeline', () => {
		const set = { nature: 'Careful', evs: { hp: 252, spd: 252 }, ability: 'Poison Heal' };
		const g = game(passive, { species: 'Gliscor', ...set, moves: ['earthquake'] }, 'multi', 'gen7customgame',
			{ species: 'Vaporeon', ability: 'Water Absorb', moves: ['surf'], nature: 'Modest', evs: { spa: 252 } });
		const state = g.play();
		const evidence = state.opponentEvidence.filter(e => e.kind === 'damage' && e.first.startsWith('p4:'));
		assert(evidence.length, g.battle.log.join('\n'));
		const foe = state.opponent.active[0];
		const result = refineOpponentModels(foe, candidates(foe, [set,
			{ nature: 'Impish', evs: { hp: 252, def: 252 }, ability: 'Poison Heal' }]), evidence);
		assert.equal(result.models.length, 1);
		assert.equal(result.models[0].name, '0');
	});

	it('accounts for known boosts and screens instead of misattributing their damage to a held item', () => {
		for (const effect of ['boost', 'screen']) {
			const set = { nature: 'Adamant', evs: { hp: 248, atk: 252 }, ability: 'Technician' };
			const g = game({ species: 'Vaporeon', ability: 'Water Absorb', moves: ['splash'] },
				{ species: 'Scizor', ...set, moves: ['bulletpunch'] });
			if (effect === 'boost') g.battle.boost({ atk: 2 }, g.battle.p1.active[0]);
			else g.battle.p2.addSideCondition('reflect', g.battle.p2.active[0]);
			g.state();
			const state = g.play();
			const result = refine(state, [{ ...set, name: 'ordinary' }, { ...set, name: 'band', item: 'Choice Band' }]);
			assert.deepEqual(result.models.map(m => m.name), ['ordinary'], effect);
		}
	});

	it('retains evidence across switches, discards it on an Illusion reveal, and resets between battles', () => {
		const g = game(passive, { species: 'Scizor', moves: ['bulletpunch'] });
		const state = g.play(), count = state.opponentEvidence.length;
		assert(count);
		g.tracker.parseMessage('|switch|p1a: Other|Blissey|100/100');
		assert.equal(g.tracker.evidence.getHistory().length, count);
		g.tracker.parseMessage('|replace|p1a: Other|Zoroark|100/100');
		assert.equal(g.tracker.evidence.getHistory().length, 0);
		assert.equal(state.opponentEvidence.length, count, 'Historical snapshots are not mutated by later events');
		g.tracker.evidence.restore(state.opponentEvidence);
		g.tracker.reset();
		assert.equal(g.tracker.evidence.getHistory().length, 0);
	});

	it('narrows the shipped random Hydreigon models and changes the evaluator predictions without revealing its item', () => {
		const evs = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
		const g = game({ species: 'Garchomp', level: 79, nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', level: 79, ability: 'Levitate', evs, item: 'Choice Scarf', moves: ['darkpulse'] },
			'singles', 'gen9randombattle');
		const opening = g.state(), before = inferOpponent(opening.opponent.active[0], 'gen9randombattle');
		assert(before.some(m => m.pokemon.item === 'Choice Scarf'));
		assert(before.some(m => m.pokemon.item !== 'Choice Scarf'));
		const state = g.play(), foe = state.opponent.active[0];
		const evaluator = new HardEvaluation(state, 'gen9randombattle');
		const actions = evaluator.predictions(state.self.active[0]).get(foe);
		assert(actions.length);
		assert(actions.every(a => a.user.item === 'Choice Scarf'));
		assert(!foe.itemKnown);
		assert.equal(g.tracker.getActiveOpponent().item, '');
		assert(evaluator.inferenceNotes.get(foe).some(n => n.startsWith('speed evidence')));
	});

	it('does not infer Scarf from a priority attack, Tailwind or Trick Room', () => {
		for (const situation of ['priority', 'tailwind', 'trickroom']) {
			const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
				{ species: 'Scizor', moves: [situation === 'priority' ? 'bulletpunch' : 'tackle'] });
			if (situation === 'tailwind') g.battle.p1.addSideCondition('tailwind', g.battle.p1.active[0]);
			if (situation === 'trickroom') g.battle.field.addPseudoWeather('trickroom', g.battle.p1.active[0]);
			g.state();
			const state = g.play();
			const result = refine({ ...state, opponentEvidence: state.opponentEvidence.filter(e => e.kind === 'speed') },
				[{ name: 'ordinary', evs: {} }, { name: 'scarf', item: 'Choice Scarf', evs: {} }]);
			assert(result.models.some(m => m.name === 'ordinary'), situation);
		}
	});

	it('skips critical hits, multi-hit attacks, residual damage and capped KO damage', () => {
		for (const kind of ['crit', 'multi', 'residual', 'ko']) {
			const g = game(passive, { species: 'Scizor', moves: ['bulletpunch'] });
			const move = kind === 'multi' ? 'Double Hit' : 'Bullet Punch';
			g.tracker.parseMessage(`|move|p1a: Scizor|${move}|p2a: Mew\n` +
				(kind === 'crit' ? '|-crit|p2a: Mew\n' : '') +
				`|-damage|p2a: Mew|${kind === 'ko' ? '0 fnt' : '70/100'}${kind === 'residual' ? '|[from] psn' : ''}\n|turn|2`);
			assert.equal(g.tracker.evidence.getHistory().filter(e => e.kind === 'damage').length, 0, kind);
		}
	});

	it('retains uncertainty when every preset contradicts the observations and preserves raw facts', () => {
		const g = game(passive, { species: 'Scizor', item: 'Choice Band', ability: 'Technician', moves: ['bulletpunch'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [{ name: 'unrepresented', nature: 'Modest' }]);
		const evidence = structuredClone(state.opponentEvidence);
		for (const e of evidence.filter(e => e.kind === 'damage')) { e.before = 100; e.after = 1; }
		const result = refineOpponentModels(foe, models, evidence);
		assert.equal(result.models.length, 1);
		assert(result.notes.some(n => n.includes('conflicts')));
		assert(!foe.itemKnown);
		assert.equal(g.tracker.getActiveOpponent().item, '');
	});

	it('uses filtered models in the real Hard evaluator, including public Leftovers and Life Orb evidence', () => {
		for (const item of ['Leftovers', 'Life Orb']) {
			const g = game({ ...passive, moves: ['tackle'] },
				{ species: 'Scizor', item, ability: 'Technician', moves: ['bulletpunch'] }, 'singles', 'gen9randombattle');
			const state = g.play(), foe = state.opponent.active[0];
			assert.equal(foe.originalItem, item);
			assert(foe.itemKnown);
			const actual = inferOpponent(foe, 'gen9randombattle');
			assert(actual.every(m => m.pokemon.item.toLowerCase().replace(/ /g, '') !== 'choiceband'));
		}
		const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Levitate' };
		const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', ...set, item: 'Choice Scarf', moves: ['dragonpulse'] });
		const state = g.play(), foe = state.opponent.active[0];
		foe.presetModels = candidates(foe, [set, { ...set, item: 'Choice Scarf' }]);
		const evaluator = new HardEvaluation(state, 'gen7customgame');
		const actions = evaluator.predictions(state.self.active[0]).get(foe);
		assert(actions.every(a => a.user.item === 'Choice Scarf'));
		assert(evaluator.inferenceNotes.get(foe).some(n => n.includes('speed evidence')));
	});
});
