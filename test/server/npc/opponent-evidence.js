'use strict';
const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { computeStatsFromPreset } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
const { refineOpponentModels } = require('../../../dist/server/npc/ai/hard/evidence');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { inferOpponent, predictOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');

const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
let battles = [];
function game(own, foe, mode = 'singles', format = 'gen7customgame', partner = passive, reserves = { own: [], foe: [] }) {
	const multi = mode === 'multi', doubles = mode === 'doubles';
	const generation = format.match(/^gen\d+/)?.[0] || 'gen7';
	const battle = new Battle({ format: { ...Dex.formats.get(`${generation}customgame`), gameType: mode, playerCount: multi ? 4 : 2 },
		seed: [8, 19, 27, 42], p1: { name: 'Foe', team: [...(doubles ? [foe, passive] : [foe]), ...reserves.foe] },
		p2: { name: 'Own', team: [...(doubles ? [own, passive] : [own]), ...reserves.own] },
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
		return { name: preset.name || String(i), matched: true, weight: 1 / presets.length, spread: preset,
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
	it('carries public binding sources and own Mega spreads through singles, doubles and Multi', () => {
		const own = { species: 'Diancie', item: 'Diancite', nature: 'Timid', moves: ['protect'], evs: { spe: 252 } };
		for (const mode of ['singles', 'doubles', 'multi']) {
			const g = game(own, passive, mode, 'gen6ou', own);
			const source = mode === 'multi' ? 'p4b: Diancie' : 'p2a: Diancie';
			const target = mode === 'multi' ? 'p3b: Mew' : 'p1a: Mew';
			g.tracker.parseMessage(`|-activate|${target}|move: Fire Spin|[of] ${source}`);
			const state = g.state();
			const foe = state.opponent.active.find(p => p.ownerSide === target.slice(0, 2));
			assert.equal(foe.trapSource, `${source.slice(0, 2)}:Diancie`, mode);
			assert.equal(foe.statSpread, undefined);
			assert(state.self.active.some(p => p.ownerSide === source.slice(0, 2) && p.statSpread?.nature === 'Timid'));
			g.tracker.parseMessage(`|-end|${target}|Fire Spin|[partiallytrapped]`);
			assert.equal(g.state().opponent.active.find(p => p.ownerSide === target.slice(0, 2)).trapSource, undefined);
		}
	});
	it('excludes active Choice items after distinct selected moves during one stay', () => {
		const g = game({ species: 'Skarmory', moves: ['splash'], evs: { hp: 252, def: 252 } },
			{ species: 'Scizor', ability: 'Technician', moves: ['bulletpunch', 'bugbite'] });
		g.play(); g.battle.makeChoices('move 2', 'move 1');
		const state = g.state();
		assert(state.opponentEvidence.some(e => e.kind === 'selection' && e.excludedItems.includes('choiceband')));
		const result = refine(state, [{ item: 'Choice Band' }, { item: 'Leftovers' }]);
		assert(result.models.every(m => m.pokemon.item === 'Leftovers'));
	});
	it('excludes Assault Vest after a selected status move across singles, doubles and multi', () => {
		for (const mode of ['singles', 'doubles', 'multi']) {
			const g = game(passive, { species: 'Tornadus-Therian', ability: 'Regenerator', moves: ['taunt'] }, mode, 'gen6ou');
			const state = g.play(), foe = state.opponent.active[0];
			const result = refineOpponentModels(foe, inferOpponent(foe, 'gen6ou'), state.opponentEvidence);
			assert(state.opponentEvidence.some(e => e.excludedItems?.includes('assaultvest')), mode);
			assert(result.models.every(m => m.pokemon.item !== 'assaultvest'), mode);
		}
	});
	it('does not turn called moves or suppressed-item selections into Choice exclusions', () => {
		const g = game({ species: 'Skarmory', moves: ['splash'], evs: { hp: 252, def: 252 } },
			{ species: 'Scizor', ability: 'Technician', moves: ['bulletpunch', 'bugbite'] });
		g.tracker.parseMessage('|move|p1a: Scizor|Bullet Punch|p2a: Mew\n' +
			'|move|p1a: Scizor|Bug Bite|p2a: Mew|[from] move: Sleep Talk');
		assert(!g.tracker.evidence.getHistory().some(e => e.excludedItems?.includes('choiceband')));
		const h = game({ species: 'Skarmory', moves: ['splash'], evs: { hp: 252, def: 252 } },
			{ species: 'Scizor', ability: 'Technician', moves: ['bulletpunch', 'bugbite'] });
		h.battle.field.addPseudoWeather('magicroom', h.battle.p1.active[0]); h.state();
		h.play(); h.battle.makeChoices('move 2', 'move 1');
		assert(!h.state().opponentEvidence.some(e => e.excludedItems?.includes('choiceband')));
	});
	it('retains public delayed-effect sources when rebuilding a decision snapshot', () => {
		const g = game(passive, { species: 'Slowbro', ability: 'Regenerator', moves: ['futuresight'] }, 'singles', 'gen6ou');
		const state = g.play();
		assert.equal(state.self.conditions.futureMoves[1], 2);
		assert.equal(state.self.conditions.futureAttacks[1].move, 'futuresight');
		assert.equal(state.self.conditions.futureAttacks[1].source.replaceAll(' ', ''), state.opponent.active[0].ident.replaceAll(' ', ''));
	});
	it('tests the known type of our Hidden Power instead of inventing Normal-type damage', () => {
		const special = { nature: 'Careful', evs: { hp: 252, spd: 252 }, ability: 'Poison Heal' };
		const g = game({ species: 'Mew', nature: 'Modest', evs: { spa: 252 }, moves: ['hiddenpowerice'] },
			{ species: 'Gliscor', ...special, moves: ['splash'] });
		const state = g.play();
		assert(state.opponentEvidence.some(e => e.move === 'hiddenpower'));
		const result = refine(state, [{ ...special, name: 'special' },
			{ name: 'physical', nature: 'Impish', evs: { hp: 252, def: 252 }, ability: 'Poison Heal' }]);
		assert(result.models.some(m => m.name === 'special'));
		assert(result.models.every(m => m.pokemon.baseStats.spd > computeStatsFromPreset(
			Dex.species.get('Gliscor').baseStats, 100, { nature: 'Impish', evs: { hp: 252, def: 252 } }).spd));
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
		assert(result.notes.some(n => n.includes('exceptional evidence')));
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
	it('adjusts defensive investment within the preset before changing the item', () => {
		const g = game({ species: 'Mew', nature: 'Modest', evs: { spa: 252 }, moves: ['surf'] },
			{ species: 'Gliscor', ability: 'Poison Heal', item: 'Leftovers', nature: 'Careful',
				evs: { hp: 252, spd: 252, def: 4 }, moves: ['earthquake'] });
		const state = g.play(), foe = state.opponent.active[0];
		const original = candidates(foe, [{ nature: 'Impish', evs: { hp: 252, def: 252 }, item: 'Leftovers' }]);
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert.equal(result.models.length, 1);
		assert.equal(result.models[0].pokemon.item, 'Leftovers');
		assert(result.models[0].pokemon.baseStats.spd > original[0].pokemon.baseStats.spd);
		assert(Object.values(result.models[0].spread.evs).reduce((a, b) => a + b, 0) <= 508);
	});

	for (const [item, stat, move, nature, defense] of [
		['Choice Band', 'atk', 'earthquake', 'Adamant', 'def'],
		['Choice Specs', 'spa', 'flamethrower', 'Modest', 'spd'],
	]) {
		it(`excludes ${item} below its 252-EV damage interval instead of reducing offensive EVs`, () => {
			const g = game({ species: 'Registeel', moves: ['splash'], evs: { hp: 252, [defense]: 252 } },
				{ species: 'Mew', nature, evs: { [stat]: 252 }, moves: [move] });
			const state = g.play(), foe = state.opponent.active[0];
			const original = candidates(foe, [
				{ name: 'choice', item, nature, evs: { [stat]: 252, spe: 252 } },
				{ name: 'ordinary', nature, evs: { [stat]: 252, spe: 252 } },
			]);
			const result = refineOpponentModels(foe, original, state.opponentEvidence);
			assert.deepEqual(result.models.map(m => m.name), ['ordinary']);
			assert(result.notes.some(n => n.includes('Choice minimum investment')));
			const onlyChoice = refineOpponentModels(foe, original.slice(0, 1), state.opponentEvidence);
			assert(onlyChoice.models.length);
			assert(onlyChoice.models.every(m => !m.pokemon.item), 'All-conflicting fallback must not restore the rejected item');
		});
		it(`retains legitimate ${item} damage and its full offensive investment`, () => {
			const g = game({ species: 'Registeel', moves: ['splash'], evs: { hp: 252, [defense]: 252 } },
				{ species: 'Mew', item, nature, evs: { [stat]: 252 }, moves: [move] });
			const result = refine(g.play(), [{ name: 'choice', item, nature, evs: { [stat]: 252 } }]);
			assert.equal(result.models[0].pokemon.item, item);
			assert.equal(result.models[0].spread.evs[stat], 252);
		});
	}
	it('excludes Scarf below the 176-Speed-EV floor instead of inventing a zero-Speed Scarf', () => {
		const g = game({ species: 'Aerodactyl', nature: 'Jolly', evs: { spe: 252 }, moves: ['splash'] },
			{ species: 'Mew', nature: 'Hardy', item: 'Choice Scarf', evs: { hp: 252 }, moves: ['splash'] });
		const result = refine(g.play(), [
			{ name: 'scarf', item: 'Choice Scarf', nature: 'Hardy', evs: { spe: 252 } },
			{ name: 'ordinary', nature: 'Hardy', evs: { spe: 252 } },
		]);
		assert.deepEqual(result.models.map(m => m.name), ['ordinary']);
	});
	it('still adjusts Scarf Speed within 176 to 252 EVs', () => {
		const g = game({ species: 'Electrode', nature: 'Timid', evs: { spe: 252 }, moves: ['splash'] },
			{ species: 'Mew', nature: 'Hardy', item: 'Choice Scarf', evs: { spe: 176 }, moves: ['splash'] });
		const result = refine(g.play(), [{ item: 'Choice Scarf', nature: 'Hardy', evs: { spe: 252 } }]);
		assert.equal(result.models[0].pokemon.item, 'Choice Scarf');
		assert(result.models[0].spread.evs.spe >= 176 && result.models[0].spread.evs.spe < 252);
	});
	it('keeps an observed original item within its catalogue presets during subsequent fitting', () => {
		const g = game({ species: 'Registeel', moves: ['splash'], evs: { hp: 252, def: 252 } },
			{ species: 'Scizor', item: 'Choice Band', nature: 'Adamant', ability: 'Technician',
				evs: { atk: 252, hp: 252 }, moves: ['bulletpunch'] }, 'singles', 'gen6ou');
		g.tracker.parseMessage('|-item|p1a: Scizor|Choice Band');
		const state = g.play(), foe = state.opponent.active[0];
		const original = inferOpponent(foe, 'gen6ou');
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert(original.length && result.models.length);
		assert(result.models.every(m => Dex.toID(m.pokemon.item) === 'choiceband'));
		assert(result.models.every(m => original.some(p => p.name === m.name)));
	});
	for (const evs of [
		{ hp: 252, atk: 252, def: 4 }, { hp: 252, spa: 252, spd: 4 },
		{ spe: 252, atk: 252, def: 4 }, { spe: 252, spa: 252, spd: 4 },
		{ hp: 252, atk: 128, spa: 128 }, { spe: 252, def: 128, spd: 128 },
		{ hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 },
	]) {
		it(`fits speed evidence without creating forbidden investment shapes from ${JSON.stringify(evs)}`, () => {
			const g = game({ species: 'Mew', nature: 'Hardy', evs: { spe: 128 }, moves: ['splash'] },
				{ species: 'Mew', nature: 'Hardy', evs: { spe: evs.spe >= 128 ? 0 : 252 }, moves: ['splash'] });
			const result = refine(g.play(), [{ nature: 'Hardy', evs }]);
			const model = result.models[0], fitted = model.spread.evs;
			assert(model.statRanges, JSON.stringify(result.notes));
			assert(Object.values(fitted).filter(ev => ev > 0).length <= 3);
			assert(!((fitted.hp || fitted.spe) && (fitted.atk || fitted.spa) && (fitted.def || fitted.spd)));
			assert(!(fitted.hp && fitted.atk && fitted.spa));
			assert(!(fitted.spe && fitted.def && fitted.spd));
			assert(Object.values(fitted).reduce((a, b) => a + b, 0) <= 508);
		});
	}

	it('fits the original spread after exceptional speed evidence supports an unlisted Scarf', () => {
		const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
			{ species: 'Hydreigon', ability: 'Levitate', item: 'Choice Scarf', nature: 'Timid',
				evs: { spa: 252, spe: 252, spd: 4 }, moves: ['dragonpulse'] });
		const state = g.play(), foe = state.opponent.active[0];
		const original = candidates(foe, [{ nature: 'Quiet', evs: { hp: 252, spa: 252 }, item: 'Leftovers' }]);
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert.equal(result.models.length, 1);
		assert.equal(result.models[0].pokemon.item, 'choicescarf');
		assert(result.models[0].pokemon.baseStats.spe > original[0].pokemon.baseStats.spe);
	});

	it('requires damage above max non-Choice Attack before introducing an unlisted Band', () => {
		const set = { nature: 'Adamant', evs: { hp: 248, atk: 252 }, ability: 'Technician' };
		for (const item of ['', 'Choice Band']) {
			const g = game({ species: 'Vaporeon', ability: 'Water Absorb', moves: ['splash'] },
				{ species: 'Scizor', ...set, item, moves: ['bulletpunch'] });
			const state = g.play(), foe = state.opponent.active[0];
			const original = candidates(foe, [{ ...set, evs: item ? set.evs : { hp: 248 }, name: 'ordinary' }]);
			const result = refineOpponentModels(foe, original, state.opponentEvidence);
			assert.equal(result.models.length, 1);
			assert.equal(result.models[0].pokemon.item, item ? 'choiceband' : '');
			assert(result.models[0].pokemon.baseStats.atk >= original[0].pokemon.baseStats.atk);
			assert.deepEqual(result.models[0].moves, original[0].moves);
			assert(!foe.itemKnown);
		}
	});

	it('uses damage to retain Assault Vest even after Tornadus reveals an unlisted attack', () => {
		const g = game({ species: 'Mew', nature: 'Modest', evs: { spa: 252 }, moves: ['surf'] },
			{ species: 'Tornadus-Therian', ability: 'Regenerator', item: 'Assault Vest', nature: 'Timid',
				evs: { hp: 248, def: 8, spe: 252 }, moves: ['gust'] }, 'singles', 'gen6ou');
		const state = g.play(), foe = state.opponent.active[0];
		assert(foe.moves.map(Dex.toID).includes('gust'), g.battle.log.join('\n'));
		assert(!foe.itemKnown);
		const original = inferOpponent(foe, 'gen6ou');
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert(result.models.length);
		assert(result.models.some(m => m.pokemon.item === 'assaultvest'));
		assert(result.models.every(m => m.moves.some(move => move.id === 'gust')));
	});

	it('retains Tornadus presets and their move pools when damage evidence contradicts every spread', () => {
		const g = game({ species: 'Mew', moves: ['surf'] },
			{ species: 'Tornadus-Therian', ability: 'Regenerator', moves: ['gust'] }, 'singles', 'gen6ou');
		const state = g.play(), foe = state.opponent.active[0];
		const original = inferOpponent(foe, 'gen6ou');
		assert.equal(original.length, 3);
		const evidence = structuredClone(state.opponentEvidence.filter(e => e.kind === 'damage' && e.second === foe.ident));
		assert(evidence.length);
		for (const e of evidence) { e.before = 100; e.after = 1; }
		const result = refineOpponentModels(foe, original, evidence);
		assert.deepEqual(result.models, original);
		assert.deepEqual([...new Set(result.models.map(m => m.pokemon.item))].sort(), ['assaultvest', 'rockyhelmet']);
	});

	it('replays the 296 HP Hidden Power case without discarding Assault Vest or expanding configurations', () => {
		const g = game({ species: 'Landorus-Therian', ability: 'Intimidate', item: 'Rocky Helmet', nature: 'Impish',
			evs: { hp: 248, def: 252, spd: 8 }, moves: ['uturn'] },
		{ species: 'Tornadus-Therian', ability: 'Regenerator', moves: ['hiddenpowerice'] }, 'singles', 'gen6ou');
		g.tracker.parseMessage('|move|p1a: Tornadus-Therian|Hidden Power|p2a: Landorus-Therian\n' +
			'|-supereffective|p2a: Landorus-Therian\n|-damage|p2a: Landorus-Therian|85/381\n' +
			'|move|p2a: Landorus-Therian|U-turn|p1a: Tornadus-Therian\n' +
			'|-resisted|p1a: Tornadus-Therian\n|-damage|p1a: Tornadus-Therian|87/100\n|upkeep\n|turn|2');
		const state = g.state(), foe = state.opponent.active[0];
		const original = inferOpponent(foe, 'gen6ou');
		const frozen = structuredClone(original);
		const start = performance.now();
		const result = refineOpponentModels(foe, original, state.opponentEvidence);
		assert(performance.now() - start < 5000, 'Fitting must not become another search tree');
		assert.equal(result.models.length, 2);
		assert(result.models.every(m => m.pokemon.item === 'assaultvest'));
		for (const model of result.models) {
			assert(model.pokemon.baseStats.spa > 256);
			const { calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');
			const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
			const damage = calculateDamage(model.pokemon, state.self.active[0], hardMove('hiddenpowerice', 1, 'gen6ou'), state.field);
			assert(damage.max >= 291 && damage.min <= 298, 'Decision damage must explain the observed HP interval');
			assert(model.moves.some(m => m.id === 'hiddenpowerice'));
			assert(Object.values(model.spread.evs).reduce((a, b) => a + b, 0) <= 508);
			assert(Object.values(model.spread.evs).every(ev => ev >= 0 && ev <= 252));
			const evs = model.spread.evs;
			assert(Object.values(evs).filter(ev => ev > 0).length <= 3);
			assert(!((evs.hp || evs.spe) && (evs.atk || evs.spa) && (evs.def || evs.spd)));
			assert(!(evs.hp && evs.atk && evs.spa));
			assert(!(evs.spe && evs.def && evs.spd));
			assert(model.statRanges.spa[0] <= model.pokemon.baseStats.spa);
			assert(model.statRanges.spa[1] >= model.pokemon.baseStats.spa);
		}
		assert.deepEqual(original, frozen);
		assert(!foe.itemKnown);
		assert.equal(g.tracker.getActiveOpponent().item, '');
	});

	it('does not favor a preset whose Hidden Power type cannot be evaluated', () => {
		const g = game(passive, { species: 'Tornadus-Therian', ability: 'Regenerator', moves: ['hiddenpowerice'] });
		const state = g.play(), foe = state.opponent.active[0];
		const models = candidates(foe, [
			{ name: 'vest', item: 'assaultvest', nature: 'Timid', evs: { hp: 248, spe: 252 } },
			{ name: 'helmet', item: 'rockyhelmet', nature: 'Timid', evs: { hp: 248, spe: 252 } },
		]);
		models.forEach(m => { m.moves = [{ id: 'hiddenpower', availability: 1 }]; });
		const result = refineOpponentModels(foe, models, state.opponentEvidence);
		assert.deepEqual(result.models.map(m => m.name), ['vest', 'helmet']);
		assert(result.notes.some(n => n.includes('unresolved')));
	});

	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: records missing Helmet contact damage without excluding suppressed or prevented effects`, () => {
			for (const variant of ['missing', 'present', 'magicguard', 'pads', 'noncontact', 'magicroom']) {
				const g = game({ species: 'Mew', ability: variant === 'magicguard' ? 'Magic Guard' : 'Synchronize',
					item: variant === 'pads' ? 'Protective Pads' : '', moves: [variant === 'noncontact' ? 'surf' : 'uturn'] },
				{ species: 'Tornadus-Therian', ability: 'Regenerator', item: variant === 'present' ? 'Rocky Helmet' : 'Assault Vest',
					moves: ['gust'] }, mode);
				if (variant === 'magicroom') {
					g.battle.field.addPseudoWeather('magicroom', g.battle.p2.active[0]);
					g.state();
				}
				const state = g.play();
				const excluded = state.opponentEvidence.some(e => e.excludedItems?.includes('rockyhelmet'));
				assert.equal(excluded, variant === 'missing', variant + '\n' + g.battle.log.join('\n'));
			}
		});

		it(`${mode}: infers Scarf from simultaneous Drizzle before max-Speed Ninetales's Drought`, () => {
			const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Drizzle' };
			const g = game({ species: 'Ninetales', nature: 'Timid', evs: { spe: 252 }, ability: 'Drought', moves: ['splash'] },
				{ species: 'Pelipper', ...set, item: 'Choice Scarf', moves: ['splash'] }, mode);
			const state = g.state();
			const entry = state.opponentEvidence.filter(e => e.speedSource === 'entry');
			assert.equal(entry.length, 1, g.battle.log.join('\n'));
			assert.equal(entry[0].first, state.opponent.active[0].ident);
			assert.deepEqual(refine(state, [{ ...set, name: 'ordinary' }, { ...set, name: 'scarf', item: 'Choice Scarf' }])
				.models.map(m => m.name), ['scarf']);
			assert(!state.opponent.active[0].itemKnown);
		});

		it(`${mode}: infers Scarf from the order of simultaneous Intimidate activations`, () => {
			const set = { nature: 'Jolly', evs: { spe: 252 }, ability: 'Intimidate' };
			const g = game({ species: 'Salamence', ...set, moves: ['splash'] },
				{ species: 'Landorus-Therian', ...set, item: 'Choice Scarf', moves: ['splash'] }, mode, 'gen6ou');
			const state = g.state();
			assert.equal(state.opponentEvidence.filter(e => e.speedSource === 'entry').length, 1, g.battle.log.join('\n'));
			assert.deepEqual(refine(state, [{ ...set, name: 'ordinary' }, { ...set, name: 'scarf', item: 'Choice Scarf' }])
				.models.map(m => m.name), ['scarf']);
		});

		it(`${mode}: uses Earthquake before Will-O-Wisp to exclude slow gen6 OU Excadrill sets`, () => {
			const presets = require('../../../data/npc/strategies/gen6ou.json').species.excadrill
				.filter(p => ['Fast Utility', 'Specially Defensive'].includes(p.name))
				.map(p => ({ name: p.name, nature: Dex.natures.get(p.natures[0]).name,
					evs: p.evs[0], item: p.items[0], ability: p.abilities[0] }));
			const g = game({ species: 'Rotom-Wash', ability: 'Levitate', nature: 'Bold',
				evs: { hp: 248, def: 132, spe: 128 }, moves: ['willowisp'] },
			{ species: 'Excadrill', ...presets.find(p => p.name === 'Fast Utility'), moves: ['earthquake'] }, mode, 'gen6ou');
			const state = g.play();
			const speed = state.opponentEvidence.filter(e => e.kind === 'speed' && e.move === 'earthquake' && e.response === 'willowisp');
			assert.equal(speed.length, 1, g.battle.log.join('\n'));
			assert.equal(state.self.active[0].baseStats.spe, 240);
			const result = refine({ ...state, opponentEvidence: speed }, presets);
			assert(result.models.some(m => m.name === 'Fast Utility'));
			assert(result.models.every(m => m.pokemon.baseStats.spe >= 240));
			const evaluator = new HardEvaluation(state, 'gen6ou');
			assert(evaluator.opponentModels(state.opponent.active[0]).every(m => m.pokemon.baseStats.spe >= 240));
		});

		it(`${mode}: removes non-Scarf Hydreigon after it outruns max-Speed Jolly Garchomp`, () => {
			const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Levitate' };
			const g = game({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
				{ species: 'Hydreigon', ...set, item: 'Choice Scarf', moves: ['dragonpulse'] }, mode);
			const state = g.play();
			assert(state.opponentEvidence.some(e => e.kind === 'speed'));
			const result = refine(state, [{ ...set, name: 'ordinary' }, { ...set, item: 'Choice Scarf', name: 'scarf' }]);
			assert.deepEqual(result.models.map(m => m.name), ['scarf']);
			assert.equal(state.opponent.active[0].itemKnown, false, 'Inference must not reveal an item as fact');
			assert(result.notes.some(note => note.startsWith('speed/damage evidence')));
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
			assert(result.models.some(m => m.name === 'special'));
			assert(result.models.every(m => m.pokemon.baseStats.spd > computeStatsFromPreset(
				Dex.species.get('Gliscor').baseStats, 100, { nature: 'Impish', evs: { hp: 252, def: 252 } }).spd));
		});
	}

	it('does not treat higher entry-ability priority as higher Speed', () => {
		const g = game({ species: 'Salamence', ability: 'Intimidate', nature: 'Jolly', evs: { spe: 252 }, moves: ['splash'] },
			{ species: 'Tyranitar', ability: 'Unnerve', moves: ['splash'] });
		assert(!g.state().opponentEvidence.some(e => e.speedSource === 'entry'), g.battle.log.join('\n'));
	});

	it('records simultaneous replacement abilities after a double knockout', () => {
		const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Drizzle' };
		const g = game({ species: 'Geodude', nature: 'Adamant', evs: { atk: 252 }, moves: ['explosion'] },
			{ species: 'Sunkern', moves: ['splash'] }, 'singles', 'gen7customgame', passive, {
				own: [{ species: 'Ninetales', nature: 'Timid', evs: { spe: 252 }, ability: 'Drought', moves: ['splash'] }],
				foe: [{ species: 'Pelipper', ...set, item: 'Choice Scarf', moves: ['splash'] }],
			});
		g.play();
		assert(g.battle.p1.activeRequest.forceSwitch[0]);
		assert(g.battle.p2.activeRequest.forceSwitch[0]);
		g.battle.makeChoices('switch 2', 'switch 2');
		const state = g.state();
		assert.equal(state.opponentEvidence.filter(e => e.speedSource === 'entry').length, 1, g.battle.log.join('\n'));
		assert.deepEqual(refine(state, [{ ...set, name: 'ordinary' }, { ...set, name: 'scarf', item: 'Choice Scarf' }])
			.models.map(m => m.name), ['scarf']);
	});

	it('does not compare abilities from separate voluntary switch-ins', () => {
		const g = game({ species: 'Ninetales', ability: 'Drought', moves: ['splash'] },
			{ species: 'Pelipper', ability: 'Drizzle', moves: ['splash'] });
		g.tracker.evidence.restore([]);
		g.tracker.parseMessage('|switch|p1a: Pelipper|Pelipper|100/100\n' +
			'|-weather|RainDance|[from] ability: Drizzle|[of] p1a: Pelipper\n' +
			'|switch|p2a: Ninetales|Ninetales|100/100\n' +
			'|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Ninetales');
		assert(!g.state().opponentEvidence.some(e => e.speedSource === 'entry'));
	});

	it('accepts possible entry speed ties without claiming an exact item', () => {
		const g = game({ species: 'Ninetales', ability: 'Drought', moves: ['splash'] },
			{ species: 'Pelipper', ability: 'Drizzle', moves: ['splash'] });
		const state = g.state(), foe = state.opponent.active[0];
		const entry = state.opponentEvidence.filter(e => e.speedSource === 'entry');
		assert.equal(entry.length, 1);
		const models = candidates(foe, [{ name: 'tie', ability: 'Drizzle' }]);
		models[0].pokemon.baseStats.spe = state.self.active[0].baseStats.spe;
		const result = refineOpponentModels(foe, models, entry);
		assert.deepEqual(result.models.map(m => m.name), ['tie']);
		assert.deepEqual(result.notes, []);
	});

	for (const move of ['swordsdance', 'stealthrock', 'roost', 'recover']) {
		it(`records ${move} before an attack without reusing its invalidated damage snapshot`, () => {
			const set = { nature: 'Timid', evs: { spe: 252 }, ability: 'Levitate' };
			const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
				{ species: 'Hydreigon', ...set, item: 'Choice Scarf', moves: [move] });
			g.battle.p1.active[0].hp = Math.floor(g.battle.p1.active[0].maxhp / 2);
			g.state();
			const state = g.play();
			const speed = state.opponentEvidence.filter(e => e.kind === 'speed');
			assert.equal(speed.length, 1, g.battle.log.join('\n'));
			assert.equal(speed[0].move, move);
			const result = refine({ ...state, opponentEvidence: speed },
				[{ ...set, name: 'ordinary' }, { ...set, item: 'Choice Scarf', name: 'scarf' }]);
			assert.deepEqual(result.models.map(m => m.name), ['scarf']);
			if (move !== 'recover') assert(!state.opponentEvidence.some(e => e.kind === 'damage'));
		});
	}

	for (const move of ['protect', 'splash']) {
		it(`does not mistake ${move === 'protect' ? 'Protect' : 'Prankster'} priority for higher Speed`, () => {
			const set = { ability: move === 'protect' ? 'Synchronize' : 'Prankster' };
			const g = game({ species: 'Garchomp', nature: 'Jolly', evs: { hp: 252, spe: 252 }, moves: ['tackle'] },
				{ species: move === 'protect' ? 'Mew' : 'Whimsicott', ...set, moves: [move] });
			const state = g.play();
			const speed = state.opponentEvidence.filter(e => e.kind === 'speed');
			assert.equal(speed.length, 1, g.battle.log.join('\n'));
			const result = refine({ ...state, opponentEvidence: speed },
				[{ ...set, name: 'ordinary' }, { ...set, item: 'Choice Scarf', name: 'scarf' }]);
			assert.deepEqual(result.models.map(m => m.name), ['ordinary', 'scarf']);
		});
	}

	it('stops order recording after speed changes, queue manipulation and called moves', () => {
		for (const effect of ['|-boost|p1a: Mew|spe|2', '|-sidestart|p1: Foe|move: Tailwind',
			'|-activate|p1a: Mew|move: After You', '|-activate|p1a: Mew|item: Quick Claw',
			'|move|p1a: Mew|Tackle|p2a: Mew|[from] move: Metronome']) {
			const g = game(passive, passive);
			g.tracker.parseMessage(`|move|p1a: Mew|Splash|p1a: Mew\n${effect}\n|move|p2a: Mew|Tackle|p1a: Mew\n|upkeep`);
			assert(!g.tracker.evidence.getHistory().some(e => e.kind === 'speed'), effect);
		}
	});

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
		assert(result.models.some(m => m.name === '0'));
		assert(result.models.every(m => m.pokemon.baseStats.spd > 200));
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
		assert(evaluator.inferenceNotes.get(foe).some(n => n.startsWith('speed/damage evidence')));
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
		assert(evaluator.inferenceNotes.get(foe).some(n => n.includes('speed/damage evidence')));
	});
});
