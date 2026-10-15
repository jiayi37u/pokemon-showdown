'use strict';

const assert = require('../../assert');
const { NPC, NPC_RANDOM_FORMATS, NPC_RANDOM_MULTI_FORMATS } = require('../../../dist/server/npc/manager');
const { commands, pages } = require('../../../dist/server/chat-plugins/npc');

describe('NPC global random battle menu', () => {
	let originalRooms;
	let originalDifficulty;
	let originalGetRandom;
	let requests;
	let replies;
	let boxes;
	let errors;
	let joined;
	let user;
	let context;
	let selections;
	let battleRoom;

	before(() => NPC.loadTemplates());
	beforeEach(() => {
		originalRooms = global.Rooms;
		originalDifficulty = NPC.get('norman').difficulty;
		NPC.get('norman').difficulty = 'basic';
		battleRoom = { roomid: 'battle-npc-random-test', settings: {} };
		originalGetRandom = NPC.getRandom;
		requests = [];
		replies = [];
		boxes = [];
		errors = [];
		joined = [];
		selections = 0;
		user = { joinRoom: room => joined.push(room) };
		context = {
			sendReply: reply => replies.push(reply), sendReplyBox: html => boxes.push(html),
			errorReply: error => errors.push(error),
		};
		NPC.getRandom = () => {
			selections++;
			// Appearance selection must not change the globally selected difficulty.
			return NPC.get('norman');
		};
		global.Rooms = { createBattle: options => {
			requests.push(options);
			return battleRoom;
		} };
	});
	afterEach(() => {
		global.Rooms = originalRooms;
		NPC.get('norman').difficulty = originalDifficulty;
		NPC.getRandom = originalGetRandom;
	});

	it('should list supported random formats in a single NPC table row with a Challenge button', () => {
		const html = pages.npc.call({}, [], user);
		const rows = html.match(/<tr>[\s\S]*?<\/tr>/g);
		const randomRows = rows.filter(row => row.includes('value="/npc challenge random"'));
		assert.equal(randomRows.length, 1);
		assert(randomRows[0].includes('<strong>Random Battle</strong>'));
		for (const format of [...NPC_RANDOM_FORMATS, ...NPC_RANDOM_MULTI_FORMATS]) {
			assert(randomRows[0].includes(Dex.formats.get(format).name));
		}
		assert(!html.includes('value="/npc random '));
		for (const npc of NPC.getAll()) {
			assert.equal(npc.randomFormats, undefined);
			const row = rows.find(r => r.includes(`value="/npc challenge ${npc.id}"`));
			assert(row && !row.includes('Random Battle'));
			const detail = pages.npc.call({}, ['challenge', npc.id], user);
			assert(!detail.includes('randombattle'));
			for (const format of NPC.getSupportedFormats(npc.id).filter(f => !NPC_RANDOM_FORMATS.includes(f) && !f.includes('multi'))) {
				assert(detail.includes(`/npc start ${npc.id}, ${format},`));
			}
		}
	});

	for (const difficulty of ['basic', 'smart']) {
		it(`should carry ${difficulty} from Challenge through format selection to Battle`, async () => {
			commands.npc.challenge.call(context, 'random', null, user);
			assert.equal(errors.length, 0);
			assert.equal(boxes.length, 1);
			const select = `/npc challenge random, ${difficulty}`;
			assert(boxes[0].includes(`value="${select}"`));
			commands.npc.challenge.call(context, select.slice('/npc challenge '.length), null, user);
			const html = boxes[1];
			assert.equal(html, pages.npc.call({}, ['challenge', 'random', difficulty], user));
			assert(html.includes(`${difficulty === 'basic' ? 'Basic' : 'Smart'} ✓`));
			assert(!html.includes('requires team'));
			assert(html.includes('Multi Battle'));
			for (const format of NPC_RANDOM_MULTI_FORMATS) {
				assert(html.includes(`value="/npc multisetup random, smart, ${format}"`));
			}
			assert.equal(selections, 0);
			assert.equal(requests.length, 0);
			for (const format of NPC_RANDOM_FORMATS) {
				assert(html.includes(`value="/npc random ${format}, ${difficulty}"`));
			}
			const battleButton = /value="(\/npc random gen5pokemmorandombattle, [a-z]+)"/.exec(html)[1];
			await commands.npc.random.call(context, battleButton.slice('/npc random '.length), null, user);
			assert.equal(selections, 1);
			assert.equal(requests[0].format, 'gen5pokemmorandombattle');
			assert.equal(battleRoom.npcBattle.difficulty, difficulty);
			assert.deepEqual(joined, [battleRoom]);
		});
	}

	for (const [target, format, difficulty] of [
		['', 'gen9randombattle', 'smart'],
		['gen9randombattle', 'gen9randombattle', 'smart'],
		['gen5pokemmorandombattle', 'gen5pokemmorandombattle', 'smart'],
		['gen5pokemmorandombattle, basic', 'gen5pokemmorandombattle', 'basic'],
	]) {
		it(`should start ${target || 'the default format'} with a randomly chosen appearance`, async () => {
			await commands.npc.random.call(context, target, null, user);
			assert.equal(selections, 1);
			assert.equal(requests.length, 1);
			assert.equal(requests[0].format, format);
			assert.equal(battleRoom.npcBattle.npcId, 'norman');
			assert.equal(battleRoom.npcBattle.difficulty, difficulty);
			assert.equal(requests[0].players[1].user.avatar, NPC.get('norman').avatar);
			assert.deepEqual(errors, []);
			assert.deepEqual(joined, [battleRoom]);
			assert.deepEqual(replies, ['|redirect|/battle-npc-random-test']);
		});
	}

	for (const target of ['gen9ou', 'gen5pokemmorandombattle, impossible']) {
		it(`should reject ${target} before selecting an NPC or starting a battle`, async () => {
			await commands.npc.random.call(context, target, null, user);
			assert.equal(errors.length, 1);
			assert.equal(selections, 0);
			assert.equal(requests.length, 0);
		});
	}

	it('should report an empty NPC roster without starting a battle', async () => {
		NPC.getRandom = () => null;
		await commands.npc.random.call(context, 'gen5pokemmorandombattle', null, user);
		assert.deepEqual(errors, ['No NPCs available.']);
		assert.equal(requests.length, 0);
	});
});
