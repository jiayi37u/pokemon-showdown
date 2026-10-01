/**
 * CFRU AI - Battle State Builder
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Utility to build BattleState from Pokemon Showdown battle data.
 * Handles both revealed-only and full information modes.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../sim/dex';
import type {
	BattleState,
	AIPokemon,
	AIMove,
	SideConditions,
	FieldConditions,
	CFRUAIConfig,
} from './types';
import { DEFAULT_AI_CONFIG, resolveLevel } from './types';
import type { BattleTracker, TrackedPokemon } from './util/battle-tracker';

/**
 * Build BattleState from Pokemon Showdown request and battle data
 */
export function buildBattleState(
	request: AnyObject,
	battle: AnyObject | null,
	config: CFRUAIConfig = DEFAULT_AI_CONFIG
): BattleState {
	const side = request.side;
	const isDoubles = request.active ? request.active.length > 1 : false;
	const turn = battle?.turn ?? 1;

	// Build self (full information)
	// Pass battle object to get boosts and volatiles from battle.sides[0].active
	const selfActive = buildSelfActive(request, battle);
	const selfReserve = buildSelfReserve(request, selfActive);
	const selfConditions = buildSideConditions(battle?.sides?.[0]?.sideConditions);

	// Build opponent (revealed or full based on config)
	const opponentSide = battle?.sides?.[1];
	const opponentActive = config.useFullInfo
		? buildOpponentActiveFull(opponentSide)
		: buildOpponentActiveRevealed(battle);
	const opponentReserve = config.useFullInfo
		? buildOpponentReserveFull(opponentSide, opponentActive)
		: buildOpponentReserveRevealed(battle, opponentActive);
	const opponentConditions = buildSideConditions(opponentSide?.sideConditions);

	// Build field conditions
	const field = buildFieldConditions(battle);

	return {
		turn,
		isDoubles,
		self: {
			active: selfActive,
			reserve: selfReserve,
			team: [...selfActive, ...selfReserve],
			conditions: selfConditions,
		},
		opponent: {
			active: opponentActive,
			reserve: opponentReserve,
			team: [...opponentActive, ...opponentReserve],
			conditions: opponentConditions,
		},
		field,
	};
}

/**
 * Build self active Pokemon from request
 * Takes battle object to get boosts and volatiles from battle.sides[ourSideIndex].active
 *
 * @param request - The battle request object
 * @param battle - The battle object (may be null)
 * @param ourSideIndex - The index of our side in battle.sides (0 for p1, 1 for p2)
 */
function buildSelfActive(request: AnyObject, battle: AnyObject | null, ourSideIndex: number = 0): AIPokemon[] {
	const active: AIPokemon[] = [];
	const pokemon = request.side.pokemon;
	const activeData = request.active || [];
	// CFRU AI Fix: Use correct side index based on which player we are
	const battleActive = battle?.sides?.[ourSideIndex]?.active || [];

	for (let i = 0; i < activeData.length; i++) {
		const mon = pokemon[i];
		if (!mon || mon.condition.endsWith(' fnt')) continue;

		const aiPokemon = buildPokemonFromRequest(mon, i + 1, true);

		// Get boosts and volatiles from battle object if available
		// CFRU AI Fix: This is critical for setup move scoring to work correctly
		const battleMon = battleActive[i];
		if (battleMon) {
			// Copy boosts from battle data
			if (battleMon.boosts) {
				aiPokemon.boosts = {
					atk: battleMon.boosts.atk || 0,
					def: battleMon.boosts.def || 0,
					spa: battleMon.boosts.spa || 0,
					spd: battleMon.boosts.spd || 0,
					spe: battleMon.boosts.spe || 0,
					accuracy: battleMon.boosts.accuracy || 0,
					evasion: battleMon.boosts.evasion || 0,
				};
			}

			// Copy volatiles from battle data
			if (battleMon.volatiles) {
				aiPokemon.volatiles = new Set(Object.keys(battleMon.volatiles));
			}
		}

		active.push(aiPokemon);
	}

	return active;
}

/**
 * Build self reserve Pokemon from request
 */
