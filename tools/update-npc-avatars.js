'use strict';

// Refresh names and artist credits only; images remain hosted by Pokémon Showdown.
const fs = require('fs');
const path = require('path');
const SOURCE = 'https://play.pokemonshowdown.com/sprites/trainers/';

function parseTrainerDirectory(html) {
	const avatars = {};
	for (const [, id, body] of html.matchAll(/<figure id="([a-z0-9-]+)\.png">([\s\S]*?)<\/figure>/g)) {
		const credit = /<br\s*\/?>by ([^<]+)<\/figcaption>/.exec(body)?.[1].trim() || '';
		avatars[id] = credit;
	}
	if (!Object.hasOwn(avatars, 'brock')) {
		throw new Error('Trainer directory format not recognized; catalogue was not updated.');
	}
	return Object.fromEntries(Object.entries(avatars).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
	const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`Trainer directory returned HTTP ${response.status}`);
	const avatars = parseTrainerDirectory(await response.text());
	const catalogue = { source: SOURCE, updated: new Date().toISOString().slice(0, 10), avatars };
	fs.writeFileSync(
		path.resolve(__dirname, '../data/npc/trainer-avatars.json'), JSON.stringify(catalogue, null, 2) + '\n'
	);
	console.log(`Updated ${Object.keys(avatars).length} trainer avatars.`);
}

module.exports = { parseTrainerDirectory };
if (require.main === module) {
	main().catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
