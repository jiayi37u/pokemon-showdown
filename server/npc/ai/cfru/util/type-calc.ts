/**
 * CFRU AI - Type Calculation Utilities
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Type effectiveness calculation functions.
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, AICache, FieldConditions } from '../types';
import {
	effectiveAbility, defensiveAbility, effectiveItem, effectivePriority, getEffectiveStat, grounded, rulesDex,
} from './mechanics';
import { itemMoveFailure } from './items';

/** Resolve public move effects while retaining the selected move's identity and slot. */
export function resolveMove(attacker: AIPokemon, move: AIMove, field: FieldConditions, target?: AIPokemon): AIMove {
	const dex = rulesDex(field);
	let id = move.id;
	if (id === 'naturepower') {
		const terrainMoves: Record<string, string> = {
			electric: 'thunderbolt', grassy: 'energyball', misty: 'moonblast', psychic: 'psychic',
		};
		id = dex.currentMod === 'mmo' || dex.gen >= 6 ? (terrainMoves[field.terrain] || 'triattack') :
			dex.gen === 5 ? 'earthquake' : dex.gen === 3 ? 'swift' : 'triattack';
		const called = dex.moves.get(id);
		move = { ...move, calledMove: id, category: called.category, basePower: called.basePower,
			type: called.type, baseType: called.type, accuracy: called.accuracy, flags: called.flags, target: called.target,
			status: called.status, boosts: called.boosts, recoil: called.recoil,
			secondaryChance: called.secondary?.chance || 0, multihit: called.multihit || null };
	}
	if (['photongeyser', 'lightthatburnsthesky'].includes(id) ||
		(attacker.terastallized && (id === 'terablast' ||
			id === 'terastarstorm' && toID(attacker.species) === 'terapagosstellar'))) {
		// The engine compares staged stats before item/ability multipliers, not damage against this target.
		const physical = getEffectiveStat(attacker.baseStats.atk, attacker.boosts.atk) >
			getEffectiveStat(attacker.baseStats.spa, attacker.boosts.spa);
		move = { ...move, category: physical ? 'Physical' : 'Special' };
	}
	if (id === 'shellsidearm' && target) {
		const power = (atk: 'atk' | 'spa', def: 'def' | 'spd') => {
			const attack = getEffectiveStat(attacker.baseStats[atk], attacker.boosts[atk]);
			const defense = getEffectiveStat(target.baseStats[def], target.boosts[def]);
			return Math.floor(Math.floor(Math.floor(2 * attacker.level / 5 + 2) * 90 * attack / defense) / 50);
		};
		// Ties are random in battle; use the default special category for estimates.
		const physical = power('atk', 'def') > power('spa', 'spd');
		const flags = { ...move.flags };
		if (physical) flags.contact = 1;
		else delete flags.contact;
		move = { ...move, category: physical ? 'Physical' : 'Special', flags };
	}
	if (id === 'expandingforce' && field.terrain === 'psychic' && grounded(attacker, field)) {
		move = { ...move, target: 'allAdjacentFoes' };
	}
	if (id === 'terastarstorm' && toID(attacker.species) === 'terapagosstellar') {
		move = { ...move, target: 'allAdjacentFoes' };
	}
	return { ...move, ...resolveMoveType(attacker, { ...move, id }, field) };
}

