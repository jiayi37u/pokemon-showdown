'use strict';

const assert = require('assert').strict;
const { Battle, Dex, PRNG } = require('../../../dist/sim');
const { NPCMultiManager } = require('../../../dist/server/npc/ai/multi-manager');
const { buildAIMove } = require('../../../dist/server/npc/ai/cfru/state-builder');

const lanturn = { species: 'Lanturn', ability: 'Volt Absorb', moves: ['splash'] };
// Electric immunity without preset attacks keeps these cases focused on switch targeting.
const vibrava = { species: 'Vibrava', ability: 'Levitate', item: 'Eviolite', nature: 'Calm',
	evs: { hp: 252, spd: 252 }, moves: ['splash'] };
const porygon = { species: 'Porygon-Z', ability: 'Adaptability', item: 'Choice Scarf', moves: ['icebeam', 'thunderbolt'] };
const partner = { species: 'Blissey', ability: 'Natural Cure', moves: ['icebeam'] };
const venusaur = { species: 'Venusaur', ability: 'Overgrow', moves: ['energyball'] };
// Keep this reserve below the incoming-damage limit against Lanturn's public preset.
const scizor = { species: 'Scizor', ability: 'Technician', nature: 'Careful',
	evs: { hp: 252, spd: 252, def: 4 }, moves: ['bulletpunch'] };

function createMulti(teams, preview = false, difficulty = 'smart') {
	const battle = new Battle({
		format: { ...Dex.formats.get('gen9customgame'), gameType: 'multi', playerCount: 4 }, seed: [1, 2, 3, 4],
		p1: { name: 'Player1', team: teams[0] }, p2: { name: 'NPC1', team: teams[1] },
		p3: { name: 'Player2', team: teams[2] }, p4: { name: 'NPC2', team: teams[3] },
	});
	const choices = [];
	const room = {
		format: 'gen9nationaldexmulti', turn: 0, p2: { request: null }, p4: { request: null },
		stream: {
			push() {},
			write(line) {
				const [, side, choice] = /^>(p[24]) (.+)$/.exec(line);
				const request = JSON.parse(room[side].request.request);
				if (choice.startsWith('switch ')) {
					const slot = Number(choice.slice(7));
					assert(slot > 1 && slot <= request.side.pokemon.length, line);
					assert.equal(request.side.pokemon[slot - 1].active, false, line);
					assert(!request.side.pokemon[slot - 1].condition.endsWith(' fnt'), line);
				}
				choices.push({ side, choice });
				assert(battle.choose(side, choice), `${line}: ${battle[side].choice.error}`);
			},
		},
	};
	const manager = new NPCMultiManager(room, { difficulty, seed: [1, 2, 3, 4] });
	Object.defineProperty(room.stream, 'battle', { get() { throw new Error('AI must not read the simulator Battle'); } });
	for (const ai of Object.values(manager.controllers || {})) ai.prng = new PRNG([1, 2, 3, 4]);
	let cursor = 0;
	let rqid = 0;
	const published = {};
	const sync = (sides = ['p2', 'p4']) => {
		room.stream.push(battle.log.slice(cursor).join('\n'));
		cursor = battle.log.length;
		room.turn = battle.turn;
		for (const side of sides) {
			const request = battle[side].activeRequest;
			if (published[side] === request) continue;
			published[side] = request;
			room[side].request = { request: JSON.stringify(request), rqid: ++rqid, isWait: request.wait ? 'cantUndo' : false, choice: '' };
		}
	};
	const poll = () => {
		manager.checkSideRequest('p2', room.p2);
		manager.checkSideRequest('p4', room.p4);
		manager.tryMakeDecision();
	};
	const decide = () => {
		sync();
		poll();
		return choices.slice();
	};
	const play = inputs => {
		for (const [i, choice] of inputs.entries()) {
			if (choice) assert(battle.choose(`p${i + 1}`, choice), battle.sides[i].choice.error);
		}
	};
	if (!preview) battle.makeChoices(); // Most cases begin after team preview.
	return { battle, room, manager, choices, sync, poll, decide, play, destroy() { manager.stop(); battle.destroy(); } };
}

let game;
afterEach(() => { game?.destroy(); game = undefined; });

