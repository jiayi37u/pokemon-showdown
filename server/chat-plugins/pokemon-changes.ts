/**
 * Pokemon Changes Command
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * View custom Pokemon stat changes from data/npc/balance-changes.md
 *
 * @license MIT
 */

import * as fs from 'fs';
import * as path from 'path';

interface PokemonChange {
	name: string;
	changes: string[];
}

/**
 * Normalize name for map key (supports Chinese)
 * Unlike toID(), this preserves Chinese characters
 */
function normalizeKey(name: string): string {
	return name.toLowerCase().replace(/\s+/g, '');
}

/**
 * Parse balance-changes.md and return all changes
 */
function parseChangelog(): Map<string, PokemonChange> {
	// Use process.cwd() since __dirname points to dist/ after compilation
	const changelogPath = path.resolve(process.cwd(), 'data/npc/balance-changes.md');
	const changes = new Map<string, PokemonChange>();

	try {
		const content = fs.readFileSync(changelogPath, 'utf8');
		const lines = content.split('\n');

		let currentPokemon: PokemonChange | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				// Empty line, save current pokemon if exists
				if (currentPokemon) {
					changes.set(normalizeKey(currentPokemon.name), currentPokemon);
					currentPokemon = null;
				}
				continue;
			}

			if (trimmed.startsWith('-') || trimmed.startsWith('–')) {
				// This is a change line
				if (currentPokemon) {
					currentPokemon.changes.push(trimmed);
				}
			} else {
				// This is a pokemon name
				if (currentPokemon) {
					changes.set(normalizeKey(currentPokemon.name), currentPokemon);
				}
				currentPokemon = {
					name: trimmed,
					changes: [],
				};
			}
		}

		// Don't forget the last pokemon
		if (currentPokemon) {
			changes.set(normalizeKey(currentPokemon.name), currentPokemon);
		}
	} catch (err) {
		// File not found or read error
	}

	return changes;
}

/**
 * Get Chinese name mapping (basic support)
 */
function getChineseName(id: string): string | null {
	// This is a simplified mapping, you can expand it
	const chineseNames: {[key: string]: string} = {
		'mightyena': '大狼犬',
		'camerupt': '喷火驼',
		'cacturne': '梦歌仙人掌',
	};
	return chineseNames[id] || null;
}

export const commands: Chat.ChatCommands = {
	pokemon改动: 'pokechanges',
	改动: 'pokechanges',
	changes: 'pokechanges',
	pokechanges(target, room, user) {
		if (!this.runBroadcast()) return;

		const changes = parseChangelog();

		if (changes.size === 0) {
			return this.sendReplyBox(`<div class="pad"><p>No Pokemon changes found.</p></div>`);
		}

		const targetTrimmed = target.trim();

		if (!targetTrimmed) {
			// Show all changed Pokemon
			let html = `<div class="pad">`;
			html += `<h2>Pokemon Stat Changes</h2>`;
			html += `<p>以下精灵有自定义改动 / The following Pokemon have custom changes:</p>`;
			html += `<div class="ladder"><table>`;
			html += `<tr><th>Pokemon</th><th>Changes</th></tr>`;

			for (const [id, pokemon] of changes) {
				const changesSummary = pokemon.changes.length > 0
					? pokemon.changes.slice(0, 3).join('<br/>') + (pokemon.changes.length > 3 ? '<br/>...' : '')
					: 'No details';

				html += `<tr>`;
				html += `<td><strong>${pokemon.name}</strong></td>`;
				html += `<td style="font-size:0.9em">${changesSummary}</td>`;
				html += `</tr>`;
			}

			html += `</table></div>`;
			html += `<p><small>使用 <code>/changes [精灵名称]</code> 查看具体改动</small></p>`;
			html += `</div>`;

			return this.sendReplyBox(html);
		}

		// Search for specific Pokemon
		// Try direct match with normalized key (supports Chinese)
		let pokemon = changes.get(normalizeKey(targetTrimmed));

		// If not found, try toID for English names
		if (!pokemon) {
			const targetId = toID(targetTrimmed);
			if (targetId) {
				// Search through all entries
				for (const [key, p] of changes) {
					if (toID(p.name) === targetId) {
						pokemon = p;
						break;
					}
				}
			}
		}

		// Also try Dex lookup to get the ID
		if (!pokemon) {
			const dexMon = Dex.species.get(targetTrimmed);
			if (dexMon.exists) {
				// Check Chinese name mapping
				const chineseName = getChineseName(dexMon.id);
				if (chineseName) {
					pokemon = changes.get(normalizeKey(chineseName));
				}
			}
		}

		if (!pokemon) {
			return this.errorReply(`未找到 "${targetTrimmed}" 的改动记录。使用 /changes 查看所有改动。`);
		}

		// Show specific Pokemon changes
		let html = `<div class="pad">`;
		html += `<h2>${pokemon.name} 改动</h2>`;

		if (pokemon.changes.length === 0) {
			html += `<p>No detailed changes recorded.</p>`;
		} else {
			html += `<ul>`;
			for (const change of pokemon.changes) {
				// Parse the change line: " - stat old - new"
				const match = change.match(/[-–]\s*(\w+)\s+(\d+)\s*[-–]\s*(\d+)/);
				if (match) {
					const [, stat, oldVal, newVal] = match;
					const diff = parseInt(newVal) - parseInt(oldVal);
					const diffStr = diff > 0 ? `<span style="color:green">+${diff}</span>` : `<span style="color:red">${diff}</span>`;
					html += `<li><strong>${stat}</strong>: ${oldVal} → ${newVal} (${diffStr})</li>`;
				} else {
					html += `<li>${change}</li>`;
				}
			}
			html += `</ul>`;
		}

		html += `<p><button class="button" name="send" value="/changes">查看所有改动</button></p>`;
		html += `</div>`;

		return this.sendReplyBox(html);
	},
};

export const commandsHelp: Chat.ChatCommands['help'] = {
	pokechanges: [
		`/changes - 查看所有有自定义改动的精灵`,
		`/changes [精灵名称] - 查看特定精灵的改动详情`,
		`支持中英文名称搜索`,
	],
};