function buildSelfReserve(request: AnyObject, active: AIPokemon[]): AIPokemon[] {
	const reserve: AIPokemon[] = [];
	const pokemon = request.side.pokemon;
	const activeSlots = new Set(active.map(p => p.slot));

	for (let i = 0; i < pokemon.length; i++) {
		const slot = i + 1;
		if (activeSlots.has(slot)) continue;

		const mon = pokemon[i];
		if (!mon) continue;

		reserve.push(buildPokemonFromRequest(mon, slot, false));
	}

	return reserve;
}

/**
 * Build Pokemon from request data (self)
 * Note: This function builds basic Pokemon info from request.
 * For active Pokemon with boosts, use buildSelfActiveWithBoosts which requires battle object.
 */
function buildPokemonFromRequest(mon: AnyObject, slot: number, isActive: boolean): AIPokemon {
	// Parse condition: "100/100" or "50/100 par" or "0 fnt"
	const conditionParts = mon.condition.split(' ');
	const hpParts = conditionParts[0].split('/');
	const currentHp = parseInt(hpParts[0]) || 0;
	const maxHp = parseInt(hpParts[1]) || currentHp;
	const status = conditionParts[1] || '';
	const fainted = status === 'fnt' || currentHp === 0;
	const hpPercent = maxHp > 0 ? (currentHp / maxHp) * 100 : 0;

	// Parse details: "Species, L50, M" or "Species-Forme, L100, F"
	const details = mon.details.split(', ');
	const species = details[0];
	// CFRU AI Fix: Default to L100 for National Dex and similar formats
	// PS omits level in details when it's the format default (usually 100)
	const level = parseInt((details[1] || 'L100').replace('L', '')) || 100;
	const gender = details[2] || 'N';

	// Get species data
	const speciesData = Dex.species.get(species);
	const types = speciesData.types || [];

	// CFRU AI Fix: Use actual stats from request instead of base stats (species stats)
	// mon.stats contains the actual computed stats: { atk, def, spa, spd, spe }
	// This is critical for damage calculation accuracy!
	const speciesBaseStats = speciesData.baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };
	const actualStats = mon.stats ? {
		hp: maxHp, // Use actual max HP from condition
		atk: mon.stats.atk,
		def: mon.stats.def,
		spa: mon.stats.spa,
		spd: mon.stats.spd,
		spe: mon.stats.spe,
	} : speciesBaseStats; // Fallback to base stats if mon.stats is not available

	// DEBUG: Uncomment to debug Pokemon stats from request
	// console.log(`[DEBUG] buildPokemonFromRequest: ${species}, mon.stats=${JSON.stringify(mon.stats)}, actualStats=${JSON.stringify(actualStats)}`);

	// Get moves
	const moves = mon.moves || [];

	// Get ability and item
	const ability = mon.ability || mon.baseAbility || '';
	const item = mon.item || '';

	// Parse boosts from request data if available
	// CFRU AI Fix: Boosts need to be tracked for setup move scoring
	// The request doesn't include boosts directly, they come from battle.sides[].active[].boosts
	const boosts = {
		atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
	};

	// Parse volatiles (simplified)
	const volatiles = new Set<string>();

	// Default ability stat mod (Quark Drive, Protosynthesis, etc.)
	// Will be overwritten by tracker data for active Pokemon
	const abilityStatMod = {
		stat: null as 'atk' | 'def' | 'spa' | 'spd' | 'spe' | null,
		multiplier: 1,
	};

	return {
		slot,
		species,
		hp: currentHp,
		maxHp,
		hpPercent,
		status: fainted ? '' : status,
		sleepTurns: 0,
		toxicCounter: 0,
		types,
		ability,
		item,
		moves,
		lastMove: '', // Self lastMove is tracked via BattleTracker for consecutive Protect detection
		baseStats: actualStats, // Now using actual stats instead of species base stats!
		boosts,
		abilityStatMod,
		volatiles,
		fainted,
		active: isActive,
		level,
		gender,
	};
}

/**
 * Build opponent active Pokemon from revealed information
 */
