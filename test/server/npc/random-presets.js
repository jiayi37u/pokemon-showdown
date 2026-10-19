'use strict';

const assert = require('assert').strict;
const { Dex, Teams } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { trackedPokemonToAIPokemon, buildBattleStateWithTracker, buildPokemonFromRequest } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { computeStatsFromPreset, canHaveOpponentMoves } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
const { inferOpponent } = require('../../../dist/server/npc/ai/hard/opponent-model');

function observation(species, level, format, moves = [], events = []) {
	const tracker = createBattleTracker('p2');
	tracker.parseMessage(`|switch|p1a: Foe|${species}, L${level}|100/100`);
	for (const move of moves) tracker.parseMessage(`|move|p1a: Foe|${Dex.moves.get(move).name}|p2a: NPC`);
	for (const event of events) tracker.parseMessage(event);
	return {
		tracker,
		pokemon: trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, format),
	};
}

function roleNames(pokemon) {
	return [...new Set(pokemon.presetModels.map(model => model.name))];
}

describe('Shared random-battle configuration inference', function () {
	this.timeout(20000);

	it('uses the current Terapagos ability throughout random hypotheses after a public forme change', () => {
		const { pokemon, tracker } = observation('Terapagos', 77, 'gen9randombattle', [], [
			'|-activate|p1a: Foe|ability: Tera Shift',
			'|detailschange|p1a: Foe|Terapagos-Terastal, L77',
		]);
		assert.equal(tracker.getActiveOpponent().ability, 'Tera Shell');
		assert(pokemon.presetModels.some(model => model.matched));
		assert(pokemon.presetModels.every(model => Dex.toID(model.pokemon.ability) === 'terashell'));
		const direct = observation('Terapagos-Terastal', 77, 'gen9randombattle').pokemon;
		assert.equal(Dex.toID(direct.ability), 'terashell');
		assert(direct.presetModels.every(model => Dex.toID(model.pokemon.ability) === 'terashell'));
	});

	for (const AI of [NormalAI, HardAI]) {
		it(`${AI.name} narrows Gen5 Charizard to the Swords Dance role using only public information`, () => {
			const ai = new AI({ write() {} }, { seed: [1, 2, 3, 4] });
			const room = { format: 'gen5pokemmorandombattle', turn: 1 };
			Object.defineProperty(room, 'sides', { get() { throw new Error('Hidden sides accessed'); } });
			ai.setBattle(room);
			const tracker = ai.getTracker();
			tracker.parseMessage('|switch|p1a: Foe|Charizard, L84|100/100');
			const request = { side: { id: 'p2', pokemon: [{
				ident: 'p2: NPC', details: 'Blissey, L80', active: true, condition: '500/500',
				stats: { atk: 30, def: 150, spa: 150, spd: 250, spe: 100 },
				moves: ['icebeam'], baseAbility: 'Natural Cure', item: '',
			}] }, active: [{ moves: [{ id: 'icebeam', move: 'Ice Beam', pp: 10, maxpp: 10, target: 'normal' }] }] };
			const snapshot = () => buildBattleStateWithTracker(request, room, tracker, { ...DEFAULT_AI_CONFIG, formatId: room.format });
			ai.choose = choice => assert(choice.startsWith('move '), choice);
			ai.receiveRequest(request);
			assert.equal(roleNames(snapshot().opponent.active[0]).length, 3);
			tracker.parseMessage('|move|p1a: Foe|Swords Dance|p1a: Foe');
			ai.receiveRequest(request);
			const opponent = snapshot().opponent.active[0];
			assert.deepEqual(roleNames(opponent), ['random:charizard:Setup Sweeper']);
			assert.deepEqual(opponent.moves.map(Dex.toID), ['swordsdance']);
			assert(opponent.moveKnowledge.presetCandidates.includes('acrobatics'));
			assert(!opponent.moveKnowledge.presetCandidates.includes('roost'));
			assert.equal(opponent.item, 'Flying Gem');
			assert.equal(opponent.itemKnown, false);
			assert.deepEqual(tracker.getActiveOpponent().knownMoves.map(Dex.toID), ['swordsdance']);
			assert.equal(tracker.getActiveOpponent().item, '');
			assert(inferOpponent(opponent, room.format).every(model => model.name === 'random:charizard:Setup Sweeper'));
		});
	}

	it('uses random spreads instead of the OU preset and preserves role boundaries', () => {
		const { pokemon } = observation('Charizard', 84, 'gen5pokemmorandombattle');
		assert.equal(pokemon.moveKnowledge.remainingSlots, 4);
		assert(!canHaveOpponentMoves(pokemon.moveKnowledge, ['swordsdance', 'fireblast']));
		assert(pokemon.presetModels.every(model => model.pokemon.baseStats.atk <= 189));
		const garchomp = observation('Garchomp', 80, 'gen9randombattle').pokemon;
		assert(garchomp.baseStats.atk < 300, 'Random Garchomp must not receive Jolly 252 Atk / Spe from OU');
	});

	it('narrows roles by public native item and keeps that evidence after consumption', () => {
		for (const event of ['-item', '-enditem']) {
			const { pokemon, tracker } = observation('Charizard', 84, 'gen5pokemmorandombattle', [],
				[`|${event}|p1a: Foe|Flying Gem${event === '-enditem' ? '|[from] gem' : ''}`]);
			assert.deepEqual(roleNames(pokemon), ['random:charizard:Setup Sweeper']);
			assert.equal(pokemon.item, event === '-item' ? 'Flying Gem' : '');
			assert.equal(tracker.getActiveOpponent().originalItem, 'Flying Gem');
		}
	});

	it('uses native ability evidence but does not treat an acquired ability or item as native', () => {
		const solar = observation('Charizard', 84, 'gen5pokemmorandombattle', [], ['|-ability|p1a: Foe|Solar Power']).pokemon;
		assert(!roleNames(solar).some(name => name.endsWith('Setup Sweeper')));
		const traded = observation('Charizard', 84, 'gen5pokemmorandombattle', ['swordsdance'], [
			'|-item|p1a: Foe|Choice Scarf|[from] move: Trick',
			'|-ability|p1a: Foe|Insomnia|Blaze|[from] move: Worry Seed',
		]).pokemon;
		assert.deepEqual(roleNames(traded), ['random:charizard:Setup Sweeper']);
		assert(traded.presetModels.every(model => model.pokemon.item === 'Choice Scarf' && model.pokemon.ability === 'Insomnia'));
	});

	it('uses Gen9 doubles data for Multi and Gen5 singles data for MMO Multi', () => {
		for (const format of ['gen9multirandombattle', 'gen5pokemmomultirandombattle']) {
			const generator = Teams.getGenerator(format, [1, 2, 3, 4]);
			const doubles = format.startsWith('gen9');
			const data = doubles ? generator.randomDoublesSets : generator.randomSets;
			const level = generator.getLevel(generator.dex.species.get('charizard'), doubles);
			const { pokemon } = observation('Charizard', level, format);
			assert.deepEqual(roleNames(pokemon).sort(), data.charizard.sets.map(set => `random:charizard:${set.role}`).sort());
			const pool = new Set(data.charizard.sets.flatMap(set => set.movepool.map(Dex.toID)));
			assert(pokemon.moveKnowledge.presetCandidates.every(move => pool.has(move)));
		}
	});

	it('infers the Mega stone from Gen7 level without applying the evolved stats or ability early', () => {
		const base = observation('Venusaur', 84, 'gen7randombattle').pokemon;
		assert(roleNames(base).every(name => name.startsWith('random:venusaur:')));
		const { pokemon, tracker } = observation('Venusaur', 78, 'gen7randombattle');
		assert(roleNames(pokemon).every(name => name.startsWith('random:venusaurmega:')));
		assert.equal(pokemon.species, 'Venusaur');
		assert.equal(pokemon.item, 'Venusaurite');
		assert.equal(pokemon.itemKnown, false);
		assert.notEqual(Dex.toID(pokemon.ability), 'thickfat');
		assert.equal(pokemon.baseStats.def, computeStatsFromPreset(Dex.species.get('Venusaur').baseStats, 78, {}).def);
		tracker.parseMessage('|detailschange|p1a: Foe|Venusaur-Mega, L78');
		const mega = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, 'gen7randombattle');
		assert.equal(Dex.toID(mega.ability), 'thickfat');
		assert(mega.baseStats.def > pokemon.baseStats.def);
	});

	it('keeps the random source through a public stance change', () => {
		const format = 'gen7randombattle';
		const generator = Teams.getGenerator(format, [1, 2, 3, 4]);
		const level = generator.getLevel(generator.dex.species.get('aegislash'));
		const { pokemon, tracker } = observation('Aegislash', level, format);
		tracker.parseMessage('|-formechange|p1a: Foe|Aegislash-Blade');
		const blade = trackedPokemonToAIPokemon(tracker.getActiveOpponent(), 1, true, format);
		assert.deepEqual(roleNames(blade), roleNames(pokemon));
		assert(blade.presetModels.every(model => model.matched));
		assert(blade.baseStats.atk > pokemon.baseStats.atk);
	});

	it('reuses item rules and conditional IV/EV optimizations', () => {
		const chansey = observation('Chansey', 85, 'gen9randombattle').pokemon;
		assert.equal(chansey.item, 'Eviolite');
		assert.equal(chansey.baseStats.atk, 13); // 0 Attack IV/EV; Seismic Toss does not use Attack.
		const generator = Teams.getGenerator('gen5pokemmorandombattle', [1, 2, 3, 4]);
		const level = generator.getLevel(generator.dex.species.get('ferrothorn'));
		const ferrothorn = observation('Ferrothorn', level, 'gen5pokemmorandombattle', ['gyroball']).pokemon;
		assert(ferrothorn.presetModels.every(model => model.pokemon.baseStats.spe === Math.floor(40 * level / 100) + 5));
	});

	it('retains four public slots and resolves untyped Hidden Power without adding a fifth slot', () => {
		const { pokemon } = observation('Charizard', 84, 'gen5pokemmorandombattle',
			['fireblast', 'airslash', 'focusblast', 'hiddenpower']);
		assert.equal(pokemon.moveKnowledge.remainingSlots, 0);
		assert(canHaveOpponentMoves(pokemon.moveKnowledge, ['hiddenpowergrass']));
		assert(pokemon.presetModels.every(model => !model.moves.some(move => move.id === 'hiddenpower')));
		assert(!canHaveOpponentMoves(pokemon.moveKnowledge, ['roost']));
		assert.deepEqual(pokemon.moves.map(Dex.toID), ['fireblast', 'airslash', 'focusblast', 'hiddenpower']);
	});

	it('falls back to public moves and random baseline stats when evidence has no compatible role', () => {
		const { pokemon } = observation('Garchomp', 80, 'gen9randombattle', ['surf']);
		assert.deepEqual(roleNames(pokemon), ['random:unmatched']);
		assert.deepEqual(pokemon.moveKnowledge.presetCandidates, []);
		assert.equal(pokemon.item, '');
		assert.deepEqual(pokemon.baseStats, computeStatsFromPreset(Dex.species.get('Garchomp').baseStats, 80, {}));
	});

	it('parses levels when the species name itself starts with L', () => {
		const { pokemon, tracker } = observation('Lanturn', 87, 'gen9multirandombattle');
		assert.equal(tracker.getActiveOpponent().level, 87);
		assert(pokemon.presetModels.every(model => model.matched));
		const self = buildPokemonFromRequest({ details: 'Lanturn, L87', condition: '100/100', moves: ['scald'] }, 1, true);
		assert.equal(self.level, 87);
	});

	for (const format of ['gen9randombattle', 'gen5pokemmorandombattle', 'gen9multirandombattle',
		'gen5pokemmomultirandombattle', 'gen7randombattle']) {
		it(`retains actual generated configurations in ${format}`, () => {
			const team = Teams.generate(format, { seed: [1, 2, 3, 4] });
			for (const set of team) {
				const events = [`|-ability|p1a: Foe|${set.ability}`];
				if (set.item) events.push(`|-item|p1a: Foe|${set.item}`);
				const { pokemon } = observation(set.species, set.level, format, set.moves, events);
				const stats = computeStatsFromPreset(Dex.forFormat(format).species.get(set.species).baseStats, set.level, set);
				assert(pokemon.presetModels.some(model => model.matched &&
					canHaveOpponentMoves(model.pokemon.moveKnowledge, set.moves) &&
					Object.keys(stats).every(stat => model.pokemon.baseStats[stat] === stats[stat])),
				`Generated ${set.species} must remain possible with its actual spread`);
			}
		});
	}

	it('leaves ordinary OU inference on its existing preset path', () => {
		const { pokemon } = observation('Garchomp', 100, 'gen7ou');
		assert.equal(pokemon.presetModels, undefined);
		assert.equal(pokemon.baseStats.atk, 359);
		assert.equal(pokemon.baseStats.spe, 333);
	});
});

