/**
 * NPC Manager
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Manages NPC templates and teams for NPC battles.
 *
 * @license MIT
 */

import { FS } from '../../lib';
import type { PokemonSet } from '../../sim/teams';

/** NPC team configuration - supports multiple teams per format for random selection */
export interface NPCTeamConfig {
	/** Format-based team mapping, e.g., "gen9ou": ["team1.json", "team2.json"] */
	singles?: {
		[format: string]: string[];
	};
	/** Format-based doubles team mapping, e.g., "gen9doublesou": ["team1.json"] */
	doubles?: {
		[format: string]: string[];
	};
	/** Format-based multi team mapping, e.g., "gen9nationaldexmulti": ["team1.json"] */
	multi?: {
		[format: string]: string[];
	};
	/** Supported random battle formats, e.g., ["gen9randombattle", "gen8randombattle"] */
	randombattle?: string[];
}

/** Multi battle team with slot assignments */
export interface MultiTeam {
	p2: PokemonSet[];
	p4: PokemonSet[];
}

/** NPC template definition */
export interface NPCTemplate {
	id: string;
	name: string;
	avatar: string;
	title?: string;
	description?: string;
	difficulty: 'random' | 'basic' | 'smart' | 'expert';
	teams: NPCTeamConfig;
	customRules?: string[];
}

/** NPC team file format */
export interface NPCTeamFile {
	format: string;
	pokemon: PokemonSet[];
}

/**
 * Check if format is a doubles format
 */
function isDoublesFormat(format: string): boolean {
	return format.includes('doubles') || format.includes('vgc');
}

/**
 * Check if format is a multi battle format
 */
function isMultiFormat(format: string): boolean {
	return format.includes('multi');
}

/**
 * Check if format is a random battle format
 */
function isRandomBattleFormat(format: string): boolean {
	return format.includes('randombattle') || format.includes('randomdoubles');
}

/**
 * NPCManager - Manages NPC templates and teams
 */
export class NPCManager {
	/** Loaded templates */
	private templates: Map<string, NPCTemplate> = new Map();

	/** Data directory path */
	private readonly dataPath = 'data/npc';

	/** Number of loaded templates */
	get count(): number {
		return this.templates.size;
	}

	/**
	 * Load all NPC templates from templates.json
	 */
	loadTemplates(): void {
		try {
			const templatesPath = `${this.dataPath}/templates.json`;
			const data = FS(templatesPath).readIfExistsSync();

			if (!data) {
				console.log('[NPC] No templates.json found, skipping NPC initialization');
				return;
			}

			const templates = JSON.parse(data) as { [id: string]: NPCTemplate };

			this.templates.clear();
			for (const id in templates) {
				const template = templates[id];
				template.id = id; // Ensure id is set
				this.templates.set(id, template);
			}

			console.log(`[NPC] Loaded ${this.templates.size} NPC templates`);
		} catch (err) {
			console.error('[NPC] Failed to load templates:', err);
		}
	}

	/**
	 * Get a template by ID
	 */
	get(id: string): NPCTemplate | null {
		return this.templates.get(id) || null;
	}

	/**
	 * Get all templates
	 */
	getAll(): NPCTemplate[] {
		return Array.from(this.templates.values());
	}

	/**
	 * Get a random NPC template
	 */
	getRandom(): NPCTemplate | null {
		const templates = this.getAll();
		if (templates.length === 0) return null;
		return templates[Math.floor(Math.random() * templates.length)];
	}

	/**
	 * Check if NPC supports a format
	 */
	supportsFormat(npcId: string, format: string): boolean {
		const template = this.get(npcId);
		if (!template) return false;

		// Check random battle
		if (isRandomBattleFormat(format)) {
			return !!(template.teams.randombattle && template.teams.randombattle.includes(format));
		}

		// Check multi battle
		if (isMultiFormat(format)) {
			return !!(template.teams.multi && template.teams.multi[format]?.length > 0);
		}

		// Check doubles
		if (isDoublesFormat(format)) {
			return !!(template.teams.doubles && template.teams.doubles[format]?.length > 0);
		}

		// Check singles
		return !!(template.teams.singles && template.teams.singles[format]?.length > 0);
	}

