'use strict';

// Paired gen7 OU comparison using the production runner and the checked-in sample teams.
// Usage: node test/npc/sim-battle/compare.js [seed-count=10] [output-directory]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const count = Number(process.argv[2] || 10);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('seed-count must be an integer from 1 to 100');
const root = path.resolve(__dirname, '../../..');
const output = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), 'npc-compare-'));
fs.mkdirSync(output, { recursive: true });
const results = [];
for (let seed = 1; seed <= count; seed++) {
	for (const team of [1, 2]) {
		for (const p1 of ['normal', 'hard']) {
			const id = `${seed}-${team}-${p1}`;
			const args = [
				'dist/test/npc/sim-battle/runner.js', '--format', 'gen7ou', '--game-type', 'singles',
				'--player', `test/npc/sim-battle/sample-teams/sample_team_${team}_gen7ou.txt`,
				'--npc', `test/npc/sim-battle/sample-teams/sample_team_${3 - team}_gen7ou.txt`,
				'--p1-strategy', 'mirror-npc', '--p1-difficulty', p1,
				'--npc-difficulty', p1 === 'hard' ? 'normal' : 'hard',
				'--seed', `${seed},2,3,4`, '--max-turns', '300', '--log-level', 'DECISION',
			];
			const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000,
				maxBuffer: 16 * 1024 * 1024 });
			fs.writeFileSync(path.join(output, `${id}.log`), result.stdout || '');
			fs.writeFileSync(path.join(output, `${id}.err`), result.stderr || '');
			if (result.error || result.status !== 0) throw new Error(`${id} failed; inspect ${output}: ${result.error || result.stderr}`);
			const win = /^\|win\|(.+)$/m.exec(result.stdout);
			const turns = [...result.stdout.matchAll(/^\|turn\|(\d+)$/gm)];
			const capped = result.stderr.includes('maxTurns=');
			const tie = /^\|tie(?:\||$)/m.test(result.stdout);
			if (!win && !capped && !tie) throw new Error(`${id} did not finish; inspect ${output}`);
			const winner = win ? ((win[1] === 'Player') === (p1 === 'hard') ? 'hard' : 'normal') : capped ? 'capped' : 'tie';
			results.push({ seed, p1Team: team, p1Difficulty: p1, winner, turns: Number(turns[turns.length - 1]?.[1] || 0) });
		}
	}
}
const summary = { format: 'gen7ou', seeds: count, games: results.length, output,
	wins: Object.fromEntries(['hard', 'normal', 'tie', 'capped'].map(name =>
		[name, results.filter(r => r.winner === name).length])), results };
fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