describe('Production NPCMultiManager decisions', () => {
	for (const side of ['p2', 'p4']) for (const move of ['healpulse', 'floralhealing', 'decorate', 'acupressure']) {
		it(`Normal ${side} issues ${move} to an allied field position`, () => {
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			const support = { ...passive, moves: [move] };
			game = createMulti([[passive], [side === 'p2' ? support : passive],
				[passive], [side === 'p4' ? support : passive]], false, 'normal');
			const recipient = game.battle[side === 'p2' ? 'p4' : 'p2'].active[0];
			recipient.hp = Math.floor(recipient.maxhp / 4);
			game.battle.add('-damage', recipient, recipient.getHealth);
			game.battle.makeRequest('move');
			game.decide();
			const choice = game.choices.find(c => c.side === side).choice;
			if (move === 'acupressure') assert(/^move 1 -[12]$/.test(choice), choice);
			else assert.equal(choice, side === 'p2' ? 'move 1 -2' : 'move 1 -1');
			game.play(['move 1', null, 'move 1', null]);
			assert(!game.battle.log.some(line => /^\|-boost\|p[13]/.test(line)));
			if (['healpulse', 'floralhealing'].includes(move)) assert(recipient.hp > recipient.maxhp / 2);
		});
	}

	for (const difficulty of ['normal', 'hard']) {
		for (const side of ['p3', 'p4']) for (const move of ['batonpass', 'shedtail']) {
			it(`${difficulty}: ${side} ${move} shares inherited state with both production controllers`, () => {
				const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
				const source = { species: 'Smeargle', ability: 'Own Tempo',
					moves: ['calmmind', move === 'batonpass' ? 'substitute' : 'splash', move] };
				const recipient = { species: 'Bronzong', ability: 'Levitate', moves: ['splash'] };
				const teams = [[passive], [passive], [passive], [passive]];
				const index = Number(side[1]) - 1;
				teams[index] = [source, recipient];
				game = createMulti(teams, false, difficulty);
				for (const moveSlot of [1, 2, 3]) {
					const choices = ['move 1', 'move 1', 'move 1', 'move 1'];
					choices[index] = `move ${moveSlot}`;
					game.play(choices);
					game.sync();
				}
				const switches = [null, null, null, null];
				switches[index] = 'switch 2';
				game.play(switches);
				game.decide();
				for (const controller of Object.values(game.manager.controllers)) {
					const state = difficulty === 'hard' ? controller.state : controller.battleState;
					const target = (side === 'p4' ? state.self : state.opponent).active.find(p => p.slot === 2);
					assert.equal(target.species, 'Bronzong');
					assert.equal(target.boosts.spa, move === 'batonpass' ? 1 : 0);
					assert(target.volatiles.has('substitute'));
					assert.equal(target.activeMoveActions, 0);
				}
				game.play(['move 1', null, 'move 1', null]);
				assert.equal(game.battle.turn, 5);
			});
		}

		for (const own of [false, true]) {
			it(`${difficulty}: production Multi preserves ${own ? 'p4' : 'p3'} Illusion state on reveal`, () => {
				const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
				const hidden = { name: 'Hidden', species: 'Zoroark', ability: 'Illusion',
					moves: ['nastyplot', 'substitute', 'darkpulse'] };
				const mask = { name: 'Mask', ...passive };
				const user = { species: 'Smeargle', ability: 'Own Tempo', moves: ['splash', 'snarl'] };
				game = createMulti(own ? [[user], [passive], [passive], [hidden, mask]] :
					[[passive], [passive], [hidden, mask], [user]], false, difficulty);
				game.sync();
				game.play(['move 1', 'move 1', 'move 1', 'move 1']);
				game.sync();
				game.play(own ? ['move 2', 'move 1', 'move 1', 'move 2'] : ['move 1', 'move 1', 'move 2', 'move 2']);
				game.decide();
				for (const controller of Object.values(game.manager.controllers)) {
					const state = difficulty === 'hard' ? controller.state : controller.battleState;
					const target = (own ? state.self : state.opponent).active.find(p => p.slot === 2);
					assert.equal(target.species, 'Zoroark');
					assert(target.volatiles.has('substitute'));
					assert.equal(target.boosts.spa, game.battle[own ? 'p4' : 'p3'].active[0].boosts.spa);
					assert.equal(target.activeMoveActions, 1);
				}
				game.play(['move 1', null, own ? 'move 1' : 'move 3 1', null]);
				assert.equal(game.battle.turn, 4);
			});
		}

		for (const onlySupport of [false, true]) {
			it(`${difficulty}: handles p4's ally fainting, onlySupport=${onlySupport}`, () => {
				const passive = { species: 'Mew', ability: 'Synchronize', moves: ['psychic', 'splash'] };
				const fragile = { species: 'Magikarp', level: 1, ability: 'Swift Swim', moves: ['splash'] };
				const support = { species: 'Furret', ability: 'Keen Eye',
					moves: onlySupport ? ['helpinghand'] : ['helpinghand', 'tackle'] };
				game = createMulti([[passive], [fragile], [passive], [support]], false, difficulty);
				game.play(['move 1 1', 'move 1', 'move 2', 'move 1 -1']);
				assert(game.battle.p2.active[0].fainted);
				game.decide();
				const choice = game.choices.find(c => c.side === 'p4').choice;
				if (onlySupport) assert.equal(choice, 'move 1 -1');
				else assert(/^move 2 [12]$/.test(choice), choice);
				game.play(['move 2', null, 'move 2', null]);
				assert.equal(game.battle.turn, 3);
			});
		}

		for (const move of ['shadowforce', 'fly']) {
			it(`${difficulty}: submits a locked charging move without choosing a new target for p4`, () => {
				const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
				const charging = { species: 'Giratina', ability: 'Pressure', moves: [move] };
				game = createMulti([[passive], [passive], [passive], [charging]], false, difficulty);
				game.play(['move 1', 'move 1', 'move 1', 'move 1 1']);
				assert.equal(game.battle.p4.activeRequest.active[0].moves[0].target, undefined);
				game.decide();
				assert.equal(game.choices.find(c => c.side === 'p4').choice, 'move 1');
				game.play(['move 1', null, 'move 1', null]);
				assert.equal(game.battle.turn, 3);
				assert(!game.battle.p4.active[0].volatiles.twoturnmove);
			});
		}

		it(`${difficulty}: applies shared Transform state to p4 and to an opponent copying p4`, () => {
			const ditto = { species: 'Ditto', ability: 'Limber', moves: ['transform'] };
			const jolteon = { species: 'Jolteon', ability: 'Volt Absorb', moves: ['calmmind'] };
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			for (const own of [true, false]) {
				game = createMulti([[own ? jolteon : passive], [passive], [own ? passive : ditto],
					[own ? ditto : jolteon]], false, difficulty);
				game.play(['move 1', 'move 1', own ? 'move 1' : 'move 1 2', own ? 'move 1 1' : 'move 1']);
				game.decide();
				const controller = game.manager.controllers.p4;
				const state = controller.battleState || controller.state;
				const mon = (own ? state.self : state.opponent).active.find(p => p.slot === 2);
				assert.equal(mon.species, 'Jolteon');
				assert.deepEqual(mon.types, ['Electric']);
				assert.equal(Dex.toID(mon.ability), 'voltabsorb');
				assert.equal(mon.boosts.spa, 1);
				game.destroy();
				game = undefined;
			}
		});

		it(`${difficulty}: sees a partner's statused reserve for Heal Bell but cannot switch into it`, () => {
			const cleric = { species: 'Blissey', ability: 'Natural Cure', moves: ['healbell', 'splash'] };
			const burned = { species: 'Chansey', ability: 'Serene Grace', item: 'Flame Orb', moves: ['splash'] };
			const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
			game = createMulti([[passive], [cleric], [passive], [burned, passive]], false, difficulty);
			game.play(['move 1', 'move 2', 'move 1', 'move 1']);
			assert.equal(game.battle.p4.active[0].status, 'brn');
			game.play(['move 1', 'move 2', 'move 1', 'switch 2']);
			game.decide();
			const controller = game.manager.controllers.p2;
			const state = controller.battleState || controller.state;
			assert(state.self.team.some(p => p.species === 'Chansey' && p.status === 'brn'));
			assert.equal(state.self.reserve.length, 0);
			assert.equal(game.choices.find(c => c.side === 'p2').choice, 'move 1');
		});
	}

	it('should handle team preview before both NPCs start choosing moves', () => {
		game = createMulti([[lanturn], [partner, venusaur], [vibrava], [partner, scizor]], true);
		const choices = game.decide();
		assert.deepEqual(choices.map(c => c.side), ['p2', 'p4']);
		assert(choices.every(c => /^team [12]$/.test(c.choice)));
		game.play(['default', '', 'default', '']);
		game.decide();
		assert.equal(game.choices.length, 4);
		assert(game.choices.slice(2).every(c => c.choice.startsWith('move ')));
	});

	it('Hard selects each Multi lead only from that controller\'s own team', () => {
		const pivot = { species: 'Scizor', ability: 'Technician', moves: ['uturn'] };
		const hazards = { species: 'Ferrothorn', ability: 'Iron Barbs', moves: ['spikes'] };
		game = createMulti([[lanturn], [partner, pivot], [vibrava], [hazards, partner]], true, 'hard');
		assert.deepEqual(game.decide(), [{ side: 'p2', choice: 'team 2' }, { side: 'p4', choice: 'team 1' }]);
		game.play(['default', '', 'default', '']);
		assert.equal(game.battle.p2.active[0].species.id, 'scizor');
		assert.equal(game.battle.p4.active[0].species.id, 'ferrothorn');
	});

	it('should use the simulator-provided Struggle when PP is exhausted', () => {
		game = createMulti([[lanturn], [partner], [vibrava], [partner]]);
		for (const move of game.battle.p2.active[0].moveSlots) move.pp = 0;
		game.battle.makeRequest('move');
		assert.equal(game.battle.p2.activeRequest.active[0].moves[0].id, 'struggle');
		game.decide();
		assert.equal(game.choices.find(c => c.side === 'p2').choice, 'move 1');
	});

	for (const side of ['p2', 'p4']) {
		it(`should switch threatened ${side} into its own safe reserve after Flamethrower is revealed`, () => {
			const charizard = { species: 'Charizard', ability: 'Blaze', moves: ['flamethrower'] };
			const protectedScizor = { species: 'Scizor', ability: 'Technician', moves: ['protect', 'rockslide'] };
			const slowbro = { species: 'Slowbro', ability: 'Regenerator', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['surf'] };
			const magikarp = { species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] };
			game = createMulti([
				[charizard], side === 'p2' ? [protectedScizor, slowbro] : [magikarp, scizor],
				[magikarp], side === 'p4' ? [protectedScizor, slowbro] : [magikarp, scizor],
			]);
			game.play([`move 1 ${side === 'p2' ? 1 : 2}`, 'move 1', 'move 1', 'move 1']);
			game.decide();
			assert.equal(game.choices.find(c => c.side === side).choice, 'switch 2');
			game.play([`move 1 ${side === 'p2' ? 1 : 2}`, '', 'move 1', '']);
			assert.equal(game.battle[side].active[0].species.id, 'slowbro');
		});

		it(`should switch ${side} out of a revealed immunity using only its own reserve`, () => {
			game = createMulti([[lanturn], side === 'p2' ? [porygon, venusaur] : [partner, venusaur], [vibrava], side === 'p4' ? [porygon, scizor] : [partner, scizor]]);
			game.play(['move 1', side === 'p2' ? 'move 2 1' : 'move 1 2', 'move 1', side === 'p4' ? 'move 2 1' : 'move 1 2']);
			game.decide();
			assert.equal(game.choices.find(c => c.side === side).choice, 'switch 2');
			game.play(['move 1', '', 'move 1', '']);
			assert.equal(game.battle[side].active[0].species.id, side === 'p2' ? 'venusaur' : 'scizor');
		});

		for (const immuneSide of ['p1', 'p3']) {
			it(`should retain move slot 2 for ${side} and attack the target other than ${immuneSide}`, () => {
				const gyarados = { species: 'Gyarados', ability: 'Moxie', moves: ['splash'] };
				game = createMulti([immuneSide === 'p1' ? [lanturn] : [gyarados], side === 'p2' ? [porygon, venusaur] : [partner], immuneSide === 'p3' ? [lanturn] : [gyarados], side === 'p4' ? [porygon, scizor] : [partner]]);
				const immuneSlot = immuneSide === 'p1' ? 1 : 2;
				game.play(['move 1', side === 'p2' ? `move 2 ${immuneSlot}` : 'move 1 1', 'move 1', side === 'p4' ? `move 2 ${immuneSlot}` : 'move 1 1']);
				game.decide();
				assert.equal(game.choices.find(c => c.side === side).choice, `move 2 ${3 - immuneSlot}`);
			});
		}

		it(`should keep ${side} in when trapped even with a healthy reserve`, () => {
			game = createMulti([[{ ...lanturn, moves: ['meanlook'] }], side === 'p2' ? [porygon, venusaur] : [partner], [vibrava], side === 'p4' ? [porygon, scizor] : [partner]]);
			game.play([`move 1 ${side === 'p2' ? 1 : 2}`, side === 'p2' ? 'move 2 1' : 'move 1 2', 'move 1', side === 'p4' ? 'move 2 1' : 'move 1 2']);
			assert.equal(game.battle[side].activeRequest.active[0].trapped, true);
			game.decide();
			assert(game.choices.find(c => c.side === side).choice.startsWith('move 2 '));
		});

		it(`should target the other NPC with Helping Hand from ${side}`, () => {
			const support = { species: 'Blissey', ability: 'Natural Cure', moves: ['helpinghand'] };
			game = createMulti([[lanturn], side === 'p2' ? [support] : [partner], [vibrava], side === 'p4' ? [support] : [partner]]);
			game.decide();
			assert.equal(game.choices.find(c => c.side === side).choice, `move 1 ${side === 'p2' ? -2 : -1}`);
		});
	}

	it('should allow both NPCs to use their own reserve slot 2', () => {
		game = createMulti([[lanturn], [porygon, venusaur], [vibrava], [porygon, scizor]]);
		game.play(['move 1', 'move 2 1', 'move 1', 'move 2 1']);
		assert.deepEqual(game.decide(), [{ side: 'p2', choice: 'switch 2' }, { side: 'p4', choice: 'switch 2' }]);
	});

	it('should not use a partner reserve when its own team has none', () => {
		game = createMulti([[lanturn], [porygon], [vibrava], [partner, venusaur]]);
		game.play(['move 1', 'move 2 1', 'move 1', 'move 1 2']);
		game.decide();
		assert(game.choices.find(c => c.side === 'p2').choice.startsWith('move 2 '));
	});

	it('should exclude fainted reserves while preserving the original team slot', () => {
		const sacrifice = { ...partner, moves: ['memento'] };
		game = createMulti([[lanturn], [sacrifice, porygon, venusaur], [vibrava], [partner]]);
		game.play(['move 1', 'move 1 2', 'move 1', 'move 1 2']);
		game.play(['', 'switch 2', '', '']);
		game.play(['move 1', 'move 2 1', 'move 1', 'move 1 2']);
		game.decide();
		assert.equal(game.choices.find(c => c.side === 'p2').choice, 'switch 3');
	});

	it('should wait for a delayed partner request and never repeat submitted choices', () => {
		game = createMulti([[lanturn], [partner], [vibrava], [partner]]);
		game.sync(['p2']);
		game.poll();
		assert.equal(game.choices.length, 0);
		game.sync(['p4']);
		game.poll();
		assert.equal(game.choices.length, 2);
		game.poll();
		assert.equal(game.choices.length, 2);
		game.play(['move 1', '', 'move 1', '']);
		game.sync(['p4']);
		game.poll();
		assert.equal(game.choices.length, 2, 'Must not use the previous-turn p2 request');
		game.sync(['p2']);
		game.poll();
		assert.equal(game.choices.length, 4);
	});

	it('should handle a forced switch while the living partner waits', () => {
		game = createMulti([[lanturn], [{ ...partner, moves: ['healingwish'] }, venusaur], [vibrava], [partner, scizor]]);
		game.play(['move 1', 'move 1', 'move 1', 'move 1 2']);
		assert(game.battle.p2.activeRequest.forceSwitch);
		assert.equal(game.battle.p4.activeRequest.wait, true);
		assert.deepEqual(game.decide(), [{ side: 'p2', choice: 'switch 2' }]);
		assert.equal(game.battle.p2.active[0].species.id, 'venusaur');
		assert.equal(game.battle.p4.active[0].species.id, 'blissey');
		const state = game.manager.controllers.p2.battleState;
		assert.equal(state.self.active.find(p => p.slot === 2).species, 'Blissey');
		game.sync(['p2']);
		game.poll();
		assert.equal(game.choices.length, 1, 'A previous-turn wait request must not stand in for the new partner request');
		game.sync(['p4']);
		game.poll();
		assert.equal(game.choices.length, 3);
	});

	it('should replace both fainted NPCs independently', () => {
		const sacrifice = { ...partner, moves: ['healingwish'] };
		game = createMulti([[lanturn], [sacrifice, venusaur], [vibrava], [sacrifice, scizor]]);
		game.play(['move 1', 'move 1', 'move 1', 'move 1']);
		assert.deepEqual(game.decide(), [{ side: 'p2', choice: 'switch 2' }, { side: 'p4', choice: 'switch 2' }]);
		assert.equal(game.battle.p2.active[0].species.id, 'venusaur');
		assert.equal(game.battle.p4.active[0].species.id, 'scizor');
	});

	it('should retain p4 and p3 field positions after p2 and p1 faint', () => {
		game = createMulti([[{ ...lanturn, moves: ['memento'] }], [{ ...partner, moves: ['memento'] }], [vibrava], [partner]]);
		game.play(['move 1 2', 'move 1 2', 'move 1', 'move 1 2']);
		game.decide();
		assert.equal(game.choices.find(c => c.side === 'p4').choice, 'move 1 2');
		assert(!game.choices.some(c => c.side === 'p2' && c.choice !== 'pass'));
	});

	it('should preserve current ability, level, last move, boosts and ability stat modifiers', () => {
		game = createMulti([[lanturn], [{ species: 'Porygon2', ability: 'Trace', level: 50, moves: ['protect'] }], [vibrava], [{ species: 'Iron Valiant', ability: 'Quark Drive', item: 'Booster Energy', level: 50, moves: ['swordsdance'] }]]);
		game.play(['move 1', 'move 1', 'move 1', 'move 1']);
		game.decide();
		const state = game.manager.controllers.p2.battleState;
		const p2 = state.self.active.find(p => p.slot === 1);
		const p4 = state.self.active.find(p => p.slot === 2);
		assert.equal(p2.level, 50);
		assert.equal(p2.ability, game.battle.p2.active[0].ability);
		assert.notEqual(p2.ability, 'trace');
		assert.equal(p2.lastMove, 'protect');
		assert.equal(p4.boosts.atk, 2);
		assert.equal(p4.abilityStatMod.multiplier, 5325 / 4096);
		assert.equal(p4.active, true);
	});

	it('should value Haze across all four players and stop after clearing boosts', () => {
		const dragon = { species: 'Dragonite', ability: 'Inner Focus', moves: ['dragondance', 'splash'] };
		const hazer = { species: 'Blissey', ability: 'Natural Cure', moves: ['haze', 'dazzlinggleam', 'splash'] };
		const idle = { ...partner, moves: ['splash'] };
		game = createMulti([[dragon], [idle], [lanturn], [hazer]]);
		for (let i = 0; i < 2; i++) game.play(['move 1', 'move 1', 'move 1', 'move 3']);
		game.decide();
		assert.equal(game.choices.find(c => c.side === 'p4').choice, 'move 1');
		game.play(['move 2', '', 'move 1', '']);
		game.decide();
		assert.equal(game.choices.filter(c => c.side === 'p4').at(-1).choice, 'move 2');
		const ai = game.manager.controllers.p4;
		const state = ai.battleState;
		const haze = ai.scoringEngine.scoreMove(state, state.self.active.find(p => p.slot === 2), buildAIMove(Dex.moves.get('haze'), 1), state.opponent.active[0]);
		assert.equal(haze.score, 60);
	});

	it('should complete a Multi battle through the production request coordinator', () => {
		const magikarp = { species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] };
		game = createMulti([[lanturn, magikarp], [porygon, venusaur], [vibrava, magikarp], [partner, scizor]]);
		game.play(['move 1', 'move 2 1', 'move 1', 'move 1 2']);
		for (let step = 0; step < 60 && !game.battle.ended; step++) {
			game.decide();
			for (const side of ['p1', 'p3']) {
				if (!game.battle.ended && !game.battle[side].activeRequest.wait) {
					assert(game.battle.choose(side, 'default'), game.battle[side].choice.error);
				}
			}
		}
		assert(game.battle.ended, `Battle stalled on turn ${game.battle.turn}`);
	});
});

describe('Hard production Multi integration', () => {
	it('creates two Hard controllers and submits legal target choices through the shared coordinator', () => {
		game = createMulti([[lanturn], [porygon, venusaur], [vibrava], [partner, scizor]], false, 'hard');
		assert(Object.values(game.manager.controllers).every(ai => ai.difficulty === 'hard'));
		game.decide();
		assert.equal(game.choices.length, 2);
		assert(game.choices.every(choice => choice.choice.startsWith('move ') || choice.choice.startsWith('switch ')));
		for (let turn = 0; turn < 10 && !game.battle.ended; turn++) {
			for (const side of ['p1', 'p3']) {
				if (game.battle[side].activeRequest && !game.battle[side].activeRequest.wait) {
					assert(game.battle.choose(side, 'default'));
				}
			}
			if (!game.battle.ended) game.decide();
		}
		assert(game.battle.turn > 2 || game.battle.ended);
	});
});
