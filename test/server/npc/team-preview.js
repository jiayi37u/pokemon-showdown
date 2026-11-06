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
