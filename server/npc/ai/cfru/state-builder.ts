/**
 * CFRU AI - Battle State Builder
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Builds BattleState from authorized requests, public protocol facts and separate preset estimates.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../sim/dex';
import { abilityStatModifier } from './util/mechanics';
import {
	DEFAULT_AI_CONFIG,
	type BattleState,
	type AIPokemon,
	type AIMove,
	type SideConditions,
	type FieldConditions,
	type CFRUAIConfig,
} from './types';
import {
	normalizeWeather, type BattleTracker, type TrackedPokemon, type TrackedTransformation,
} from './util/battle-tracker';
import {
	parseCondition,
	parseDetails,
	speciesDefaults,
	makeAIPokemonSkeleton,
} from './util/pokemon-builder';
import { getOpponentPreset, getOpponentMoveKnowledge, computeStatsFromPreset } from './util/opponent-presets';
import { applyRandomBattlePresets } from './util/random-presets';

/**
 * Build Pokemon from request data (self)
 * Active effects and estimates are applied by the shared state assembly path.
 */
export function buildPokemonFromRequest(mon: AnyObject, slot: number, isActive: boolean, formatId = ''): AIPokemon {
	const { currentHp, maxHp, hpPercent, status, fainted } = parseCondition(mon.condition);
	const { species, level, gender } = parseDetails(mon.details);
	const { types } = speciesDefaults(species, formatId);

	// CFRU AI Fix: Use actual stats from request instead of base stats (species stats)
	// mon.stats contains the actual computed stats: { atk, def, spa, spd, spe }
	// This is critical for damage calculation accuracy!
	const { baseStats: fallbackBaseStats } = speciesDefaults(species, formatId);
	const actualStats = mon.stats ? {
		hp: maxHp, // Use actual max HP from condition
		atk: mon.stats.atk,
		def: mon.stats.def,
		spa: mon.stats.spa,
		spd: mon.stats.spd,
		spe: mon.stats.spe,
	} : fallbackBaseStats; // Fallback to base stats if mon.stats is not available

	return makeAIPokemonSkeleton({
		slot,
		species,
		hp: currentHp,
		maxHp,
		hpPercent,
		status,
		fainted,
		types,
		ability: mon.ability || mon.baseAbility || '',
		item: mon.item || '',
		itemKnown: true,
		moves: mon.moves || [],
		baseStats: actualStats,
		active: isActive,
		level,
		gender,
	});
}

/**
 * 把单条 PS move 数据转成 AIMove。
 *
 * 入参 `moveData` 容忍三种来源：
 *   1) request.active[i].moves[j] —— 原生 PS 协议对象，字段：
 *      { move, id, pp, maxpp, target, disabled }
 *   2) NPCBattleAI 的 MoveChoice —— 已经预先补了 Dex 字段：
 *      { slot, move, target, zMove, disabled, basePower, type, category }
 *   3) Multi 场景从别处搬运的 move 对象：可能只有 `id` 而没有 `move`
 *
 * Return/Frustration 这类 PS 名字带 BP 的招（例如 "Return 102"），Dex 查不到，硬编码。
 */
export function buildAIMove(moveData: AnyObject, slot: number, formatId = ''): AIMove {
	const moveName = moveData.move || moveData.id || '';
	const moveId = toID(moveName);
	const dexMove = (formatId ? Dex.forFormat(formatId) : Dex).moves.get(moveName);
	// MoveChoice may contain metadata filled from the global Dex upstream.
	// When the format is known, its move data is authoritative.
	const metadata = formatId && dexMove.exists ? dexMove : moveData;
	const isReturn = moveId.startsWith('return') && moveId !== 'returntoearth';
	const isFrustration = moveId.startsWith('frustration');

	return {
		id: moveId,
		name: isReturn ? 'Return' : (isFrustration ? 'Frustration' : (dexMove.name || moveName)),
		slot,
		type: isReturn || isFrustration ? 'Normal' : (metadata.type || dexMove.type || '???'),
		category: isReturn || isFrustration ? 'Physical' :
		((metadata.category || dexMove.category || 'Status') as 'Physical' | 'Special' | 'Status'),
		basePower: isReturn ? 102 : (isFrustration ? 1 : (metadata.basePower ?? dexMove.basePower ?? 0)),
		accuracy: isReturn || isFrustration ? 100 : dexMove.accuracy,
		pp: moveData.pp ?? dexMove.pp ?? 10,
		maxPp: moveData.maxpp ?? dexMove.pp ?? 10,
		priority: dexMove.priority || 0,
		target: moveData.target || dexMove.target || 'normal',
		flags: isReturn || isFrustration ? { contact: 1, protect: 1 } : (dexMove.flags || {}),
		status: dexMove.status,
		boosts: dexMove.boosts,
		recoil: dexMove.recoil,
		secondaryChance: dexMove.secondary?.chance || 0,
		disabled: moveData.disabled || false,
		isZMove: !!moveData.zMove,
		isMaxMove: false,
		multihit: dexMove.multihit || null,
	};
}

