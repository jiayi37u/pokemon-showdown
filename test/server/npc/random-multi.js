'use strict';

const assert = require('assert').strict;
const { Battle, Dex, Teams, PRNG, TeamValidator } = require('../../../dist/sim');
const { NPC, NPC_RANDOM_MULTI_FORMATS } = require('../../../dist/server/npc/manager');
const { createNPCMultiBattle, createNPCBattle } = require('../../../dist/server/npc/room');
const { NPCMultiManager } = require('../../../dist/server/npc/ai/multi-manager');
const { commands } = require('../../../dist/server/chat-plugins/npc');
const { challenges } = require('../../../dist/server/ladders-challenges');

// Drive the production coordinator with real simulator requests and protocol messages.
function completeBattle(options) {
	const players = Object.fromEntries(options.players.map((p, i) => [`p${i + 1}`, { name: p.user.name, team: p.team }]));
	const battle = new Battle({ formatid: options.format, seed: [1, 2, 3, 4], ...players });
	const room = {
		format: options.format, turn: 0, p2: {}, p4: {},
		stream: {
			push() {},
			write(line) {
				const [, side, choice] = /^>(p[24]) (.+)$/.exec(line);
				assert(battle.choose(side, choice), `${line}: ${battle[side].choice.error}`);
			},
		},
	};
	Object.defineProperty(room.stream, 'battle', { get() { throw new Error('Cannot access private battle state'); } });
	const manager = new NPCMultiManager(room, { difficulty: 'smart' });
	for (const ai of Object.values(manager.controllers)) ai.prng = new PRNG([4, 3, 2, 1]);
	let cursor = 0;
	let rqid = 0;
	const published = {};
	try {
		assert.equal(battle.gameType, 'multi');
		assert.equal(battle.p1.allySide, battle.p3);
		assert.equal(battle.p2.allySide, battle.p4);
		assert.equal(battle.dex.currentMod, options.format.includes('pokemmo') ? 'mmo' : 'base');
		for (let i = 0; i < 4; i++) {
			const team = Teams.unpack(options.players[i].team);
			assert.equal(team.length, 3);
			assert.deepEqual(battle.sides[i].pokemon.map(p => p.level), team.map(p => p.level));
		}
		for (let step = 0; step < 1000 && !battle.ended; step++) {
			room.stream.push(battle.log.slice(cursor).join('\n'));
			cursor = battle.log.length;
			room.turn = battle.turn;
			for (const side of ['p2', 'p4']) {
				const request = battle[side].activeRequest;
				if (published[side] !== request) {
					published[side] = request;
					room[side].request = { request: JSON.stringify(request), rqid: ++rqid, isWait: !!request.wait };
				}
				manager.checkSideRequest(side, room[side]);
			}
			manager.tryMakeDecision();
			for (const side of ['p1', 'p3']) {
				if (!battle.ended && !battle[side].activeRequest.wait) {
					assert(battle.choose(side, 'default'), battle[side].choice.error);
				}
			}
		}
		assert(battle.ended, `Random Multi stalled on turn ${battle.turn}`);
	} finally {
		manager.stop();
		battle.destroy();
	}
}

