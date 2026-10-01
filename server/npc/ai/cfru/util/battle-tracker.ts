/**
 * CFRU AI - Battle State Tracker
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Tracks opponent Pokemon information from battle protocol messages.
 * This is necessary because in server environment, the Battle object
 * runs in a separate process and is not directly accessible.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';

/**
 * Tracked Pokemon information
 */
export interface TrackedPokemon {
	/** Species name */
	species: string;

	/** Pokemon types */
	types: string[];

	/** Pokemon level (parsed from details, defaults to 100) */
	level: number;

	/** Known ability (may be empty if not revealed) */
	ability: string;

	/** Known item (may be empty if not revealed) */
	item: string;

	/**
	 * Whether we know for sure the item was lost (consumed/knocked off)
	 * true = confirmed no item (saw -enditem message)
	 * false = item unknown or item is known to exist
	 */
	itemLost: boolean;

	/** Current HP percentage (0-100) */
	hpPercent: number;

	/** Status condition (empty if none) */
	status: string;

	/** Known moves (revealed through battle) */
	knownMoves: string[];

	/** Last move used (for Encore/Disable evaluation) */
	lastMove: string;

	/** Is currently active */
	active: boolean;

	/** Position identifier (e.g., 'p1a', 'p1b' for doubles) */
	position: string;

	/** Stat boosts (-6 to +6) */
	boosts: {
		atk: number;
		def: number;
		spa: number;
		spd: number;
		spe: number;
		accuracy: number;
		evasion: number;
	};
}

/**
 * Battle Tracker - Monitors battle protocol messages to track opponent state
 *
 * Usage:
 * ```typescript
 * const tracker = new BattleTracker('p2');  // We are p2
 * tracker.attachToStream(battle.stream);
 *
 * // Later, get opponent info
 * const opponent = tracker.getActiveOpponent();
 * if (opponent) {
 *     console.log(opponent.types, opponent.ability, opponent.item);
 * }
 * ```
 */
export class BattleTracker {
	/** Which player we are (p1 or p2) */
	private readonly ourSide: 'p1' | 'p2';

	/** Which player is opponent */
	private readonly opponentSide: 'p1' | 'p2';

	/** Tracked opponent Pokemon (keyed by position like 'p1a', 'p1b') */
	private opponentPokemon: Map<string, TrackedPokemon> = new Map();

	/** All known opponent Pokemon (keyed by species for team tracking) */
	private opponentTeam: Map<string, TrackedPokemon> = new Map();

	/** Field conditions */
	private fieldConditions: {
		weather: string;
		terrain: string;
		trickRoom: boolean;
	} = { weather: '', terrain: '', trickRoom: false };

	/** Opponent side conditions */
	private opponentSideConditions: {
		stealthrock: boolean;
		spikes: number;
		toxicspikes: number;
		stickyweb: boolean;
		reflect: number;
		lightscreen: number;
		auroraveil: number;
		tailwind: number;
	} = {
		stealthrock: false,
		spikes: 0,
		toxicspikes: 0,
		stickyweb: false,
		reflect: 0,
		lightscreen: 0,
		auroraveil: 0,
		tailwind: 0,
	};

	/** Our side conditions (for tracking hazards on our side) */
	private ourSideConditions: {
		stealthrock: boolean,
		spikes: number,
		toxicspikes: number,
		stickyweb: boolean,
		reflect: number,
		lightscreen: number,
		auroraveil: number,
		tailwind: number,
	} = {
		stealthrock: false,
		spikes: 0,
		toxicspikes: 0,
		stickyweb: false,
		reflect: 0,
		lightscreen: 0,
		auroraveil: 0,
		tailwind: 0,
	};

	/**
	 * Our active Pokemon boosts (tracked from stream messages)
	 * Keyed by position slot ('a', 'b' for doubles)
	 */
	private ourActiveBoosts: Map<string, {
		atk: number,
		def: number,
		spa: number,
		spd: number,
		spe: number,
		accuracy: number,
		evasion: number,
	}> = new Map();

	/**
	 * Our active Pokemon ability stat modifiers (Quark Drive, Protosynthesis, etc.)
	 * These are multipliers (1.3 for non-speed, 1.5 for speed), not stage boosts
	 * Keyed by position slot ('a', 'b' for doubles)
	 */
	private ourAbilityStatMods: Map<string, {
		stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null,
		multiplier: number,
	}> = new Map();

	/**
	 * Our active Pokemon last move used (CFRU gLastResultingMoves[bankAtk])
	 * Keyed by position slot ('a', 'b' for doubles)
	 * Used for consecutive Protect detection
	 */
	private ourLastMove: Map<string, string> = new Map();

	/** Whether we've attached to a stream */
	private attached = false;