/**
 * Build AIMove array from request move data
 */
export function buildMovesFromRequest(request: AnyObject, activeIndex: number, formatId = ''): AIMove[] {
	const active = request.active?.[activeIndex];
	if (!active?.moves) return [];
	return active.moves.map((moveData: AnyObject, i: number) => buildAIMove(moveData, i + 1, formatId));
}

/** A request belongs to one player; field slots and party slots are separate in Multi. */
export interface AIPlayerRequest {
	side: string;
	request: AnyObject;
}

/** The sole state assembly path for singles, doubles and Multi. */
export function buildBattleStateFromRequests(
	requests: AIPlayerRequest[], tracker: BattleTracker, config: CFRUAIConfig = DEFAULT_AI_CONFIG,
	turn = tracker.getTurn()
): BattleState {
	const formatId = config.formatId;
	const isDoubles = config.isDoubles || requests.length > 1 || requests.some(({ request }) =>
		(request.active || request.forceSwitch || []).length > 1);
	const entries: { mon: AnyObject, pokemon: AIPokemon, position: string, active: boolean }[] = requests.flatMap(
		({ side, request }) => (request.side?.pokemon || []).map((mon: AnyObject, i: number) => {
			const active = mon.active ?? i < (request.active || request.forceSwitch || []).length;
			const position = tracker.getPosition(side, i);
			const pokemon = buildPokemonFromRequest(mon, active ? tracker.getFieldSlot(position) : i + 1, active, formatId);
			pokemon.ownerSide = side;
			tracker.recordRequestItem(mon.ident, pokemon.item);
			pokemon.sleepSelfInflicted = tracker.getSelfInflictedSleep(mon.ident);
			// Register only request facts. Transform may have occurred before the first request.
			if (active) tracker.rememberOurPokemon(position, mon.ident, pokemon);
			pokemon.recyclableItem = tracker.getRecyclableItem(mon.ident);
			pokemon.itemKnockedOff = tracker.wasItemKnockedOff(mon.ident);
			return { mon, pokemon, position, active };
		}));
	const selfActive: AIPokemon[] = [];
	const selfReserve: AIPokemon[] = [];
	for (const { mon, pokemon, position, active } of entries) {
		if (!active) {
			selfReserve.push(pokemon);
		} else if (!pokemon.fainted) {
			pokemon.boosts = tracker.getOurActiveBoosts(position);
			pokemon.abilityStatMod = tracker.getOurAbilityStatMod(position);
			pokemon.lastMove = tracker.getOurLastMove(position);
			pokemon.volatiles = tracker.getVolatiles(position);
			pokemon.activeMoveActions = tracker.hasActed(position) ? 1 : 0;
			const transformed = applyTransformation(pokemon, tracker.getTransformation(position), formatId, true);
			transformed.types = tracker.getTypes(position, transformed.types);
			// Newer requests expose the current ability, including changes after Transform.
			if (mon.ability !== undefined) transformed.ability = mon.ability;
			transformed.sleepTurns = transformed.status === 'slp' ? tracker.getSleepTurns(position, transformed.ability) : 0;
			selfActive.push(transformed);
		}
	}
	const opponentActive = tracker.getActiveOpponents().map(({ position, pokemon }) => {
		const result = trackedPokemonToAIPokemon(pokemon, tracker.getFieldSlot(position), true, formatId,
			tracker.getSleepTurns(position, pokemon.ability));
		result.types = tracker.getTypes(position, result.types);
		result.activeMoveActions = tracker.hasActed(position) ? 1 : 0;
		return result;
	});
	const opponentReserve = buildOpponentReserveFromTracker(tracker, opponentActive, formatId);
	return {
		turn, isDoubles,
		self: { active: selfActive, reserve: selfReserve, team: [...selfActive, ...selfReserve],
			conditions: { ...tracker.getOurSideConditions(), wishes: tracker.getWishes(), futureMoves: tracker.getFutureMoves() } },
		opponent: { remaining: tracker.getRemainingOpponents(), active: opponentActive, reserve: opponentReserve,
			team: [...opponentActive, ...opponentReserve], conditions: buildOpponentConditionsFromTracker(tracker) },
		field: { ...buildFieldConditionsFromTracker(tracker), formatId },
	};
}

