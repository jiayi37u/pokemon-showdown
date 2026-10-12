'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

const revealCases = [
	['Arcanine', 'Flash Fire', 'flamethrower', '-start', 2],
	['Bronzong', 'Levitate', 'earthquake', '-immune'],
	['Garchomp', 'Rough Skin', 'tackle', '-damage'],
	['Ferrothorn', 'Iron Barbs', 'tackle', '-damage'],
	['Drifblim', 'Aftermath', 'crunch', '-damage', 1, 1],
	['Kommo-o', 'Soundproof', 'hypervoice', '-immune'],
	['Kommo-o', 'Bulletproof', 'shadowball', '-immune'],
	['Ninetales', 'Drought', 'splash', '-weather'],
	['Pelipper', 'Drizzle', 'splash', '-weather'],
	['Tyranitar', 'Sand Stream', 'splash', '-weather'],
	['Abomasnow', 'Snow Warning', 'splash', '-weather'],
	['Pincurchin', 'Electric Surge', 'splash', '-fieldstart'],
	['Rillaboom', 'Grassy Surge', 'splash', '-fieldstart'],
	['Weezing-Galar', 'Misty Surge', 'splash', '-fieldstart'],
	['Indeedee', 'Psychic Surge', 'splash', '-fieldstart'],
	['Ludicolo', 'Rain Dish', 'raindance', '-heal', 1, 100],
	['Blissey', 'Slow Start', 'splash', '-start'], // Custom Game avoids the single-ability species inference.
	['Dragonite', 'Inner Focus', 'splash', '-fail'],
];