describe('Random preset hypotheses preserve public action history', () => {
	const { buildBattleStateFromRequests, buildAIMove } = require('../../../dist/server/npc/ai/cfru/state-builder');
	const { calculateDamage } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: includes public counters before building active and reserve hypotheses`, () => {
			const formatId = 'gen9randombattle';
			const tracker = createBattleTracker('p2', mode === 'multi');
			tracker.setFormat(formatId);
			const request = side => ({ side, request: { side: { id: side, pokemon: [{
				ident: `${side}: Own`, details: 'Mew, L100', active: true, condition: '300/300',
				stats: { atk: 200, def: 200, spa: 200, spd: 200, spe: 200 },
				moves: ['tackle'], ability: 'Synchronize', item: '',
			}] }, active: [{}] } });
			const requests = (mode === 'multi' ? ['p2', 'p4'] : ['p2']).map(request);
			if (mode === 'doubles') {
				requests[0].request.side.pokemon.push({ ...requests[0].request.side.pokemon[0], ident: 'p2: Ally' });
				requests[0].request.active.push({});
			}
			tracker.parseMessage('|switch|p1a: Ape|Annihilape, L76|100/100\n|switch|p2a: Own|Mew|100/100');
			if (mode !== 'singles') {
				tracker.parseMessage(`|switch|${mode === 'multi' ? 'p3b' : 'p1b'}: Foe|Mew|100/100`);
			}
			tracker.parseMessage('|move|p1a: Ape|Rage Fist|p2a: Own\n|move|p2a: Own|Double Hit|p1a: Ape\n' +
				'|-damage|p1a: Ape|90/100\n|-damage|p1a: Ape|80/100\n|-hitcount|p1a: Ape|2\n' +
				'|-status|p1a: Ape|tox\n|-damage|p1a: Ape|74/100 tox|[from] psn\n' +
				'|turn|2\n|-damage|p1a: Ape|62/100 tox|[from] psn\n|turn|3');
			const build = () => buildBattleStateFromRequests(requests, tracker,
				{ ...DEFAULT_AI_CONFIG, formatId, isDoubles: mode !== 'singles' });
			let state = build();
			const foe = state.opponent.active[0];
			assert(foe.presetModels.length > 0);
			for (const model of inferOpponent(foe, formatId)) {
				assert.equal(model.pokemon.timesAttacked, 2);
				assert.equal(model.pokemon.toxicCounter, 2);
				assert.equal(model.pokemon.activeMoveActions, 1);
				const move = buildAIMove({ id: 'ragefist' }, 1, formatId);
				const damage = calculateDamage(model.pokemon, state.self.active[0], move, state.field);
				assert(damage.average > calculateDamage({ ...model.pokemon, timesAttacked: 0 },
					state.self.active[0], move, state.field).average * 2);
			}
			tracker.parseMessage('|switch|p1a: Bench|Mew|100/100');
			state = build();
			const reserve = state.opponent.reserve.find(p => p.species === 'Annihilape');
			assert(reserve.presetModels.every(model => model.pokemon.timesAttacked === 2));
			assert(reserve.presetModels.every(model => model.pokemon.toxicCounter === 0));
		});
	}
});
