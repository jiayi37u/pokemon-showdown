'use strict';
// Optional Node preload for local benchmarks. Output is outside the repository by default.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { serialize } = require('v8');
const directory = process.env.NPC_TIMING_DIR || path.join(os.tmpdir(), 'npc-decision-timing');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, `${process.pid}.jsonl`);
const started = performance.now();
let sequence = 0;
for (const [difficulty, name] of [['hard', 'HardAI'], ['normal', 'NormalAI']]) {
	const Controller = require(`../../../dist/server/npc/ai/${difficulty}`)[name];
	const receive = Controller.prototype.receiveRequestWithState;
	Controller.prototype.receiveRequestWithState = function (request, state, ...args) {
		const side = request.side?.id;
		const measured = !request.wait && !request.teamPreview;
		const snapshot = measured && process.env.NPC_CAPTURE_DIR ?
			path.join(process.env.NPC_CAPTURE_DIR, `${process.pid}-${++sequence}.bin`) : undefined;
		if (snapshot) {
			fs.mkdirSync(path.dirname(snapshot), { recursive: true });
			// Capture the actual production input before decision mutation. Never read the opposing team.
			fs.writeFileSync(snapshot, serialize({ difficulty, request, state, args,
				seed: this.prng.getSeed(), config: this.configCFRU,
				lastSwitchTurn: this.lastSwitchTurn, sacrificePlans: this.sacrificePlans,
				lastMoves: [...(this.sacrificePlans?.values() || [])].map(p =>
					[p.position, this.getTracker().getOurLastMove(p.position)]),
			}));
		}
		const choose = this.choose;
		let choice;
		if (measured) this.choose = function (value) { choice = value; return choose.call(this, value); };
		const start = performance.now();
		try {
			return receive.call(this, request, state, ...args);
		} finally {
			const milliseconds = performance.now() - start;
			this.choose = choose;
			if (measured) {
				const entry = this.getLogger().getEntries().at(-1);
				fs.appendFileSync(output, JSON.stringify({ difficulty, side, turn: state.turn, milliseconds, snapshot, choice,
					actor: state.self.active[0]?.species, foe: state.opponent.active[0]?.species,
					kind: request.forceSwitch ? 'replacement' : 'action', reasoning: entry?.reasoning }) + '\n');
			}
		}
	};
}
process.on('exit', code => fs.appendFileSync(output, JSON.stringify({
	kind: 'process', exit: code, milliseconds: performance.now() - started,
	command: process.argv.slice(1),
}) + '\n'));