describe('NPC ability reveals', () => {
	for (const [species, ability, move, event, turns = 1, hp] of revealCases) {
		it(`should record ${ability} from real ${event} output`, () => {
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [{ species, ability, moves: ['splash'] }] },
				p2: { name: 'NPC', team: [{ species: 'Blissey', ability: ability === 'Inner Focus' ? 'Intimidate' : 'Natural Cure', moves: [move] }] },
			});
			try {
				battle.makeChoices();
				if (hp) battle.p1.active[0].hp = hp;
				for (let turn = 0; turn < turns && !battle.ended; turn++) battle.makeChoices('move 1', 'move 1');
				const lines = battle.log.filter(line => line.startsWith(`|${event}|`) && line.includes(`ability: ${ability}`));
				assert(lines.length, `Simulator must actually emit ${event} for ${ability}`);
				const tracker = createBattleTracker('p2');
				tracker.parseMessage(battle.log.join('\n'));
				assert.equal(tracker.getOpponentTeam()[0].ability, ability);
			} finally {
				battle.destroy();
			}
		});
	}

	for (const [species, ability, move] of [['Raichu', 'Lightning Rod', 'thunderbolt'], ['Gastrodon', 'Storm Drain', 'watergun']]) {
		it(`should reveal ${ability} even when Special Attack cannot rise`, () => {
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [{ species, ability, moves: ['splash'] }] },
				p2: { name: 'NPC', team: [{ species: 'Blissey', ability: 'Natural Cure', moves: [move] }] },
			});
			try {
				battle.makeChoices();
				battle.p1.active[0].boosts.spa = 6;
				battle.makeChoices('move 1', 'move 1');
				assert(battle.log.some(line => line.startsWith('|-immune|') && line.includes(ability)));
				assert(!battle.log.some(line => line.startsWith('|-ability|')));
				const tracker = createBattleTracker('p2');
				tracker.parseMessage(battle.log.join('\n'));
				assert.equal(tracker.getActiveOpponent().ability, ability);
			} finally {
				battle.destroy();
			}
		});
	}

	it('should reveal the copied opponent ability through our Trace', () => {
		const battle = new Battle({
			formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Bronzong', ability: 'Levitate', moves: ['splash'] }] },
			p2: { name: 'NPC', team: [{ species: 'Gardevoir', ability: 'Trace', moves: ['splash'] }] },
		});
		try {
			battle.makeChoices();
			const tracker = createBattleTracker('p2');
			tracker.parseMessage(battle.log.join('\n'));
			assert.equal(tracker.getActiveOpponent().ability, 'Levitate');
		} finally {
			battle.destroy();
		}
	});

	for (const move of ['skillswap', 'worryseed', 'gastroacid']) {
		it(`should track ${move} without retaining the temporary ability after switching`, () => {
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [
					{ species: 'Bronzong', ability: 'Levitate', moves: ['splash'] },
					{ species: 'Lanturn', ability: 'Volt Absorb', moves: ['splash'] },
				] },
				p2: { name: 'NPC', team: [{ species: 'Blissey', ability: 'Natural Cure', moves: ['earthquake', move, 'splash'] }] },
			});
			try {
				const tracker = createBattleTracker('p2');
				let cursor = 0;
				const feed = () => {
					tracker.parseMessage(battle.log.slice(cursor).join('\n'));
					cursor = battle.log.length;
				};
				battle.makeChoices();
				battle.makeChoices('move 1', 'move 1');
				feed();
				assert.equal(tracker.getActiveOpponent().ability, 'Levitate');
				battle.makeChoices('move 1', 'move 2');
				feed();
				const expected = move === 'skillswap' ? 'Natural Cure' : move === 'worryseed' ? 'Insomnia' : '';
				assert.equal(tracker.getActiveOpponent().ability, expected);
				battle.makeChoices('switch 2', 'move 3');
				battle.makeChoices('switch 2', 'move 3');
				feed();
				assert.equal(tracker.getActiveOpponent().ability, 'Levitate');
				assert.equal(battle.p1.active[0].ability, 'levitate');
			} finally {
				battle.destroy();
			}
		});
	}

	it('should attribute ally healing and protection to the holder, not the recipient', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Ally|Lanturn|50/100\n|switch|p1b: Holder|Sinistcha|100/100');
		tracker.parseMessage('|-heal|p1a: Ally|75/100|[from] ability: Hospitality|[of] p1b: Holder');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1a').pokemon.ability, '');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1b').pokemon.ability, 'Hospitality');
		tracker.parseMessage('|switch|p1b: Holder|Aromatisse|100/100');
		tracker.parseMessage('|-block|p1a: Ally|ability: Aroma Veil|[of] p1b: Holder');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1a').pokemon.ability, '');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1b').pokemon.ability, 'Aroma Veil');
	});

	it('should record direct activation without requiring a companion ability message', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Raichu|Raichu|100/100');
		tracker.parseMessage('|-activate|p1a: Raichu|ability: Lightning Rod');
		assert.equal(tracker.getActiveOpponent().ability, 'Lightning Rod');
	});

	for (const ability of ['Mummy', 'Wandering Spirit', 'Lingering Aroma']) {
		it(`should follow both sides of ${ability} and restore native abilities on re-entry`, () => {
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [
					{ species: 'Bronzong', ability: 'Levitate', moves: ['tackle', 'splash'] },
					{ species: 'Lanturn', ability: 'Volt Absorb', moves: ['splash'] },
				] },
				p2: { name: 'NPC', team: [
					{ species: 'Blissey', ability, moves: ['splash'] },
					{ species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] },
				] },
			});
			try {
				const trackers = [createBattleTracker('p2'), createBattleTracker('p1')];
				let cursor = 0;
				const feed = () => {
					for (const tracker of trackers) tracker.parseMessage(battle.log.slice(cursor).join('\n'));
					cursor = battle.log.length;
				};
				battle.makeChoices();
				battle.makeChoices('move 1', 'move 1');
				feed();
				assert.equal(trackers[0].getActiveOpponent().ability, ability);
				assert.equal(trackers[1].getActiveOpponent().ability, ability === 'Wandering Spirit' ? 'Levitate' : ability);
				battle.makeChoices('switch 2', 'switch 2');
				battle.makeChoices('switch 2', 'switch 2');
				feed();
				assert.equal(trackers[0].getActiveOpponent().ability, 'Levitate');
				assert.equal(trackers[1].getActiveOpponent().ability, ability);
			} finally {
				battle.destroy();
			}
		});
	}

	it('should use our Role Play to reveal the opponent ability', () => {
		const battle = new Battle({
			formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Player', team: [{ species: 'Bronzong', ability: 'Levitate', moves: ['splash'] }] },
			p2: { name: 'NPC', team: [{ species: 'Blissey', ability: 'Natural Cure', moves: ['roleplay'] }] },
		});
		try {
			battle.makeChoices();
			battle.makeChoices('move 1', 'move 1');
			const tracker = createBattleTracker('p2');
			tracker.parseMessage(battle.log.join('\n'));
			assert.equal(tracker.getActiveOpponent().ability, 'Levitate');
		} finally {
			battle.destroy();
		}
	});

	it('should restore Trace rather than persist its copied ability before a new reveal', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Gardevoir|Gardevoir|100/100');
		tracker.parseMessage('|-ability|p1a: Gardevoir|Levitate|Trace|[from] ability: Trace|[of] p2a: Bronzong');
		assert.equal(tracker.getActiveOpponent().ability, 'Levitate');
		tracker.parseMessage('|switch|p1a: Lanturn|Lanturn|100/100');
		tracker.parseMessage('|switch|p1a: Gardevoir|Gardevoir|100/100');
		assert.equal(tracker.getActiveOpponent().ability, 'Trace');
	});

	it('should attribute status and confusion caused by abilities to their source', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Raichu|Raichu|100/100');
		tracker.parseMessage('|-status|p2a: Blissey|par|[from] ability: Static|[of] p1a: Raichu');
		assert.equal(tracker.getActiveOpponent().ability, 'Static');
		tracker.parseMessage('|-start|p1a: Raichu|confusion|[from] ability: Poison Puppeteer|[of] p2a: Pecharunt');
		assert.equal(tracker.getActiveOpponent().ability, 'Static');
	});

	it('should retain an unknown native ability after a hidden allied Skill Swap', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Ally|Lanturn|100/100\n|switch|p1b: Partner|Bronzong|100/100');
		tracker.parseMessage('|-ability|p1b: Partner|Levitate');
		tracker.parseMessage('|-activate|p1a: Ally|move: Skill Swap|||[of] p1b: Partner');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1a').pokemon.ability, 'Levitate');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1b').pokemon.ability, '');
		tracker.parseMessage('|switch|p1a: Ally|Lanturn|100/100');
		assert.equal(tracker.getActiveOpponents().find(p => p.position === 'p1a').pokemon.ability, '');
	});

	it('should keep unknown holders and move/item effects from revealing an opponent ability', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Lanturn|Lanturn|100/100');
		tracker.parseMessage('|-weather|RainDance|[from] ability: Drizzle');
		tracker.parseMessage('|-fieldstart|move: Electric Terrain|[from] move: Electric Terrain');
		tracker.parseMessage('|-activate|p1a: Lanturn|item: Quick Claw');
		tracker.parseMessage('|-start|p1a: Lanturn|move: Substitute');
		assert.equal(tracker.getActiveOpponent().ability, '');
	});

	for (const damaged of [false, true]) {
		it(`should switch a Choice-locked Porygon-Z after Volt Absorb ${damaged ? 'heals' : 'blocks at full HP'}`, () => {
			const stream = { push() {}, write() {} };
			const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
			ai.setBattle({ stream, format: 'gen9customgame' });
			const battle = new Battle({
				formatid: 'gen9customgame', seed: [1, 2, 3, 4],
				p1: { name: 'Player', team: [
					{ species: 'Blissey', ability: 'Natural Cure', moves: ['splash'] },
					{ species: 'Lanturn', ability: 'Volt Absorb', moves: ['protect'] },
				] },
				p2: { name: 'NPC', team: [
					{ species: 'Porygon-Z', ability: 'Adaptability', item: 'Choice Scarf', moves: ['thunderbolt', 'icebeam'] },
					{ species: 'Venusaur', ability: 'Overgrow', moves: ['energyball', 'splash'] },
				] },
			});
			try {
				battle.makeChoices('team 12', 'team 12');
				battle.makeChoices('move 1', 'move 1');
				const lanturn = battle.p1.pokemon[1];
				if (damaged) lanturn.hp = Math.floor(lanturn.maxhp / 2);
				battle.makeChoices('switch 2', 'move 1');
				const protocol = battle.log.join('\n');
				assert(protocol.includes(`|-${damaged ? 'heal' : 'immune'}|p1a: Lanturn|`));
				assert(protocol.includes('[from] ability: Volt Absorb'));
				assert(!protocol.includes('|-ability|p1a: Lanturn|'));
				// Feed actual simulator output and the NPC's request, without exposing Battle to the AI.
				stream.push(protocol);
				const request = JSON.parse(JSON.stringify(battle.p2.activeRequest));
				assert.equal(request.active[0].moves.find(m => m.id === 'icebeam').disabled, true);
				let choice;
				ai.choose = value => { choice = value; };
				ai.receiveRequest(request);
				assert.equal(choice, 'switch 2');
				assert.equal(ai.getTracker().getActiveOpponent().ability, 'Volt Absorb');
				battle.makeChoices('move 1', choice);
				assert.equal(battle.p2.active[0].species.id, 'venusaur');
				// Revealed abilities survive leaving and re-entering the field.
				battle.makeChoices('switch 2', 'move 2');
				battle.makeChoices('switch 2', 'move 2');
				stream.push(battle.log.join('\n'));
				assert.equal(ai.getTracker().getActiveOpponent().ability, 'Volt Absorb');
			} finally {
				battle.destroy();
			}
		});
	}

	it('should attribute absorption to the recipient, even when [of] names the attacker', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Lanturn|Lanturn|100/100');
		tracker.parseMessage('|-heal|p2a: Porygon-Z|100/100|[from] ability: Volt Absorb|[of] p1a: Lanturn');
		assert.equal(tracker.getActiveOpponent().ability, '');
		tracker.parseMessage('|-heal|p1a: Lanturn|100/100|[from] ability: Volt Absorb|[of] p2a: Porygon-Z');
		assert.equal(tracker.getActiveOpponent().ability, 'Volt Absorb');
	});

	it('should leave unrevealed abilities unknown after ordinary healing or type immunity', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|switch|p1a: Lanturn|Lanturn|50/100');
		tracker.parseMessage('|-heal|p1a: Lanturn|75/100|[from] item: Leftovers');
		tracker.parseMessage('|-heal|p1a: Lanturn|75/100|[from] ability: Hospitality|[of] p1b: Sinistcha');
		tracker.parseMessage('|-immune|p1a: Lanturn');
		assert.equal(tracker.getActiveOpponent().ability, '');
		assert.equal(tracker.getActiveOpponent().hpPercent, 75);
	});

	for (const [species, ability] of [['Seismitoad', 'Water Absorb'], ['Toxicroak', 'Dry Skin'], ['Orthworm', 'Earth Eater']]) {
		for (const event of ['-heal', '-immune']) {
			it(`should track ${ability} from ${event} on the other Multi opponent`, () => {
				const tracker = createBattleTracker('p2', true);
				tracker.parseMessage(`|switch|p3b: Target|${species}|100/100`);
				tracker.parseMessage(`|${event}|p3b: Target|${event === '-heal' ? '100/100|' : ''}[from] ability: ${ability}`);
				assert.equal(tracker.getActiveOpponents()[0].pokemon.ability, ability);
			});
		}
	}
});