/** Single-controller adapter; the battle reference supplies only the public turn number. */
export function buildBattleStateWithTracker(
	request: AnyObject, battle: AnyObject | null, tracker: BattleTracker, config: CFRUAIConfig = DEFAULT_AI_CONFIG
): BattleState {
	return buildBattleStateFromRequests([{ side: request.side?.id || tracker.getOurSide(), request }],
		tracker, config, battle?.turn ?? tracker.getTurn());
}

/**
 * Build opponent reserve from tracker
 */
function buildOpponentReserveFromTracker(tracker: BattleTracker, active: AIPokemon[], formatId: string = ''): AIPokemon[] {
	const reserve: AIPokemon[] = [];
	const team = tracker.getOpponentTeam();

	let slot = Math.max(0, ...active.map(p => p.slot)) + 1;
	for (const mon of team) {
		if (mon.active) continue;
		if (mon.hpPercent <= 0) continue; // Skip fainted

		reserve.push(trackedPokemonToAIPokemon(
			mon, slot++, false, formatId, tracker.getSleepTurns(mon.ident || mon.position, mon.ability)
		));
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
	formatId = '',
	sleepTurns = 0
): AIPokemon {
	// CFRU AI Fix: Use tracked.level directly instead of resolveLevel
	// This ensures opponent level matches the actual level parsed from protocol messages
	// Previously resolveLevel could return 100 for unrecognized formats, causing level mismatch
	const level = tracked.level || 100;
	const { baseStats } = (formatId ? Dex.forFormat(formatId) : Dex).species.get(tracked.species);

	// 优先使用 opponent-presets.json 的常见练度；未命中回退到 IV=31 / EV=85 / 无性格的默认估算
	// 协议里暴露的道具（tracked.item）优先于 preset.item：对手已经被观察到持有某物就以观察为准
	const preset = getOpponentPreset(tracked.species, formatId);
	let calculatedStats: AIPokemon['baseStats'];
	let presetItem: string | undefined;
	if (preset) {
		calculatedStats = computeStatsFromPreset(baseStats, level, preset);
		presetItem = preset.item;
	} else {
		const IV = 31;
		const EV = 85;
		calculatedStats = {
			hp: Math.floor((2 * baseStats.hp + IV + Math.floor(EV / 4)) * level / 100) + level + 10,
			atk: Math.floor((2 * baseStats.atk + IV + Math.floor(EV / 4)) * level / 100) + 5,
			def: Math.floor((2 * baseStats.def + IV + Math.floor(EV / 4)) * level / 100) + 5,
			spa: Math.floor((2 * baseStats.spa + IV + Math.floor(EV / 4)) * level / 100) + 5,
			spd: Math.floor((2 * baseStats.spd + IV + Math.floor(EV / 4)) * level / 100) + 5,
			spe: Math.floor((2 * baseStats.spe + IV + Math.floor(EV / 4)) * level / 100) + 5,
		};
	}

	const estimatedMaxHp = calculatedStats.hp;
	const estimatedHp = Math.floor(estimatedMaxHp * tracked.hpPercent / 100);
	const fainted = tracked.hpPercent <= 0;
	// item 的来源优先级：协议暴露的（tracked.item） > preset.item > 空字符串
	const effectiveItem = tracked.item || (tracked.itemLost ? '' : (presetItem || ''));

	const pokemon = makeAIPokemonSkeleton({
		slot,
		species: tracked.species,
		hp: estimatedHp,
		maxHp: estimatedMaxHp,
		hpPercent: tracked.hpPercent,
		status: tracked.status || '',
		fainted,
		types: tracked.types,
		ability: tracked.ability || '',
		item: effectiveItem,
		itemLost: tracked.itemLost || false,
		moves: tracked.knownMoves,
		lastMove: tracked.lastMove || '',
		baseStats: calculatedStats,
		boosts: tracked.boosts ? { ...tracked.boosts } : undefined,
		active: isActive,
		level,
		gender: 'N',
	});
	pokemon.volatiles = new Set(tracked.volatiles);
	pokemon.abilityStatMod = abilityStatModifier(pokemon.volatiles);
	pokemon.ownerSide = (tracked.ident || tracked.position).slice(0, 2);
	pokemon.sleepSelfInflicted = tracked.sleepSelfInflicted;
	pokemon.sleepTurns = pokemon.status === 'slp' ? sleepTurns : 0;
	pokemon.itemKnown = !!tracked.item || tracked.itemLost;
	pokemon.observedAbility = tracked.baseAbility || '';
	pokemon.itemChanged = tracked.itemChanged;
	pokemon.recyclableItem = tracked.recyclableItem;
	pokemon.itemKnockedOff = tracked.itemKnockedOff;
	pokemon.originalItem = tracked.originalItem || '';
	pokemon.abilityChanged = tracked.abilityChanged;
	pokemon.moveKnowledge = getOpponentMoveKnowledge(tracked.species, tracked.knownMoves, formatId);
	return applyTransformation(applyRandomBattlePresets(pokemon, formatId), tracked.transformation, formatId);
}

/** Transform copies the target's non-HP stats, types, moves and ability, not its item or level. */
function applyTransformation(
	pokemon: AIPokemon, transformation: TrackedTransformation | undefined, formatId = '', own = false
): AIPokemon {
	if (!transformation) return pokemon;
	const source = transformation.target ? trackedPokemonToAIPokemon(transformation.target, 1, true, formatId) :
		transformation.pokemon;
	if (!source) return pokemon;
	const dex = formatId ? Dex.forFormat(formatId) : Dex;
	const revealedMoves = [...new Set([...source.moves, ...transformation.knownMoves].map(toID))];
	const knowledge = transformation.target ? (source as AIPokemon).moveKnowledge : undefined;
	return {
		...pokemon,
		species: source.species,
		volatiles: new Set([...pokemon.volatiles, 'transform']),
		types: [...source.types],
		baseStats: { ...source.baseStats, hp: pokemon.baseStats.hp },
		ability: dex.gen <= 2 ? pokemon.ability : own ? source.ability || pokemon.ability : pokemon.ability || source.ability,
		abilityChanged: dex.gen > 2 || pokemon.abilityChanged,
		moves: own ? pokemon.moves : revealedMoves,
		moveKnowledge: own ? undefined : {
			revealedMoves,
			presetCandidates: (knowledge?.presetCandidates || []).filter(id => !revealedMoves.includes(toID(id))),
			remainingSlots: Math.max(0, 4 - revealedMoves.length),
			movePools: knowledge?.movePools?.map(pool => [...pool]),
		},
		presetModels: undefined,
	};
}

/**
 * Build canonical field conditions from public protocol facts.
 */
function buildFieldConditionsFromTracker(tracker: BattleTracker): FieldConditions {
	const trackerField = tracker.getFieldConditions();

	return {
		weather: normalizeWeather(trackerField.weather || ''),
		weatherTurns: -1, // Not tracked
		terrain: trackerField.terrain || '',
		terrainTurns: 0, // Not tracked
		trickroom: trackerField.trickRoom || false,
		trickroomTurns: 0, // Not tracked
		gravity: trackerField.gravity,
		magicroom: trackerField.magicRoom,
		wonderroom: trackerField.wonderRoom,
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
		safeguard: conditions.safeguard,
		wishes: tracker.getWishes(false),
		futureMoves: tracker.getFutureMoves(false),
	};
}
