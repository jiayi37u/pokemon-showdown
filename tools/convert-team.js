#!/usr/bin/env node
/**
 * PS Team to NPC JSON Converter
 *
 * Converts Pokemon Showdown team format to NPC JSON format
 * and optionally updates templates.json
 *
 * Usage:
 *   node tools/convert-team.js <input> <output> [options]
 *
 * Options:
 *   --npc <id>        NPC template ID (e.g., gymbrock)
 *   --format <fmt>    Battle format (e.g., gen9nationaldex)
 *   --mode <mode>     Team mode: singles, doubles, multi (default: singles)
 *   --no-update       Don't update templates.json
 *   --help            Show help
 *
 * Multi mode:
 *   In multi mode, the first 3 Pokemon are assigned to p2, the last 3 to p4.
 *
 * Examples:
 *   node tools/convert-team.js tmp_team.txt gym-brock-gen9ou.json --npc gymbrock --format gen9nationaldex --mode singles
 *   node tools/convert-team.js tmp_team.txt gym-brock-multi.json --npc gymbrock --format gen9nationaldexmulti --mode multi
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = 'data/npc';
const TEAMS_PATH = `${DATA_PATH}/teams`;
const TEMPLATES_PATH = `${DATA_PATH}/templates.json`;

// Stat name mapping
const STAT_NAMES = {
	'HP': 'hp', 'hp': 'hp',
	'Atk': 'atk', 'atk': 'atk', 'Attack': 'atk',
	'Def': 'def', 'def': 'def', 'Defense': 'def',
	'SpA': 'spa', 'spa': 'spa', 'Sp. Atk': 'spa', 'Special Attack': 'spa', 'SAtk': 'spa',
	'SpD': 'spd', 'spd': 'spd', 'Sp. Def': 'spd', 'Special Defense': 'spd', 'SDef': 'spd',
	'Spe': 'spe', 'spe': 'spe', 'Speed': 'spe',
};

function parseArgs() {
	const args = process.argv.slice(2);
	const options = {
		input: null,
		output: null,
		npc: null,
		format: null,
		mode: 'singles',
		update: true,
		help: false,
	};

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (arg === '--npc') {
			options.npc = args[++i];
		} else if (arg === '--format') {
			options.format = args[++i];
		} else if (arg === '--mode') {
			options.mode = args[++i];
		} else if (arg === '--no-update') {
			options.update = false;
		} else if (!arg.startsWith('-')) {
			if (!options.input) {
				options.input = arg;
			} else if (!options.output) {
				options.output = arg;
			}
		}
		i++;
	}

	return options;
}

function showHelp() {
	console.log(`
PS Team to NPC JSON Converter

Usage:
  node tools/convert-team.js <input> <output> [options]

Arguments:
  <input>             Input file path (PS format team text)
  <output>            Output file name (will be saved to data/npc/teams/)

Options:
  --npc <id>          NPC template ID (e.g., gymbrock)
  --format <fmt>      Battle format (e.g., gen9nationaldex)
  --mode <mode>       Team mode: singles, doubles, multi (default: singles)
  --no-update         Don't update templates.json
  --help              Show this help message

Multi mode:
  In multi mode, expects 6 Pokemon. First 3 are assigned to p2, last 3 to p4.

Examples:
  # Convert singles team
  node tools/convert-team.js tmp_team.txt gym-brock-gen9ou.json \\
    --npc gymbrock --format gen9nationaldex --mode singles

  # Convert multi battle team (6 Pokemon: first 3 -> p2, last 3 -> p4)
  node tools/convert-team.js tmp_team.txt gym-brock-multi.json \\
    --npc gymbrock --format gen9nationaldexmulti --mode multi
`);
}

/**
 * Parse PS team format text into PokemonSet array
 */
function parseTeam(text) {
	const pokemon = [];
	const blocks = text.trim().split(/\n\s*\n/);

	for (const block of blocks) {
		if (!block.trim()) continue;

		const lines = block.trim().split('\n');
		const set = parsePokemonBlock(lines);
		if (set) {
			pokemon.push(set);
		}
	}

	return pokemon;
}