	/** Whether this is a multi battle */
	private isMultiBattle = false;

	/** Opponent sides (for multi battles: p1 & p3 or p2 & p4) */
	private opponentSides: Set<string>;

	/** Our team sides (for multi battles: p2 & p4 or p1 & p3) */
	private ourTeamSides: Set<string>;

	constructor(ourSide: 'p1' | 'p2' = 'p2', isMulti = false) {
		this.ourSide = ourSide;
		this.opponentSide = ourSide === 'p1' ? 'p2' : 'p1';
		this.isMultiBattle = isMulti;

		// In multi battles, track both opponent sides and our team sides
		// Team 1: p1 + p3, Team 2: p2 + p4
		if (isMulti) {
			if (ourSide === 'p1' || ourSide === 'p2') {
				// If we're p2 (or p1), opponents are p1 and p3 (or p2 and p4)
				this.opponentSides = new Set(ourSide === 'p2' ? ['p1', 'p3'] : ['p2', 'p4']);
				// Our team is the opposite
				this.ourTeamSides = new Set(ourSide === 'p2' ? ['p2', 'p4'] : ['p1', 'p3']);
			} else {
				this.opponentSides = new Set(['p1', 'p3']); // Default for p2/p4 perspective
				this.ourTeamSides = new Set(['p2', 'p4']);
			}
		} else {
			this.opponentSides = new Set([this.opponentSide]);
			this.ourTeamSides = new Set([this.ourSide]);
		}
	}

	/**
	 * Check if a side is an opponent
	 */
	private isOpponentSide(side: string): boolean {
		return this.opponentSides.has(side);
	}

	/**
	 * Check if a side is on our team (for multi battles: both p2 and p4)
	 */
	private isOurTeamSide(side: string): boolean {
		return this.ourTeamSides.has(side);
	}

	/**
	 * Attach to a battle stream to receive protocol messages
	 */
	attachToStream(stream: AnyObject): void {
		if (this.attached) return;
		this.attached = true;

		// Intercept stream.push to parse messages
		const originalPush = stream.push.bind(stream);
		stream.push = (chunk: string) => {
			if (chunk) {
				this.parseMessage(chunk);
			}
			return originalPush(chunk);
		};
	}

	/**
	 * Parse a battle protocol message
	 */
	parseMessage(message: string): void {
		const lines = message.split('\n');
		for (const line of lines) {
			this.parseLine(line);
		}
	}

	/**
	 * Parse a single protocol line
	 */
	private parseLine(line: string): void {
		if (!line.startsWith('|')) return;

		const parts = line.slice(1).split('|');
		const command = parts[0];

		switch (command) {
		case 'switch':
		case 'drag':
		case 'replace':
			this.handleSwitch(parts);
			break;
		case 'faint':
			this.handleFaint(parts);
			break;
		case '-ability':
			this.handleAbility(parts);
			break;
		case '-item':
		case '-enditem':
			this.handleItem(parts);
			break;
		case '-damage':
		case '-heal':
			this.handleHPChange(parts);
			break;
		case '-status':
			this.handleStatus(parts);
			break;
		case '-curestatus':
		case '-cureteam':
			this.handleCureStatus(parts);
			break;
		case 'move':
			this.handleMove(parts);
			break;
		case '-weather':
			this.handleWeather(parts);
			break;
		case '-fieldstart':
		case '-fieldend':
			this.handleField(parts);
			break;
		case '-boost':
		case '-unboost':
			this.handleBoost(parts);
			break;
		case '-setboost':
			this.handleSetBoost(parts);
			break;
		case '-clearboost':
		case '-clearallboost':
		case '-clearpositiveboost':
		case '-clearnegativeboost':
			this.handleClearBoost(parts);
			break;
		case '-sidestart':
		case '-sideend':
			this.handleSideCondition(parts);
			break;
		case '-start':
		case '-end':
			this.handleVolatileStatus(parts);
			break;
		}
	}

	/**
	 * Handle switch/drag/replace
	 * Format: |switch|p1a: Nickname|Species, L50, M|100/100
	 *
	 * IMPORTANT: When our Pokemon switches out, its boosts are reset to 0.
	 * CFRU: protectUses and lastMove are also reset when switching
	 */
	private handleSwitch(parts: string[]): void {
		const positionPart = parts[1]; // "p1a: Nickname"
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim(); // "p1a"
		const side = position.slice(0, 2); // "p1"
		const slot = position.slice(2); // "a" or "b"

		// CFRU AI Fix: Clear our team boosts, ability stat mods, and lastMove when we switch out
		// Switching resets all stat boosts to 0 and removes volatile statuses
		// In multi battles, this handles both p2 and p4 switches
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			this.ourActiveBoosts.set(boostKey, {
				atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
			});
			// Also clear ability stat mods (Quark Drive/Protosynthesis)
			this.ourAbilityStatMods.delete(boostKey);
			// Reset lastMove (CFRU: switching resets gDisableStructs)
			this.ourLastMove.set(boostKey, '');
			return; // Don't need to track our own Pokemon details
		}

