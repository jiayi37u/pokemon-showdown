/**
 * Multi Battle 测试 / Multi Battle Tests
 * 测试多人组队对战 NPC 功能
 */

const { test, section, assert, assertEqual, getResults, resetResults, printSummary } = require('./test-utils');

// 加载模块
const { NPC } = require('../../../dist/server/npc/manager');

// 确保 NPC 模板已加载
NPC.loadTemplates();

section('Multi Battle - NPC 模板支持');

test('NPC 应支持 multi 格式', () => {
	const supported = NPC.supportsFormat('gymbrock', 'gen9nationaldexmulti');
	assert(supported, 'gymbrock should support gen9nationaldexmulti format');
});

test('NPC 不应支持未配置的 multi 格式', () => {
	const supported = NPC.supportsFormat('gymbrock', 'gen9multi');
	assert(!supported, 'gymbrock should not support unconfigured gen9multi format');
});

test('getSupportedFormats 应包含 multi 格式', () => {
	const formats = NPC.getSupportedFormats('gymbrock');
	assert(formats.includes('gen9nationaldexmulti'), 'getSupportedFormats should include gen9nationaldexmulti');
});

section('Multi Battle - 队伍加载与分割');

test('getMultiTeam 应返回 p2 和 p4 队伍', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	assert(multiTeam !== null, 'getMultiTeam should return a team');
	assert(Array.isArray(multiTeam.p2), 'multiTeam.p2 should be an array');
	assert(Array.isArray(multiTeam.p4), 'multiTeam.p4 should be an array');
});

test('p2 队伍应有 3 只精灵', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	assertEqual(multiTeam.p2.length, 3, 'p2 team should have 3 Pokemon');
});

test('p4 队伍应有 3 只精灵', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	assertEqual(multiTeam.p4.length, 3, 'p4 team should have 3 Pokemon');
});

test('队伍中应不含 slot 字段', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	for (const pokemon of multiTeam.p2) {
		assert(pokemon.slot === undefined, `p2 Pokemon ${pokemon.species} should not have slot field`);
	}
	for (const pokemon of multiTeam.p4) {
		assert(pokemon.slot === undefined, `p4 Pokemon ${pokemon.species} should not have slot field`);
	}
});

test('p2 队伍应包含正确的精灵', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	const p2Species = multiTeam.p2.map(p => p.species);
	assert(p2Species.includes('Tyranitar'), 'p2 should include Tyranitar');
	assert(p2Species.includes('Garganacl'), 'p2 should include Garganacl');
	assert(p2Species.includes('Great Tusk'), 'p2 should include Great Tusk');
});

test('p4 队伍应包含正确的精灵', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9nationaldexmulti');
	const p4Species = multiTeam.p4.map(p => p.species);
	assert(p4Species.includes('Excadrill'), 'p4 should include Excadrill');
	assert(p4Species.includes('Arcanine-Hisui'), 'p4 should include Arcanine-Hisui');
	assert(p4Species.includes('Amoonguss'), 'p4 should include Amoonguss');
});

test('getMultiTeam 对不支持的格式应返回 null', () => {
	const multiTeam = NPC.getMultiTeam('gymbrock', 'gen9multi');
	assert(multiTeam === null, 'getMultiTeam should return null for unsupported format');
});

test('getMultiTeam 对不存在的 NPC 应返回 null', () => {
	const multiTeam = NPC.getMultiTeam('nonexistent', 'gen9nationaldexmulti');
	assert(multiTeam === null, 'getMultiTeam should return null for nonexistent NPC');
});

section('Multi Battle - NPCMultiManager 构建');

// 测试 NPCMultiManager 的基本构建
const { NPCMultiManager } = require('../../../dist/server/npc/ai/multi-manager');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

test('NPCMultiManager 应能创建实例', () => {
	// 创建一个模拟的 battle 对象，包含必要的 stream 方法
	const mockBattle = {
		turn: 1,
		ended: false,
		p2: { request: null, active: [] },
		p4: { request: null, active: [] },
		sides: [],
		field: {},
		stream: {
			write: () => {},
			read: () => null,
			push: function(msg) { this.messages = this.messages || []; this.messages.push(msg); },
			messages: [],
		},
	};

	const manager = new NPCMultiManager(mockBattle, {
		battleId: 'test-battle',
		difficulty: 'smart',
	});

	assert(manager !== null, 'NPCMultiManager should be created');
	assert(typeof manager.start === 'function', 'NPCMultiManager should have start method');
	assert(typeof manager.stop === 'function', 'NPCMultiManager should have stop method');
});

section('Multi Battle - Boost 追踪完整流程');

