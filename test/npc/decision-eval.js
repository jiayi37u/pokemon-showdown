'use strict';
const fs = require('fs');
const path = require('path');
const { serialize } = require('v8');
const { execFileSync } = require('child_process');
const { createBattleTracker } = require('../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateWithTracker } = require('../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../dist/server/npc/ai/cfru/types');
const { replay } = require('./sim-battle/replay-decision');

const directory = path.join(__dirname, 'decision-eval');
const cases = require('./decision-eval/cases.json');

/** Rebuild public evidence at each historical request, without rerunning past decisions. */
function buildFrame(input) {
	if (input.protocol.at(-1) !== `|turn|${input.turn}`) {
		throw new Error('Evaluation protocol must stop at the target turn, before either action');
	}
	const tracker = createBattleTracker(input.side);
	tracker.setFormat(input.format);
	const config = { ...DEFAULT_AI_CONFIG, formatId: input.format };
	const requests = new Map(input.requests.map(frame => [frame.turn, frame.request]));
	let request, state;
	for (const line of input.protocol) {
		tracker.parseMessage(line);
		if (!line.startsWith('|turn|')) continue;
		const turn = Number(line.split('|')[2]);
		request = requests.get(turn);
		if (!request) throw new Error(`Missing reconstructed request for turn ${turn}`);
		state = buildBattleStateWithTracker(request, { format: input.format, turn }, tracker, config);
	}
	return { difficulty: 'hard', request, state, args: [], config, seed: input.seed,
		lastSwitchTurn: new Map(input.lastSwitchTurn), sacrificePlans: new Map(),
		lastMoves: [[`${input.side}a`, tracker.getOurLastMove(`${input.side}a`)]] };
}

function grade(expectedMove, choice, request) {
	const match = /^move (\d+)(?: |$)/.exec(choice || '');
	const actualMove = match ? request.active[0].moves[Number(match[1]) - 1]?.id || null : null;
	return { actualMove, passed: actualMove === expectedMove };
}

function run(ids = []) {
	for (const id of ids) if (!cases.some(question => question.id === id)) throw new Error(`Unknown case: ${id}`);
	const selected = ids.length ? cases.filter(question => ids.includes(question.id)) : cases;
	const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: path.resolve(__dirname, '../..'), encoding: 'utf8',
	}).trim();
	const results = selected.map(question => {
		console.error(`Evaluating ${question.id}: ${question.actor}`);
		const input = JSON.parse(fs.readFileSync(path.join(directory, question.input), 'utf8'));
		// Labels are never passed to the production AI or state builder.
		const frame = buildFrame(input);
		if (frame.state.turn !== question.turn || frame.state.self.active[0].species !== question.actor) {
			throw new Error(`Input does not match the turn/actor for ${question.id}`);
		}
		const result = replay(serialize(frame));
		const verdict = grade(question.expectedMove, result.choice, frame.request);
		const reasoning = result.entry?.reasoning || [];
		const nodes = /\((\d+) nodes/.exec(reasoning.join('; '));
		console.error(`${question.id}: ${verdict.passed ? 'PASS' : 'FAIL'} (${result.choice})`);
		return { id: question.id, battle: question.battle, turn: question.turn, actor: question.actor,
			expectedMove: question.expectedMove, ...verdict, choice: result.choice,
			milliseconds: result.milliseconds, nodes: nodes ? Number(nodes[1]) : null,
			cache: result.cache, reconstruction: input.reconstruction, reasoning };
	});
	const passed = results.filter(result => result.passed).length;
	return { revision, nodeVersion: process.version, evaluatedAt: new Date().toISOString(),
		total: results.length, passed, failed: results.length - passed, accuracy: passed / results.length, results };
}

if (require.main === module) {
	// Tracker diagnostics go to stderr; stdout remains a machine-readable report.
	const log = console.log;
	let report;
	try {
		console.log = console.error;
		report = run(process.argv.slice(2));
	} finally {
		console.log = log;
	}
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = report.failed ? 1 : 0;
}

module.exports = { buildFrame, grade };