		// Only track opponent details below (for multi: p1 AND p3)
		if (!this.isOpponentSide(side)) return;

		const detailPart = parts[2]; // "Species, L50, M"
		if (!detailPart) return;

		// Parse species and level from details
		// Format: "Species, L50, M" or "Species-Forme, L100, F" or "Species, L50" (no gender)
		const detailParts = detailPart.split(',').map(s => s.trim());
		const species = detailParts[0];

		// Parse level from "L50" or "L100" format, default to 100 (National Dex standard)
		let level = 100;
		for (const part of detailParts) {
			if (part.startsWith('L')) {
				const parsedLevel = parseInt(part.slice(1));
				if (!isNaN(parsedLevel)) {
					level = parsedLevel;
				}
				break;
			}
		}

		const hpPart = parts[3]; // "100/100" or "100/100 par"

		// Parse HP
		let hpPercent = 100;
		let status = '';
		if (hpPart) {
			const hpMatch = hpPart.match(/(\d+)\/(\d+)/);
			if (hpMatch) {
				hpPercent = (parseInt(hpMatch[1]) / parseInt(hpMatch[2])) * 100;
			}
			const statusMatch = hpPart.match(/\d+\/\d+\s+(\w+)/);
			if (statusMatch) {
				status = statusMatch[1];
			}
		}

		// Get species data
		const speciesData = Dex.species.get(species);
		const types = speciesData.types || [];

		// Check for known ability from species (if only one possible)
		let ability = '';
		const abilities = Object.values(speciesData.abilities || {});
		if (abilities.length === 1) {
			ability = abilities[0] as string;
		}

		// Create or update tracked Pokemon
		const tracked: TrackedPokemon = {
			species,
			types,
			level,
			ability,
			item: '',
			itemLost: false,  // Default: assume item exists but unknown
			hpPercent,
			status,
			knownMoves: [],
			lastMove: '',
			active: true,
			position,
			boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
		};

		// Deactivate previous Pokemon in this exact position (not other positions on same side)
		const existingInPosition = this.opponentPokemon.get(position);
		if (existingInPosition && existingInPosition.species !== species) {
			existingInPosition.active = false;
		}

		// Update if we already know this Pokemon
		const existing = this.opponentTeam.get(species);
		if (existing) {
			tracked.ability = existing.ability || tracked.ability;
			tracked.item = existing.item;
			tracked.itemLost = existing.itemLost;  // Preserve itemLost status
			tracked.knownMoves = existing.knownMoves;
		}