function buildOpponentActiveRevealed(battle: AnyObject | null): AIPokemon[] {
	if (!battle?.sides?.[1]) return [];

	const active: AIPokemon[] = [];
	const opponentSide = battle.sides[1];

	for (let i = 0; i < opponentSide.active.length; i++) {
		const mon = opponentSide.active[i];
		if (!mon || mon.fainted) continue;

		active.push(buildOpponentPokemonRevealed(mon, i + 1, true));
	}

	return active;
}

/**
 * Build opponent reserve from revealed information
 */
function buildOpponentReserveRevealed(battle: AnyObject | null, active: AIPokemon[]): AIPokemon[] {
	if (!battle?.sides?.[1]) return [];

	const reserve: AIPokemon[] = [];
	const opponentSide = battle.sides[1];
	const activeSlots = new Set(active.map(p => p.slot));

	// Can only see team preview info for reserves
	for (let i = 0; i < opponentSide.pokemon.length; i++) {
		const slot = i + 1;
		if (activeSlots.has(slot)) continue;

		const mon = opponentSide.pokemon[i];
		if (!mon) continue;

		// Limited information for reserves
		reserve.push({
			slot,
			species: mon.speciesForme || mon.species || 'Unknown',
			hp: 0, // Unknown
			maxHp: 0,
			hpPercent: mon.fainted ? 0 : 100, // Assume full if not fainted
			status: '',
			sleepTurns: 0,
			toxicCounter: 0,
			types: Dex.species.get(mon.speciesForme || mon.species).types || [],
			ability: '', // Unknown
			item: '', // Unknown
			itemLost: false, // Unknown, assume has item
			moves: [], // Unknown
			baseStats: Dex.species.get(mon.speciesForme || mon.species).baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
			boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			volatiles: new Set(),
			fainted: mon.fainted || false,
			active: false,
			level: mon.level || 100,
			gender: mon.gender || 'N',
		});
	}

	return reserve;
}

/**
 * Build opponent Pokemon from revealed battle data
 */
function buildOpponentPokemonRevealed(mon: AnyObject, slot: number, isActive: boolean): AIPokemon {
	const speciesData = Dex.species.get(mon.speciesForme || mon.species);

	// HP is shown as percentage
	const hpPercent = mon.hp !== undefined ? (mon.hp / mon.maxhp) * 100 : 100;

	// Get revealed moves
	const moves: string[] = [];
	if (mon.moveSlots) {
		for (const moveSlot of mon.moveSlots) {
			if (moveSlot.revealed || moveSlot.used) {
				moves.push(moveSlot.id);
			}
		}
	}

	// Get revealed ability
	let ability = '';
	if (mon.ability) {
		ability = mon.ability;
	} else if (mon.baseAbility && mon.abilityRevealed) {
		ability = mon.baseAbility;
	}

	// Get revealed item
	let item = '';
	if (mon.item && mon.itemRevealed) {
		item = mon.item;
	}

	// Get boosts
	const boosts = { ...mon.boosts } || {
		atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
	};

	// Get volatiles
	const volatiles = new Set<string>();
	if (mon.volatiles) {
		for (const v in mon.volatiles) {
			volatiles.add(v);
		}
	}

	return {
		slot,
		species: mon.speciesForme || mon.species || 'Unknown',
		hp: Math.floor(mon.hp || 0),
		maxHp: mon.maxhp || 0,
		hpPercent,
		status: mon.status || '',
		sleepTurns: mon.statusData?.sleepTurns || 0,
		toxicCounter: mon.statusData?.toxicTurns || 0,
		types: speciesData.types || [],
		ability,
		item,
		moves,
		baseStats: speciesData.baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
		boosts,
		abilityStatMod: { stat: null, multiplier: 1 },
		volatiles,
		fainted: mon.fainted || false,
		active: isActive,
		level: mon.level || 100,
		gender: mon.gender || 'N',
	};
}

/**
 * Build opponent active Pokemon with full information
 */
function buildOpponentActiveFull(opponentSide: AnyObject | undefined): AIPokemon[] {
	if (!opponentSide) return [];

	const active: AIPokemon[] = [];

	for (let i = 0; i < opponentSide.active.length; i++) {
		const mon = opponentSide.active[i];
		if (!mon || mon.fainted) continue;

		active.push(buildOpponentPokemonFull(mon, i + 1, true));
	}

	return active;
}

