'use strict';
const fs = require('fs');
const path = require('path');

function summarize(rows) {
	const groups = new Map();
	for (const row of rows.filter(r => r.kind !== 'process')) {
		const reason = (row.reasoning || []).join('; ');
		const mode = /only retained action/.test(reason) ? 'single-candidate' :
			/Search fallback|replacement fallback/i.test(reason) ? 'fallback' :
			/Two-turn search|Replacement search/.test(reason) ? 'search' : 'other';
		const key = `${row.difficulty}/${row.side}/${row.kind}/${mode}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(row.milliseconds);
	}
	return {
		groups: [...groups].map(([group, times]) => {
			times.sort((a, b) => a - b);
			const quantile = q => times[Math.max(0, Math.ceil(q * times.length) - 1)];
			return { group, count: times.length, median: quantile(0.5), p95: quantile(0.95),
				max: times.at(-1), total: times.reduce((a, b) => a + b, 0) };
		}),
		// This is an inspection order, not an anomaly threshold or a strategy verdict.
		slowest: rows.filter(r => r.kind !== 'process').sort((a, b) => b.milliseconds - a.milliseconds),
	};
}
if (require.main === module) {
	if (!process.argv[2]) throw new Error('Usage: node test/npc/sim-battle/summarize-decisions.js TIMING_DIR');
	const rows = fs.readdirSync(process.argv[2]).filter(f => f.endsWith('.jsonl')).flatMap(file =>
		fs.readFileSync(path.join(process.argv[2], file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
	console.log(JSON.stringify(summarize(rows), null, 2));
}
module.exports = { summarize };
