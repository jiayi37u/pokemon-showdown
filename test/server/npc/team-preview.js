'use strict';

const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { HardAI } = require('../../../dist/server/npc/ai/hard');

const mon = (species, moves = ['tackle'], extra = {}) => ({ species, moves, ...extra });
let battle;
afterEach(() => { battle?.destroy(); battle = undefined; });

function setup(AI, team, formatid = 'gen9customgame') {
	battle = new Battle({ formatid, seed: [1, 2, 3, 4],
		p1: { name: 'Player', team: [mon('Mew'), mon('Mew')] }, p2: { name: 'NPC', team } });
	const ai = new AI({ write() {} }, { seed: [1, 2, 3, 4], logging: { console: 0, file: 0 } });
	let choice;
	ai.choose = value => { choice = value; };
	ai.setBattle({ format: formatid, turn: battle.turn });
	ai.getTracker().parseMessage(battle.log.join('\n'));
	return () => { ai.receiveRequest(structuredClone(battle.p2.activeRequest)); return choice; };
}

describe('NPC lead selection', () => {
	it('Normal samples all party members instead of always keeping the first slot', () => {
		const decide = setup(NormalAI, [mon('Mew'), mon('Pikachu'), mon('Blissey'), mon('Garchomp')]);
		const choices = new Set(Array.from({ length: 40 }, decide));
		assert.deepEqual([...choices].sort(), ['team 1', 'team 2', 'team 3', 'team 4']);
		for (const choice of choices) assert(battle.choose('p2', choice), battle.p2.choice.error);
	});

	for (const move of ['voltswitch', 'uturn', 'flipturn', 'stealthrock', 'spikes']) {
		it(`Hard selects a ${move} user ahead of a faster non-support member`, () => {
			const decide = setup(HardAI, [mon('Deoxys-Speed'), mon('Shuckle', [move])]);
			assert.equal(decide(), 'team 2');
			battle.makeChoices('default', decide());
			assert.equal(battle.p2.active[0].species.id, 'shuckle');
		});
	}

	it('Hard samples eligible members equally regardless of how many preferred moves they carry', () => {
		const decide = setup(HardAI, [mon('Deoxys-Speed'), mon('Mew', ['uturn', 'stealthrock', 'spikes']),
			mon('Scizor', ['uturn']), mon('Tentacruel', ['toxicspikes'])]);
		const choices = new Set(Array.from({ length: 40 }, decide));
		assert.deepEqual([...choices].sort(), ['team 2', 'team 3']);
	});

	it('Hard excludes Toxic Spikes and other pivots, then compares actual Speed including Scarf', () => {
		const decide = setup(HardAI, [mon('Garchomp', ['tackle'], { nature: 'Jolly', evs: { spe: 252 } }),
			mon('Hydreigon', ['tackle'], { nature: 'Timid', evs: { spe: 252 }, item: 'Choice Scarf' }),
			mon('Shuckle', ['toxicspikes']), mon('Pangoro', ['partingshot'])], 'gen6customgame');
		assert.equal(decide(), 'team 2');
		battle.makeChoices('default', decide());
		assert.equal(battle.p2.active[0].species.id, 'hydreigon');
	});

	it('Hard randomly breaks ties between the fastest members', () => {
		const decide = setup(HardAI, [mon('Shuckle'), mon('Mew'), mon('Mew')]);
		assert.deepEqual([...new Set(Array.from({ length: 40 }, decide))].sort(), ['team 2', 'team 3']);
	});

	for (const AI of [NormalAI, HardAI]) {
		it(`${AI.name} submits a legal lead in doubles`, () => {
			const decide = setup(AI, [mon('Mew'), mon('Scizor', ['uturn']), mon('Blissey')], 'gen9doublescustomgame');
			const choice = decide();
			assert(/^team [123]$/.test(choice), choice);
			battle.makeChoices('default', choice);
			assert.equal(battle.p2.active.length, 2);
			assert.equal(new Set(battle.p2.active).size, 2);
		});

		it(`${AI.name} leaves the generated Random Battle lead in place`, () => {
			const decide = setup(AI, [mon('Mew'), mon('Scizor', ['uturn'])], 'gen9randombattle');
			assert(!battle.p2.activeRequest.teamPreview);
			const lead = battle.p2.active[0];
			const choice = decide();
			assert(!choice.startsWith('team '), choice);
			assert.equal(battle.p2.active[0], lead);
			assert(battle.choose('p2', choice), battle.p2.choice.error);
		});
	}
});
