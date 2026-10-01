/**
 * 战斗追踪器测试 / Battle Tracker Tests
 * 测试场地状态追踪、boost追踪、切换清除等
 */

const { section, test, assertEqual, assert } = require('./test-utils');

function runBattleTrackerTests() {
	const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');

	// =============================================================================
	// BattleTracker 测试 / BATTLE TRACKER TESTS
	// =============================================================================

	section('战斗追踪器场地状态解析 / BattleTracker Side Condition Parsing');

	// 测试 "move: Stealth Rock" 格式
	test('应正确解析 "move: Stealth Rock" 格式 / Parse "move: Stealth Rock" format', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-sidestart|p1: Opponent|move: Stealth Rock');
		const conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.stealthrock, true, '隐形岩应被追踪');
	});

	// 测试普通 "Stealth Rock" 格式
	test('应正确解析普通 "Stealth Rock" 格式 / Parse plain "Stealth Rock" format', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-sidestart|p1: Opponent|Stealth Rock');
		const conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.stealthrock, true, '隐形岩应被追踪');
	});

	// 测试 Spikes 层数追踪
	test('应正确解析撒菱层数 / Parse Spikes layers correctly', () => {
		const tracker = createBattleTracker('p2');

		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		let conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.spikes, 1, '撒菱第1层');

		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.spikes, 2, '撒菱第2层');

		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.spikes, 3, '撒菱第3层(满)');

		// 超过上限应保持3层
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.spikes, 3, '撒菱上限3层');
	});

	// 测试我方场地状态追踪
	test('应分开追踪我方场地状态 / Track our side conditions separately', () => {
		const tracker = createBattleTracker('p2');

		// 对手在我方场地设置隐形岩
		tracker.parseMessage('|-sidestart|p2: Player|move: Stealth Rock');

		const opponentConditions = tracker.getOpponentSideConditions();
		assertEqual(opponentConditions.stealthrock, false, '对手场地不应有隐形岩');

		const ourConditions = tracker.getOurSideConditions();
		assertEqual(ourConditions.stealthrock, true, '我方场地应有隐形岩');
	});

	// 测试清除场地状态
	test('应正确处理 -sideend / Handle -sideend correctly', () => {
		const tracker = createBattleTracker('p2');

		tracker.parseMessage('|-sidestart|p1: Opponent|move: Stealth Rock');
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');
		tracker.parseMessage('|-sidestart|p1: Opponent|Spikes');

		let conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.stealthrock, true, '隐形岩已设置');
		assertEqual(conditions.spikes, 2, '撒菱2层');

		tracker.parseMessage('|-sideend|p1: Opponent|Stealth Rock');
		tracker.parseMessage('|-sideend|p1: Opponent|Spikes');

		conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.stealthrock, false, '隐形岩已清除');
		assertEqual(conditions.spikes, 0, '撒菱已清除');
	});

	// =============================================================================
	// 我方 boost 追踪测试 / OUR SIDE BOOST TRACKING TESTS
	// =============================================================================

	section('我方 boost 追踪 / Our Side Boost Tracking');

	// 追踪我方 boost 增加
	test('应追踪我方 boost 增加 / Track our boost increases (Swords Dance)', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 2, '我方攻击应为+2');
	});

	// 追踪多次 boost
	test('应追踪多次 boost 增加 / Track multiple boost increases', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 4, '我方攻击应为+4');
	});

	// boost 上限 +6
	test('boost 上限应为 +6 / Cap boosts at +6', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 6, '我方攻击应上限为+6');
	});

	// 追踪 unboost
	test('应追踪 unboost (威吓) / Track unboost (Intimidate)', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-unboost|p2a: Lucario|atk|1');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 1, '我方攻击应为+1');
	});

	// 处理 clearboost
	test('应处理 clearboost (黑雾) / Handle clearboost (Haze)', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|4');
		tracker.parseMessage('|-boost|p2a: Lucario|spe|2');
		tracker.parseMessage('|-clearboost|p2a: Lucario');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 0, 'clearboost 后攻击应为0');
		assertEqual(boosts.spe, 0, 'clearboost 后速度应为0');
	});

	// 不混淆对手和我方的 boost
	test('不应混淆对手和我方的 boosts / Don\'t mix opponent boosts with ours', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p1a: Garchomp|atk|2'); // 对手
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 0, '我方攻击应仍为0');
	});

	// 追踪不同属性
	test('应独立追踪不同属性 / Track different stats independently', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2a: Lucario|spe|1');
		tracker.parseMessage('|-boost|p2a: Lucario|def|1');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 2, '攻击应为+2');
		assertEqual(boosts.spe, 1, '速度应为+1');
		assertEqual(boosts.def, 1, '防御应为+1');
		assertEqual(boosts.spa, 0, '特攻应为0');
	});

	// 双打中追踪 slot b
	test('应追踪双打中 slot b 的 boosts / Track slot b in doubles', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-boost|p2a: Lucario|atk|2');
		tracker.parseMessage('|-boost|p2b: Dragapult|spa|2');
		const boostsA = tracker.getOurActiveBoosts('a');
		const boostsB = tracker.getOurActiveBoosts('b');
		assertEqual(boostsA.atk, 2, '槽位a攻击应为+2');
		assertEqual(boostsB.spa, 2, '槽位b特攻应为+2');
		assertEqual(boostsB.atk, 0, '槽位b攻击应为0');
	});

	// 默认 boost 为 0
	test('未追踪槽位应返回零 boost / Return zero boosts for untracked slot', () => {
		const tracker = createBattleTracker('p2');
		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 0, '默认攻击应为0');
		assertEqual(boosts.def, 0, '默认防御应为0');
	});

	// 隐形岩追踪仍然正常工作
	test('隐形岩追踪仍正常工作 / Stealth Rock tracking still works', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-sidestart|p1: Opponent|move: Stealth Rock');
		const conditions = tracker.getOpponentSideConditions();
		assertEqual(conditions.stealthrock, true, '隐形岩应为true');
	});

	// =============================================================================
	// 切换清除 boost 测试 / SWITCH CLEARS BOOST TESTS
	// =============================================================================

	section('切换清除 boost / Switch Clears Boosts');

	// 切换清除我方 boost
	test('切换时应清除我方 boost / Clear our boosts when we switch out', () => {
		const tracker = createBattleTracker('p2');

		tracker.parseMessage('|-boost|p2a: Lucario|atk|4');
		tracker.parseMessage('|-boost|p2a: Lucario|spe|2');

		let boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 4, '切换前攻击应为+4');
		assertEqual(boosts.spe, 2, '切换前速度应为+2');

		tracker.parseMessage('|switch|p2a: Garchomp|Garchomp, L50, M|100/100');

		boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 0, '切换后攻击应为0');
		assertEqual(boosts.spe, 0, '切换后速度应为0');
	});

	// 对手切换不影响我方 boost
	test('对手切换不应影响我方 boost / Opponent switch doesn\'t affect our boosts', () => {
		const tracker = createBattleTracker('p2');

		tracker.parseMessage('|-boost|p2a: Lucario|atk|4');
		tracker.parseMessage('|switch|p1a: Garchomp|Garchomp, L50, M|100/100');

		const boosts = tracker.getOurActiveBoosts('a');
		assertEqual(boosts.atk, 4, '对手切换后攻击应仍为+4');
	});

	// 双打中只清除切换槽位的 boost
	test('双打中只应清除切换槽位的 boost / Only clear switched slot boosts in doubles', () => {
		const tracker = createBattleTracker('p2');

		tracker.parseMessage('|-boost|p2a: Lucario|atk|4');
		tracker.parseMessage('|-boost|p2b: Dragapult|spa|4');

		tracker.parseMessage('|switch|p2a: Garchomp|Garchomp, L50|100/100');

		const boostsA = tracker.getOurActiveBoosts('a');
		const boostsB = tracker.getOurActiveBoosts('b');

		assertEqual(boostsA.atk, 0, '槽位a攻击应为0');
		assertEqual(boostsB.spa, 4, '槽位b特攻应保持+4');
	});

	// =============================================================================
	// Quark Drive / Protosynthesis 追踪测试
	// =============================================================================

	section('Quark Drive / Protosynthesis 追踪');

	// Quark Drive ATK boost
	test('应追踪 Quark Drive ATK boost / Track Quark Drive ATK boost', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-start|p2a: Iron Hands|quarkdriveatk');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, 'atk', '属性应为atk');
		assert(Math.abs(mod.multiplier - 1.3) < 0.01, `倍率应约为1.3, 实际为${mod.multiplier}`);
	});

	// Quark Drive SPE boost (1.5x)
	test('应追踪 Quark Drive SPE boost (1.5x) / Track Quark Drive SPE with 1.5x multiplier', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-start|p2a: Iron Bundle|quarkdrivespe');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, 'spe', '属性应为spe');
		assertEqual(mod.multiplier, 1.5, '速度倍率应为1.5');
	});

	// Protosynthesis SPA boost
	test('应追踪 Protosynthesis SPA boost / Track Protosynthesis SPA boost', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-start|p2a: Flutter Mane|protosynthesisspa');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, 'spa', '属性应为spa');
		assert(Math.abs(mod.multiplier - 1.3) < 0.01, `倍率应约为1.3, 实际为${mod.multiplier}`);
	});

	// Quark Drive 结束时清除
	test('Quark Drive 结束时应清除 / Clear Quark Drive when it ends', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-start|p2a: Iron Hands|quarkdriveatk');
		tracker.parseMessage('|-end|p2a: Iron Hands|Quark Drive');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, null, '结束后属性应为null');
	});

	// 切换清除能力属性加成
	test('切换时应清除能力属性加成 / Clear ability stat mod when switching', () => {
		const tracker = createBattleTracker('p2');
		tracker.parseMessage('|-start|p2a: Iron Hands|quarkdriveatk');
		tracker.parseMessage('|switch|p2a: Garchomp|Garchomp, L50, M|100/100');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, null, '切换后属性应为null');
	});

	// 默认能力属性加成
	test('未追踪槽位应返回默认能力属性加成 / Return default ability stat mod for untracked slot', () => {
		const tracker = createBattleTracker('p2');
		const mod = tracker.getOurAbilityStatMod('a');
		assertEqual(mod.stat, null, '默认属性应为null');
		assertEqual(mod.multiplier, 1, '默认倍率应为1');
	});

	// =============================================================================
	// Multi Battle boost 追踪测试
	// =============================================================================

	section('Multi Battle boost 追踪 / Multi Battle Boost Tracking');

	// 测试 p2 的 boost 追踪 (应该工作)
	test('Multi: 应追踪 p2 的威吓 unboost / Track p2 Intimidate unboost in multi battle', () => {
		const tracker = createBattleTracker('p2', true); // isMulti = true
		tracker.parseMessage('|-unboost|p2a: Tyranitar|atk|1');
		const boosts = tracker.getOurActiveBoosts('p2a');
		assertEqual(boosts.atk, -1, 'p2 攻击应为 -1');
	});

	// 测试 p4 的 boost 追踪 (可能有问题)
	test('Multi: 应追踪 p4 的威吓 unboost / Track p4 Intimidate unboost in multi battle', () => {
		const tracker = createBattleTracker('p2', true); // isMulti = true
		tracker.parseMessage('|-unboost|p4a: Garchomp|atk|1');
		const boosts = tracker.getOurActiveBoosts('p4a');
		assertEqual(boosts.atk, -1, 'p4 攻击应为 -1');
	});

	// 测试 p2 和 p4 同时被威吓
	test('Multi: 应同时追踪 p2 和 p4 的 unboost / Track both p2 and p4 unboosts', () => {
		const tracker = createBattleTracker('p2', true);
		tracker.parseMessage('|-unboost|p2a: Tyranitar|atk|1');
		tracker.parseMessage('|-unboost|p4a: Garchomp|atk|1');

		const p2Boosts = tracker.getOurActiveBoosts('p2a');
		const p4Boosts = tracker.getOurActiveBoosts('p4a');

		assertEqual(p2Boosts.atk, -1, 'p2 攻击应为 -1');
		assertEqual(p4Boosts.atk, -1, 'p4 攻击应为 -1');
	});

	// 测试 p4 boost 增加
	test('Multi: 应追踪 p4 的剑舞 boost / Track p4 Swords Dance boost in multi battle', () => {
		const tracker = createBattleTracker('p2', true);
		tracker.parseMessage('|-boost|p4a: Garchomp|atk|2');
		const boosts = tracker.getOurActiveBoosts('p4a');
		assertEqual(boosts.atk, 2, 'p4 攻击应为 +2');
	});

	// 验证 ourTeamSides 包含 p4
	test('Multi: ourTeamSides 应包含 p2 和 p4 / ourTeamSides should contain p2 and p4', () => {
		const tracker = createBattleTracker('p2', true);
		// 通过追踪行为间接验证 - p4 boost 应该被追踪
		tracker.parseMessage('|-boost|p4a: Test|def|1');
		const boosts = tracker.getOurActiveBoosts('p4a');
		assertEqual(boosts.def, 1, 'p4 防御应为 +1，证明 p4 在 ourTeamSides 中');
	});
}

module.exports = { runBattleTrackerTests };
