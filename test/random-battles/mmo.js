'use strict';

const assert = require('../assert');
const { Battle, Dex, Teams } = require('../../dist/sim');
const { Runner } = require('../../dist/sim/tools/runner');
const { BasicAI } = require('../../dist/server/npc/ai/basic');
const { NormalAI } = require('../../dist/server/npc/ai/normal');
const gen5Sets = require('../../data/random-battles/gen5/sets.json');

const format = 'gen5pokemmorandombattle';

describe('PokeMMO Random Battle', () => {
	it('should keep MMO mechanics separate from singles tier bans and level limits', () => {
		const data = Dex.formats.get(format);
		const rules = Dex.formats.getRuleTable(data);
		assert.equal(data.mod, 'mmo');
		assert.equal(data.team, 'random');
		assert(rules.has('stadiumsleepclause'));
		assert(!rules.has('sleepclausemmo'));
		assert(rules.has('pokemmohiddenpower'));
		assert(rules.has('dynamaxclause'));
		assert(rules.has('illusionlevelmod'));
		assert(!rules.has('pokemmostandard'));
		assert(!rules.has('teampreview'));
		assert(!rules.has('sleepclausemod'));
		assert(!rules.has('-pokemontag:uber'));
		assert(!rules.adjustLevel);
		assert.equal(rules.complexBans.length, 0);
		assert.equal(Dex.formats.getRuleTable(Dex.formats.get('gen5pokemmoou')).adjustLevel, 50);
	});

	it('should generate sets for the entire Gen 5 catalogue at the original balancing levels', () => {
		const generator = Teams.getGenerator(format, [1, 2, 3, 4]);
		assert.deepEqual(Object.keys(generator.randomSets), Object.keys(gen5Sets));
		const gen5 = Dex.mod('gen5');
		for (const [id, data] of Object.entries(gen5Sets)) {
			for (let i = 0; i < 3; i++) {
				generator.setSeed([i, 2, 3, 4]);
				const set = generator.randomSet(id, {}, i === 0);
				const species = gen5.species.get(set.species);
				assert(species.exists && species.gen <= 5, set.species);
				assert.equal(set.level, data.level, id);
				assert(data.sets.some(s => s.abilities.includes(set.ability)), `${id}: ${set.ability}`);
				assert(set.moves.length >= 1 && set.moves.length <= 4, id);
				assert.equal(new Set(set.moves.map(m => gen5.moves.get(m).id)).size, set.moves.length, id);
				for (const move of set.moves) {
					assert(gen5.moves.get(move).exists && gen5.moves.get(move).gen <= 5, `${id}: ${move}`);
				}
			}
		}
	});

	it('should retain Ubers and combinations that are banned only in MMO singles tiers', () => {
		const generator = Teams.getGenerator(format, [1, 2, 3, 4]);
		assert.equal(generator.randomSet('kyogre').level, 69);
		assert.equal(generator.randomSet('mewtwo').level, 70);
		assert.equal(generator.randomSet('beedrill').level, 99);
		assert.equal(generator.randomSet('blaziken').ability, 'Speed Boost');
		assert.equal(generator.randomSet('dugtrio').ability, 'Arena Trap');
		let hasDracoMeteor = false;
		for (let i = 0; i < 20; i++) {
			hasDracoMeteor ||= generator.randomSet('hydreigon').moves.includes('dracometeor');
		}
		assert(hasDracoMeteor);
	});

	it('should build complete, reproducible teams without modifying the Gen 5 generator or source data', () => {
		const original = JSON.stringify(gen5Sets);
		const seed = [1, 2, 3, 4];
		const gen5Team = Teams.generate('gen5randombattle', { seed });
		const generator = Teams.getGenerator(format, seed);
		const baseSpeciesPool = new Set(Object.keys(gen5Sets).map(id => generator.dex.species.get(id).baseSpecies));
		const seen = new Set();
		for (let i = 0; i < 100; i++) {
			generator.setSeed([i, 2, 3, 4]);
			const team = generator.getTeam();
			assert.equal(team.length, 6);
			const names = team.map(set => generator.dex.species.get(set.species).baseSpecies);
			assert.equal(new Set(names).size, 6);
			for (const name of names) {
				assert(baseSpeciesPool.has(name), name);
				seen.add(name);
			}
		}
		assert(seen.has('Mewtwo'));
		assert([...seen].some(name => Dex.mod('gen5').species.get(name).tier === 'NU'));
		assert.deepEqual(Teams.generate(format, { seed }), Teams.generate(format, { seed }));
		assert.deepEqual(Teams.generate('gen5randombattle', { seed }), gen5Team);
		assert.equal(JSON.stringify(gen5Sets), original);
	});

	it('should preserve levels through NPC team packing and use MMO battle mechanics', () => {
		const generator = Teams.getGenerator(format, [1, 2, 3, 4]);
		const team = ['kyogre', 'mewtwo', 'beedrill', 'blaziken', 'unown', 'latios'].map(id => generator.randomSet(id));
		const battle = new Battle({
			formatid: format,
			seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: Teams.pack(team) },
			p2: { name: 'NPC', team: Teams.pack(team) },
		});
		try {
			assert.equal(battle.gen, 8);
			assert.equal(battle.dex.currentMod, 'mmo');
			assert.equal(battle.requestState, 'move');
			assert.equal(battle.field.weatherState.duration, 5);
			assert.equal(battle.dex.moves.get('knockoff').basePower, 20);
			assert.equal(battle.dex.moves.get('knockoff').onBasePower, undefined);
			assert.equal(battle.dex.moves.get('outrage').basePower, 90);
			assert.equal(battle.dex.moves.get('recover').pp, 5);
			assert.equal(battle.dex.getEffectiveness('Dark', 'Steel'), -1);
			for (const side of battle.sides) {
				assert.deepEqual(side.pokemon.map(p => p.level), team.map(s => s.level));
				assert.equal(side.canDynamaxNow(), false);
				for (const pokemon of side.pokemon) assert.equal(pokemon.canTerastallize, null);
				assert.equal(side.pokemon[4].hpType, battle.dex.moves.get(team[4].moves[0]).type);
			}
		} finally {
			battle.destroy();
		}
	});

	it('should generate both teams inside the simulator when no teams are supplied', () => {
		const battle = new Battle({
			formatid: format,
			seed: [1, 2, 3, 4],
			p1: { name: 'Player', seed: [1, 2, 3, 4] },
			p2: { name: 'NPC', seed: [4, 3, 2, 1] },
		});
		try {
			for (const side of battle.sides) {
				assert.equal(side.pokemon.length, 6);
				assert(side.pokemon.every(p => p.level >= 69 && p.level <= 100));
			}
			battle.makeChoices();
			assert.equal(battle.turn, 2);
		} finally {
			battle.destroy();
		}
	});

	for (const AI of [BasicAI, NormalAI]) {
		it(`should complete a battle using the NPC ${AI.name} controller`, async function () {
			this.timeout(10000);
			await new Runner({
				format, prng: [5, 6, 7, 8],
				p2options: { createAI: (stream, options) => new AI(stream, { seed: options.seed }) },
			}).run();
		});
	}
});
