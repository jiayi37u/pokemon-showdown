'use strict';

const assert = require('../../assert');
const common = require('../../common');
const { Dex, TeamValidator } = require('../../../dist/sim');
const { PokeMMOTiers } = require('../../../dist/data/mods/mmo/formats-data');

let battle;
const formats = ['gen5pokemmoou', 'gen5pokemmouu', 'gen5pokemmonu'];
function set(species, ability, moves = ['protect'], extra = {}) {
	return { species, ability, moves, evs: { hp: 4, atk: 252, spe: 252 }, ...extra };
}
function validate(pokemon, format = formats[0]) {
	return new TeamValidator(format).validateTeam([pokemon]);
}

describe('PokeMMO tiers', () => {
	afterEach(() => {
		battle?.destroy();
		battle = null;
	});

	it('should use the complete MMO tier catalogue without changing Gen 5 OU', () => {
		const counts = {};
		const dex = Dex.mod('mmo');
		for (const [id, tier] of Object.entries(PokeMMOTiers)) {
			counts[tier] = (counts[tier] || 0) + 1;
			assert.equal(dex.species.get(id).tier, tier, id);
		}
		assert.deepEqual(counts, { Uber: 60, OU: 43, UU: 53, NU: 46, UT: 487, LC: 2 });
		assert.equal(dex.species.get('gallade').tier, 'NU');
		assert.equal(Dex.mod('gen5').species.get('gallade').tier, 'RU');
		assert.equal(Dex.mod('gen5').moves.get('outrage').basePower, 120);
	});

	for (const [index, formatid] of formats.entries()) {
		it(`should enforce tier inheritance in ${formatid}`, () => {
			const candidates = [
				set('Garchomp', 'Rough Skin', ['swordsdance', 'earthquake']),
				set('Empoleon', 'Competitive', ['scald', 'roost']),
				set('Gallade', 'Steadfast', ['sacredsword']),
				set('Pikachu', 'Static', ['thunderbolt']),
			];
			for (const [tier, pokemon] of candidates.entries()) {
				const problems = validate(pokemon, formatid);
				if (tier < index) {
					assert(problems?.some(problem => problem.includes('is tagged')), JSON.stringify(problems));
				} else {
					assert.equal(problems, null, JSON.stringify(problems));
				}
			}
		});

		it(`should validate and finish a level 50 battle in ${formatid}`, () => {
			const team = [set('Pikachu', 'Static', ['thunderbolt'], { level: 100 })];
			assert.equal(new TeamValidator(formatid).validateTeam(team), null);
			battle = common.createBattle({ formatid }, [team, team]);
			battle.makeChoices();
			assert.equal(battle.gen, 8);
			assert.equal(battle.p1.active[0].level, 50);
			assert.equal(battle.p1.canDynamaxNow(), false);
			assert.equal(battle.p1.active[0].canTerastallize, null);
			for (let turn = 0; turn < 50 && !battle.ended; turn++) battle.makeChoices();
			assert(battle.ended);
		});

		it(`should reject Ubers, unavailable species, items and abilities in ${formatid}`, () => {
			for (const pokemon of [
				set('Mewtwo', 'Pressure'), set('Regice', 'Clear Body'), set('Landorus', 'Sand Force'),
				set('Miraidon', 'Hadron Engine'), set('Kyurem-Black', 'Teravolt'),
				set('Pikachu', 'Static', ['protect'], { item: 'Heavy-Duty Boots' }),
				set('Pikachu', 'Static', ['protect'], { item: 'Booster Energy' }),
				set('Smeargle', 'Moody'), set('Abra', 'Magic Guard'),
			]) {
				assert(validate(pokemon, formatid), `${pokemon.species}: ${pokemon.ability}, ${pokemon.item}`);
			}
		});
	}

	for (const [species, banned, allowed] of [
		['Dugtrio', 'Arena Trap', 'Sand Veil'],
		['Blaziken', 'Speed Boost', 'Blaze'],
		['Gallade', 'Sharpness', 'Steadfast'],
	]) {
		it(`should ban only the forbidden ability combination for ${species}`, () => {
			assert(validate(set(species, banned))?.some(problem => problem.includes('combination')));
			assert.equal(validate(set(species, allowed)), null);
		});
	}

	it('should ban Hydreigon with Draco Meteor but permit Dragon Pulse and Garchomp with Swords Dance', () => {
		assert(validate(set('Hydreigon', 'Levitate', ['dracometeor']))?.some(p => p.includes('combination')));
		assert.equal(validate(set('Hydreigon', 'Levitate', ['dragonpulse'])), null);
		assert.equal(validate(set('Garchomp', 'Rough Skin', ['swordsdance'])), null);
	});

	it('should allow released hidden and backported abilities and items', () => {
		for (const pokemon of [
			set('Weezing', 'Neutralizing Gas', ['sludgebomb'], { item: 'Assault Vest' }),
			set('Empoleon', 'Competitive', ['scald']),
			set('Shiftry', 'Wind Rider', ['leafblade']),
			set('Beartic', 'Slush Rush', ['iciclecrash']),
			set('Pelipper', 'Drizzle', ['hurricane']),
			set('Pikachu', 'Lightning Rod', ['thunderbolt']),
		]) assert.equal(validate(pokemon), null, pokemon.species);
		for (const item of ['Clear Amulet', 'Covert Cloak', 'Loaded Dice', 'Safety Goggles', 'Eject Pack',
			'Weakness Policy', 'Room Service', 'Snowball', 'Luminous Moss', 'Throat Spray', 'Punching Glove']) {
			assert.equal(validate(set('Pikachu', 'Static', ['thunderbolt'], { item })), null, item);
		}
	});

	it('should use MMO tutor move pools instead of cartridge transfer restrictions', () => {
		for (const pokemon of [
			set('Golem', 'Sturdy', ['rapidspin']), set('Blissey', 'Natural Cure', ['wish']),
			set('Nidoking', 'Sheer Force', ['lovelykiss', 'morningsun']),
			set('Magnezone', 'Magnet Pull', ['agility']),
			set('Weavile', 'Pressure', ['moonlight']), set('Politoed', 'Drizzle', ['lovelykiss']),
			set('Gastrodon-East', 'Storm Drain', ['scald']),
		]) assert.equal(validate(pokemon), null, pokemon.species);
		assert(validate(set('Pikachu', 'Static', ['spore']))?.some(p => p.includes("can't learn")));
		assert.equal(validate(set('Smeargle', 'Own Tempo', ['spore', 'batonpass'])), null);
		assert(validate(set('Smeargle', 'Own Tempo', ['darkvoid'])));
	});

	it('should reject duplicate species, duplicate moves, OHKO, evasion moves and excessive EVs', () => {
		const pikachu = set('Pikachu', 'Static', ['thunderbolt']);
		assert(new TeamValidator(formats[0]).validateTeam([pikachu, { ...pikachu }]));
		assert(validate(set('Pikachu', 'Static', ['thunderbolt', 'thunderbolt']))?.some(p => p.includes('duplicate')));
		assert(validate(set('Pikachu', 'Static', ['hiddenpowerice', 'hiddenpowerfire']))?.some(p => p.includes('duplicate')));
		assert(validate(set('Pikachu', 'Static', ['doubleteam']))?.some(p => p.includes('Evasion')));
		assert(validate(set('Lapras', 'Water Absorb', ['sheercold']))?.some(p => p.includes('OHKO')));
		assert(validate(set('Pikachu', 'Static', ['thunderbolt'], { evs: { hp: 252, atk: 252, spe: 252 } })));
	});

	it('should preserve IVs while allowing a chosen Hidden Power type only in MMO tiers', () => {
		const ivs = { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 };
		const pokemon = set('Pikachu', 'Static', ['hiddenpowerice'], { ivs: { ...ivs } });
		assert.equal(validate(pokemon), null);
		assert.equal(pokemon.hpType, 'Ice');
		assert.deepEqual(pokemon.ivs, ivs);
		battle = common.createBattle({ formatid: formats[0] }, [[pokemon], [set('Snorlax', 'Immunity')]]);
		battle.makeChoices();
		assert.equal(battle.p1.active[0].hpType, 'Ice');
		assert.equal(battle.dex.moves.get('hiddenpower').basePowerCallback.call(battle, battle.p1.active[0]), 60);
		assert(validate(set('Pikachu', 'Static', ['hiddenpower'], { hpType: 'Fairy' })));
		assert(validate(set('Pikachu', 'Static', ['hiddenpowerice'], { ivs: { ...ivs } }), 'gen5ou'));
	});

	it('should reuse Stadium Sleep Clause in MMO tiers and random formats', () => {
		for (const format of [...formats, 'gen5pokemmorandombattle', 'gen5pokemmomultirandombattle',
			'gen5pokemmo', 'gen5pokemmotest', 'gen5pokemmodoubles']) {
			const rules = Dex.formats.getRuleTable(Dex.formats.get(format));
			assert(rules.has('stadiumsleepclause'), format);
			assert(!rules.has('sleepclausemmo'), format);
			assert(!rules.has('sleepclausemod'), format);
		}
	});

	it('should count Rest, allow sleep again after waking or fainting, and allow voluntary Rest', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Smeargle', 'Own Tempo', ['spore'])],
			[set('Snorlax', 'Immunity', ['rest']), set('Pikachu', 'Static')],
		]);
		battle.makeChoices();
		const user = battle.p1.active[0];
		const target = battle.p2.active[0];
		const reserve = battle.p2.pokemon[1];
		const spore = battle.dex.moves.get('spore');
		const rest = battle.dex.moves.get('rest');
		assert(target.trySetStatus('slp', target, rest));
		assert.equal(reserve.trySetStatus('slp', user, spore), false, 'Rest occupies the opposing sleep allowance');
		target.cureStatus();
		assert(reserve.trySetStatus('slp', user, spore), 'Waking frees the allowance');
		assert(target.trySetStatus('slp', target, rest), 'Voluntary Rest remains allowed');
		target.cureStatus();
		assert.equal(target.trySetStatus('slp', user, spore), false);
		reserve.faint();
		assert(target.trySetStatus('slp', user, spore), 'Fainted sleepers do not occupy the allowance');
		assert(user.trySetStatus('slp', target, spore), 'Opposing sides have separate allowances');
	});

	it('should not consume the sleep allowance on an immune target', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Smeargle', 'Own Tempo', ['spore'])], [set('Hypno', 'Insomnia')],
		]);
		battle.makeChoices();
		const user = battle.p1.active[0];
		const target = battle.p2.active[0];
		assert.equal(target.trySetStatus('slp', user, battle.dex.moves.get('spore')), false);
		target.setAbility('innerfocus');
		assert(target.trySetStatus('slp', user, battle.dex.moves.get('spore')));
	});

	it('should apply the MMO move powers, recovery PP and updated species stats', () => {
		const dex = Dex.mod('mmo');
		assert.equal(dex.moves.get('outrage').basePower, 90);
		assert.equal(dex.moves.get('knockoff').basePower, 20);
		assert.equal(dex.moves.get('rapidspin').basePower, 50);
		for (const move of ['recover', 'rest', 'slackoff', 'softboiled', 'roost', 'milkdrink']) {
			assert.equal(dex.moves.get(move).pp, 5, move);
		}
		assert.equal(dex.species.get('pelipper').baseStats.spa, 95);
		assert.equal(dex.species.get('dugtrio').baseStats.atk, 100);
		assert.equal(dex.species.get('clefable').types[0], 'Normal');
	});

	it('should summon finite snow, boost Ice defense and avoid hail chip damage', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Abomasnow', 'Snow Warning')], [set('Snorlax', 'Immunity')],
		]);
		battle.makeChoices();
		assert.equal(battle.field.weather, 'snowscape');
		assert.equal(battle.field.weatherState.duration, 5);
		const snowDefense = battle.p1.active[0].getStat('def');
		battle.makeChoices();
		assert.fullHP(battle.p2.active[0]);
		for (let i = 0; i < 4; i++) battle.makeChoices();
		assert.equal(battle.field.weather, '');
		assert.bounded(snowDefense / battle.p1.active[0].getStat('def'), [1.49, 1.51]);
	});

	it('should deal 1/8 HP residual damage from partial trapping', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Pikachu', 'Static')], [set('Snorlax', 'Immunity')],
		]);
		battle.makeChoices();
		const target = battle.p2.active[0];
		battle.makeChoices();
		target.addVolatile('partiallytrapped', battle.p1.active[0], battle.dex.moves.get('bind'));
		battle.makeChoices();
		assert.equal(target.maxhp - target.hp, Math.floor(target.baseMaxhp / 8));
	});
	it('should accept a legal set for every non-Uber species in the MMO catalogue', () => {
		const { PokeMMOLearnsets } = require('../../../dist/data/mods/mmo/learnsets-data');
		const validator = new TeamValidator(formats[0]);
		const dex = validator.dex;
		let checked = 0;
		for (const [id, tier] of Object.entries(PokeMMOTiers)) {
			if (tier === 'Uber') continue;
			const species = dex.species.get(id);
			const moves = PokeMMOLearnsets[id];
			const move = moves.find(id => !validator.ruleTable.isBanned(`move:${id}`));
			assert(move, id);
			assert.equal(validate(set(species.name, species.abilities[0], [move])), null, id);
			checked++;
		}
		assert.equal(checked, 631);
	});

	it('should double Slush Rush speed in snow and restore it when snow ends', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Beartic', 'Slush Rush')], [set('Snorlax', 'Immunity')],
		]);
		battle.makeChoices();
		const pokemon = battle.p1.active[0];
		const speed = pokemon.getStat('spe');
		battle.field.setWeather('snowscape', pokemon);
		assert.equal(pokemon.getStat('spe'), speed * 2);
		battle.field.clearWeather();
		assert.equal(pokemon.getStat('spe'), speed);
	});

	it('should activate Competitive and suppress it under Neutralizing Gas', () => {
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Empoleon', 'Competitive')], [set('Weezing', 'Neutralizing Gas')],
		]);
		battle.makeChoices();
		const pokemon = battle.p1.active[0];
		const foe = battle.p2.active[0];
		battle.boost({ def: -1 }, pokemon, foe, battle.dex.moves.get('leer'));
		assert.equal(pokemon.boosts.spa, 0);
		foe.setAbility('levitate');
		battle.boost({ def: -1 }, pokemon, foe, battle.dex.moves.get('leer'));
		assert.equal(pokemon.boosts.spa, 2);
	});

	it('should use Loaded Dice to hit at least four times', () => {
		battle = common.createBattle({ formatid: formats[0], forceRandomChance: true }, [
			[set('Pikachu', 'Static', ['pinmissile'], { item: 'Loaded Dice' })],
			[set('Steelix', 'Sturdy', ['splash'])],
		]);
		battle.makeChoices();
		battle.makeChoices();
		assert(battle.log.some(line => /\|-hitcount\|.*\|[45]$/.test(line)));
	});

	it('should preserve current sleepers across serialization without a lifetime sleep limit', () => {
		const { Battle } = require('../../../dist/sim');
		battle = common.createBattle({ formatid: formats[0] }, [
			[set('Smeargle', 'Own Tempo', ['spore'])], [set('Snorlax', 'Immunity'), set('Pikachu', 'Static')],
		]);
		battle.makeChoices();
		assert(battle.p2.active[0].trySetStatus('slp', battle.p1.active[0], battle.dex.moves.get('spore')));
		const serialized = battle.toJSON();
		battle.destroy();
		battle = Battle.fromJSON(serialized);
		assert.equal(battle.p2.pokemon[1].trySetStatus('slp', battle.p1.active[0], battle.dex.moves.get('spore')), false);
		battle.p2.active[0].cureStatus();
		assert(battle.p2.pokemon[1].trySetStatus('slp', battle.p1.active[0], battle.dex.moves.get('spore')));
	});
});