/** Type-changing effects also resolve public Stellar type consumption without constructing a scoring context. */
export function resolveMoveType(
	attacker: AIPokemon,
	move: Pick<AIMove, 'id' | 'type' | 'category' | 'flags'> & Partial<Pick<AIMove, 'baseType' | 'isZMove'>>,
	field: FieldConditions
): { baseType: string, type: string, typeChangeBoost: number } {
	const dex = rulesDex(field);
	const id = move.id;
	const baseType = move.baseType || move.type;
	let type = baseType;
	if (id === 'terablast' && attacker.terastallized) type = attacker.terastallized;
	if (id === 'terastarstorm' && toID(attacker.species) === 'terapagosstellar') {
		type = 'Stellar';
	}
	if (['judgment', 'multiattack', 'technoblast', 'naturalgift'].includes(id)) {
		type = 'Normal';
		const item = dex.items.get(effectiveItem(attacker, field));
		const itemType = id === 'judgment' ? (!item.zMove && item.onPlate) :
			id === 'multiattack' ? item.onMemory : id === 'naturalgift' ? item.naturalGift?.type : item.onDrive;
		if (typeof itemType === 'string') type = itemType;
	} else if (id === 'revelationdance') {
		const types = attacker.volatiles.has('roost') ? attacker.types.filter(t => t !== 'Flying') : attacker.types;
		type = types.find(t => t !== '???' && t !== 'Bird') || (types.length ? '???' : 'Normal');
	} else if (id === 'weatherball') {
		const weatherTypes: Record<string, string> = { sun: 'Fire', rain: 'Water', sand: 'Rock', hail: 'Ice', snow: 'Ice' };
		type = weatherTypes[field.weather] || 'Normal';
	} else if (id === 'terrainpulse' && grounded(attacker, field)) {
		const terrainTypes: Record<string, string> = {
			electric: 'Electric', grassy: 'Grass', misty: 'Fairy', psychic: 'Psychic',
		};
		type = terrainTypes[field.terrain] || 'Normal';
	} else if (id === 'ivycudgel') {
		const species = toID(attacker.species).replace(/tera$/, '');
		const types: Record<string, string> = {
			ogerponwellspring: 'Water', ogerponhearthflame: 'Fire', ogerponcornerstone: 'Rock',
		};
		type = types[species] || baseType;
	} else if (id === 'ragingbull') {
		const types: Record<string, string> = {
			taurospaldeacombat: 'Fighting', taurospaldeablaze: 'Fire', taurospaldeaaqua: 'Water',
		};
		type = types[toID(attacker.species)] || baseType;
	} else if (id === 'aurawheel') {
		type = toID(attacker.species) === 'morpekohangry' ? 'Dark' : 'Electric';
	}
	const ability = effectiveAbility(attacker, field);
	const conversion: Record<string, string> = {
		pixilate: 'Fairy', aerilate: 'Flying', refrigerate: 'Ice', galvanize: 'Electric',
	};
	const fixedType = [
		'judgment', 'multiattack', 'naturalgift', 'revelationdance', 'technoblast', 'terrainpulse', 'weatherball',
	];
	let typeChangeBoost = 1;
	if (!fixedType.includes(id) && !(attacker.terastallized && ['terablast', 'terastarstorm'].includes(id)) &&
		!(move.isZMove && move.category !== 'Status')) {
		if (type === 'Normal' && conversion[ability]) {
			type = conversion[ability];
			typeChangeBoost = dex.gen <= 6 ? 1.3 : 1.2;
		} else if (ability === 'normalize' && !id.startsWith('hiddenpower') && id !== 'struggle') {
			type = 'Normal';
			typeChangeBoost = dex.gen <= 6 ? 1 : 1.2;
		}
	}
	if (ability === 'liquidvoice' && move.flags.sound && !attacker.volatiles.has('dynamax')) type = 'Water';
	return { baseType, type, typeChangeBoost };
}

/** Type effectiveness multipliers */
export const TYPE_EFFECTIVENESS = {
	IMMUNE: 0,
	QUARTER: 0.25,
	HALF: 0.5,
	NORMAL: 1,
	DOUBLE: 2,
	QUAD: 4,
} as const;

/**
 * Get type effectiveness multiplier for a move against a defender
 * Based on CFRU's AI_SpecialTypeCalc (damage_calc.c:1200)
 * @param moveType - The move's type
 * @param defenderTypes - The defender's types
 * @param cache - Optional cache for memoization
 * @returns Effectiveness multiplier (0, 0.25, 0.5, 1, 2, or 4)
 */