/**
 * Build opponent reserve with full information
 */
function buildOpponentReserveFull(opponentSide: AnyObject | undefined, active: AIPokemon[]): AIPokemon[] {
	if (!opponentSide) return [];

	const reserve: AIPokemon[] = [];
	const activeSlots = new Set(active.map(p => p.slot));

	for (let i = 0; i < opponentSide.pokemon.length; i++) {
		const slot = i + 1;
		if (activeSlots.has(slot)) continue;

		const mon = opponentSide.pokemon[i];
		if (!mon) continue;

		reserve.push(buildOpponentPokemonFull(mon, slot, false));
	}

	return reserve;
}

/**
 * Build opponent Pokemon with full information
 */
function buildOpponentPokemonFull(mon: AnyObject, slot: number, isActive: boolean): AIPokemon {
	const speciesData = Dex.species.get(mon.speciesForme || mon.species);
	const hpPercent = mon.maxhp > 0 ? (mon.hp / mon.maxhp) * 100 : 0;

	// Get all moves
	const moves: string[] = [];
	if (mon.moveSlots) {
		for (const moveSlot of mon.moveSlots) {
			moves.push(moveSlot.id);
		}
	}

	// Get boosts
	const boosts = { ...mon.boosts } || {
		atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
	};

	// Get volatiles
	const volatiles = new Set<string>();
	if (mon.volatiles) {
		for (const v in mon.volatiles) {
			volatiles.add(v);
		}
	}

	return {
		slot,
		species: mon.speciesForme || mon.species || 'Unknown',
		hp: mon.hp || 0,
		maxHp: mon.maxhp || 0,
		hpPercent,
		status: mon.status || '',
		sleepTurns: mon.statusData?.sleepTurns || 0,
		toxicCounter: mon.statusData?.toxicTurns || 0,
		types: speciesData.types || [],
		ability: mon.ability || mon.baseAbility || '',
		item: mon.item || '',
		itemLost: !mon.item,  // If no item, it's lost (for self this is accurate)
		moves,
		baseStats: speciesData.baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
		boosts,
		abilityStatMod: { stat: null, multiplier: 1 },
		volatiles,
		fainted: mon.fainted || false,
		active: isActive,
		level: mon.level || 100,
		gender: mon.gender || 'N',
	};
}

/**
 * Build side conditions from battle data
 */
function buildSideConditions(sideConditions: AnyObject | undefined): SideConditions {
	if (!sideConditions) {
		return {
			stealthrock: false,
			spikes: 0,
			toxicspikes: 0,
			stickyweb: false,
			lightscreen: 0,
			reflect: 0,
			auroraveil: 0,
			tailwind: 0,
			wish: 0,
			futuremove: 0,
		};
	}

	return {
		stealthrock: !!sideConditions.stealthrock,
		spikes: sideConditions.spikes?.layers || 0,
		toxicspikes: sideConditions.toxicspikes?.layers || 0,
		stickyweb: !!sideConditions.stickyweb,
		lightscreen: sideConditions.lightscreen?.duration || 0,
		reflect: sideConditions.reflect?.duration || 0,
		auroraveil: sideConditions.auroraveil?.duration || 0,
		tailwind: sideConditions.tailwind?.duration || 0,
		wish: sideConditions.wish?.duration || 0,
		futuremove: sideConditions.futuremove?.duration || 0,
	};
}

/**
 * Build field conditions from battle data
 */