test('NPCMultiManager tracker 应追踪 p2 和 p4 的 boost', () => {
	// 创建带 stream 的模拟 battle
	const mockBattle = {
		turn: 1,
		ended: false,
		p2: { request: null, active: [] },
		p4: { request: null, active: [] },
		sides: [],
		field: {},
		stream: {
			write: () => {},
			read: () => null,
			push: function(msg) { this.messages = this.messages || []; this.messages.push(msg); },
			messages: [],
		},
		format: 'gen9nationaldexmulti',
	};

	const manager = new NPCMultiManager(mockBattle, {
		battleId: 'boost-test',
		difficulty: 'smart',
	});

	// 获取 tracker (通过访问私有属性进行测试)
	const tracker = manager.tracker;
	assert(tracker !== undefined, 'manager should have tracker');

	// 模拟威吓消息
	tracker.parseMessage('|-unboost|p2a: Tyranitar|atk|1');
	tracker.parseMessage('|-unboost|p4a: Garchomp|atk|1');

	// 验证追踪
	const p2Boosts = tracker.getOurActiveBoosts('p2a');
	const p4Boosts = tracker.getOurActiveBoosts('p4a');

	assertEqual(p2Boosts.atk, -1, 'p2 攻击应为 -1');
	assertEqual(p4Boosts.atk, -1, 'p4 攻击应为 -1');
});

test('NPCMultiManager buildAIPokemon 应获取 p4 的 boost', () => {
	const mockBattle = {
		turn: 1,
		ended: false,
		p2: { request: null, active: [] },
		p4: { request: null, active: [] },
		sides: [],
		field: {},
		stream: {
			write: () => {},
			read: () => null,
			push: function(msg) {},
			messages: [],
		},
		format: 'gen9nationaldexmulti',
	};

	const manager = new NPCMultiManager(mockBattle, {
		battleId: 'boost-test-2',
		difficulty: 'smart',
	});

	// 先追踪 boost - 注意: PS 协议中 p4 使用 slot 'b'
	manager.tracker.parseMessage('|-unboost|p4b: Garchomp|atk|1');

	// 模拟 p4 的 request
	const p4Request = {
		side: {
			pokemon: [{
				ident: 'p4: Garchomp',
				details: 'Garchomp, L100, M',
				condition: '357/357',
				active: true,
				stats: { atk: 359, def: 245, spa: 196, spd: 206, spe: 333 },
				moves: ['earthquake', 'scaleshot', 'swordsdance', 'stoneedge'],
				baseAbility: 'roughskin',
				item: 'rockyhelmet',
				pokeball: 'pokeball',
				ability: 'roughskin',
			}],
		},
		active: [{
			moves: [
				{ move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16, target: 'allAdjacent', disabled: false },
				{ move: 'Scale Shot', id: 'scaleshot', pp: 32, maxpp: 32, target: 'normal', disabled: false },
				{ move: 'Swords Dance', id: 'swordsdance', pp: 32, maxpp: 32, target: 'self', disabled: false },
				{ move: 'Stone Edge', id: 'stoneedge', pp: 8, maxpp: 8, target: 'normal', disabled: false },
			],
		}],
	};

	// 调用 extractActivePokemon (私有方法，需要通过反射或直接测试)
	// 由于是私有方法，我们通过 buildVirtualDoublesState 间接测试
	// 先设置 pendingRequests
	manager.pendingRequests = {
		p4: { request: p4Request, rqid: 1 },
	};

	// 调用 buildVirtualDoublesState
	const state = manager.buildVirtualDoublesState(undefined, manager.pendingRequests.p4);

	// 验证 selfActive 中 p4 的 boost
	assert(state.self.active.length >= 1, 'should have at least 1 active Pokemon');

	const p4Pokemon = state.self.active[0];
	assertEqual(p4Pokemon.boosts.atk, -1, 'p4 Pokemon 攻击 boost 应为 -1');
});

test('只有 p4 request 时应能正确找到 attacker', () => {
	const mockBattle = {
		turn: 1,
		ended: false,
		p2: { request: null, active: [] },
		p4: { request: null, active: [] },
		sides: [],
		field: {},
		stream: {
			write: () => {},
			read: () => null,
			push: function(msg) {},
			messages: [],
		},
		format: 'gen9nationaldexmulti',
	};

	const manager = new NPCMultiManager(mockBattle, {
		battleId: 'slot-test',
		difficulty: 'smart',
	});

	// 只有 p4 的 request，没有 p2
	const p4Request = {
		side: {
			pokemon: [{
				ident: 'p4: Garchomp',
				details: 'Garchomp, L100, M',
				condition: '357/357',
				active: true,
				stats: { atk: 359, def: 245, spa: 196, spd: 206, spe: 333 },
				moves: ['earthquake', 'scaleshot', 'swordsdance', 'stoneedge'],
				baseAbility: 'roughskin',
				item: 'rockyhelmet',
				pokeball: 'pokeball',
				ability: 'roughskin',
			}],
		},
		active: [{
			moves: [
				{ move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16, target: 'allAdjacent', disabled: false },
			],
		}],
	};

	// 只传入 p4 request，p2 为 undefined
	const state = manager.buildVirtualDoublesState(undefined, { request: p4Request, rqid: 1 });

	// 验证 selfActive 应该有 1 个 Pokemon，且 slot 为 2 (p4)
	assertEqual(state.self.active.length, 1, 'should have 1 active Pokemon');
	assertEqual(state.self.active[0].slot, 2, 'p4 Pokemon slot should be 2');
	assertEqual(state.self.active[0].species, 'Garchomp', 'species should be Garchomp');
});

// 打印测试结果
printSummary();

module.exports = { runMultiBattleTests: () => getResults() };
