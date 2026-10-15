'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');

const porygon = { species: 'Porygon-Z', ability: 'Adaptability', item: 'Choice Scarf', moves: ['thunderbolt', 'icebeam'] };
const partner = { species: 'Blissey', ability: 'Natural Cure', moves: ['icebeam'] };
const lanturn = { species: 'Lanturn', ability: 'Volt Absorb', moves: ['splash'] };
// Electric immunity without preset attacks keeps these cases focused on switch targeting.
const vibrava = { species: 'Vibrava', ability: 'Levitate', item: 'Eviolite', nature: 'Calm',
	evs: { hp: 252, spd: 252 }, moves: ['splash'] };
const venusaur = { species: 'Venusaur', ability: 'Overgrow', moves: ['energyball'] };

/** Feed the production NormalAI only protocol and requests, then validate its choice in the simulator. */
function scenario(playerTeam, npcTeam, playerChoice, npcChoice, check) {
	const stream = { push() {}, write() {} };
	const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
	ai.setBattle({ stream, format: 'gen9doublescustomgame' });
	const battle = new Battle({
		formatid: 'gen9doublescustomgame', seed: [1, 2, 3, 4],
		p1: { name: 'Player', team: playerTeam },
		p2: { name: 'NPC', team: npcTeam },
	});
	try {
		battle.makeChoices();
		assert(battle.choose('p1', playerChoice), battle.p1.choice.error);
		assert(battle.choose('p2', npcChoice), battle.p2.choice.error);
		stream.push(battle.log.join('\n'));
		const request = JSON.parse(JSON.stringify(battle.p2.activeRequest));
		let choice;
		ai.choose = value => { choice = value; };
		ai.receiveRequest(request);
		const actions = choice.split(', ');
		// Check every switch, including cases that are expected to stay in.
		const switches = actions.filter(action => action.startsWith('switch ')).map(action => Number(action.slice(7)));
		assert.equal(new Set(switches).size, switches.length, 'Each reserve can be chosen only once');
		for (const slot of switches) {
			assert(slot > 2, `Must not switch to either active Pokemon: ${choice}`);
			assert.equal(request.side.pokemon[slot - 1].active, false);
			assert(!request.side.pokemon[slot - 1].condition.endsWith(' fnt'));
		}
		assert(battle.choose('p2', choice), `${choice}: ${battle.p2.choice.error}`);
		check({ actions, battle, request, ai });
	} finally {
		battle.destroy();
	}
}

describe('NormalAI doubles switching', () => {
	for (const poryIndex of [0, 1]) {
		it(`should switch active slot ${poryIndex + 1} to a reserve when both targets are immune`, () => {
			const team = poryIndex ? [partner, porygon, venusaur] : [porygon, partner, venusaur];
			const opening = poryIndex ? 'move 1 2, move 1 1' : 'move 1 1, move 1 2';
			scenario([lanturn, vibrava], team, 'move 1, move 1', opening, ({ actions, battle }) => {
				assert.equal(actions[poryIndex], 'switch 3');
				assert(actions[1 - poryIndex].startsWith('move '));
				assert(battle.choose('p1', 'move 1, move 1'), battle.p1.choice.error);
				assert.equal(battle.p2.active[poryIndex].species.id, 'venusaur');
				assert.equal(battle.p2.active[1 - poryIndex].species.id, 'blissey');
			});
		});

		for (const immuneIndex of [0, 1]) {
			it(`should keep slot ${poryIndex + 1} in and attack the other target when opponent ${immuneIndex + 1} absorbs Electric`, () => {
				const vulnerable = { species: 'Gyarados', ability: 'Intimidate', moves: ['splash'] };
				const opponents = immuneIndex ? [vulnerable, lanturn] : [lanturn, vulnerable];
				const team = poryIndex ? [partner, porygon, venusaur] : [porygon, partner, venusaur];
				const opening = poryIndex ? `move 1 ${2 - immuneIndex}, move 1 ${immuneIndex + 1}` : `move 1 ${immuneIndex + 1}, move 1 ${2 - immuneIndex}`;
				scenario(opponents, team, 'move 1, move 1', opening, ({ actions }) => {
					assert.equal(actions[poryIndex], `move 1 ${2 - immuneIndex}`);
				});
			});
		}
	}

	for (const reserves of [[], [venusaur], [venusaur, { species: 'Scizor', ability: 'Technician', moves: ['bulletpunch'] }]]) {
		it(`should allocate ${reserves.length} reserves without duplicate or active switch targets`, () => {
			const raichu = { species: 'Raichu', ability: 'Static', item: 'Choice Scarf', moves: ['thunderbolt'] };
			scenario([lanturn, vibrava], [porygon, raichu, ...reserves], 'move 1, move 1', 'move 1 1, move 1 1', ({ actions }) => {
				assert.equal(actions.filter(action => action.startsWith('switch ')).length, reserves.length);
			});
		});
	}

	it('should keep a trapped Pokemon in even with a healthy reserve', () => {
		const trappingLanturn = { ...lanturn, moves: ['meanlook'] };
		scenario([trappingLanturn, vibrava], [porygon, partner, venusaur], 'move 1 1, move 1', 'move 1 1, move 1 2', ({ actions, request }) => {
			assert.equal(request.active[0].trapped, true);
			assert(actions[0].startsWith('move '));
		});
	});

	it('should evaluate the second attacker using its own special attack, not its partner\'s', () => {
		const weakPartner = { species: 'Chansey', ability: 'Natural Cure', moves: ['seismictoss'] };
		const snorlax = { species: 'Snorlax', ability: 'Thick Fat', moves: ['splash'] };
		const strongAttacker = { ...porygon, nature: 'Modest', evs: { spa: 252 } };
		scenario([lanturn, snorlax], [weakPartner, strongAttacker, venusaur], 'move 1, move 1', 'move 1 2, move 1 1', ({ actions }) => {
			assert.equal(actions[1], 'move 1 2');
		});
	});

	it('should choose only a reserve during a forced replacement and leave the partner in place', () => {
		const sacrificingPartner = { ...partner, moves: ['healingwish'] };
		scenario([lanturn, vibrava], [sacrificingPartner, porygon, venusaur], 'move 1, move 1', 'move 1, move 1 1', ({ actions, battle, request, ai }) => {
			assert.deepEqual(request.forceSwitch, [true, false]);
			assert.deepEqual(ai.battleState.opponent.active.map(p => p.slot), [1, 2]);
			assert.deepEqual(actions, ['switch 3', 'pass']);
			assert.equal(battle.p2.active[0].species.id, 'venusaur');
			assert.equal(battle.p2.active[1].species.id, 'porygonz');
		});
	});

	it('should keep slot identities after the first Pokemon on each side faints', () => {
		const sacrificingLanturn = { ...lanturn, moves: ['memento'] };
		const sacrificingPartner = { ...partner, moves: ['memento'] };
		scenario([sacrificingLanturn, vibrava], [sacrificingPartner, porygon], 'move 1 2, move 1', 'move 1 2, move 1 1', ({ actions }) => {
			assert.deepEqual(actions, ['pass', 'move 1 2']);
		});
	});
});