/**
 * Parse a single Pokemon block
 */
function parsePokemonBlock(lines) {
	if (lines.length === 0) return null;

	const set = {
		species: '',
		ability: '',
		item: '',
		nature: '',
		evs: {},
		moves: [],
	};

	// Parse first line: "Name (Species) @ Item" or "Species @ Item"
	let firstLine = lines[0].trim();

	// Extract item
	const atIndex = firstLine.lastIndexOf(' @ ');
	if (atIndex !== -1) {
		set.item = firstLine.slice(atIndex + 3).trim();
		firstLine = firstLine.slice(0, atIndex).trim();
	}

	// Extract gender if present
	const genderMatch = firstLine.match(/\s*\((M|F)\)\s*$/);
	if (genderMatch) {
		set.gender = genderMatch[1];
		firstLine = firstLine.slice(0, genderMatch.index).trim();
	}

	// Extract species from parentheses or use the whole name
	const speciesMatch = firstLine.match(/\(([^)]+)\)\s*$/);
	if (speciesMatch) {
		set.species = speciesMatch[1].trim();
		set.name = firstLine.slice(0, speciesMatch.index).trim();
	} else {
		set.species = firstLine;
	}

	// Parse remaining lines
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();

		if (line.startsWith('Ability:')) {
			set.ability = line.slice(8).trim();
		} else if (line.startsWith('Tera Type:')) {
			set.teraType = line.slice(10).trim();
		} else if (line.startsWith('EVs:')) {
			set.evs = parseStats(line.slice(4));
		} else if (line.startsWith('IVs:')) {
			set.ivs = parseStats(line.slice(4));
		} else if (line.endsWith('Nature')) {
			set.nature = line.slice(0, -7).trim();
		} else if (line.startsWith('Level:')) {
			set.level = parseInt(line.slice(6).trim(), 10);
		} else if (line.startsWith('Shiny:')) {
			set.shiny = line.slice(6).trim().toLowerCase() === 'yes';
		} else if (line.startsWith('Happiness:')) {
			set.happiness = parseInt(line.slice(10).trim(), 10);
		} else if (line.startsWith('-') || line.startsWith('~')) {
			const move = line.slice(1).trim();
			if (move) {
				set.moves.push(move);
			}
		}
	}

	// Clean up empty/default fields
	if (!set.name) delete set.name;
	if (!set.item) delete set.item;
	if (!set.ability) delete set.ability;
	if (!set.nature) delete set.nature;
	if (!set.teraType) delete set.teraType;
	if (!set.gender) delete set.gender;
	if (!set.level) delete set.level;
	if (!set.shiny) delete set.shiny;
	if (set.happiness === undefined) delete set.happiness;
	if (Object.keys(set.evs).length === 0) delete set.evs;
	if (!set.ivs || Object.keys(set.ivs).length === 0) delete set.ivs;

	return set;
}

/**
 * Parse stat line like "252 HP / 252 Atk / 4 Spe"
 */
function parseStats(statLine) {
	const stats = {};
	const parts = statLine.split('/');

	for (const part of parts) {
		const match = part.trim().match(/^(\d+)\s+(.+)$/);
		if (match) {
			const value = parseInt(match[1], 10);
			const statName = match[2].trim();
			const statId = STAT_NAMES[statName];
			if (statId) {
				stats[statId] = value;
			}
		}
	}

	return stats;
}

/**
 * Compact evs, ivs objects and moves arrays to single line
 * Converts multi-line formatted fields to single-line for readability
 */
