'use strict';

const assert = require('assert').strict;
const { NPC } = require('../../../dist/server/npc/manager');
const { pages: battlePages } = require('../../../dist/server/chat-plugins/npc');
const { searchTrainerAvatars } = require('../../../dist/server/npc/trainer-avatars');
const { parseTrainerDirectory } = require('../../../tools/update-npc-avatars');

describe('NPC template administration', () => {
	let commands, pages;
	let originals, templates, writes, reloads, errors, joined, user, context, connection, updates;
	const clone = value => JSON.parse(JSON.stringify(value));
	const render = (...query) => pages.npcadmin.call({}, query, user);
	const save = target => commands.npcadmin.save.call(context, target, null, user);
	const unlock = () => commands.npcadmin.unlock.call(context, '963741', null, user);

	before(() => {
		({ commands, pages } = require('../../../dist/server/chat-plugins/npc-admin'));
	});

	beforeEach(() => {
		templates = {
			gymbrock: {
				id: 'gymbrock', name: 'Brock', avatar: 'brock', description: 'Rock trainer',
				title: 'Pewter Gym Leader', difficulty: 'hard',
				teams: ['gym-brock-gen9nationaldex.json'], customRules: ['!Species Clause'],
			},
		};
		writes = 0;
		reloads = 0;
		errors = [];
		joined = [];
		updates = [];
		connection = { send: message => updates.push(message) };
		user = { id: 'npctemplateadmin' };
		context = {
			sendReply() {},
			errorReply: message => errors.push(message),
			parse: command => joined.push(command),
		};
		const replacements = {
			readTemplatesRaw: () => clone(templates),
			writeTemplates: value => {
				writes++;
				templates = clone(value);
			},
			reload: () => reloads++,
			get: id => templates[id] || null,
			getAll: () => Object.values(templates),
			getSupportedFormats: () => [],
		};
		originals = {};
		for (const key of Object.keys(replacements)) {
			originals[key] = NPC[key];
			NPC[key] = replacements[key];
		}
	});

	afterEach(() => {
		commands.npcadmin.lock.call(context, '', null, user);
		Object.assign(NPC, originals);
	});

	it('requires an unlocked session for both creation and editing', () => {
		for (const target of ['|新 NPC|brock|描述', 'gymbrock|新名称|brock|描述']) {
			assert.throws(() => save(target), /管理功能已锁定/);
		}
		assert(!render('npcnew').includes('data-submitsend="/npcadmin save'));
		assert(!render('npcedit', 'gymbrock').includes('data-submitsend="/npcadmin save'));
		assert.equal(writes, 0);
		unlock();
		commands.npcadmin.lock.call(context, '', null, user);
		assert.throws(() => save('gymbrock|新名称|brock|描述'), /管理功能已锁定/);
	});

	it('creates NPCs with stable generated IDs and connects the form to team creation', () => {
		unlock();
		for (const [, pattern] of render('npcnew').matchAll(/ pattern="([^"]+)"/g)) {
			assert.doesNotThrow(() => new RegExp(pattern, 'v'));
		}
		const form = /data-submitsend="([^"]+)"/.exec(render('npcnew'))[1];
		const command = form.replace('{name}', '小刚').replace('{avatar}', 'brock')
			.replace('{description}', '第一行\n第二行 | 岩石');
		save(command.slice('/npcadmin save '.length));
		const created = templates.npc1;
		assert.deepEqual(created, {
			id: 'npc1', name: '小刚', avatar: 'brock', description: '第一行\n第二行 | 岩石',
			difficulty: 'smart', teams: [],
		});
		assert.equal(joined.at(-1), '/j view-npcadmin-npcedit-npc1');
		const edit = render('npcedit', 'npc1');
		assert(edit.includes('为此 NPC 添加队伍'));
		assert(edit.includes('/view-npcadmin-new-npc1'));
		assert(!edit.includes('name="id"'));
		assert(!edit.includes('name="difficulty"'));
		assert(render('new', 'npc1').includes('<option value="npc1" selected>小刚</option>'));
		save('|小刚|brock|另一位同名 NPC');
		assert.equal(templates.npc2.name, '小刚');
		assert.deepEqual(templates.npc1, created);
		assert.equal(writes, 2);
		assert.equal(reloads, 2);
		assert.deepEqual(errors, []);
	});

	it('edits only the three requested fields, preserving identity, difficulty and team bindings', () => {
		unlock();
		const before = clone(templates.gymbrock);
		save('gymbrock|岩石馆主|brock|新描述');
		assert.deepEqual(templates.gymbrock, {
			...before, name: '岩石馆主', avatar: 'brock', description: '新描述',
		});
		assert.equal(Object.keys(templates).length, 1);
		assert.equal(reloads, 1);
		save('gymbrock|岩石馆主|maxie-gen3|');
		assert.equal(templates.gymbrock.description, '');
		assert.equal(templates.gymbrock.avatar, 'maxie-gen3');
		assert.equal(templates.gymbrock.difficulty, 'hard');
	});

	it('rejects stale IDs and invalid input without writing or reloading', () => {
		unlock();
		for (const target of [
			'missing|名字|brock|描述', '__proto__|名字|brock|描述',
			'|名字|brock', '| |brock|描述', `|${'名'.repeat(51)}|brock|描述`,
			'|名字\n换行|brock|描述', '|名字||描述', '|名字|../brock|描述',
			'|名字|https://example.com/avatar.png|描述', `|名字|brock|${'字'.repeat(2001)}`,
		]) {
			const count = errors.length;
			save(target);
			assert.equal(errors.length, count + 1, target);
		}
		assert.equal(writes, 0);
		assert.equal(reloads, 0);
		assert(render('npcedit', 'missing').includes('NPC 不存在'));
	});

	it('escapes editable text in admin and player pages without displaying ID labels', () => {
		unlock();
		save('gymbrock|<b>小刚</b>|brock|</textarea><script>alert(1)</script>');
		const edit = render('npcedit', 'gymbrock');
		assert(edit.includes('&lt;b&gt;小刚&lt;&#x2f;b&gt;'));
		assert(!edit.includes('<script>'));
		const overview = render();
		assert(!overview.includes('<b>小刚</b>'));
		assert(!overview.includes('(gymbrock)'));
		assert(!render('new').includes('(gymbrock)'));
		for (const query of [[], ['challenge', 'gymbrock']]) {
			const html = battlePages.npc.call({}, query, user);
			assert(html.includes('&lt;b&gt;小刚&lt;&#x2f;b&gt;'));
			assert(!html.includes('<script>'));
		}
		assert(Chat.multiLinePattern.test('/npcadmin save |小刚|brock|第一行\n第二行'));
	});

	it('previews the current avatar and searches all seven Brock variants', () => {
		unlock();
		const html = render('npcedit', 'gymbrock');
		assert(html.includes('name="avatar" value="brock"'));
		assert(html.includes('alt="brock" width="80" height="80"'));
		assert(html.includes('placeholder="输入英文名称，例如 brock"'));
		const expected = ['brock', 'brock-gen1', 'brock-gen1rb', 'brock-gen2', 'brock-gen3', 'brock-lgpe', 'brock-masters'];
		assert.deepEqual(searchTrainerAvatars('BROCK').ids, expected);
		assert.deepEqual(searchTrainerAvatars('brock gen3').ids, ['brock-gen3']);
		assert(searchTrainerAvatars('brcok').ids.includes('brock'));
		assert(searchTrainerAvatars('rock-gen3').ids.includes('brock-gen3'));
		const searchForm = /data-submitsend="(\/npcadmin avatarsearch [^"]+)"/.exec(html)[1];
		commands.npcadmin.avatarsearch.call(context, searchForm.replace('{query}', 'brock')
			.slice('/npcadmin avatarsearch '.length), null, user, connection);
		assert(updates[0].startsWith('>view-npcadmin-npcedit-gymbrock\n|selectorhtml|#npc-avatar-results|'));
		for (const id of expected) {
			assert(updates[0].includes(`/npcadmin avatarselect gymbrock|${id}`));
			assert(updates[0].includes(`src="https://play.pokemonshowdown.com/sprites/trainers/${id}.png"`));
		}
		assert(updates[0].includes('by kyledove'));
		assert(!updates[0].includes('|pagehtml|'));
		assert.equal(writes, 0);
		assert.equal(reloads, 0);
	});

	it('caps results at ten, explains empty searches, and keeps the selected avatar during searches', () => {
		unlock();
		for (const query of ['', 'a', 'gen']) {
			commands.npcadmin.avatarsearch.call(context, `gymbrock|${query}`, null, user, connection);
			const result = updates.at(-1);
			assert.equal((result.match(/name="send"/g) || []).length, 10);
			assert(!result.includes('name="avatar"'));
		}
		assert.equal(searchTrainerAvatars('zzzznomatchingtrainerzzzz').total, 0);
		assert.equal(searchTrainerAvatars('小刚').total, 0);
		commands.npcadmin.avatarsearch.call(context, 'gymbrock|<script>', null, user, connection);
		assert(!updates.at(-1).includes('<script>'));
		commands.npcadmin.avatarsearch.call(context, 'gymbrock|zzzznomatchingtrainerzzzz', null, user, connection);
		assert(updates.at(-1).includes('没有找到匹配的头像'));
		assert.equal(writes, 0);
	});

	it('selects an avatar by updating only the form field and preview, then persists it on save', () => {
		unlock();
		const html = render('npcedit', 'gymbrock');
		const choice = /value="(\/npcadmin avatarselect gymbrock\|brock-gen3)"/.exec(html)[1];
		commands.npcadmin.avatarselect.call(context, choice.slice('/npcadmin avatarselect '.length), null, user, connection);
		const selection = updates.at(-1);
		assert(selection.startsWith('>view-npcadmin-npcedit-gymbrock\n|selectorhtml|#npc-avatar-selection|'));
		assert(selection.includes('name="avatar" value="brock-gen3"'));
		assert(selection.includes('alt="brock-gen3"'));
		assert(!selection.includes('name="name"'));
		assert(!selection.includes('name="description"'));
		assert(!selection.includes('|pagehtml|'));
		assert.equal(templates.gymbrock.avatar, 'brock');
		assert.equal(writes, 0);
		assert.equal(reloads, 0);
		const avatar = /name="avatar" value="([^"]+)"/.exec(selection)[1];
		save(`gymbrock|未保存的名字|${avatar}|未保存的描述`);
		assert.equal(templates.gymbrock.name, '未保存的名字');
		assert.equal(templates.gymbrock.description, '未保存的描述');
		assert.equal(templates.gymbrock.avatar, 'brock-gen3');
		assert.equal(reloads, 1);
	});

	it('supports the new-NPC picker and rejects locked or forged selections', () => {
		for (const action of ['avatarsearch', 'avatarselect']) {
			assert.throws(() => commands.npcadmin[action].call(context, '|brock', null, user, connection), /管理功能已锁定/);
		}
		unlock();
		commands.npcadmin.avatarsearch.call(context, '|maxie', null, user, connection);
		assert(updates.at(-1).startsWith('>view-npcadmin-npcnew\n|selectorhtml|#npc-avatar-results|'));
		commands.npcadmin.avatarselect.call(context, '|maxie-gen3', null, user, connection);
		assert(updates.at(-1).includes('name="avatar" value="maxie-gen3"'));
		const count = updates.length;
		for (const target of ['|../brock', '|not-a-trainer', '|<img>', 'missing|brock', 'gymbrock\n|brock']) {
			commands.npcadmin.avatarselect.call(context, target, null, user, connection);
		}
		commands.npcadmin.avatarsearch.call(context, `gymbrock|${'a'.repeat(101)}`, null, user, connection);
		assert.equal(errors.length, 6);
		assert.equal(updates.length, count);
		assert.equal(writes, 0);
	});

	it('retains catalogue artist credits and rejects an unexpected directory response', () => {
		assert.deepEqual(parseTrainerDirectory(
			'<figure id="brock.png"><figcaption><a href="brock.png">brock</a></figcaption></figure>' +
			'<figure id="brock-lgpe.png"><figcaption><a href="brock-lgpe.png">brock-lgpe</a><br />by kyledove</figcaption></figure>'
		), { brock: '', 'brock-lgpe': 'kyledove' });
		assert.throws(() => parseTrainerDirectory('<html>Service unavailable</html>'), /not recognized/);
	});
});
