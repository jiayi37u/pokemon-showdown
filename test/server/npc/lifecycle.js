'use strict';

const assert = require('assert').strict;
const { Battle, Teams } = require('../../../dist/sim');
const { RoomBattle } = require('../../../dist/server/room-battle');
const { NPC } = require('../../../dist/server/npc/manager');
const { createNPCBattle, createNPCMultiBattle } = require('../../../dist/server/npc/room');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

const tick = () => new Promise(resolve => { setTimeout(resolve, 20); });
const npcTeam = [{ species: 'Mew', ability: 'Synchronize', moves: ['psychic', 'flamethrower'],
	nature: 'Modest', evs: { spa: 252, spe: 252 } }];
const userTeam = [{ species: 'Eevee', ability: 'Run Away', moves: ['tackle'],
	nature: 'Calm', evs: { hp: 252, spd: 252 } }];

describe('NPC battle lifecycle', () => {
	let originals, rooms, observed;
	const user = { id: 'npclifecycle', name: 'NPC Lifecycle', joinRoom() {} };
	beforeEach(() => {
		originals = { createBattle: Rooms.createBattle, get: NPC.get, supports: NPC.supportsFormat,
			getTeam: NPC.getTeam, getMultiTeam: NPC.getMultiTeam, setBattle: HardAI.prototype.setBattle, receive: HardAI.prototype.receiveRequest };
		rooms = []; observed = [];
		NPC.get = () => ({ id: 'lifecycle', name: 'Lifecycle', difficulty: 'hard' });
		NPC.supportsFormat = () => true;
		NPC.getTeam = () => npcTeam;
		NPC.getMultiTeam = () => ({ p2: npcTeam, p4: npcTeam });
		// Keep the real simulator and room end/destroy methods. Only user/room transport is stubbed.
		Rooms.createBattle = options => {
			const room = { roomid: options.roomid, settings: {}, add() {}, update() {} };
			const battle = Object.assign(Object.create(RoomBattle.prototype), {
				room, roomid: room.roomid, format: options.format, ended: false, turn: 0,
				players: [], timer: { end() {} }, checkActive() {},
			});
			room.battle = battle;
			const push = chunk => {
				const lines = chunk.split('\n');
				if (lines[0] === 'sideupdate' && lines[2]?.startsWith('|request|')) {
					const player = battle[lines[1]], request = JSON.parse(lines[2].slice(9));
					player.request = { request: JSON.stringify(request), rqid: ++player.rqid, isWait: !!request.wait };
				}
				if (lines[0] === 'end') battle.setEnded();
			};
			battle.stream = { push, destroy() {}, write(line) {
				const [, side, choice] = /^>(p[24]) (.+)$/.exec(line);
				assert(sim.choose(side, choice), sim[side].choice.error);
			} };
			const players = {};
			options.players.forEach((p, i) => {
				const side = `p${i + 1}`;
				players[side] = { name: p.user.name, team: p.team };
				battle[side] = { rqid: 0, request: {}, getUser() { return null; }, destroy() {} };
				battle.players.push(battle[side]);
			});
			const sim = new Battle({ formatid: options.format, seed: [1, 2, 3, 4], ...players,
				send(type, data) {
					battle.stream.push(`${type}\n${Array.isArray(data) ? data.join('\n') : data}`);
				},
			});
			rooms.push({ room, battle, sim, push });
			return room;
		};
		HardAI.prototype.setBattle = function (battle) {
			originals.setBattle.call(this, battle);
			observed.push({ ai: new WeakRef(this), tracker: new WeakRef(this.getTracker()),
				matchups: new WeakRef(this.matchups), damage: new WeakRef(this.matchups.damageCache),
				positions: new WeakRef(this.matchups.positions), decisions: 0, hits: 0 });
		};
		HardAI.prototype.receiveRequest = function (request) {
			const record = observed.find(r => r.ai.deref() === this);
			originals.receive.call(this, request);
			if (record && request.active) {
				assert.equal(this.matchups, record.matchups.deref(), 'Keep the same evaluator within a battle');
				assert.equal(this.matchups.damageCache, record.damage.deref(), 'Keep the same damage cache');
				record.decisions++;
				record.hits = this.matchups.damageCache.stats.hits;
				record.entries = this.matchups.damageCache.stats.entries;
			}
		};
	});
	afterEach(() => {
		for (const { battle, sim } of rooms) {
			if (!battle.ended) battle.setEnded();
			sim.destroy();
		}
		Rooms.createBattle = originals.createBattle;
		NPC.get = originals.get; NPC.supportsFormat = originals.supports; NPC.getTeam = originals.getTeam;
		NPC.getMultiTeam = originals.getMultiTeam;
		HardAI.prototype.setBattle = originals.setBattle;
		HardAI.prototype.receiveRequest = originals.receive;
	});

	async function start() {
		const result = await createNPCBattle({ user, npcId: 'lifecycle', format: 'gen6customgame',
			team: userTeam, difficulty: 'hard' });
		assert(result.success, result.error);
		return rooms[rooms.length - 1];
	}
	async function finish(game) {
		for (let i = 0; i < 300 && !game.sim.ended; i++) {
			if (!game.sim.p1.activeRequest.wait && !game.sim.p1.isChoiceDone()) game.sim.choose('p1', 'default');
			game.sim.sendUpdates();
			game.battle.turn = game.sim.turn;
			await tick();
		}
		game.sim.sendUpdates();
		assert(game.sim.ended, 'The real simulator must finish the battle');
		assert(game.battle.ended);
		assert.equal(game.battle.npcCleanup, undefined);
		assert.equal(game.battle.stream.push, game.push, 'Detach tracker without closing the room stream');
	}

	it('finishes two consecutive Hard battles, retains caches during play and detaches at each end', async function () {
		this.timeout(30000);
		for (let i = 0; i < 2; i++) {
			const game = await start();
			await finish(game);
			assert(observed[i].decisions >= 2, 'Exercise cache reuse across real turns');
			assert(observed[i].hits > 0 && observed[i].entries > 0);
		}
		assert.equal(rooms.length, 2, 'Both old rooms remain reachable');
	});

	it('collects the first battle AI and caches while the second battle and both rooms remain alive', async function () {
		if (!global.gc) this.skip(); // Run with mocha --expose-gc for reachability verification.
		this.timeout(30000);
		const first = await start();
		await finish(first);
		const second = await start();
		// WeakRef targets are kept alive within the job that dereferences them.
		await tick(); global.gc();
		await tick(); global.gc();
		for (const key of ['ai', 'tracker', 'matchups', 'damage', 'positions']) {
			assert.equal(observed[0][key].deref(), undefined, `Previous battle still retains ${key}`);
			assert(observed[1][key].deref(), `Running battle lost ${key}`);
		}
		await finish(second);
		await tick(); global.gc();
		await tick(); global.gc();
		for (const key of ['ai', 'tracker', 'matchups', 'damage', 'positions']) {
			assert.equal(observed[1][key].deref(), undefined, `Second battle still retains ${key}`);
		}
	});

	it('releases the controller when an unfinished room is destroyed', async () => {
		const game = await start();
		game.battle.destroy();
		assert.equal(game.battle.npcCleanup, undefined);
		assert.equal(game.battle.stream.push, game.push);
		await new Promise(resolve => { setTimeout(resolve, 550); });
		assert.equal(observed[0].decisions, 0, 'Cancelled initial polling must not make a decision');
	});

	it('releases the Multi manager and both controllers at battle end', async () => {
		const result = await createNPCMultiBattle({ user, teammate: { ...user, id: 'partner', name: 'Partner' },
			npcId: 'lifecycle', format: 'gen9nationaldexmulti', team: userTeam, teammateTeam: Teams.pack(userTeam), difficulty: 'hard' });
		assert(result.success, result.error);
		const game = rooms[0];
		const refs = (() => {
			const manager = game.room.npcMultiBattle.manager;
			assert(manager.running);
			const released = [manager, manager.controllers.p2, manager.controllers.p4,
				manager.controllers.p2.matchups, manager.controllers.p4.matchups].map(p => new WeakRef(p));
			game.battle.setEnded();
			assert.equal(game.room.npcMultiBattle.manager, undefined);
			assert.equal(game.battle.npcCleanup, undefined);
			assert.equal(manager.pollHandle, null);
			assert.equal(game.battle.stream.push, game.push);
			return released;
		})();
		if (global.gc) {
			await tick(); global.gc();
			await tick(); global.gc();
			assert(refs.every(ref => !ref.deref()), 'Multi controllers and caches must be collectible');
		}
	});

	it('detaches only the tracker and preserves the stream wrapper installed before it', () => {
		const forwarded = [], stream = { push(chunk) { forwarded.push(chunk); } };
		const push = stream.push, tracker = createBattleTracker('p2');
		tracker.attachToStream(stream);
		stream.push('|turn|2');
		tracker.detachFromStream();
		tracker.detachFromStream();
		assert.equal(stream.push, push);
		stream.push('|turn|3');
		assert.equal(tracker.getTurn(), 2);
		assert.deepEqual(forwarded, ['|turn|2', '|turn|3']);
	});
});