export function getTypeEffectiveness(
	moveType: string,
	defenderTypes: string[],
	cache?: AICache
): number {
	// Check cache
	const cacheKey = `${moveType}-${defenderTypes.join(',')}`;
	if (cache?.typeEffectiveness.has(cacheKey)) {
		return cache.typeEffectiveness.get(cacheKey)!;
	}

	// IMPORTANT: First check for immunity using Dex.getImmunity
	// getImmunity returns FALSE if immune (that's how PS Dex API works)
	// This handles Ground vs Flying, Normal/Fighting vs Ghost, etc.
	if (!Dex.getImmunity(moveType, defenderTypes)) {
		// Cache result
		if (cache) {
			cache.typeEffectiveness.set(cacheKey, 0);
		}
		return 0;
	}

	// Not immune, calculate effectiveness
	// Dex.getEffectiveness returns a sum: +1 for each super-effective, -1 for each resist
	const effectivenessSum = Dex.getEffectiveness(moveType, defenderTypes);

	// Convert sum to multiplier: sum of +2 = 4x, +1 = 2x, 0 = 1x, -1 = 0.5x, -2 = 0.25x
	const multiplier = Math.pow(2, effectivenessSum);

	// Cache result
	if (cache) {
		cache.typeEffectiveness.set(cacheKey, multiplier);
	}

	return multiplier;
}

/**
 * Check if a move type has STAB (Same Type Attack Bonus)
 * @param moveType - The move's type
 * @param attackerTypes - The attacker's types
 * @returns true if STAB applies
 */
export function hasSTAB(moveType: string, attackerTypes: string[]): boolean {
	return attackerTypes.includes(moveType);
}

/**
 * Get STAB multiplier
 * @param moveType - The move's type
 * @param attackerTypes - The attacker's types
 * @param ability - The attacker's ability (for Adaptability)
 * @returns STAB multiplier (1, 1.5, or 2 for Adaptability)
 */
export function getSTABMultiplier(
	moveType: string, attackerTypes: string[], ability: string, pokemon?: AIPokemon
): number {
	const original = pokemon?.terastallized ? pokemon.originalTypes || attackerTypes : attackerTypes;
	const isSTAB = attackerTypes.includes(moveType) || original.includes(moveType);
	let stab = isSTAB ? 1.5 : 1;
	if (pokemon?.terastallized === 'Stellar') {
		if (toID(pokemon.species) === 'terapagosstellar' || !pokemon.stellarBoostedTypes?.includes(moveType)) {
			return isSTAB ? 2 : 4915 / 4096;
		}
		return stab;
	}
	if (pokemon?.terastallized === moveType && original.includes(moveType)) stab = 2;
	if (toID(ability) === 'adaptability' && attackerTypes.includes(moveType)) return stab === 2 ? 2.25 : 2;
	return stab;
}

/**
 * Check if a type is immune to a move type due to ability
 * @param moveType - The move's type
 * @param ability - The defender's ability
 * @returns Object with immunity status and the ability effect
 */
