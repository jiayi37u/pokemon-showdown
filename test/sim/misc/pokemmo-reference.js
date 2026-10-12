'use strict';

const assert = require('../../assert');
const common = require('../../common');
const { Dex, TeamValidator } = require('../../../dist/sim');

let battle;
function mon(species = 'Snorlax', ability = 'Thick Fat', moves = ['splash'], item = '') {
	return { species, ability, moves, item, level: 50 };
}
function start(p1, p2, doubles = false) {
	battle = common.createBattle({ formatid: doubles ? 'gen5pokemmodoubles' : 'gen5pokemmo' }, [p1, p2]);
	// Hit at 100% accuracy, never crit, and trigger only guaranteed secondary effects.
	battle.randomChance = (n, d) => n >= d;
	battle.randomizer = damage => damage;
	battle.makeChoices();
	return [battle.p1.active[0], battle.p2.active[0]];
}
function damage(source, target, id) {
	const move = battle.dex.getActiveMove(id);
	move.willCrit = false;
	return battle.actions.getDamage(source, target, move);
}

describe('PokeMMO mechanics reference', () => {
	afterEach(() => {
		battle?.destroy();
		battle = null;
	});

	it('should use the documented powers, accuracy, priority and fully boosted recovery PP', () => {
		const powers = {
			knockoff: 20, outrage: 90, suckerpunch: 70, hiddenpower: 60, lusterpurge: 95, mistball: 95,
			thunderbolt: 90, icebeam: 90, flamethrower: 90, surf: 90, fireblast: 110, thunder: 110,
			blizzard: 110, hydropump: 110, hurricane: 110, overheat: 130, dracometeor: 130, leafstorm: 130,
			rapidspin: 50, leechlife: 80, futuresight: 120, energyball: 90, aurasphere: 80, dragonpulse: 85,
			heatwave: 95, crabhammer: 100, meteormash: 90, hex: 65, magmastorm: 100, skullbash: 130,
			synchronoise: 120, technoblast: 120, pinmissile: 25, muddywater: 90,
			firepledge: 80, grasspledge: 80, waterpledge: 80,
		};
		const dex = Dex.mod('mmo');
		for (const [move, power] of Object.entries(powers)) assert.equal(dex.moves.get(move).basePower, power, move);
		assert.equal(dex.moves.get('darkvoid').accuracy, 50);
		for (const move of ['followme', 'ragepowder']) assert.equal(dex.moves.get(move).priority, 2, move);
		const [user] = start([mon('Smeargle', 'Own Tempo', ['recover', 'rest', 'roost', 'slackoff'])], [mon()]);
		for (const slot of user.moveSlots) assert.equal(slot.maxpp, 8, slot.id);
		for (const move of ['softboiled', 'milkdrink']) assert.equal(dex.moves.get(move).pp * 8 / 5, 8);
	});

	it('should retain the 17-type chart and Steel resistance to Ghost and Dark', () => {
		const dex = Dex.mod('mmo');
		assert.equal(dex.types.all().filter(type => !type.isNonstandard).length, 17);
		assert.equal(dex.types.get('Fairy').isNonstandard, 'Future');
		assert.equal(dex.getEffectiveness('Dark', 'Steel'), -1);
		assert.equal(dex.getEffectiveness('Ghost', 'Steel'), -1);
		for (const species of ['Clefable', 'Wigglytuff', 'Azumarill', 'Gardevoir']) {
			assert(!dex.species.get(species).types.includes('Fairy'));
		}
	});

	for (const [species, ability, weather, rock] of [
		['Pelipper', 'Drizzle', 'raindance', 'Damp Rock'],
		['Torkoal', 'Drought', 'sunnyday', 'Heat Rock'],
		['Hippowdon', 'Sand Stream', 'sandstorm', 'Smooth Rock'],
		['Abomasnow', 'Snow Warning', 'snowscape', 'Icy Rock'],
	]) {
		for (const extended of [false, true]) {
			it(`should expire ${ability} after ${extended ? 8 : 5} turns`, () => {
				start([mon(species, ability, ['splash'], extended ? rock : '')], [mon()]);
				const duration = extended ? 8 : 5;
				assert.equal(battle.field.weatherState.duration, duration);
				for (let turn = 0; turn < duration - 1; turn++) battle.makeChoices();
				assert.equal(battle.field.weather, weather);
				battle.makeChoices();
				assert.equal(battle.field.weather, '');
			});
		}
	}

	it('should pivot out with Teleport after the opponent moves', () => {
		const [user] = start([mon('Alakazam', 'Synchronize', ['teleport']), mon()], [mon('Snorlax', 'Thick Fat', ['tackle'])]);
		battle.makeChoices();
		assert(user.hp < user.maxhp);
		assert.equal(battle.requestState, 'switch');
		battle.makeChoices('switch 2', '');
		assert.equal(battle.p1.active[0].species.name, 'Snorlax');
	});

	it('should sleep for 1-3 missed turns and preserve the countdown when switching', () => {
		const [user, target] = start([mon()], [mon(), mon('Blissey', 'Serene Grace')]);
		const random = battle.random.bind(battle);
		let sawDuration = false;
		battle.random = (min, max) => {
			if (min === 2 && max === 5) { sawDuration = true; return 4; }
			return random(min, max);
		};
		target.trySetStatus('slp', user, battle.dex.moves.get('hypnosis'));
		assert(sawDuration);
		battle.makeChoices();
		const remaining = target.statusState.time;
		battle.makeChoices('move splash', 'switch 2');
		battle.makeChoices('move splash', 'switch 2');
		assert.equal(target.statusState.time, remaining);
		battle.makeChoices();
		assert.equal(target.status, 'slp');
		battle.makeChoices();
		assert.equal(target.status, 'slp');
		battle.makeChoices();
		assert.equal(target.status, '');
	});

	it('should block opposing Prankster status moves on Dark types', () => {
		start([mon('Sableye', 'Prankster', ['glare'])], [mon('Umbreon', 'Synchronize'), mon()]);
		battle.makeChoices();
		assert.equal(battle.p2.active[0].status, '');
		battle.makeChoices('move glare', 'switch 2');
		assert.equal(battle.p2.active[0].status, 'par');
	});

	for (const ability of ['Inner Focus', 'Own Tempo', 'Oblivious', 'Scrappy']) {
		it(`should block Intimidate with ${ability}`, () => {
			const [user] = start([mon('Snorlax', ability)], [mon('Gyarados', 'Intimidate')]);
			assert.statStage(user, 'atk', 0);
		});
	}
	for (const move of ['taunt', 'attract', 'captivate']) {
		it(`should block ${move} with Oblivious`, () => {
			const [user] = start([{ ...mon('Snorlax', 'Oblivious'), gender: 'F' }],
				[{ ...mon('Gyarados', 'Intimidate', [move]), gender: 'M' }]);
			battle.makeChoices();
			assert(!user.volatiles.taunt);
			assert(!user.volatiles.attract);
			assert.statStage(user, 'spa', 0);
		});
	}

	it('should make Toxic always hit for Poison users despite evasion', () => {
		const [user, target] = start([mon('Weezing', 'Levitate', ['toxic'])], [mon()]);
		battle.randomChance = () => false;
		target.boosts.evasion = 6;
		battle.makeChoices();
		assert.equal(target.status, 'tox');
		target.cureStatus();
		user.setType('Normal');
		battle.makeChoices();
		assert.equal(target.status, '');
	});

	it('should double Facade power when burned without halving its damage', () => {
		const [user, target] = start([mon('Snorlax', 'Thick Fat', ['facade'])], [mon()]);
		const healthy = damage(user, target, 'facade');
		user.setStatus('brn');
		assert.bounded(damage(user, target, 'facade'), [healthy * 2 - 3, healthy * 2 + 3]);
	});

	for (const [species, ability] of [['Ferrothorn', 'Iron Barbs'], ['Garchomp', 'Rough Skin']]) {
		it(`should suppress ${ability} only for Mold Breaker attacks`, () => {
			const [user] = start([mon('Excadrill', 'Mold Breaker', ['tackle'])], [mon(species, ability)]);
			battle.makeChoices();
			assert.fullHP(user);
			user.setAbility('sandforce');
			battle.makeChoices();
			assert.equal(user.maxhp - user.hp, Math.floor(user.maxhp / 8));
		});
	}

	for (const [species, ability, item, immune] of [
		['Blastoise', 'Torrent', '', false], ['Venusaur', 'Overgrow', '', true],
		['Reuniclus', 'Overcoat', '', true], ['Blastoise', 'Torrent', 'Safety Goggles', true],
	]) {
		it(`should apply Rage Powder redirection with ${species}/${ability}/${item || 'no item'}`, () => {
			start([mon('Amoonguss', 'Effect Spore', ['ragepowder']), mon()],
				[mon(species, ability, ['watergun'], item), mon()], true);
			battle.makeChoices('move ragepowder, move splash', 'move watergun 2, move splash');
			const powder = battle.p1.active[0], ally = battle.p1.active[1];
			assert.equal(powder.hp < powder.maxhp, !immune);
			assert.equal(ally.hp < ally.maxhp, immune);
		});
	}

	it('should let Ghost Pokemon switch out of Mean Look', () => {
		start([mon('Umbreon', 'Synchronize', ['meanlook'])], [mon('Gengar', 'Cursed Body'), mon()]);
		battle.makeChoices();
		assert(!battle.p2.active[0].trapped);
		battle.makeChoices('move meanlook', 'switch 2');
		assert.equal(battle.p2.active[0].species.name, 'Snorlax');
		assert(battle.p2.active[0].trapped);
	});

	for (const [screen, move] of [['reflect', 'tackle'], ['lightscreen', 'watergun']]) {
		for (const doubles of [false, true]) {
			it(`should apply ${screen} at ${doubles ? '2/3' : '1/2'} damage in ${doubles ? 'doubles' : 'singles'}`, () => {
				const team = [mon()];
				if (doubles) team.push(mon('Blissey', 'Serene Grace'));
				const [user, target] = start(team, team, doubles);
				const normal = damage(user, target, move);
				target.side.addSideCondition(screen, target);
				const ratio = doubles ? 2 / 3 : 1 / 2;
				assert.bounded(damage(user, target, move), [normal * ratio - 1, normal * ratio + 1]);
			});
		}
	}

	it('should remove items with Knock Off without increasing its damage', () => {
		const [user, target] = start([mon('Snorlax', 'Thick Fat', ['knockoff'])], [mon('Snorlax', 'Thick Fat', ['splash'], 'Leftovers')]);
		const held = damage(user, target, 'knockoff');
		target.clearItem();
		assert.equal(damage(user, target, 'knockoff'), held);
		target.setItem('leftovers');
		battle.makeChoices();
		assert.equal(target.item, '');
	});

	for (const move of ['aerialace', 'leafblade', 'nightslash', 'psychocut', 'sacredsword', 'xscissor']) {
		it(`should boost ${move} by 1.5x with Sharpness`, () => {
			const [user, target] = start([mon('Gallade', 'Sharpness')], [mon()]);
			const boosted = damage(user, target, move);
			user.setAbility('steadfast');
			const normal = damage(user, target, move);
			assert.bounded(boosted, [normal * 1.5 - 3, normal * 1.5 + 3]);
		});
	}

	it('should activate Wind Rider in Tailwind and block wind attacks', () => {
		const [user] = start([mon('Shiftry', 'Wind Rider', ['tailwind'])], [mon('Pidgeot', 'Keen Eye', ['gust'])]);
		battle.makeChoices();
		assert.fullHP(user);
		assert.statStage(user, 'atk', 2);
	});

	for (const [species, ability, weather] of [['Pelipper', 'Drizzle', 'raindance'], ['Gyarados', 'Intimidate', '']]) {
		it(`should restart ${ability} after Neutralizing Gas leaves`, () => {
			const [user] = start([mon('Weezing', 'Neutralizing Gas'), mon(), mon('Blissey', 'Serene Grace')],
				[mon(species, ability), mon('Magikarp', 'Swift Swim')], true);
			assert.equal(battle.field.weather, '');
			assert.statStage(user, 'atk', 0);
			battle.makeChoices('switch 3, move splash', 'move splash, move splash');
			if (weather) {
				assert.equal(battle.field.weather, weather);
				assert(battle.log.some(line => line.includes('[from] ability: Drizzle')));
			} else {
				assert.statStage(battle.p1.active[1], 'atk', -1);
				assert(battle.log.some(line => line.includes('|-ability|') && line.includes('Intimidate')));
			}
		});
	}

	it('should apply Assault Vest defense and prevent status move selection', () => {
		const [user] = start([mon('Snorlax', 'Thick Fat', ['tackle', 'protect'], 'Assault Vest')], [mon()]);
		const boosted = user.getStat('spd');
		assert(battle.p1.activeRequest.active[0].moves.find(m => m.id === 'protect').disabled);
		user.clearItem();
		assert.bounded(boosted / user.getStat('spd'), [1.49, 1.51]);
	});
	it('should block only opposing stat drops with Clear Amulet', () => {
		const [user, foe] = start([mon('Snorlax', 'Thick Fat', ['splash'], 'Clear Amulet')], [mon()]);
		battle.boost({ def: -1 }, user, foe, battle.dex.moves.get('leer'));
		assert.statStage(user, 'def', 0);
		battle.boost({ def: -1 }, user, user, battle.dex.moves.get('closecombat'));
		assert.statStage(user, 'def', -1);
	});
	it('should block secondary effects with Covert Cloak', () => {
		const [, target] = start([mon('Pikachu', 'Static', ['thunderbolt'])], [mon('Snorlax', 'Thick Fat', ['splash'], 'Covert Cloak')]);
		const random = battle.random.bind(battle);
		battle.random = (min, max) => min === 100 && max === undefined ? 0 : random(min, max);
		battle.makeChoices();
		assert.equal(target.status, '');
		target.clearItem();
		battle.makeChoices();
		assert.equal(target.status, 'par');
	});

	for (const [item, species, move, stat, stages] of [
		['Weakness Policy', 'Dragonite', 'icebeam', 'atk', 2],
		['Snowball', 'Snorlax', 'icebeam', 'atk', 1],
		['Luminous Moss', 'Snorlax', 'watergun', 'spd', 1],
	]) {
		it(`should consume and activate ${item} on the appropriate hit`, () => {
			const [, target] = start([mon('Magikarp', 'Swift Swim', [move])], [mon(species, 'Inner Focus', ['splash'], item)]);
			battle.makeChoices();
			assert.statStage(target, stat, stages);
			if (item === 'Weakness Policy') assert.statStage(target, 'spa', 2);
			assert.equal(target.item, '');
		});
	}
	it('should block entry hazard damage with Heavy-Duty Boots', () => {
		start([mon(), mon('Charizard', 'Blaze', ['splash'], 'Heavy-Duty Boots')], [mon()]);
		battle.p1.addSideCondition('stealthrock', battle.p2.active[0]);
		battle.makeChoices('switch 2', 'move splash');
		assert.fullHP(battle.p1.active[0]);
	});
	it('should consume Room Service and lower Speed in Trick Room', () => {
		const [user] = start([mon('Reuniclus', 'Magic Guard', ['trickroom'], 'Room Service')], [mon()]);
		battle.makeChoices();
		assert.statStage(user, 'spe', -1);
		assert.equal(user.item, '');
	});
	it('should block powder and weather damage with Safety Goggles', () => {
		const [user, foe] = start([mon('Snorlax', 'Thick Fat', ['splash'], 'Safety Goggles')], [mon('Amoonguss', 'Effect Spore', ['spore'])]);
		battle.field.setWeather('sandstorm', foe);
		battle.makeChoices();
		assert.equal(user.status, '');
		assert.fullHP(user);
	});
	it('should boost punches by 1.1x and remove contact with Punching Glove', () => {
		const [user, target] = start([mon('Snorlax', 'Thick Fat', ['thunderpunch'], 'Punching Glove')], [mon('Ferrothorn', 'Iron Barbs')]);
		const boosted = damage(user, target, 'thunderpunch');
		user.clearItem();
		const normal = damage(user, target, 'thunderpunch');
		assert.bounded(boosted, [normal * 1.1 - 2, normal * 1.1 + 2]);
		user.setItem('punchingglove');
		battle.makeChoices();
		assert.fullHP(user);
	});
	it('should switch out after a stat drop with Eject Pack', () => {
		start([mon('Snorlax', 'Thick Fat', ['splash'], 'Eject Pack'), mon('Blissey', 'Serene Grace')], [mon('Pikachu', 'Static', ['growl'])]);
		battle.makeChoices();
		assert.equal(battle.requestState, 'switch');
		assert.equal(battle.p1.active[0].item, '');
		battle.makeChoices('switch 2', '');
		assert.equal(battle.p1.active[0].species.name, 'Blissey');
	});
	it('should consume Throat Spray and boost SpA after a sound move', () => {
		const [user] = start([mon('Exploud', 'Soundproof', ['hypervoice'], 'Throat Spray')], [mon()]);
		battle.makeChoices();
		assert.statStage(user, 'spa', 1);
		assert.equal(user.item, '');
	});

	for (const species of ['Latios', 'Latias', 'Alakazam']) {
		it(`should apply only the documented Soul Dew bonuses to ${species}`, () => {
			const [user, target] = start([mon(species, 'Levitate', ['psychic'], 'Soul Dew')], [mon()]);
			const spa = user.getStat('spa'), spd = user.getStat('spd');
			const boosted = ['psychic', 'dragonpulse', 'thunderbolt'].map(move => damage(user, target, move));
			user.clearItem();
			assert.equal(user.getStat('spa'), spa);
			assert.equal(user.getStat('spd'), spd);
			for (const [index, move] of ['psychic', 'dragonpulse', 'thunderbolt'].entries()) {
				const normal = damage(user, target, move);
				const ratio = species !== 'Alakazam' && move !== 'thunderbolt' ? 1.2 : 1;
				assert.bounded(boosted[index], [normal * ratio - 2, normal * ratio + 2]);
			}
		});
	}
	it('should give a one-use 1.5x Normal Gem boost and keep all 17 type gems available', () => {
		const dex = Dex.mod('mmo');
		for (const type of dex.types.all().filter(type => !type.isNonstandard)) assert.equal(dex.items.get(`${type.name} Gem`).isNonstandard, null);
		const [user, target] = start([mon('Snorlax', 'Thick Fat', ['tackle'], 'Normal Gem')], [mon()]);
		battle.makeChoices();
		const boosted = target.maxhp - target.hp;
		assert.equal(user.item, '');
		const before = target.hp;
		battle.makeChoices();
		const normal = before - target.hp;
		assert.bounded(boosted, [normal * 1.5 - 3, normal * 1.5 + 3]);
	});

	it('should apply all 55 documented modern base-stat updates', () => {
		const species = `Butterfree Beedrill Pidgeot Pikachu Raichu Nidoqueen Nidoking Clefable Wigglytuff Vileplume
			Poliwrath Alakazam Victreebel Golem Ampharos Bellossom Azumarill Jumpluff Beautifly Exploud Staraptor Roserade
			Stoutland Unfezant Gigalith Seismitoad Leavanny Scolipede Krookodile Cresselia Arbok Dugtrio Farfetchd Dodrio
			Electrode Exeggutor Noctowl Ariados Qwilfish Magcargo Corsola Mantine Swellow Pelipper Masquerain Delcatty
			Volbeat Illumise Lunatone Solrock Chimecho Woobat Crustle Beartic Cryogonal`.split(/\s+/);
		assert.equal(species.length, 55);
		for (const name of species) {
			// This fork separately customizes Gen 9 Exploud; MMO uses its cartridge stats.
			const expected = name === 'Exploud' ? { hp: 104, atk: 91, def: 63, spa: 91, spd: 73, spe: 68 } :
				Dex.species.get(name).baseStats;
			assert.deepEqual(Dex.mod('mmo').species.get(name).baseStats, expected, name);
		}
	});

	for (const [family, moves] of [
		['Geodude Graveler Golem', ['rapidspin']], ['Nidoran-F Nidorina Nidoqueen', ['moonlight']],
		['Sneasel Weavile', ['moonlight']], ['Nidoran-M Nidorino Nidoking', ['morningsun', 'lovelykiss']],
		['Zapdos Moltres Articuno', ['extrasensory']], ['Magnemite Magneton Magnezone', ['agility']],
		['Happiny Chansey Blissey', ['wish']], ['Jirachi', ['followme']], ['Poliwag Poliwhirl Politoed', ['lovelykiss']],
		['Bellsprout Weepinbell Victreebel', ['lovelykiss']],
		['Magby Magmar Magmortar', ['followme']], ['Elekid Electabuzz Electivire', ['followme']],
	]) {
		it(`should permit the documented special tutors for ${family}`, () => {
			const validator = new TeamValidator('gen5pokemmoou');
			for (const name of family.split(' ')) {
				const species = validator.dex.species.get(name);
				const set = { ...mon(name, species.abilities[0], moves), evs: { hp: 4, spa: 252, spe: 252 } };
				assert.equal(validator.validateTeam([set]), null, name);
			}
		});
	}
	it('should choose all 16 Hidden Power types without changing IVs in the singles tiers', () => {
		const validator = new TeamValidator('gen5pokemmoou');
		const types = validator.dex.types.all().filter(type => !type.isNonstandard && type.name !== 'Normal');
		assert.equal(types.length, 16);
		for (const type of types) {
			const ivs = { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 };
			const set = { ...mon('Pikachu', 'Static', [`Hidden Power ${type.name}`]), ivs: { ...ivs }, evs: { spa: 252, spe: 252 } };
			assert.equal(validator.validateTeam([set]), null, type.name);
			assert.equal(set.hpType, type.name);
			assert.deepEqual(set.ivs, ivs);
		}
	});

	it('should keep the MMO overrides out of the Gen 5 and Gen 9 formats', () => {
		assert.equal(Dex.mod('gen5').moves.get('darkvoid').accuracy, 80);
		assert.equal(Dex.mod('gen5').getImmunity('powder', 'Grass'), true);
		assert.equal(Dex.mod('gen5').abilities.get('overcoat').onImmunity.call({}, 'powder'), undefined);
		assert(Dex.mod('gen5').items.get('souldew').onModifySpA);
		assert.equal(Dex.mod('gen9').abilities.get('ironbarbs').flags.breakable, undefined);
		assert.equal(Dex.mod('gen9').abilities.get('roughskin').flags.breakable, undefined);
	});
});
