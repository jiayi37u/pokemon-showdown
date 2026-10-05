#!/usr/bin/env node
/**
 * CFRU AI 综合测试运行器
 * Comprehensive Test Runner for CFRU AI
 *
 * Run all tests: node test/npc/ai/run-tests.js
 * Run specific test: node test/npc/ai/run-tests.js type-effectiveness
 *
 * 可用的测试模块 / Available test modules:
 * - type-effectiveness: 属性相克测试
 * - battle-tracker: 战斗追踪器测试
 * - multi-hit: 多次攻击伤害计算测试
 * - damage-calc: 伤害计算测试
 * - doubles-partner: 双打队友检查测试
 * - contact-moves: 接触招式风险测试
 * - positives: 正面评分测试
 * - negatives: 负面评分测试
 * - format-level: 格式等级解析测试
 */

console.log('=== CFRU AI Comprehensive Test / CFRU AI 综合测试 ===\n');

const { getResults, printSummary, resetResults } = require('./test-utils');

// 测试模块映射
const testModules = {
	'type-effectiveness': () => require('./type-effectiveness.test').runTypeEffectivenessTests(),
	'battle-tracker': () => require('./battle-tracker.test').runBattleTrackerTests(),
	'multi-hit': () => require('./multi-hit.test').runMultiHitTests(),
	'damage-calc': () => require('./damage-calc.test').runDamageCalcTests(),
	'ai-damage-calc': () => require('./ai-damage-calc.test').runAIDamageCalcTests(),
	'opponent-presets': () => require('./opponent-presets.test').runOpponentPresetTests(),
	'doubles-partner': () => require('./doubles-partner.test').runDoublesPartnerTests(),
	'contact-moves': () => require('./contact-moves.test').runContactMoveTests(),
	'positives': () => require('./positives.test').runPositivesScoringTests(),
	'negatives': () => require('./negatives.test').runNegativesScoringTests(),
	'switching': () => require('./switching.test').runSwitchingTests(),
	'multi-battle': () => require('./multi-battle.test').runMultiBattleTests(),
	'format-level': () => require('./format-level.test').runFormatLevelTests(),
};

// 获取命令行参数
const args = process.argv.slice(2);

// 如果指定了特定测试，只运行那些测试
if (args.length > 0) {
	for (const testName of args) {
		if (testModules[testName]) {
			console.log(`\n>>> Running: ${testName} <<<`);
			testModules[testName]();
		} else {
			console.log(`\n>>> Unknown test module: ${testName} <<<`);
			console.log('Available modules:', Object.keys(testModules).join(', '));
		}
	}
} else {
	// 运行所有测试
	for (const [name, runTest] of Object.entries(testModules)) {
		try {
			runTest();
		} catch (e) {
			console.log(`\n>>> Error in ${name}: ${e.message} <<<`);
			console.log(e.stack);
		}
	}
}

// 打印结果
printSummary();

const { passed, failed } = getResults();
process.exit(failed > 0 ? 1 : 0);
