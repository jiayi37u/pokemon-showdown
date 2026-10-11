'use strict';

const assert = require('../../assert');
const common = require('../../common');
const { TeamValidator } = require('../../../dist/sim');

let battle;

describe('PokeMMO', () => {
	afterEach(() => {
		battle?.destroy();
		battle = null;
	});

	for (const [formatid, level, slots] of [
		['gen5pokemmo', 100, 1],
		['gen5pokemmotest', 50, 1],
		['gen5pokemmodoubles', 50, 2],
	]) {
		it(`should validate teams and finish a battle in ${formatid}`, () => {
			const team = [
				{ species: 'Pikachu', ability: 'Static', moves: ['thunderbolt'], level: 100 },
				{ species: 'Snorlax', ability: 'Immunity', moves: ['tackle'], level: 100 },
			];
			assert.equal(new TeamValidator(formatid).validateTeam(team), null);
			battle = common.createBattle({ formatid }, [team, team]);
			assert.equal(battle.requestState, 'teampreview');
			battle.makeChoices();
			assert.equal(battle.dex.currentMod, 'mmo');
			assert.equal(battle.dex.gen, 5);
			assert.equal(battle.gen, 8);
			assert.equal(battle.p1.active.length, slots);
			assert.equal(battle.p1.active[0].level, level);
			for (let i = 0; i < 100 && !battle.ended; i++) battle.makeChoices();
			assert(battle.ended);
		});
	}

	it('should reject duplicate species and unavailable Pokemon in the Test format', () => {
		const validator = new TeamValidator('gen5pokemmotest');
		const pikachu = { species: 'Pikachu', ability: 'Static', moves: ['thunderbolt'] };
		assert(validator.validateTeam([{ ...pikachu }, { ...pikachu }])?.some(problem => problem.includes('Species Clause')));
		assert(validator.validateTeam([{ species: 'Miraidon', ability: 'Hadron Engine', moves: ['tackle'] }]));
	});

	it('should apply Adaptability through the current STAB event', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: false }, [[
			{ species: 'Porygon-Z', ability: 'Adaptability', moves: ['tackle'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.randomizer = damage => damage;
		const source = battle.p1.active[0];
		const target = battle.p2.active[0];
		const boosted = battle.actions.getDamage(source, target, 'tackle');
		source.setAbility('runaway');
		const normal = battle.actions.getDamage(source, target, 'tackle');
		assert.bounded(boosted, [normal * 4 / 3 - 2, normal * 4 / 3 + 2]);
	});

	it('should use 1.5x critical damage and handle numeric base power without server globals', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: false }, [[
			{ species: 'Snorlax', ability: 'Immunity', moves: ['tackle'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.randomizer = damage => damage;
		const source = battle.p1.active[0];
		const target = battle.p2.active[0];
		const move = battle.dex.getActiveMove('tackle');
		move.willCrit = false;
		const normal = battle.actions.getDamage(source, target, move);
		move.willCrit = true;
		const critical = battle.actions.getDamage(source, target, move);
		assert.bounded(critical, [normal * 1.5 - 2, normal * 1.5 + 2]);
		assert(battle.actions.getDamage(source, target, 40) > 0);
	});

	it('should apply 1/16 burn damage and halve speed for paralysis', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: false }, [[
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		const burned = battle.p1.active[0];
		const paralyzed = battle.p2.active[0];
		const speed = paralyzed.getStat('spe');
		burned.setStatus('brn');
		paralyzed.setStatus('par');
		assert.equal(paralyzed.getStat('spe'), Math.floor(speed / 2));
		battle.makeChoices();
		assert.equal(burned.maxhp - burned.hp, Math.floor(burned.maxhp / 16));
	});

	it('should expire Drizzle rain after five turns', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo' }, [[
			{ species: 'Politoed', ability: 'Drizzle', moves: ['splash'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		for (let i = 0; i < 4; i++) battle.makeChoices();
		assert.equal(battle.field.weather, 'raindance');
		battle.makeChoices();
		assert.equal(battle.field.weather, '');
	});

	it('should block Intimidate with Inner Focus', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo' }, [[
			{ species: 'Dragonite', ability: 'Inner Focus', moves: ['splash'] },
		], [
			{ species: 'Gyarados', ability: 'Intimidate', moves: ['splash'] },
		]]);
		battle.makeChoices();
		assert.statStage(battle.p1.active[0], 'atk', 0);
	});

	it('should remove hazards and boost speed with Rapid Spin', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: true }, [[
			{ species: 'Starmie', ability: 'Natural Cure', moves: ['rapidspin'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.p1.addSideCondition('stealthrock', battle.p2.active[0]);
		battle.makeChoices();
		assert(!battle.p1.sideConditions['stealthrock']);
		assert.statStage(battle.p1.active[0], 'spe', 1);
	});
	it('should resolve Future Sight after the user switches out', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: true }, [[
			{ species: 'Alakazam', ability: 'Synchronize', moves: ['futuresight'] },
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		], [
			{ species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.makeChoices();
		battle.makeChoices('switch 2', 'move splash');
		assert.fullHP(battle.p2.active[0]);
		battle.makeChoices();
		assert(battle.p2.active[0].hp < battle.p2.active[0].maxhp);
	});
	it('should preserve the Metronome exclusion list when calling a move', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: true }, [[
			{ species: 'Clefable', ability: 'Magic Guard', moves: ['metronome'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		let called = false;
		battle.sample = moves => {
			assert(!moves.some(move => ['protect', 'metronome', 'chatter'].includes(move.id)));
			const thunderbolt = moves.find(move => move.id === 'thunderbolt');
			assert(thunderbolt);
			called = true;
			return thunderbolt;
		};
		battle.makeChoices();
		assert(called);
		assert(battle.p2.active[0].hp < battle.p2.active[0].maxhp);
	});

	it('should direct Nature Power at the selected opponent in doubles', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmodoubles', forceRandomChance: true }, [[
			{ species: 'Ludicolo', ability: 'Swift Swim', moves: ['naturepower'] },
			{ species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
			{ species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.makeChoices('move naturepower 2, move splash', 'move splash, move splash');
		assert.fullHP(battle.p2.active[0]);
		assert(battle.p2.active[1].hp < battle.p2.active[1].maxhp);
	});

	it('should initialize both ability states after Skill Swap', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo' }, [[
			{ species: 'Alakazam', ability: 'Synchronize', moves: ['skillswap'] },
		], [
			{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.makeChoices();
		assert.equal(battle.p1.active[0].ability, 'immunity');
		assert.equal(battle.p2.active[0].ability, 'synchronize');
		for (const pokemon of [battle.p1.active[0], battle.p2.active[0]]) {
			assert.equal(typeof pokemon.abilityState.effectOrder, 'number');
		}
	});

	it('should apply recoil when a move damages a Substitute', () => {
		battle = common.createBattle({ formatid: 'gen5pokemmo', forceRandomChance: true }, [[
			{ species: 'Snorlax', ability: 'Immunity', moves: ['doubleedge'] },
		], [
			{ species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] },
		]]);
		battle.makeChoices();
		battle.p2.active[0].addVolatile('substitute', battle.p2.active[0]);
		battle.makeChoices();
		assert(battle.p1.active[0].hp < battle.p1.active[0].maxhp);
	});
});