export function getAbilityTypeImmunity(
	moveType: string,
	ability: string
): { immune: boolean; effect?: string } {
	const abilityId = toID(ability);
	const moveTypeId = toID(moveType);

	// Electric immunities
	if (moveTypeId === 'electric') {
		if (['voltabsorb', 'lightningrod', 'motordrive'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
	}

	// Water immunities
	if (moveTypeId === 'water') {
		if (['waterabsorb', 'stormdrain', 'dryskin'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
	}

	// Fire immunities
	if (moveTypeId === 'fire') {
		if (['flashfire', 'wellbakedbody'].includes(abilityId)) {
			return { immune: true, effect: abilityId };
		}
		// Fluffy takes double damage from Fire, not immune
	}

	// Grass immunities
	if (moveTypeId === 'grass') {
		if (abilityId === 'sapsipper') {
			return { immune: true, effect: abilityId };
		}
	}

	// Ground immunities (Levitate is handled by type chart in most cases)
	if (moveTypeId === 'ground') {
		if (abilityId === 'levitate') {
			return { immune: true, effect: abilityId };
		}
		if (abilityId === 'eartheater') {
			return { immune: true, effect: abilityId };
		}
	}

	// Sound-based move immunity
	// Note: This requires checking move flags, handled separately

	// Bulletproof (ball/bomb moves) - handled by move flags

	return { immune: false };
}

/** Apply public ability bypass and grounding conditions to an ability's type immunity. */
export function getEffectiveAbilityTypeImmunity(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions
): { immune: boolean, effect?: string } {
	const immunity = getAbilityTypeImmunity(move.type, defensiveAbility(attacker, defender, move, field));
	if (immunity.effect === 'levitate' && (grounded(defender, field) || toID(move.id) === 'thousandarrows')) {
		return { immune: false };
	}
	return immunity;
}

/**
 * Check if Wonder Guard blocks a move
 * @param moveType - The move's type
 * @param defenderTypes - The defender's types
 * @param defenderAbility - The defender's ability
 * @returns true if Wonder Guard blocks the move
 */
export function wonderGuardBlocks(
	moveType: string,
	defenderTypes: string[],
	defenderAbility: string
): boolean {
	if (toID(defenderAbility) !== 'wonderguard') {
		return false;
	}

	const effectiveness = getTypeEffectiveness(moveType, defenderTypes);
	return effectiveness <= 1;
}

/**
 * Get all resistances for a Pokemon
 * @param types - The Pokemon's types
 * @returns Map of type -> multiplier for types it resists
 */
export function getResistances(types: string[]): Map<string, number> {
	const resistances = new Map<string, number>();

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness < 1) {
			resistances.set(attackType, effectiveness);
		}
	}

	return resistances;
}

/**
 * Get all weaknesses for a Pokemon
 * @param types - The Pokemon's types
 * @returns Map of type -> multiplier for types it's weak to
 */
export function getWeaknesses(types: string[]): Map<string, number> {
	const weaknesses = new Map<string, number>();

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness > 1) {
			weaknesses.set(attackType, effectiveness);
		}
	}

	return weaknesses;
}

/**
 * Get all immunities for a Pokemon (type-based only)
 * @param types - The Pokemon's types
 * @returns Array of types the Pokemon is immune to
 */
export function getImmunities(types: string[]): string[] {
	const immunities: string[] = [];

	const allTypes = Object.keys(Dex.data.TypeChart);

	for (const attackType of allTypes) {
		const effectiveness = getTypeEffectiveness(attackType, types);
		if (effectiveness === 0) {
			immunities.push(attackType);
		}
	}

	return immunities;
}

/** Public active allies are needed for team-wide priority protection in doubles and multi. */
export interface MoveInteractionContext {
	defenderAllies?: readonly AIPokemon[];
	/** All active participants, including the attacker's allies, for redirection. */
	activePokemon?: readonly AIPokemon[];
	isAllyTarget?: boolean;
}