	/**
	 * Get NPC team for a format (randomly selects from available teams)
	 */
	getTeam(npcId: string, format: string): PokemonSet[] | null {
		console.log(`[NPC] getTeam called: npcId=${npcId}, format=${format}`);

		const template = this.get(npcId);
		if (!template) {
			console.error(`[NPC] getTeam: Template not found for npcId=${npcId}`);
			console.log(`[NPC] getTeam: Available templates: ${Array.from(this.templates.keys()).join(', ')}`);
			return null;
		}

		console.log(`[NPC] getTeam: Template found: ${template.name}`);
		console.log(`[NPC] getTeam: Template teams config:`, JSON.stringify(template.teams, null, 2));

		// Random battle uses system generation
		if (isRandomBattleFormat(format)) {
			console.log(`[NPC] getTeam: Random battle format detected, returning null for system generation`);
			return null; // Signal to use random team generation
		}

		// Get team file list based on format type
		let teamFiles: string[] | undefined;

		if (isDoublesFormat(format)) {
			teamFiles = template.teams.doubles?.[format];
			console.log(`[NPC] getTeam: Checking doubles for format=${format}, teamFiles=${JSON.stringify(teamFiles)}`);
		} else {
			teamFiles = template.teams.singles?.[format];
			console.log(`[NPC] getTeam: Checking singles for format=${format}, teamFiles=${JSON.stringify(teamFiles)}`);
		}

		if (!teamFiles || teamFiles.length === 0) {
			console.error(`[NPC] getTeam: No team files found for format=${format}`);
			console.log(`[NPC] getTeam: Available singles formats: ${Object.keys(template.teams.singles || {}).join(', ')}`);
			console.log(`[NPC] getTeam: Available doubles formats: ${Object.keys(template.teams.doubles || {}).join(', ')}`);
			console.log(`[NPC] getTeam: Available multi formats: ${Object.keys(template.teams.multi || {}).join(', ')}`);
			return null;
		}

		// Randomly select a team from the list
		const teamFile = teamFiles[Math.floor(Math.random() * teamFiles.length)];
		console.log(`[NPC] getTeam: Selected team file: ${teamFile}`);

		// Load team file (no caching to allow random selection each time)
		try {
			const teamPath = `${this.dataPath}/teams/${teamFile}`;
			console.log(`[NPC] getTeam: Loading team from path: ${teamPath}`);
			const data = FS(teamPath).readIfExistsSync();

			if (!data) {
				console.error(`[NPC] Team file not found: ${teamPath}`);
				return null;
			}

			const teamData = JSON.parse(data) as NPCTeamFile;
			console.log(`[NPC] getTeam: Loaded ${teamData.pokemon.length} Pokemon from team file`);
			return teamData.pokemon;
		} catch (err) {
			console.error(`[NPC] Failed to load team for ${npcId}:`, err);
			return null;
		}
	}

	/**
	 * Get NPC multi-battle team for a format
	 * Returns teams for p2 and p4 positions based on slot assignments
	 * @param npcId - NPC template ID
	 * @param format - Battle format
	 * @returns MultiTeam with p2 and p4 arrays, or null if not found
	 */
	getMultiTeam(npcId: string, format: string): MultiTeam | null {
		const template = this.get(npcId);
		if (!template) return null;

		// Get multi team files
		const teamFiles = template.teams.multi?.[format];
		if (!teamFiles || teamFiles.length === 0) return null;

		// Randomly select a team from the list
		const teamFile = teamFiles[Math.floor(Math.random() * teamFiles.length)];

		try {
			const teamPath = `${this.dataPath}/teams/${teamFile}`;
			const data = FS(teamPath).readIfExistsSync();

			if (!data) {
				console.error(`[NPC] Multi team file not found: ${teamPath}`);
				return null;
			}

			const teamData = JSON.parse(data) as NPCTeamFile;
			const pokemon = teamData.pokemon;

			// Split by slot assignment
			const p2Team: PokemonSet[] = [];
			const p4Team: PokemonSet[] = [];

			for (const poke of pokemon) {
				const slot = (poke as any).slot;
				if (slot === 'p2') {
					// Remove slot field from team data (not needed in battle)
					const cleanPoke = { ...poke };
					delete (cleanPoke as any).slot;
					p2Team.push(cleanPoke);
				} else if (slot === 'p4') {
					const cleanPoke = { ...poke };
					delete (cleanPoke as any).slot;
					p4Team.push(cleanPoke);
				} else {
					// No slot assignment - default split: first 3 to p2, rest to p4
					console.warn(`[NPC] Pokemon ${poke.name || poke.species} has no slot assignment in multi team`);
				}
			}

			// Fallback: if no slot assignments, split evenly
			if (p2Team.length === 0 && p4Team.length === 0) {
				const half = Math.ceil(pokemon.length / 2);
				p2Team.push(...pokemon.slice(0, half));
				p4Team.push(...pokemon.slice(half));
			}

			// Validate team sizes (should be 3 each for multi)
			if (p2Team.length !== 3 || p4Team.length !== 3) {
				console.warn(`[NPC] Multi team has incorrect sizes: p2=${p2Team.length}, p4=${p4Team.length} (expected 3 each)`);
			}

			return { p2: p2Team, p4: p4Team };
		} catch (err) {
			console.error(`[NPC] Failed to load multi team for ${npcId}:`, err);
			return null;
		}
	}

	/**
	 * Get supported formats for an NPC
	 */
	getSupportedFormats(npcId: string): string[] {
		const template = this.get(npcId);
		if (!template) return [];

		const formats: string[] = [];

		// Check singles - iterate over all format keys
		if (template.teams.singles) {
			for (const format of Object.keys(template.teams.singles)) {
				if (template.teams.singles[format]?.length > 0) {
					formats.push(format);
				}
			}
		}

		// Check doubles - iterate over all format keys
		if (template.teams.doubles) {
			for (const format of Object.keys(template.teams.doubles)) {
				if (template.teams.doubles[format]?.length > 0) {
					formats.push(format);
				}
			}
		}

		// Check multi - iterate over all format keys
		if (template.teams.multi) {
			for (const format of Object.keys(template.teams.multi)) {
				if (template.teams.multi[format]?.length > 0) {
					formats.push(format);
				}
			}
		}

		// Check random battle - add all supported random formats
		if (template.teams.randombattle) {
			formats.push(...template.teams.randombattle);
		}

		return formats;
	}

	/**
	 * Reload templates
	 */
	reload(): void {
		this.loadTemplates();
	}
}

/** Global NPC manager instance */
export const NPC = new NPCManager();