function compactPokemonFields(jsonStr) {
	// Compact "evs": { ... } to single line
	jsonStr = jsonStr.replace(/"evs": \{\s*\n\s*([^}]+)\s*\n\s*\}/g, (match, content) => {
		const compact = content.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
		return `"evs": { ${compact} }`;
	});

	// Compact "ivs": { ... } to single line
	jsonStr = jsonStr.replace(/"ivs": \{\s*\n\s*([^}]+)\s*\n\s*\}/g, (match, content) => {
		const compact = content.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
		return `"ivs": { ${compact} }`;
	});

	// Compact "moves": [ ... ] to single line (use [\s\S] to match across newlines)
	jsonStr = jsonStr.replace(/"moves": \[\s*\n([\s\S]*?)\n\s*\]/g, (match, content) => {
		const items = content.split('\n').map(line => line.trim()).filter(Boolean);
		return `"moves": [${items.join(' ')}]`;
	});

	return jsonStr;
}

/**
 * Update templates.json with new team file
 */
function updateTemplates(npcId, format, mode, teamFileName) {
	let templates = {};

	if (fs.existsSync(TEMPLATES_PATH)) {
		templates = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
	}

	if (!templates[npcId]) {
		console.log(`Warning: NPC "${npcId}" not found in templates.json, creating new entry`);
		templates[npcId] = {
			id: npcId,
			name: npcId,
			avatar: 'unknown',
			difficulty: 'smart',
			teams: {},
		};
	}

	const npc = templates[npcId];

	// Ensure teams structure exists
	if (!npc.teams) npc.teams = {};
	if (!npc.teams[mode]) npc.teams[mode] = {};
	if (!npc.teams[mode][format]) npc.teams[mode][format] = [];

	// Add team file if not already present
	const teamList = npc.teams[mode][format];
	if (!teamList.includes(teamFileName)) {
		teamList.push(teamFileName);
		console.log(`Added "${teamFileName}" to ${npcId}.teams.${mode}.${format}`);
	} else {
		console.log(`Team file "${teamFileName}" already exists in templates.json`);
	}

	// Write back
	fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(templates, null, 2) + '\n');
	console.log(`Updated ${TEMPLATES_PATH}`);
}

function main() {
	const options = parseArgs();

	if (options.help) {
		showHelp();
		process.exit(0);
	}

	if (!options.input || !options.output) {
		console.error('Error: Input and output files are required');
		showHelp();
		process.exit(1);
	}

	// Read input file
	if (!fs.existsSync(options.input)) {
		console.error(`Error: Input file not found: ${options.input}`);
		process.exit(1);
	}

	const inputText = fs.readFileSync(options.input, 'utf8');
	const pokemon = parseTeam(inputText);

	if (pokemon.length === 0) {
		console.error('Error: No Pokemon found in input file');
		process.exit(1);
	}

	console.log(`Parsed ${pokemon.length} Pokemon from ${options.input}`);

	// Add slot assignment for multi mode (first 3 -> p2, last 3 -> p4)
	if (options.mode === 'multi') {
		if (pokemon.length !== 6) {
			console.error(`Error: Multi mode requires exactly 6 Pokemon, got ${pokemon.length}`);
			process.exit(1);
		}
		for (let i = 0; i < pokemon.length; i++) {
			pokemon[i].slot = i < 3 ? 'p2' : 'p4';
		}
		console.log(`Assigned slots: first 3 Pokemon -> p2, last 3 Pokemon -> p4`);
	}

	// Build output JSON
	const output = {
		format: options.format || 'unknown',
		pokemon: pokemon,
	};

	// Ensure output directory exists
	if (!fs.existsSync(TEAMS_PATH)) {
		fs.mkdirSync(TEAMS_PATH, { recursive: true });
	}

	// Write output file
	const outputPath = path.join(TEAMS_PATH, options.output);
	let jsonStr = JSON.stringify(output, null, 2);
	// Compact evs, ivs objects and moves arrays to single line for readability
	jsonStr = compactPokemonFields(jsonStr);
	fs.writeFileSync(outputPath, jsonStr + '\n');
	console.log(`Wrote team to ${outputPath}`);

	// Update templates.json if requested
	if (options.update && options.npc && options.format) {
		updateTemplates(options.npc, options.format, options.mode, options.output);
	} else if (options.update && (!options.npc || !options.format)) {
		console.log('Skipping templates.json update (--npc and --format required)');
	}

	console.log('Done!');
}

main();
