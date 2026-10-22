'use strict';
// Optional Node preload for local benchmarks. Output is outside the repository by default.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const directory = process.env.NPC_TIMING_DIR || path.join(os.tmpdir(), 'npc-decision-timing');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, `${process.pid}.jsonl`);
const started = performance.now();
for (const [difficulty, name] of [['hard', 'HardAI'], ['normal', 'NormalAI']]) {
	const Controller = require(`../../../dist/server/npc/ai/${difficulty}`)[name];
	const receive = Controller.prototype.receiveRequestWithState;
	Controller.prototype.receiveRequestWithState = function (request, state, ...args) {
		const start = performance.now();
		try {
			return receive.call(this, request, state, ...args);
		} finally {
			const milliseconds = performance.now() - start;
			if (!request.wait && !request.teamPreview) {
				const entry = this.getLogger().getEntries().at(-1);
				fs.appendFileSync(output, JSON.stringify({ difficulty, turn: state.turn, milliseconds,
					kind: request.forceSwitch ? 'replacement' : 'action', reasoning: entry?.reasoning }) + '\n');
			}
		}
	};
}
process.on('exit', code => fs.appendFileSync(output, JSON.stringify({
	kind: 'process', exit: code, milliseconds: performance.now() - started,
	command: process.argv.slice(1),
}) + '\n'));