function buildFieldConditions(battle: AnyObject | null): FieldConditions {
	if (!battle) {
		return {
			weather: '',
			weatherTurns: -1,
			terrain: '',
			terrainTurns: 0,
			trickroom: false,
			trickroomTurns: 0,
			gravity: false,
			magicroom: false,
			wonderroom: false,
		};
	}

	const field = battle.field || {};

	// Parse weather
	let weather = '';
	let weatherTurns = -1;
	if (field.weather) {
		weather = field.weather;
		weatherTurns = field.weatherData?.duration || 0;
	}

	// Parse terrain
	let terrain = '';
	let terrainTurns = 0;
	if (field.terrain) {
		terrain = field.terrain;
		terrainTurns = field.terrainData?.duration || 0;
	}

	// Parse pseudo weather
	const pseudoWeather = field.pseudoWeather || {};

	return {
		weather,
		weatherTurns,
		terrain,
		terrainTurns,
		trickroom: !!pseudoWeather.trickroom,
		trickroomTurns: pseudoWeather.trickroom?.duration || 0,
		gravity: !!pseudoWeather.gravity,
		magicroom: !!pseudoWeather.magicroom,
		wonderroom: !!pseudoWeather.wonderroom,
	};
}

/**
 * Build AIMove array from request move data
 */
export function buildMovesFromRequest(request: AnyObject, activeIndex: number): AIMove[] {
	const moves: AIMove[] = [];
	const active = request.active?.[activeIndex];

	if (!active?.moves) return moves;

	for (let i = 0; i < active.moves.length; i++) {
		const moveData = active.moves[i];
		const moveId = toID(moveData.move);
		const dexMove = Dex.moves.get(moveData.move);

		// Return/Frustration: PS sends "Return 102" format, Dex lookup fails
		// Hardcode as 102 BP Physical Normal move
		const isReturn = moveId.startsWith('return') && moveId !== 'returntoearth';
		const isFrustration = moveId.startsWith('frustration');

		moves.push({
			id: moveId,
			name: isReturn ? 'Return' : (isFrustration ? 'Frustration' : (dexMove.name || moveData.move)),
			slot: i + 1,
			type: isReturn || isFrustration ? 'Normal' : (dexMove.type || '???'),
			category: isReturn || isFrustration ? 'Physical' : (dexMove.category || 'Status'),
			basePower: isReturn ? 102 : (isFrustration ? 1 : (moveData.basePower || dexMove.basePower || 0)),
			accuracy: isReturn || isFrustration ? 100 : dexMove.accuracy,
			pp: moveData.pp ?? dexMove.pp,
			maxPp: moveData.maxpp ?? dexMove.pp,
			priority: dexMove.priority || 0,
			target: moveData.target || dexMove.target || 'normal',
			flags: isReturn || isFrustration ? { contact: 1, protect: 1 } : (dexMove.flags || {}),
			secondaryChance: dexMove.secondary?.chance || 0,
			disabled: moveData.disabled || false,
			isZMove: false,
			isMaxMove: false,
			multihit: dexMove.multihit || null,
		});
	}

	return moves;
}

/**
 * Build BattleState using BattleTracker for opponent info
 * This is used in server environment where battle.sides is not accessible
 */
export function buildBattleStateWithTracker(
	request: AnyObject,
	battle: AnyObject | null,
	tracker: BattleTracker,
	config: CFRUAIConfig = DEFAULT_AI_CONFIG
): BattleState {
	const isDoubles = request.active ? request.active.length > 1 : false;
	const turn = battle?.turn ?? 1;

	// Determine which side index we are (p1 = 0, p2 = 1)
	const ourSide = tracker.getOurSide();
	const ourSideIndex = ourSide === 'p1' ? 0 : 1;

	// Build self (full information from request)
	// CFRU AI Fix: battle.sides is not accessible in server environment
	// Use tracker.getOurActiveBoosts() to get boosts from stream messages
	const selfActive = buildSelfActiveWithTracker(request, tracker, isDoubles);
	const selfReserve = buildSelfReserve(request, selfActive);
	const selfConditions = buildSideConditions(battle?.sides?.[ourSideIndex]?.sideConditions);

	// Build opponent from tracker
	const formatId = config.formatId || '';
	const opponentActive = buildOpponentActiveFromTracker(tracker, isDoubles, formatId);
	const opponentReserve = buildOpponentReserveFromTracker(tracker, opponentActive, formatId);
	const opponentConditions = buildOpponentConditionsFromTracker(tracker);

	// Build field conditions from tracker
	const field = buildFieldConditionsFromTracker(tracker, battle);

	return {
		turn,
		isDoubles,
		self: {
			active: selfActive,
			reserve: selfReserve,
			team: [...selfActive, ...selfReserve],
			conditions: selfConditions,
		},
		opponent: {
			active: opponentActive,
			reserve: opponentReserve,
			team: [...opponentActive, ...opponentReserve],
			conditions: opponentConditions,
		},
		field,
	};
}