		this.opponentPokemon.set(position, tracked);
		this.opponentTeam.set(species, tracked);
	}

	/**
	 * Handle faint
	 * Format: |faint|p1a: Nickname
	 */
	private handleFaint(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.active = false;
			tracked.hpPercent = 0;
		}
	}

	/**
	 * Handle ability reveal
	 * Format: |-ability|p1a: Nickname|Levitate
	 */
	private handleAbility(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const ability = parts[2];
		if (!ability) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.ability = ability;
			// Also update team record
			const teamMon = this.opponentTeam.get(tracked.species);
			if (teamMon) {
				teamMon.ability = ability;
			}
		}
	}

	/**
	 * Handle item reveal
	 * Format: |-item|p1a: Nickname|Air Balloon
	 *         |-enditem|p1a: Nickname|Air Balloon
	 */
	private handleItem(parts: string[]): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const item = parts[2];
		if (!item) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			if (command === '-enditem') {
				tracked.item = ''; // Item consumed/knocked off
				tracked.itemLost = true;  // Mark as confirmed lost
			} else {
				tracked.item = item;
				tracked.itemLost = false;  // Item revealed, not lost
			}
			// Update team record
			const teamMon = this.opponentTeam.get(tracked.species);
			if (teamMon) {
				teamMon.item = tracked.item;
				teamMon.itemLost = tracked.itemLost;
			}
		}
	}

	/**
	 * Handle HP change
	 * Format: |-damage|p1a: Nickname|50/100
	 *         |-heal|p1a: Nickname|75/100
	 */
	private handleHPChange(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const hpPart = parts[2];
		if (!hpPart) return;

		const tracked = this.opponentPokemon.get(position);
		if (!tracked) return;

		const hpMatch = hpPart.match(/(\d+)\/(\d+)/);
		if (hpMatch) {
			tracked.hpPercent = (parseInt(hpMatch[1]) / parseInt(hpMatch[2])) * 100;
		} else if (hpPart === '0 fnt') {
			tracked.hpPercent = 0;
			tracked.active = false;
		}
	}

	/**
	 * Handle status
	 * Format: |-status|p1a: Nickname|par
	 */
	private handleStatus(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const status = parts[2];
		if (!status) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.status = status;
		}
	}

	/**
	 * Handle cure status
	 * Format: |-curestatus|p1a: Nickname|par
	 */
	private handleCureStatus(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);

		if (!this.isOpponentSide(side)) return;

		const tracked = this.opponentPokemon.get(position);
		if (tracked) {
			tracked.status = '';
		}
	}

	/**
	 * Handle move usage (to track known moves and last move)
	 * Format: |move|p1a: Nickname|Earthquake|p2a: Target
	 *
	 * For opponent: tracks lastMove for Encore/Disable evaluation
	 * For our side: tracks lastMove for consecutive Protect penalty
	 *
	 * In CFRU:
	 * - gLastUsedMoves[bankDef] tracks opponent's last used move
	 * - gLastResultingMoves[bankAtk] tracks our last used move
	 */
	private handleMove(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2); // 'a' or 'b'

		const move = parts[2];
		if (!move) return;

		const moveId = toID(move);

		// Track our team's lastMove (for AI decision making)
		// In multi battles, this handles both p2 and p4 moves
		if (this.isOurTeamSide(side)) {
			// Track lastMove (CFRU gLastResultingMoves[bankAtk])
			const boostKey = `${side}${slot}`;
			this.ourLastMove.set(boostKey, moveId);
		}

		// Track opponent's moves and lastMove (for Encore/Disable evaluation)
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				// Record as last move used (for Encore/Disable evaluation)
				tracked.lastMove = move;

				// Also add to known moves if not already known
				if (!tracked.knownMoves.includes(move)) {
					tracked.knownMoves.push(move);
				}

				// Update team record
				const teamMon = this.opponentTeam.get(tracked.species);
				if (teamMon) {
					teamMon.lastMove = move;
					if (!teamMon.knownMoves.includes(move)) {
						teamMon.knownMoves.push(move);
					}
				}
			}
		}
	}

	/**
	 * Handle weather
	 * Format: |-weather|Sandstorm
	 */
	private handleWeather(parts: string[]): void {
		const weather = parts[1];
		if (weather === 'none') {
			this.fieldConditions.weather = '';
		} else if (weather) {
			this.fieldConditions.weather = weather;
		}
	}

	/**
	 * Handle field start/end
	 * Format: |-fieldstart|move: Trick Room
	 *         |-fieldend|move: Trick Room
	 */
	private handleField(parts: string[]): void {
		const command = parts[0];
		const field = parts[1];
		if (!field) return;

		const isStart = command === '-fieldstart';

		if (field.includes('Trick Room')) {
			this.fieldConditions.trickRoom = isStart;
		} else if (field.includes('Terrain')) {
			this.fieldConditions.terrain = isStart ? field : '';
		}
	}

	/**
	 * Handle side condition start/end
	 * Format: |-sidestart|p1: PlayerName|move: Stealth Rock
	 *         |-sidestart|p1: PlayerName|Spikes
	 *         |-sideend|p1: PlayerName|Reflect
	 *
	 * IMPORTANT: PS protocol sometimes uses "move: Stealth Rock" format,
	 * so we need to strip the "move: " prefix before converting to ID.
	 */
	private handleSideCondition(parts: string[]): void {
		const command = parts[0];
		const sidePart = parts[1]; // "p1: PlayerName"
		if (!sidePart) return;

		const side = sidePart.split(':')[0].trim(); // "p1"
		let condition = parts[2];
		if (!condition) return;

		const isStart = command === '-sidestart';

		// Strip "move: " prefix if present (PS protocol quirk)
		// e.g., "move: Stealth Rock" -> "Stealth Rock"
		if (condition.startsWith('move: ')) {
			condition = condition.slice(6);
		}

		const conditionId = toID(condition);

		// Determine which side's conditions to update
		const isOpponentSide = side === this.opponentSide;
		const conditions = isOpponentSide ? this.opponentSideConditions : this.ourSideConditions;

		// Entry hazards
		if (conditionId === 'stealthrock') {
			conditions.stealthrock = isStart;
		} else if (conditionId === 'spikes') {
			if (isStart) {
				conditions.spikes = Math.min(3, conditions.spikes + 1);
			} else {
				conditions.spikes = 0;
			}
		} else if (conditionId === 'toxicspikes') {
			if (isStart) {
				conditions.toxicspikes = Math.min(2, conditions.toxicspikes + 1);
			} else {
				conditions.toxicspikes = 0;
			}
		} else if (conditionId === 'stickyweb') {
			conditions.stickyweb = isStart;
		}
		// Screens
		else if (conditionId === 'reflect') {
			conditions.reflect = isStart ? 5 : 0; // Default 5 turns
		} else if (conditionId === 'lightscreen') {
			conditions.lightscreen = isStart ? 5 : 0;
		} else if (conditionId === 'auroraveil') {
			conditions.auroraveil = isStart ? 5 : 0;
		}
		// Tailwind
		else if (conditionId === 'tailwind') {
			conditions.tailwind = isStart ? 4 : 0; // Default 4 turns
		}
	}

	/**
	 * Handle volatile status start/end
	 * Format: |-start|p1a: Nickname|quarkdriveatk
	 *         |-start|p1a: Nickname|protosynthesisatk
	 *         |-end|p1a: Nickname|Quark Drive
	 *
	 * Tracks ability-based stat modifiers like Quark Drive and Protosynthesis.
	 * These provide 1.3x to non-speed stats, 1.5x to speed (5325/4096 ≈ 1.3).
	 */
	private handleVolatileStatus(parts: string[]): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2);

		const volatile = parts[2]?.toLowerCase() || '';

		// Handle Quark Drive and Protosynthesis stat boosts
		// Format: "quarkdriveatk", "quarkdrivespe", "protosynthesisdef", etc.
		const abilityStatMatch = volatile.match(/^(quarkdrive|protosynthesis)(atk|def|spa|spd|spe)$/);

		if (abilityStatMatch) {
			const [, , stat] = abilityStatMatch;
			const isStart = command === '-start';

			// Track our team (in multi battles: both p2 and p4)
			if (this.isOurTeamSide(side)) {
				const boostKey = `${side}${slot}`;
				if (isStart) {
					// Speed gets 1.5x, other stats get ~1.3x (5325/4096)
					const multiplier = stat === 'spe' ? 1.5 : 5325 / 4096;
					this.ourAbilityStatMods.set(boostKey, {
						stat: stat as 'atk' | 'def' | 'spa' | 'spd' | 'spe',
						multiplier,
					});
				}
			}
			return;
		}

		// Handle end of Quark Drive / Protosynthesis
		// Format: |-end|p1a: Pokemon|Quark Drive
		if (command === '-end') {
			const endMatch = volatile.match(/^(quark drive|protosynthesis)$/i) ||
			                 parts[2]?.match(/^(Quark Drive|Protosynthesis)$/i);
			if (endMatch && this.isOurTeamSide(side)) {
				const boostKey = `${side}${slot}`;
				this.ourAbilityStatMods.delete(boostKey);
			}
		}
	}

	/**
	 * Handle stat boost
	 * Format: |-boost|p1a: Nickname|atk|1
	 *         |-unboost|p1a: Nickname|def|2
	 *
	 * Tracks BOTH opponent and our side boosts for accurate AI decision making.
	 */
	private handleBoost(parts: string[]): void {
		const command = parts[0];
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2); // 'a', 'b', etc.

		const stat = parts[2]?.toLowerCase() as keyof TrackedPokemon['boosts'];
		const amount = parseInt(parts[3]) || 1;
		if (!stat) return;

		// Valid stat names
		const validStats = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
		if (!validStats.includes(stat)) return;

		// Track opponent boosts (original behavior)
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				if (command === '-boost') {
					tracked.boosts[stat] = Math.min(6, tracked.boosts[stat] + amount);
				} else {
					// -unboost
					tracked.boosts[stat] = Math.max(-6, tracked.boosts[stat] - amount);
				}
			}
		}

		// CFRU AI Fix: Also track our team boosts for accurate setup move scoring
		// In multi battles, this tracks both p2 and p4 boosts
		if (this.isOurTeamSide(side)) {
			// Use side+slot as key to differentiate p2a from p4a
			const boostKey = `${side}${slot}`;
			console.log(`[DEBUG BattleTracker] handleBoost: ${command} for ${position}, side=${side}, boostKey=${boostKey}, stat=${stat}, amount=${amount}`);
			console.log(`[DEBUG BattleTracker] isOurTeamSide(${side})=true, ourTeamSides=${Array.from(this.ourTeamSides).join(',')}`);
			// Initialize boosts for this slot if not exists
			if (!this.ourActiveBoosts.has(boostKey)) {
				this.ourActiveBoosts.set(boostKey, {
					atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
				});
			}
			const boosts = this.ourActiveBoosts.get(boostKey)!;
			if (command === '-boost') {
				boosts[stat as keyof typeof boosts] = Math.min(6, boosts[stat as keyof typeof boosts] + amount);
			} else {
				// -unboost
				boosts[stat as keyof typeof boosts] = Math.max(-6, boosts[stat as keyof typeof boosts] - amount);
			}
			console.log(`[DEBUG BattleTracker] After update: ${boostKey} boosts.${stat}=${boosts[stat as keyof typeof boosts]}`);
		} else {
			console.log(`[DEBUG BattleTracker] handleBoost: ${command} for ${position}, side=${side} is NOT our team side`);
		}
	}

	/**
	 * Handle set boost (absolute value)
	 * Format: |-setboost|p1a: Nickname|atk|6
	 *
	 * Tracks BOTH opponent and our team boosts.
	 */
	private handleSetBoost(parts: string[]): void {
		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2);

		const stat = parts[2]?.toLowerCase() as keyof TrackedPokemon['boosts'];
		const amount = parseInt(parts[3]) || 0;
		if (!stat) return;

		const validStats = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
		if (!validStats.includes(stat)) return;

		// Track opponent
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				tracked.boosts[stat] = Math.max(-6, Math.min(6, amount));
			}
		}

		// Track our team (in multi battles: both p2 and p4)
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			if (!this.ourActiveBoosts.has(boostKey)) {
				this.ourActiveBoosts.set(boostKey, {
					atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
				});
			}
			const boosts = this.ourActiveBoosts.get(boostKey)!;
			boosts[stat as keyof typeof boosts] = Math.max(-6, Math.min(6, amount));
		}
	}

	/**
	 * Handle clear boost
	 * Format: |-clearboost|p1a: Nickname
	 *         |-clearallboost
	 *         |-clearpositiveboost|p1a: Nickname
	 *         |-clearnegativeboost|p1a: Nickname
	 *
	 * Tracks BOTH opponent and our team boosts.
	 */
	private handleClearBoost(parts: string[]): void {
		const command = parts[0];

		// -clearallboost clears all boosts for all Pokemon (both sides)
		if (command === '-clearallboost') {
			// Clear opponent boosts
			for (const [pos, mon] of this.opponentPokemon) {
				if (this.isOpponentSide(pos.slice(0, 2)) && mon.active) {
					mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
				}
			}
			// Clear our team boosts
			for (const [, boosts] of this.ourActiveBoosts) {
				boosts.atk = 0;
				boosts.def = 0;
				boosts.spa = 0;
				boosts.spd = 0;
				boosts.spe = 0;
				boosts.accuracy = 0;
				boosts.evasion = 0;
			}
			return;
		}

		const positionPart = parts[1];
		if (!positionPart) return;

		const position = positionPart.split(':')[0].trim();
		const side = position.slice(0, 2);
		const slot = position.slice(2);

		// Helper to clear boosts based on command type
		const clearBoostsFor = (boostsObj: { atk: number, def: number, spa: number, spd: number, spe: number, accuracy: number, evasion: number }) => {
			if (command === '-clearboost') {
				boostsObj.atk = 0;
				boostsObj.def = 0;
				boostsObj.spa = 0;
				boostsObj.spd = 0;
				boostsObj.spe = 0;
				boostsObj.accuracy = 0;
				boostsObj.evasion = 0;
			} else if (command === '-clearpositiveboost') {
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) {
					if (boostsObj[stat] > 0) boostsObj[stat] = 0;
				}
			} else if (command === '-clearnegativeboost') {
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const) {
					if (boostsObj[stat] < 0) boostsObj[stat] = 0;
				}
			}
		};

		// Handle opponent
		if (this.isOpponentSide(side)) {
			const tracked = this.opponentPokemon.get(position);
			if (tracked) {
				clearBoostsFor(tracked.boosts);
			}
		}

		// Handle our team (in multi battles: both p2 and p4)
		if (this.isOurTeamSide(side)) {
			const boostKey = `${side}${slot}`;
			const boosts = this.ourActiveBoosts.get(boostKey);
			if (boosts) {
				clearBoostsFor(boosts);
			}
		}
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	/**
	 * Get the currently active opponent Pokemon (for singles)
	 */
	getActiveOpponent(): TrackedPokemon | null {
		for (const [position, mon] of this.opponentPokemon) {
			if (mon.active && position.startsWith(this.opponentSide)) {
				return mon;
			}
		}
		return null;
	}

	/**
	 * Get all active opponent Pokemon (for doubles/multi)
	 * Returns array of [position, TrackedPokemon] sorted by position
	 */
	getActiveOpponents(): Array<{ position: string; pokemon: TrackedPokemon }> {
		const active: Array<{ position: string; pokemon: TrackedPokemon }> = [];
		for (const [position, mon] of this.opponentPokemon) {
			const side = position.slice(0, 2);
			if (mon.active && this.isOpponentSide(side)) {
				active.push({ position, pokemon: mon });
			}
		}
		// Sort by position: p1a < p1b < p3a < p3b
		active.sort((a, b) => a.position.localeCompare(b.position));
		return active;
	}

	/**
	 * Get all known opponent team members
	 */
	getOpponentTeam(): TrackedPokemon[] {
		return Array.from(this.opponentTeam.values());
	}

	/**
	 * Get opponent's last used move (for singles)
	 * Used by Encore/Disable evaluation in CFRU
	 *
	 * Returns empty string if no move has been used yet.
	 */
	getOpponentLastMove(): string {
		const opponent = this.getActiveOpponent();
		return opponent?.lastMove || '';
	}

	/**
	 * Get opponent's last used move info with details
	 * Returns move name and whether it's a status move
	 */
	getOpponentLastMoveInfo(): { move: string, isStatus: boolean } | null {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.lastMove) return null;

		const moveData = Dex.moves.get(opponent.lastMove);
		return {
			move: opponent.lastMove,
			isStatus: moveData.category === 'Status',
		};
	}

	/**
	 * Get field conditions
	 */
	getFieldConditions() {
		return { ...this.fieldConditions };
	}

	/**
	 * Get opponent side conditions (hazards, screens, etc.)
	 */
	getOpponentSideConditions() {
		return { ...this.opponentSideConditions };
	}

	/**
	 * Get our side conditions (hazards, screens, etc.)
	 */
	getOurSideConditions() {
		return { ...this.ourSideConditions };
	}

	/**
	 * Get our active Pokemon boosts (for singles, slot 'a')
	 * Returns boosts for the first active slot, or default zeros if not tracked yet.
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 *               In multi battles, use full position to distinguish p2a from p4a
	 */
	getOurActiveBoosts(slot: string = 'a'): {
		atk: number,
		def: number,
		spa: number,
		spd: number,
		spe: number,
		accuracy: number,
		evasion: number,
	} {
		// If slot is a full position (e.g., 'p2a', 'p4a'), use it directly
		// Otherwise, prepend ourSide for backward compatibility
		const boostKey = slot.length > 1 ? slot : `${this.ourSide}${slot}`;
		const boosts = this.ourActiveBoosts.get(boostKey);
		if (boosts) {
			return { ...boosts };
		}
		// Return default zeros if not tracked yet
		return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
	}

	/**
	 * Get our active Pokemon ability stat modifier (Quark Drive, Protosynthesis)
	 * Returns the boosted stat and multiplier, or null if not active.
	 *
	 * These abilities provide:
	 * - 1.3x (~5325/4096) to the highest non-speed stat
	 * - 1.5x to speed if speed is highest
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 */
	getOurAbilityStatMod(slot: string = 'a'): {
		stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null,
		multiplier: number,
	} {
		// If slot is a full position (e.g., 'p2a', 'p4a'), use it directly
		// Otherwise, prepend ourSide for backward compatibility
		const modKey = slot.length > 1 ? slot : `${this.ourSide}${slot}`;
		const mod = this.ourAbilityStatMods.get(modKey);
		if (mod) {
			return { ...mod };
		}
		return { stat: null, multiplier: 1 };
	}

	/**
	 * Get our Pokemon's last move used (CFRU gLastResultingMoves[bankAtk])
	 * Used for consecutive Protect detection
	 *
	 * @param slot - Position slot ('a' for singles/doubles) or full position ('p2a' for multi)
	 * @returns The move ID of last move used, or empty string if none
	 */
	getOurLastMove(slot: string = 'a'): string {
		// If slot is a full position (e.g., 'p2a', 'p4a'), use it directly
		// Otherwise, prepend ourSide for backward compatibility
		const moveKey = slot.length > 1 ? slot : `${this.ourSide}${slot}`;
		return this.ourLastMove.get(moveKey) || '';
	}

	/**
	 * Get which side we are ('p1' or 'p2')
	 */
	getOurSide(): 'p1' | 'p2' {
		return this.ourSide;
	}

	/**
	 * Get which side the opponent is ('p1' or 'p2')
	 */
	getOpponentSideId(): 'p1' | 'p2' {
		return this.opponentSide;
	}

	/**
	 * Check if our side has Tailwind active
	 */
	hasOurTailwind(): boolean {
		return this.ourSideConditions.tailwind > 0;
	}

	/**
	 * Check if opponent has Tailwind active
	 */
	hasOpponentTailwind(): boolean {
		return this.opponentSideConditions.tailwind > 0;
	}

	/**
	 * Check if a move type is immune due to opponent's ability
	 */
	isAbilityImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.ability) return false;

		const abilityId = toID(opponent.ability);
		const typeId = toID(moveType);

		// Electric immunities
		if (typeId === 'electric') {
			if (['voltabsorb', 'lightningrod', 'motordrive'].includes(abilityId)) {
				return true;
			}
		}

		// Water immunities
		if (typeId === 'water') {
			if (['waterabsorb', 'stormdrain', 'dryskin'].includes(abilityId)) {
				return true;
			}
		}

		// Fire immunities
		if (typeId === 'fire') {
			if (['flashfire', 'wellbakedbody'].includes(abilityId)) {
				return true;
			}
		}

		// Grass immunity
		if (typeId === 'grass') {
			if (abilityId === 'sapsipper') {
				return true;
			}
		}

		// Ground immunities
		if (typeId === 'ground') {
			if (['levitate', 'eartheater'].includes(abilityId)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if a move type is immune due to opponent's item
	 */
	isItemImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent || !opponent.item) return false;

		const itemId = toID(opponent.item);
		const typeId = toID(moveType);

		// Air Balloon - Ground immunity
		if (typeId === 'ground' && itemId === 'airballoon') {
			return true;
		}

		return false;
	}

	/**
	 * Check if a move type is immune (type + ability + item)
	 */
	isImmune(moveType: string): boolean {
		const opponent = this.getActiveOpponent();
		if (!opponent) return false;

		// Check type immunity first
		const typeId = toID(moveType);

		// Ground type check - special handling for Flying type and Levitate
		if (typeId === 'ground') {
			// Flying type is immune
			if (opponent.types.includes('Flying')) {
				return true;
			}
			// Levitate ability
			if (this.isAbilityImmune(moveType)) {
				return true;
			}
			// Air Balloon
			if (this.isItemImmune(moveType)) {
				return true;
			}
		}

		// Normal type immunities
		if (typeId === 'normal' || typeId === 'fighting') {
			if (opponent.types.includes('Ghost')) {
				return true;
			}
		}

		if (typeId === 'ghost') {
			if (opponent.types.includes('Normal')) {
				return true;
			}
		}

		if (typeId === 'electric') {
			if (opponent.types.includes('Ground')) {
				return true;
			}
		}

		if (typeId === 'psychic') {
			if (opponent.types.includes('Dark')) {
				return true;
			}
		}

		if (typeId === 'dragon') {
			if (opponent.types.includes('Fairy')) {
				return true;
			}
		}

		if (typeId === 'poison') {
			if (opponent.types.includes('Steel')) {
				return true;
			}
		}

		// Check ability immunities
		if (this.isAbilityImmune(moveType)) {
			return true;
		}

		// Check item immunities
		if (this.isItemImmune(moveType)) {
			return true;
		}

		return false;
	}

	/**
	 * Get type effectiveness considering all immunities
	 */
	getEffectiveness(moveType: string): number {
		// Check full immunity first
		if (this.isImmune(moveType)) {
			return 0;
		}

		const opponent = this.getActiveOpponent();
		if (!opponent) return 1;

		// Calculate type effectiveness
		let multiplier = 1;
		for (const defType of opponent.types) {
			const effectiveness = Dex.getEffectiveness(moveType, defType);
			if (effectiveness === 1) {
				multiplier *= 2;
			} else if (effectiveness === -1) {
				multiplier *= 0.5;
			}
		}

		return multiplier;
	}

	/**
	 * Reset tracker state (for new battle)
	 */
	reset(): void {
		this.opponentPokemon.clear();
		this.opponentTeam.clear();
		this.ourActiveBoosts.clear();
		this.ourAbilityStatMods.clear();
		this.ourProtectUses.clear();
		this.ourLastMove.clear();
		this.fieldConditions = { weather: '', terrain: '', trickRoom: false };
		this.opponentSideConditions = {
			stealthrock: false,
			spikes: 0,
			toxicspikes: 0,
			stickyweb: false,
			reflect: 0,
			lightscreen: 0,
			auroraveil: 0,
			tailwind: 0,
		};
		this.ourSideConditions = {
			stealthrock: false,
			spikes: 0,
			toxicspikes: 0,
			stickyweb: false,
			reflect: 0,
			lightscreen: 0,
			auroraveil: 0,
			tailwind: 0,
		};
	}
}

/**
 * Create a new BattleTracker instance
 * @param ourSide - Which side we are ('p1' or 'p2')
 * @param isMulti - Whether this is a multi battle (tracks p1 & p3 or p2 & p4 as opponents)
 */
export function createBattleTracker(ourSide: 'p1' | 'p2' = 'p2', isMulti = false): BattleTracker {
	return new BattleTracker(ourSide, isMulti);
}