describe('NPC Random Multi invitations', () => {
	let originalCreateBattle, originalGetUser, originalGetRandom, originalGenerate, originalRandom;
	let user, teammate, context, errors, boxes, created, generated, rosters, battleRoom;
	const makeUser = id => ({
		id, name: id, connected: true, battleSettings: {}, messages: [], joined: [],
		getIdentity() { return ` ${id}`; },
		send(message) { this.messages.push(message); },
		popup(message) { this.messages.push(message); },
		joinRoom(room) { this.joined.push(room); },
	});
	before(() => NPC.loadTemplates());
	beforeEach(() => {
		originalCreateBattle = Rooms.createBattle;
		originalGetUser = Users.get;
		originalGetRandom = NPC.getRandom;
		originalGenerate = Teams.generate;
		originalRandom = Math.random;
		// Fix the shuffle draws so assignment checks never depend on chance.
		Math.random = () => 0;
		user = makeUser('randommultiinviter');
		teammate = makeUser('randommultiacceptor');
		Users.get = id => [user, teammate].find(u => u.id === toID(id)) || originalGetUser.call(Users, id);
		NPC.getRandom = () => NPC.get('norman');
		generated = 0;
		rosters = [];
		Teams.generate = (format, options) => {
			const team = originalGenerate.call(Teams, format, { ...options, seed: [++generated, 2, 3, 4] });
			rosters.push({ format, team: Teams.unpack(Teams.pack(team)) });
			return team;
		};
		errors = [];
		boxes = [];
		created = [];
		battleRoom = { roomid: 'battle-npc-random-multi-test', settings: {} };
		Rooms.createBattle = options => { created.push(options); return battleRoom; };
		context = {
			sendReply() {}, sendReplyBox: html => boxes.push(html), errorReply: error => errors.push(error),
		};
	});
	afterEach(() => {
		const challenge = challenges.search(user.id, teammate.id);
		if (challenge) challenges.remove(challenge);
		Rooms.createBattle = originalCreateBattle;
		Users.get = originalGetUser;
		NPC.getRandom = originalGetRandom;
		Teams.generate = originalGenerate;
		Math.random = originalRandom;
	});

	for (const format of NPC_RANDOM_MULTI_FORMATS) {
		it(`should invite without selected teams, then generate and complete ${format}`, async function () {
			this.timeout(15000);
			commands.npc.multisetup.call(context, `random, smart, ${format}`, null, user);
			assert(boxes[0].includes('Send Invitation'));
			assert(boxes[0].includes('No team selection needed'));
			const form = /data-submitsend="\/npc multi ([^"]+)"/.exec(boxes[0])[1];
			await commands.npc.multi.call(context, form.replace('{teammate}', teammate.id), null, user);
			assert.deepEqual(errors, []);
			const challenge = challenges.search(user.id, teammate.id);
			assert.equal(challenge.format, format);
			assert.equal(challenge.acceptButton, 'Accept & Battle');
			assert.equal(challenge.acceptCommand, `/npc acceptmulti ${user.id}`);
			assert(teammate.messages.some(m => m.includes(`/challenge ${format}||`)));
			assert.equal(generated, 0);
			assert.equal(created.length, 0);
			await commands.npc.acceptmulti.call(context, user.id, null, teammate);
			assert.deepEqual(errors, []);
			assert.equal(challenges.search(user.id, teammate.id), null);
			assert.equal(created.length, 1);
			assert.equal(generated, 2);
			assert.equal(battleRoom.npcMultiBattle.difficulty, 'smart');
			assert.equal(created[0].players[0].user, user);
			assert.equal(created[0].players[2].user, teammate);
			assert.equal(created[0].players[1].user.avatar, NPC.get('norman').avatar);
			assert.deepEqual(user.joined, [battleRoom]);
			assert.deepEqual(teammate.joined, [battleRoom]);
			assert.equal(new Set(created[0].players.map(p => p.team)).size, 4);
			for (const [index, players] of [[0, [1, 3]], [1, [0, 2]]]) {
				const roster = rosters[index];
				assert.equal(Dex.formats.get(roster.format).gameType, 'multi');
				assert.equal(Dex.forFormat(roster.format).currentMod, Dex.forFormat(format).currentMod);
				assert.equal(roster.team.length, 6);
				const assigned = players.flatMap(i => Teams.unpack(created[0].players[i].team));
				assert.equal(new Set(assigned.map(p => Dex.forFormat(format).species.get(p.species).baseSpecies)).size, 6);
				assert.equal(Teams.pack(assigned), Teams.pack([...roster.team.slice(1), roster.team[0]]),
					'Both players receive exactly the shuffled roster, preserving sets and levels');
			}
			completeBattle(created[0]);
		});
	}

	it('should ignore existing selected teams and default to Gen 9 Smart', async () => {
		user.battleSettings.team = teammate.battleSettings.team = Teams.pack(Teams.generate('gen9randombattle'));
		await commands.npc.multi.call(context, `random, ${teammate.id}`, null, user);
		await commands.npc.acceptmulti.call(context, user.id, null, teammate);
		assert.deepEqual(errors, []);
		assert.equal(created[0].format, 'gen9multirandombattle');
		for (const p of created[0].players) assert.equal(Teams.unpack(p.team).length, 3);
	});

	it('should preserve fixed NPC setup, team requirements and team validation', async () => {
		commands.npc.multisetup.call(context, 'maxie, smart', null, user);
		assert(boxes[0].includes('/npc multi maxie, {teammate}, smart, gen9nationaldexmulti'));
		await commands.npc.multi.call(context, `maxie, ${teammate.id}, smart`, null, user);
		assert(errors.pop().includes('select a team'));
		Object.assign(user.battleSettings, { team: Teams.pack([{ species: 'Pikachu', ability: 'Static', evs: { spa: 252, spe: 252, hp: 4 }, moves: ['thunderbolt'] }]) });
		await commands.npc.multi.call(context, `maxie, ${teammate.id}, smart`, null, user);
		assert.equal(challenges.search(user.id, teammate.id).acceptButton, 'Accept & Select Team');
		await commands.npc.acceptmulti.call(context, user.id, null, teammate);
		assert(errors.pop().includes('select a team'));
		Object.assign(teammate.battleSettings, { team: user.battleSettings.team });
		await commands.npc.acceptmulti.call(context, user.id, null, teammate);
		assert.deepEqual(errors, []);
		assert.equal(generated, 0);
		assert.equal(created[0].format, 'gen9nationaldexmulti');
		const validated = Teams.unpack(user.battleSettings.team);
		assert.equal(new TeamValidator('gen9nationaldexmulti').validateTeam(validated), null);
		assert.equal(created[0].players[0].team, Teams.pack(validated));
		assert.equal(created[0].players[2].team, Teams.pack(validated));
		const invalid = await createNPCMultiBattle({
			user, teammate, npcId: 'maxie', format: 'gen9nationaldexmulti',
			team: user.battleSettings.team,
			teammateTeam: Teams.pack([{ species: 'Pikachu', ability: 'Static', moves: ['notamove'] }]),
		});
		assert.equal(invalid.success, false);
		assert(invalid.error.includes('validation failed'));
	});

	it('should reject self-invites, offline teammates, invalid formats and unsupported difficulty', async () => {
		for (const target of [
			`random, ${user.id}`, 'random, missinguser',
			`random, ${teammate.id}, smart, gen9ou`, `random, ${teammate.id}, basic`,
		]) {
			await commands.npc.multi.call(context, target, null, user);
			assert(errors.pop());
		}
		teammate.connected = false;
		await commands.npc.multi.call(context, `random, ${teammate.id}`, null, user);
		assert(errors.pop().includes('not online'));
		assert.equal(generated, 0);
		assert.equal(created.length, 0);
	});

	it('should reject duplicate, wrong-recipient and cancelled invitations without generating teams', async () => {
		await commands.npc.multi.call(context, `random, ${teammate.id}`, null, user);
		await commands.npc.multi.call(context, `random, ${teammate.id}`, null, user);
		assert(errors.pop().includes('already a pending challenge'));
		await commands.npc.acceptmulti.call(context, teammate.id, null, user);
		assert(errors.pop().includes('No pending'));
		challenges.remove(challenges.search(user.id, teammate.id));
		await commands.npc.acceptmulti.call(context, user.id, null, teammate);
		assert(errors.pop().includes('No pending'));
		assert.equal(generated, 0);
		assert.equal(created.length, 0);
	});

	it('should discard the invitation if its sender disconnects', async () => {
		await commands.npc.multi.call(context, `random, ${teammate.id}`, null, user);
		Object.assign(user, { connected: false });
		await commands.npc.acceptmulti.call(context, user.id, null, teammate);
		assert(errors.pop().includes('no longer online'));
		assert.equal(challenges.search(user.id, teammate.id), null);
		assert.equal(generated, 0);
	});

	it('should require the Multi entry point and a teammate', async () => {
		const options = { user, npcId: 'norman', format: 'gen9multirandombattle' };
		assert.equal((await createNPCBattle(options)).success, false);
		assert.equal((await createNPCMultiBattle(options)).success, false);
		assert.equal(generated, 0);
		assert.equal(created.length, 0);
	});
});