/** A rule result shared by damage, scoring and threat estimates; no strategy weights. */
export function getMoveInteraction(
	attacker: AIPokemon, defender: AIPokemon, move: AIMove, field: FieldConditions,
	context: MoveInteractionContext = {}
): { effectiveness: number, blockedBy?: string, failed?: boolean } {
	const dex = rulesDex(field);
	move = resolveMove(attacker, move, field, defender);
	const data = dex.moves.get(move.calledMove || move.id);
	const ability = defensiveAbility(attacker, defender, move, field);
	const block = (blockedBy: string, failed = false) => ({ effectiveness: 0, blockedBy, ...(failed ? { failed } : {}) });
	if (['explosion', 'selfdestruct', 'mindblown', 'mistyexplosion'].includes(move.id) &&
		[attacker, defender, ...(context.activePokemon || context.defenderAllies || [])].some(p =>
			!p.fainted && defensiveAbility(attacker, p, move, field) === 'damp')) {
		return block('Damp prevents explosive moves', true);
	}
	if (move.id === 'steelroller' && !field.terrain) return block('Steel Roller requires terrain', true);
	if (move.id === 'lastresort' && attacker.usedMoves) {
		const others = attacker.moves.map(toID).filter(id => id !== 'lastresort');
		if (!others.length || !attacker.moves.some(id => toID(id) === 'lastresort') ||
			others.some(id => !attacker.usedMoves!.includes(id))) {
			return block('Last Resort requires all other moves to be used', true);
		}
	}
	if (move.id === 'spitup' && ![...attacker.volatiles].some(v => /^stockpile[1-3]$/.test(v))) {
		return block('Spit Up requires Stockpile', true);
	}
	// Redirection is field-wide. Spread moves and Stalwart/Propeller Tail bypass it.
	if (['normal', 'any', 'randomNormal', 'adjacentFoe'].includes(move.target) &&
		!['stalwart', 'propellertail'].includes(effectiveAbility(attacker, field)) &&
		!data.tracksTarget && !move.flags.pledgecombo) {
		const redirectAbility = move.type === 'Electric' ? 'lightningrod' : move.type === 'Water' ? 'stormdrain' : '';
		for (const holder of context.activePokemon || context.defenderAllies || []) {
			if (holder === attacker || holder === defender || holder.fainted || !redirectAbility) continue;
			if (defensiveAbility(attacker, holder, move, field) === redirectAbility) {
				return block(`${holder.ability} redirects the move away from this target`);
			}
		}
	}
	const requiredType = move.id === 'doubleshock' ? 'Electric' : move.id === 'burnup' ? 'Fire' : '';
	if (requiredType && !attacker.types.includes(requiredType)) {
		return block(`${move.name} requires the user to be ${requiredType} type`, true);
	}
	if (field.weather && move.category !== 'Status' &&
		((field.weatherId === 'primordialsea' && move.type === 'Fire') ||
			(field.weatherId === 'desolateland' && move.type === 'Water'))) {
		return block('Extreme weather prevents this attack', true);
	}
	if (move.id === 'poltergeist') {
		const failure = itemMoveFailure(attacker, defender, move, field);
		if (failure) return block(failure, true);
	}
	if (['fakeout', 'firstimpression'].includes(move.id) && (attacker.activeMoveActions || attacker.lastMove)) {
		return block(`${move.name} only works on the first action after entry`, true);
	}
	if (move.id === 'leechseed' && defender.types.includes('Grass')) return block('Grass type immune to Leech Seed');
	if (move.id === 'dreameater' && defender.status !== 'slp' && ability !== 'comatose') {
		return block('Dream Eater fails on non-sleeping target', true);
	}
	if (['suckerpunch', 'thunderclap'].includes(move.id) && defender.volatiles.has('mustrecharge')) {
		return block(`${move.name} fails against a recharging target`, true);
	}
	const direct = ['normal', 'any', 'allAdjacent', 'allAdjacentFoes', 'adjacentAlly', 'adjacentAllyOrSelf']
		.includes(move.target) &&
		!(move.id === 'curse' && !attacker.types.includes('Ghost'));
	const foeTarget = direct && attacker !== defender && !context.isAllyTarget;
	if (foeTarget && (move.category === 'Status' || !!move.calledMove) &&
		effectiveAbility(attacker, field) === 'prankster' &&
		!dex.getImmunity('prankster', defender.types)) {
		return block('Dark target immune to Prankster status move');
	}
	if (foeTarget && effectivePriority(attacker, move, field) > 0) {
		if (field.terrain === 'psychic' && grounded(defender, field)) {
			return block('Psychic Terrain blocks priority moves');
		}
		for (const holder of [defender, ...(context.defenderAllies || [])]) {
			if (holder.fainted) continue;
			const protection = defensiveAbility(attacker, holder, move, field);
			if (['dazzling', 'queenlymajesty', 'armortail'].includes(protection)) {
				return block(`${holder.ability} blocks priority moves`);
			}
		}
	}
	if ((direct || move.id === 'perishsong') && attacker !== defender && ability === 'soundproof' && move.flags.sound) {
		return block('Soundproof blocks sound move');
	}
	if (ability === 'bulletproof' && move.flags.bullet) return block('Bulletproof blocks ball/bomb move');
	if (direct && (move.category === 'Status' || !!move.calledMove) && attacker !== defender) {
		if (ability === 'goodasgold') return block('Good as Gold blocks status move');
		if (['disable', 'attract', 'encore', 'torment', 'taunt', 'healblock'].includes(move.id)) {
			for (const holder of [defender, ...(context.defenderAllies || [])]) {
				if (!holder.fainted && defensiveAbility(attacker, holder, move, field) === 'aromaveil') {
					return block('Aroma Veil blocks this move');
				}
			}
		}
	}
	if (direct && move.flags.powder) {
		if (!dex.getImmunity('powder', defender.types)) return block('Grass type immune to powder');
		if (ability === 'overcoat') return block('Overcoat blocks powder');
		if (effectiveItem(defender, field) === 'safetygoggles') return block('Safety Goggles blocks powder');
	}
	if (move.category === 'Status') {
		if (direct && data.ignoreImmunity === false && !dex.getImmunity(move.type, defender.types) &&
			effectiveItem(defender, field) !== 'ringtarget') return block('Type immunity to status move');
		if (direct && getEffectiveAbilityTypeImmunity(attacker, defender, move, field).immune) {
			return block(`Ability immunity: ${defender.ability}`);
		}
		return { effectiveness: 1 };
	}

	if (move.type === 'Stellar') return { effectiveness: defender.terastallized ? 2 : 1 };
	let types = defender.volatiles.has('roost') ? defender.types.filter(t => t !== 'Flying') : defender.types;
	if (!types.length) types = [dex.gen >= 5 ? 'Normal' : '???'];
	const item = effectiveItem(defender, field);
	const arrows = move.id === 'thousandarrows';
	const isGrounded = grounded(defender, field, ability !== 'levitate');
	let exponent = 0;
	for (const type of types) {
		const ignoreImmunity = data.ignoreImmunity === true ||
			(typeof data.ignoreImmunity === 'object' && data.ignoreImmunity[move.type]) || item === 'ringtarget' ||
			(move.type === 'Ground' && (arrows || isGrounded)) ||
			(type === 'Ghost' && ['Normal', 'Fighting'].includes(move.type) &&
				['scrappy', 'mindseye'].includes(effectiveAbility(attacker, field)));
		if (!ignoreImmunity && !dex.getImmunity(move.type, type)) return block(`Type immunity (${move.type} vs ${type})`);
		let typeMod = move.id === 'freezedry' && type === 'Water' ? 1 : dex.getEffectiveness(move.type, type);
		if (field.weather && field.weatherId === 'deltastream' && type === 'Flying' && typeMod > 0) typeMod = 0;
		exponent += typeMod;
		if (move.id === 'flyingpress') exponent += dex.getEffectiveness('Flying', type);
	}
	// Iron Ball alone makes Ground neutral against Flying dual types, unlike Gravity/Smack Down.
	const ironBallNeutral = move.type === 'Ground' && item === 'ironball' && types.includes('Flying') &&
		!field.gravity && !defender.volatiles.has('ingrain') && !defender.volatiles.has('smackdown');
	let effectiveness = ironBallNeutral || (arrows && types.includes('Flying') && !isGrounded) ? 1 : 2 ** exponent;
	if (move.type === 'Ground' && !arrows && !isGrounded &&
		(item === 'airballoon' || defender.volatiles.has('magnetrise') || defender.volatiles.has('telekinesis'))) {
		return block('Airborne target immune to Ground');
	}
	if (getEffectiveAbilityTypeImmunity(attacker, defender, move, field).immune) {
		return block(`Ability immunity: ${defender.ability}`);
	}
	if (ability === 'wonderguard' && effectiveness <= 1) return block('Wonder Guard blocks non-super-effective move');
	if (ability === 'terashell' && toID(defender.species) === 'terapagosterastal' &&
		defender.hp >= defender.maxHp && effectiveness >= 1 && move.id !== 'struggle') effectiveness = 0.5;
	return { effectiveness };
}
