#!/usr/bin/env node
'use strict';

// Run node build first. Input: pokemon-core/data/strategies; output: local factual snapshots.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Dex } = require('../dist/sim/dex');

const fields = ['name', 'abilities', 'items', 'natures', 'moves', 'evs', 'ivs',
	'levels', 'teraTypes', 'gender', 'shiny', 'pokemon'];
const generations = { 4: 'dp', 5: 'bw', 6: 'xy', 7: 'sm', 8: 'ss', 9: 'sv' };

function convertStrategies(sourceDir, outputDir) {
	const outputs = [];
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).filter(e => e.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		const format = entry.name;
		const dex = Dex.forFormat(format);
		if (!Dex.formats.get(format).exists) throw new Error(`Unknown format: ${format}`);
		const raw = fs.readFileSync(path.join(sourceDir, format, 'pokemon.jsonl'));
		const rows = raw.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
		rows.sort((a, b) => dex.species.get(a.speciesId).num - dex.species.get(b.speciesId).num ||
			a.speciesId.localeCompare(b.speciesId));
		const species = {};
		for (const row of rows) {
			if (!dex.species.get(row.speciesId).exists || species[row.speciesId]) {
				throw new Error(`${format}: unknown or duplicate species ${row.speciesId}`);
			}
			species[row.speciesId] = row.sets.map(set => Object.fromEntries(
				fields.filter(field => set[field] !== undefined).map(field => [field, set[field]])
			));
		}
		outputs.push([`${format}.json`, JSON.stringify({
			format,
			source: `pokemon-core/data/strategies/${format}/pokemon.jsonl`,
			sourceSha256: createHash('sha256').update(raw).digest('hex'),
			reference: `https://www.smogon.com/dex/${generations[dex.gen]}/formats/${format.slice(4)}/`,
			species,
		}, null, 2) + '\n']);
	}
	fs.mkdirSync(outputDir, { recursive: true });
	for (const [name, content] of outputs) fs.writeFileSync(path.join(outputDir, name), content);
}

if (require.main === module) {
	const [sourceDir, outputDir = path.resolve(__dirname, '../data/npc/strategies')] = process.argv.slice(2);
	if (!sourceDir || process.argv.length > 4) {
		console.error('Usage: node tools/convert-npc-strategies.js <core-data-strategies-dir> [output-dir]');
		process.exitCode = 1;
	} else {
		convertStrategies(sourceDir, outputDir);
	}
}

module.exports = { convertStrategies };
