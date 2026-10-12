'use strict';

const assert = require('../../assert');
const { Battle, Teams } = require('../../../dist/sim');
const { NPC } = require('../../../dist/server/npc/manager');
const { createNPCBattle, isFormatSupported } = require('../../../dist/server/npc/room');

describe('NPC PokeMMO Random Battle integration', () => {
	it('should offer the format and generate both teams through the NPC battle entry point', async () => {
		const format = 'gen5pokemmorandombattle';
		NPC.loadTemplates();
		assert(isFormatSupported(format));
		for (const id of ['gymbrock', 'maxie', 'norman']) {
			assert(NPC.supportsFormat(id, format), id);
			assert(NPC.supportsFormat(id, 'gen9randombattle'), id);
			assert(NPC.getSupportedFormats(id).includes(format));
		}

		const originalRooms = global.Rooms;
		const originalGenerate = Teams.generate;
		let generated = 0;
		let captured;
		const room = { settings: {} };
		global.Rooms = { createBattle: options => {
			captured = options;
			return room;
		} };
		Teams.generate = (id, options) => {
			assert.equal(id, format);
			return originalGenerate.call(Teams, id, { ...options, seed: [++generated, 2, 3, 4] });
		};
		const restore = () => {
			global.Rooms = originalRooms;
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
				p1: { name: 'Player', team: captured.players[0].team },
				p2: { name: 'Brock', team: captured.players[1].team },
			});
			try {
				assert.deepEqual(battle.p1.pokemon.map(p => p.level), player.map(p => p.level));
				assert.deepEqual(battle.p2.pokemon.map(p => p.level), npc.map(p => p.level));
				assert.equal(battle.dex.currentMod, 'mmo');
			} finally {
				battle.destroy();
			}
		} finally {
			restore();
		}
	});
});
