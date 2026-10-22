'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Teams, Battle } = require('../../../dist/sim');
const { NPCLiveLog } = require('../../../dist/server/npc/live-log');
const { HardAI } = require('../../../dist/server/npc/ai/hard');

describe('Live NPC battle observation', () => {
	let root, log, stream, forwarded, info;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-live-test-'));
		forwarded = [];
		stream = {
			push(chunk) { forwarded.push(chunk); return true; },
			destroy() { return 'destroyed'; },
		};
		info = { roomid: 'battle-npc-live-test', format: 'gen6customgame', difficulty: 'hard', players: [
			{ side: 'p1', name: 'Player', team: Teams.pack([{ species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] }]) },
			{ side: 'p2', name: 'NPC', team: Teams.pack([{ species: 'Pikachu', ability: 'Static', moves: ['thunderbolt'] }]) },
		] };
		log = new NPCLiveLog(stream, info, root);
	});
	afterEach(() => { stream.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
	const read = (log, file) => fs.readFileSync(path.join(log.directory, file), 'utf8');

	it('writes teams separately and preserves only the public channel in the protocol log', () => {
		const chunk = 'update\n|turn|1\n|split|p2\n|-damage|p2a: Pikachu|37/301\n|-damage|p2a: Pikachu|13/100';
		assert.equal(stream.push(chunk), true);
		stream.push('sideupdate\np1\n|request|{"private":"request"}');
		assert.deepEqual(forwarded, [chunk, 'sideupdate\np1\n|request|{"private":"request"}']);
		assert.equal(read(log, 'battle.log'), '|turn|1\n|-damage|p2a: Pikachu|13/100\n');
		const metadata = JSON.parse(read(log, 'metadata.json'));
		assert.equal(metadata.players[0].team[0].species, 'Magikarp');
		assert.equal(metadata.players[1].team[0].moves[0], 'Thunderbolt');
		assert.equal(read(log, 'ai.jsonl'), '');
	});

	it('records real preview and scored Hard decisions alongside engine protocol before the battle ends', () => {
		const ai = new HardAI({ write() {} }, { seed: [1, 2, 3, 4], logging: { console: 0, file: 3 }, search: false });
		const room = { format: info.format, turn: 0, stream };
		ai.setBattle(room);
		const battle = new Battle({ formatid: info.format, seed: [1, 2, 3, 4],
			send(type, data) { stream.push(`${type}\n${Array.isArray(data) ? data.join('\n') : data}`); },
			p1: { name: 'Player', team: info.players[0].team }, p2: { name: 'NPC', team: info.players[1].team },
		});
		try {
			battle.sendUpdates();
			ai.choose = choice => {
				log.decision('p2', room.turn, choice, ai.getLogger().getEntries().slice(-1)[0]);
				assert(battle.choose('p2', choice), battle.p2.choice.error);
			};
			ai.receiveRequest(battle.p2.activeRequest);
			assert.equal(JSON.parse(read(log, 'ai.jsonl').trim()).choice, 'team 1');
			battle.choose('p1', 'default');
			battle.sendUpdates();
			room.turn = battle.turn;
			ai.receiveRequest(battle.p2.activeRequest);
			const events = read(log, 'ai.jsonl').trim().split('\n').map(JSON.parse);
			assert.equal(events[1].turn, 1);
			assert.equal(events[1].choice, 'move 1');
			assert(events[1].decision.scores[0].details.length);
			assert(events[1].decision.reasoning.length);
			assert(read(log, 'battle.log').includes('|turn|1'));
			assert(!battle.ended);
		} finally { battle.destroy(); }
	});

	it('records both Multi sides, target scores, choice errors and a single end marker', () => {
		log.decision('p2', 3, 'move 1 1', { scoresByTarget: new Map([['Mew', [{ score: 100 }]]]) });
		log.decision('p4', 3, 'switch 2');
		stream.push('sideupdate\np4\n|error|[Unavailable choice] Cannot switch');
		stream.push('end\n{}');
		assert.equal(stream.destroy(), 'destroyed');
		const events = read(log, 'ai.jsonl').trim().split('\n').map(JSON.parse);
		assert.deepEqual(events.map(e => e.type), ['decision', 'decision', 'error', 'ended']);
		assert.equal(events[0].decision.scoresByTarget.Mew[0].score, 100);
		assert.equal(events[1].side, 'p4');
		log.decision('p2', 4, 'move 2');
		assert.equal(read(log, 'ai.jsonl').trim().split('\n').length, 4);
	});

	it('keeps forwarding battle messages when recording fails', () => {
		fs.rmSync(log.directory, { recursive: true });
		const original = console.error;
		const errors = [];
		console.error = message => errors.push(message);
		try {
			stream.push('update\n|turn|1');
			stream.push('update\n|turn|2');
			assert.equal(errors.length, 1);
			assert.equal(forwarded.length, 2);
		} finally { console.error = original; }
	});
});
