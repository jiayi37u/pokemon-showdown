'use strict';

const assert = require('../../assert');
const { Battle, Dex, Teams } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { NPC, NPC_RANDOM_FORMATS } = require('../../../dist/server/npc/manager');
const { createNPCBattle, isFormatSupported } = require('../../../dist/server/npc/room');

describe('NPC random singles integration', () => {
	for (const format of NPC_RANDOM_FORMATS) {
		it(`should generate both teams and complete ${format} with Smart AI`, async function () {
			this.timeout(20000);
			NPC.loadTemplates();
			assert(isFormatSupported(format));
			for (const id of ['gymbrock', 'maxie', 'norman']) {
				assert(NPC.supportsFormat(id, format), id);
				assert(NPC.supportsFormat(id, 'gen9randombattle'), id);
				assert(NPC.getSupportedFormats(id).includes(format));
			}

			const originalCreateBattle = Rooms.createBattle;
			const originalGenerate = Teams.generate;
			let generated = 0;
			let captured;
			const room = { settings: {} };
			Rooms.createBattle = options => {
				captured = options;
				return room;
			};
			Teams.generate = (id, options) => {
				assert.equal(id, format);
				return originalGenerate.call(Teams, id, { ...options, seed: [++generated, 2, 3, 4] });
			};
			const restore = () => {
				Rooms.createBattle = originalCreateBattle;
				Teams.generate = originalGenerate;
			};
			try {
				const result = await createNPCBattle({ user: { id: 'player', name: 'Player' }, npcId: 'gymbrock', format });
				assert.equal(result.success, true);
				assert.equal(result.room, room);
				assert.equal(generated, 2);
				assert.equal(captured.format, format);
				const [player, npc] = captured.players.map(p => Teams.unpack(p.team));
				assert.equal(player.length, 6);
				assert.equal(npc.length, 6);
				const battle = new Battle({
					formatid: captured.format,
					seed: [1, 2, 3, 4],
					p1: { name: 'Player', team: captured.players[0].team },
					p2: { name: 'Brock', team: captured.players[1].team },
				});
				try {
					assert.deepEqual(battle.p1.pokemon.map(p => p.level), player.map(p => p.level || 100));
					assert.deepEqual(battle.p2.pokemon.map(p => p.level), npc.map(p => p.level || 100));
					assert.equal(battle.dex.currentMod, Dex.forFormat(format).currentMod);
					const ai = new NormalAI({ write() {} }, { seed: [1, 2, 3, 4] });
					ai.setBattle({ format });
					ai.choose = choice => assert(battle.choose('p2', choice), battle.p2.choice.error);
					let cursor = 0;
					for (let step = 0; step < 1000 && !battle.ended; step++) {
						ai.getTracker().parseMessage(battle.log.slice(cursor).join('\n'));
						cursor = battle.log.length;
						ai.receiveRequest(battle.p2.activeRequest);
						if (!battle.ended && !battle.p1.activeRequest.wait) {
							assert(battle.choose('p1', 'default'), battle.p1.choice.error);
						}
					}
					assert(battle.ended, `Random singles stalled on turn ${battle.turn}`);
				} finally {
					battle.destroy();
				}
			} finally {
				restore();
			}
		});
	}
});