/**
 * Build self active Pokemon from request, using tracker for boosts
 * This is used in server environment where battle.sides is not accessible
 */
function buildSelfActiveWithTracker(request: AnyObject, tracker: BattleTracker, isDoubles: boolean): AIPokemon[] {
	const active: AIPokemon[] = [];
	const pokemon = request.side.pokemon;
	const activeData = request.active || [];

	for (let i = 0; i < activeData.length; i++) {
		const mon = pokemon[i];
		if (!mon || mon.condition.endsWith(' fnt')) continue;

		const aiPokemon = buildPokemonFromRequest(mon, i + 1, true);

		// CFRU AI Fix: Get boosts from tracker instead of battle.sides
		// Tracker listens to stream messages and tracks our boosts
		const slot = isDoubles ? (i === 0 ? 'a' : 'b') : 'a';
		const trackerBoosts = tracker.getOurActiveBoosts(slot);
		aiPokemon.boosts = {
			atk: trackerBoosts.atk,
			def: trackerBoosts.def,
			spa: trackerBoosts.spa,
			spd: trackerBoosts.spd,
			spe: trackerBoosts.spe,
			accuracy: trackerBoosts.accuracy,
			evasion: trackerBoosts.evasion,
		};

		// Get ability stat modifier (Quark Drive, Protosynthesis, etc.)
		const abilityStatMod = tracker.getOurAbilityStatMod(slot);
		aiPokemon.abilityStatMod = {
			stat: abilityStatMod.stat,
			multiplier: abilityStatMod.multiplier,
		};

		// Get lastMove for consecutive Protect detection
		// CFRU: gLastResultingMoves[bankAtk]
		aiPokemon.lastMove = tracker.getOurLastMove(slot);

		active.push(aiPokemon);
	}

	return active;
}

/**
 * Build opponent active Pokemon from tracker
 */
function buildOpponentActiveFromTracker(tracker: BattleTracker, isDoubles: boolean, formatId: string = ''): AIPokemon[] {
	const active: AIPokemon[] = [];

	if (isDoubles) {
		const opponents = tracker.getActiveOpponents();
		for (const { position, pokemon } of opponents) {
			// Extract slot from position: p1a -> 1, p1b -> 2
			const slotChar = position.charAt(position.length - 1); // 'a' or 'b'
			const slot = slotChar === 'a' ? 1 : 2;
			active.push(trackedPokemonToAIPokemon(pokemon, slot, true, formatId));
		}
	} else {
		const opponent = tracker.getActiveOpponent();
		if (opponent) {
			active.push(trackedPokemonToAIPokemon(opponent, 1, true, formatId));
		}
	}

	return active;
}

/**
 * Build opponent reserve from tracker
 */
function buildOpponentReserveFromTracker(tracker: BattleTracker, active: AIPokemon[], formatId: string = ''): AIPokemon[] {
	const reserve: AIPokemon[] = [];
	const team = tracker.getOpponentTeam();
	const activeSpecies = new Set(active.map(p => p.species));

	let slot = active.length + 1;
	for (const mon of team) {
		if (activeSpecies.has(mon.species)) continue;
		if (mon.hpPercent <= 0) continue; // Skip fainted

		reserve.push(trackedPokemonToAIPokemon(mon, slot++, false, formatId));
	}

	return reserve;
}

/**
 * Convert TrackedPokemon to AIPokemon
 * Uses IV=31, EV=85 (average), no nature modifier for opponent stat estimation
 *
 * @param tracked - The tracked Pokemon data
 * @param slot - The slot number
 * @param isActive - Whether the Pokemon is active
 * @param formatId - The format ID for level resolution (optional)
 */
export function trackedPokemonToAIPokemon(
	tracked: TrackedPokemon,
	slot: number,
	isActive: boolean,
	formatId: string = ''
): AIPokemon {
	const speciesData = Dex.species.get(tracked.species);
	// CFRU AI Fix: Use tracked.level directly instead of resolveLevel
	// This ensures opponent level matches the actual level parsed from protocol messages
	// Previously resolveLevel could return 100 for unrecognized formats, causing level mismatch
	const level = tracked.level || 100;

	// Calculate stats using IV=31, EV=85 (average effort value), no nature modifier
	// Formula: stat = ((2 * base + IV + EV/4) * level / 100) + 5
	// For HP: stat = ((2 * base + IV + EV/4) * level / 100) + level + 10
	const IV = 31;
	const EV = 85;

	const baseStats = speciesData.baseStats || { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };

	// Calculate actual stat values for opponent
	const calculatedStats = {
		hp: Math.floor((2 * baseStats.hp + IV + Math.floor(EV / 4)) * level / 100) + level + 10,
		atk: Math.floor((2 * baseStats.atk + IV + Math.floor(EV / 4)) * level / 100) + 5,
		def: Math.floor((2 * baseStats.def + IV + Math.floor(EV / 4)) * level / 100) + 5,
		spa: Math.floor((2 * baseStats.spa + IV + Math.floor(EV / 4)) * level / 100) + 5,
		spd: Math.floor((2 * baseStats.spd + IV + Math.floor(EV / 4)) * level / 100) + 5,
		spe: Math.floor((2 * baseStats.spe + IV + Math.floor(EV / 4)) * level / 100) + 5,
	};

	// Estimate HP values using calculated max HP
	const estimatedMaxHp = calculatedStats.hp;
	const estimatedHp = Math.floor(estimatedMaxHp * tracked.hpPercent / 100);

	// Copy boosts from tracker (or use defaults)
	const boosts = tracked.boosts ? { ...tracked.boosts } : {
		atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0,
	};

	return {
		slot,
		species: tracked.species,
		hp: estimatedHp,
		maxHp: estimatedMaxHp,
		hpPercent: tracked.hpPercent,
		status: tracked.status || '',
		sleepTurns: 0, // Not tracked
		toxicCounter: 0, // Not tracked
		types: tracked.types,
		ability: tracked.ability || '',
		item: tracked.item || '',
		itemLost: tracked.itemLost || false,  // Use tracked itemLost status
		moves: tracked.knownMoves,
		lastMove: tracked.lastMove || '',
		// Use calculated stats instead of base stats for damage calculation
		baseStats: calculatedStats,
		boosts,
		abilityStatMod: { stat: null, multiplier: 1 },
		volatiles: new Set(), // TODO: track volatiles
		fainted: tracked.hpPercent <= 0,
		active: isActive,
		level,
		gender: 'N',
	};
}

/**
 * Build field conditions combining tracker and battle data
 */
function buildFieldConditionsFromTracker(tracker: BattleTracker, battle: AnyObject | null): FieldConditions {
	const trackerField = tracker.getFieldConditions();

	// If we have battle data, use it (more accurate)
	if (battle?.field) {
		return buildFieldConditions(battle);
	}

	// Otherwise use tracker data
	return {
		weather: trackerField.weather || '',
		weatherTurns: -1, // Not tracked
		terrain: trackerField.terrain || '',
		terrainTurns: 0, // Not tracked
		trickroom: trackerField.trickRoom || false,
		trickroomTurns: 0, // Not tracked
		gravity: false, // Not tracked
		magicroom: false, // Not tracked
		wonderroom: false, // Not tracked
	};
}

/**
 * Build opponent side conditions from tracker
 */
function buildOpponentConditionsFromTracker(tracker: BattleTracker): SideConditions {
	const conditions = tracker.getOpponentSideConditions();

	return {
		stealthrock: conditions.stealthrock,
		spikes: conditions.spikes,
		toxicspikes: conditions.toxicspikes,
		stickyweb: conditions.stickyweb,
		lightscreen: conditions.lightscreen,
		reflect: conditions.reflect,
		auroraveil: conditions.auroraveil,
		tailwind: conditions.tailwind,
		wish: 0, // Not tracked
		futuremove: 0, // Not tracked
	};
}
