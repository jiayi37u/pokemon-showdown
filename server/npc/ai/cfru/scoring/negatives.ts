/**
 * CFRU AI - Negative Scoring Rules
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Negative scoring functions that reduce move viability.
 * Based on CFRU ai_negatives.c
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { ScoringContext, NegativeScoringFunction } from './index';
import { getTypeEffectiveness, getAbilityTypeImmunity, wonderGuardBlocks } from '../util/type-calc';
import { calculateDamage } from '../util/damage-calc';

// =============================================================================
// Type and Ability Immunity Checks
// =============================================================================

/**
 * Check for complete type immunity
 */
export const checkTypeImmunity: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const effectiveness = getTypeEffectiveness(ctx.move.type, ctx.target.types, ctx.cache);

	if (effectiveness === 0) {
		ctx.adjustments.push({
			reason: `Type immunity (${ctx.move.type} vs ${ctx.target.types.join('/')})`,
			amount: -100,
			category: 'negative',
		});
		ctx.flags.isImmune = true;
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	return 0;
};

/**
 * Check for resisted moves (not very effective)
 * Based on CFRU's damage-based approach - resisted moves deal less damage and should be penalized
 *
 * Penalties:
 * - 0.5x (resisted): -2
 * - 0.25x (double resisted): -5
 */
export const checkTypeResistance: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const effectiveness = getTypeEffectiveness(ctx.move.type, ctx.target.types, ctx.cache);

	// Only penalize resisted moves (effectiveness < 1, but not immune)
	if (effectiveness === 0) return 0; // Immunity handled by checkTypeImmunity

	if (effectiveness === 0.25) {
		ctx.adjustments.push({
			reason: `Double resisted (${ctx.move.type} vs ${ctx.target.types.join('/')}) - 0.25x`,
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	if (effectiveness === 0.5) {
		ctx.adjustments.push({
			reason: `Resisted (${ctx.move.type} vs ${ctx.target.types.join('/')}) - 0.5x`,
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	return 0;
};

/**
 * Check for low damage moves
 * Penalize moves that deal very little damage even if not resisted
 * This catches scenarios where a weak move is used against a tanky target
 *
 * Based on CFRU ai_util.c:1021-1027 (doubles damage thresholds):
 * - < 10% maxHP: -20 points (basically no damage)
 * - < 20% maxHP: -8 points (very low damage)
 * - < 33% maxHP: -3 points (insufficient damage)
 */
export const checkLowDamage: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;
	if (!ctx.damageResult) return 0;

	const damagePercent = ctx.damageResult.averagePercent;

	// Only penalize if below the threshold where rewardHighDamage kicks in
	// This avoids double-penalizing already penalized immune/resisted moves
	if (ctx.flags.isImmune || ctx.flags.hasNoEffect) return 0;

	// Exempt priority moves - low damage is acceptable for priority
	if (ctx.move.priority > 0) return 0;

	// CFRU thresholds: < 10% HP = basically no damage, < 20% = very low, < 33% HP = low damage
	if (damagePercent < 10) {
		ctx.adjustments.push({
			reason: `Very low damage (${Math.floor(damagePercent)}% < 10%)`,
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	if (damagePercent < 20) {
		ctx.adjustments.push({
			reason: `Low damage (${Math.floor(damagePercent)}% < 20%)`,
			amount: -8,
			category: 'negative',
		});
		return -8;
	}

	if (damagePercent < 33) {
		ctx.adjustments.push({
			reason: `Low damage (${Math.floor(damagePercent)}% < 33%)`,
			amount: -3,
			category: 'negative',
		});
		return -3;
	}

	return 0;
};

/**
 * Check for ability-based type immunity
 * Covers: Volt Absorb, Water Absorb, Flash Fire, Sap Sipper, etc.
 */
export const checkAbilityTypeImmunity: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const abilityId = toID(ctx.target.ability);
	const moveType = ctx.move.type;

	// Electric immunities
	if (moveType === 'Electric') {
		if (['voltabsorb', 'lightningrod', 'motordrive'].includes(abilityId)) {
			ctx.adjustments.push({
				reason: `Ability immunity: ${ctx.target.ability}`,
				amount: -20,
				category: 'negative',
			});
			ctx.flags.isImmune = true;
			return -20;
		}
	}

	// Water immunities
	if (moveType === 'Water') {
		if (['waterabsorb', 'stormdrain', 'dryskin'].includes(abilityId)) {
			ctx.adjustments.push({
				reason: `Ability immunity: ${ctx.target.ability}`,
				amount: -20,
				category: 'negative',
			});
			ctx.flags.isImmune = true;
			return -20;
		}
	}

	// Fire immunities
	if (moveType === 'Fire') {
		if (['flashfire', 'wellbakedbody'].includes(abilityId)) {
			ctx.adjustments.push({
				reason: `Ability immunity: ${ctx.target.ability}`,
				amount: -20,
				category: 'negative',
			});
			ctx.flags.isImmune = true;
			return -20;
		}
	}

	// Grass immunity
	if (moveType === 'Grass') {
		if (abilityId === 'sapsipper') {
			ctx.adjustments.push({
				reason: `Ability immunity: Sap Sipper`,
				amount: -20,
				category: 'negative',
			});
			ctx.flags.isImmune = true;
			return -20;
		}
	}

	// Ground immunity (Levitate, Earth Eater)
	if (moveType === 'Ground') {
		if (['levitate', 'eartheater'].includes(abilityId)) {
			ctx.adjustments.push({
				reason: `Ability immunity: ${ctx.target.ability}`,
				amount: -20,
				category: 'negative',
			});
			ctx.flags.isImmune = true;
			return -20;
		}
	}

	return 0;
};

/**
 * Check for item-based type immunity
 * Covers: Air Balloon (Ground immunity)
 */
export const checkItemTypeImmunity: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const itemId = toID(ctx.target.item);
	const moveType = ctx.move.type;

	// Air Balloon - Ground immunity
	if (moveType === 'Ground' && itemId === 'airballoon') {
		ctx.adjustments.push({
			reason: 'Item immunity: Air Balloon',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.isImmune = true;
		return -20;
	}

	return 0;
};

/**
 * Check for Covert Cloak blocking secondary effects
 * Covert Cloak prevents additional effects from damaging moves
 */
export const checkCovertCloak: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const itemId = toID(ctx.target.item);
	if (itemId !== 'covertcloak') return 0;

	// Check if move has secondary effect
	if (ctx.move.secondaryChance > 0) {
		ctx.adjustments.push({
			reason: 'Covert Cloak blocks secondary effect',
			amount: -3,
			category: 'negative',
		});
		return -3;
	}

	return 0;
};

/**
 * Check for Wonder Guard blocking non-super-effective moves
 */
export const checkWonderGuard: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	if (toID(ctx.target.ability) !== 'wonderguard') return 0;

	const effectiveness = getTypeEffectiveness(ctx.move.type, ctx.target.types, ctx.cache);

	if (effectiveness <= 1) {
		ctx.adjustments.push({
			reason: 'Wonder Guard blocks non-super-effective move',
			amount: -100,
			category: 'negative',
		});
		ctx.flags.isImmune = true;
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	return 0;
};

/**
 * Check for Soundproof blocking sound moves
 */
export const checkSoundproof: NegativeScoringFunction = (ctx) => {
	if (toID(ctx.target.ability) !== 'soundproof') return 0;

	if (ctx.move.flags['sound']) {
		ctx.adjustments.push({
			reason: 'Soundproof blocks sound move',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Bulletproof blocking ball/bomb moves
 */
export const checkBulletproof: NegativeScoringFunction = (ctx) => {
	if (toID(ctx.target.ability) !== 'bulletproof') return 0;

	if (ctx.move.flags['bullet']) {
		ctx.adjustments.push({
			reason: 'Bulletproof blocks ball/bomb move',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for abilities that boost stats when hit
 */
export const checkStatBoostOnHit: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const abilityId = toID(ctx.target.ability);
	const moveType = ctx.move.type;
	let penalty = 0;

	// Justified: Dark moves boost Attack
	if (abilityId === 'justified' && moveType === 'Dark') {
		if (ctx.target.boosts.atk < 6) {
			penalty = -4;
			ctx.adjustments.push({
				reason: 'Justified will boost Attack',
				amount: penalty,
				category: 'negative',
			});
		}
	}

	// Rattled: Dark/Ghost/Bug moves boost Speed
	if (abilityId === 'rattled') {
		if (['Dark', 'Ghost', 'Bug'].includes(moveType)) {
			if (ctx.target.boosts.spe < 6) {
				// Bigger penalty if target is slower
				penalty = ctx.attacker.baseStats.spe > ctx.target.baseStats.spe ? -1 : -9;
				ctx.adjustments.push({
					reason: 'Rattled will boost Speed',
					amount: penalty,
					category: 'negative',
				});
			}
		}
	}

	// Steam Engine: Fire/Water moves boost Speed
	if (abilityId === 'steamengine') {
		if (['Fire', 'Water'].includes(moveType)) {
			if (ctx.target.boosts.spe < 6) {
				penalty = ctx.attacker.baseStats.spe > ctx.target.baseStats.spe ? -5 : -9;
				ctx.adjustments.push({
					reason: 'Steam Engine will boost Speed',
					amount: penalty,
					category: 'negative',
				});
			}
		}
	}

	// Weak Armor: Physical moves boost Speed, lower Defense
	if (abilityId === 'weakarmor' && ctx.move.category === 'Physical') {
		if (ctx.target.boosts.spe < 6) {
			// Could be beneficial (lowering defense), but speed boost is usually worse
			penalty = -3;
			ctx.adjustments.push({
				reason: 'Weak Armor will boost Speed',
				amount: penalty,
				category: 'negative',
			});
		}
	}

	return penalty;
};

/**
 * Check for Dazzling / Queenly Majesty / Armor Tail blocking priority moves
 * CFRU: ai_negatives.c lines 339-346, 562-569
 */
export const checkPriorityBlock: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	// These abilities block priority moves targeting the user
	if (!['dazzling', 'queenlymajesty', 'armortail'].includes(abilityId)) {
		return 0;
	}

	// Check if move has priority > 0 and targets the opponent
	if (ctx.move.priority > 0 && ctx.move.target !== 'self') {
		ctx.adjustments.push({
			reason: `${ctx.target.ability} blocks priority moves`,
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Mirror Armor reflecting stat drops
 * CFRU: ai_negatives.c lines 394-401
 */
export const checkMirrorArmor: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'mirrorarmor') return 0;

	// Check if move lowers stats
	if (isStatLoweringMove(ctx.move)) {
		ctx.adjustments.push({
			reason: 'Mirror Armor will reflect stat drops',
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	return 0;
};

/**
 * Check for Clear Body / Full Metal Body / White Smoke preventing stat drops
 * CFRU: ai_negatives.c lines 403-415
 */
export const checkClearBody: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (!['clearbody', 'fullmetalbody', 'whitesmoke'].includes(abilityId)) {
		return 0;
	}

	// Check if move lowers stats
	if (isStatLoweringMove(ctx.move)) {
		ctx.adjustments.push({
			reason: `${ctx.target.ability} prevents stat drops`,
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Hyper Cutter preventing Attack drops
 * CFRU: ai_negatives.c lines 418-424
 */
export const checkHyperCutter: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'hypercutter') return 0;

	const moveId = toID(ctx.move.id);
	// Moves that specifically lower Attack
	const attackLoweringMoves = ['growl', 'charm', 'featherdance', 'playnice', 'partingshot',
		'memento', 'tickle', 'noblebleat', 'tearfullook'];

	if (attackLoweringMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Hyper Cutter prevents Attack drops',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Keen Eye preventing Accuracy drops
 * CFRU: ai_negatives.c lines 426-432
 */
export const checkKeenEye: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'keeneye') return 0;

	const moveId = toID(ctx.move.id);
	// Moves that specifically lower Accuracy
	const accuracyLoweringMoves = ['sandattack', 'smokescreen', 'kinesis', 'flash',
		'mudslingershot', 'mirrorshot', 'mudslap', 'octazooka'];

	if (accuracyLoweringMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Keen Eye prevents Accuracy drops',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Big Pecks preventing Defense drops
 * CFRU: ai_negatives.c lines 435-441
 */
export const checkBigPecks: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'bigpecks') return 0;

	const moveId = toID(ctx.move.id);
	// Moves that specifically lower Defense
	const defenseLoweringMoves = ['leer', 'tailwhip', 'screech', 'crunch', 'ironhead',
		'rocksmash', 'crushclaw', 'tickle'];

	if (defenseLoweringMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Big Pecks prevents Defense drops',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Defiant boosting Attack when stats are lowered
 * CFRU: ai_negatives.c lines 444-454
 */
export const checkDefiant: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'defiant') return 0;

	// Only applies to status moves that lower stats
	if (ctx.move.category !== 'Status') return 0;

	if (isStatLoweringMove(ctx.move)) {
		// Check if target can still boost Attack
		if (ctx.target.boosts.atk < 6) {
			ctx.adjustments.push({
				reason: 'Defiant will boost Attack by +2',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

/**
 * Check for Competitive boosting Sp.Atk when stats are lowered
 * CFRU: ai_negatives.c lines 457-467
 */
export const checkCompetitive: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'competitive') return 0;

	// Only applies to status moves that lower stats
	if (ctx.move.category !== 'Status') return 0;

	if (isStatLoweringMove(ctx.move)) {
		// Check if target can still boost Sp.Atk
		if (ctx.target.boosts.spa < 6) {
			ctx.adjustments.push({
				reason: 'Competitive will boost Sp.Atk by +2',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

/**
 * Check for Flower Veil protecting Grass types from status and stat drops
 * CFRU: ai_negatives.c lines 366-372
 */
export const checkFlowerVeil: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'flowerveil') return 0;

	// Only protects Grass-types
	if (!ctx.target.types.includes('Grass')) return 0;

	// Blocks status moves and stat-lowering moves
	if (ctx.move.status || isStatLoweringMove(ctx.move)) {
		ctx.adjustments.push({
			reason: 'Flower Veil protects Grass-types',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Contrary reversing stat changes (stat lowering becomes buffing)
 * CFRU: ai_negatives.c lines 383-391
 */
export const checkContraryStatLower: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'contrary') return 0;

	// Stat lowering moves will boost instead
	if (isStatLoweringMove(ctx.move)) {
		ctx.adjustments.push({
			reason: 'Contrary will reverse stat drops into boosts',
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	return 0;
};

/**
 * Check for Aroma Veil blocking mental moves
 * CFRU: ai_negatives.c lines 350-356
 * Protected moves: Disable, Attract, Encore, Torment, Taunt, Heal Block
 */
export const checkAromaVeil: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'aromaveil') return 0;

	const moveId = toID(ctx.move.id);
	// Moves blocked by Aroma Veil (from gAromaVeilProtectedMoves)
	const aromaVeilBlockedMoves = ['disable', 'attract', 'encore', 'torment', 'taunt', 'healblock'];

	if (aromaVeilBlockedMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Aroma Veil blocks this move',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Shields Down blocking status when HP > 50%
 * CFRU: ai_negatives.c lines 478-485
 */
export const checkShieldsDown: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'shieldsdown') return 0;

	// Shields Down only blocks status when Minior is in shield form (HP > 50%)
	// Check if the target is Minior and has > 50% HP
	const speciesId = toID(ctx.target.species);
	if (!speciesId.startsWith('minior')) return 0;

	if (ctx.target.hpPercent > 50 && ctx.move.status) {
		ctx.adjustments.push({
			reason: 'Shields Down blocks status at >50% HP',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check for Wonder Skin reducing status move accuracy
 * CFRU: ai_negatives.c lines 487-490
 * Note: This doesn't fully block but makes status less reliable
 */
export const checkWonderSkin: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'wonderskin') return 0;

	// Wonder Skin halves accuracy of status moves
	if (ctx.move.category === 'Status' && ctx.move.accuracy !== true) {
		ctx.adjustments.push({
			reason: 'Wonder Skin halves status move accuracy',
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	return 0;
};

/**
 * Check for Leaf Guard blocking status in sun
 * CFRU: ai_negatives.c lines 492-500
 */
export const checkLeafGuard: NegativeScoringFunction = (ctx) => {
	const abilityId = toID(ctx.target.ability);

	if (abilityId !== 'leafguard') return 0;

	// Only works in sun
	if (ctx.state.field.weather !== 'sun' && ctx.state.field.weather !== 'desolateland') {
		return 0;
	}

	// Blocks status moves
	if (ctx.move.status) {
		ctx.adjustments.push({
			reason: 'Leaf Guard blocks status in sun',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Helper function to check if a move lowers opponent stats
 * Based on CFRU's gStatLoweringMoveEffects table
 */
function isStatLoweringMove(move: { id: string; category: string }): boolean {
	const moveId = toID(move.id);

	// Status moves that lower stats
	const statLoweringMoves = [
		// Attack lowering
		'growl', 'charm', 'featherdance', 'playnice', 'partingshot', 'memento',
		'tickle', 'noblebleat', 'tearfullook', 'strengthsap',
		// Defense lowering
		'leer', 'tailwhip', 'screech', 'tickle',
		// Speed lowering
		'stringshot', 'cottonspore', 'scaryface', 'electroweb', 'glaciate',
		'bulldoze', 'rocktomb', 'icywind', 'lowsweep', 'stickyweb',
		// Sp.Atk lowering
		'confide', 'captivate', 'partingshot', 'memento', 'nobleroar',
		// Sp.Def lowering
		'metalsound', 'faketears', 'acidspray', 'acid',
		// Accuracy lowering
		'sandattack', 'smokescreen', 'kinesis', 'flash', 'mudslap',
		'mirrorshot', 'mudshot', 'octazooka', 'leafstorm',
		// Evasion lowering
		'sweetscent', 'defog',
		// Multiple stat lowering
		'vcreate', 'closecombat', 'superpower', 'hammerarm', 'dracometeor',
		'overheat', 'psychoboost', 'fleurcannon', 'hyperspacefury',
	];

	return statLoweringMoves.includes(moveId);
}

// =============================================================================
// Status Move Checks
// =============================================================================

/**
 * Check if sleep move will fail
 * CFRU: battle_util.c lines 2018-2037 (DoesSleepClausePrevent)
 */
export const checkSleepMove: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const sleepMoves = ['spore', 'sleeppowder', 'hypnosis', 'sing', 'grasswhistle',
		'lovelykiss', 'darkvoid', 'yawn', 'relicsong'];

	if (!sleepMoves.includes(moveId)) return 0;

	// Already has status
	if (ctx.target.status) {
		ctx.adjustments.push({
			reason: 'Target already has status condition',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Sleep Clause: Check if opponent already has a sleeping Pokemon
	// Based on CFRU DoesSleepClausePrevent (battle_util.c:2018-2037)
	// In standard PS singles, only one Pokemon per team can be asleep at a time
	const opponentHasSleeping = ctx.state.opponent.team.some(mon =>
		!mon.fainted && mon.status === 'slp'
	);

	if (opponentHasSleeping) {
		ctx.adjustments.push({
			reason: 'Sleep Clause: opponent already has sleeping Pokemon',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Electric Terrain blocks sleep
	if (ctx.state.field.terrain === 'electric') {
		// Check if target is grounded
		const isGrounded = !ctx.target.types.includes('Flying') &&
			toID(ctx.target.ability) !== 'levitate' &&
			!ctx.target.volatiles.has('magnetrise');

		if (isGrounded) {
			ctx.adjustments.push({
				reason: 'Electric Terrain blocks sleep',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Vital Spirit, Insomnia, Sweet Veil block sleep
	const abilityId = toID(ctx.target.ability);
	if (['vitalspirit', 'insomnia', 'sweetveil', 'comatose'].includes(abilityId)) {
		ctx.adjustments.push({
			reason: `${ctx.target.ability} prevents sleep`,
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Grass types immune to powder moves
	if (ctx.move.flags['powder'] && ctx.target.types.includes('Grass')) {
		ctx.adjustments.push({
			reason: 'Grass type immune to powder',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Safety Goggles blocks powder moves
	if (ctx.move.flags['powder'] && toID(ctx.target.item) === 'safetygoggles') {
		ctx.adjustments.push({
			reason: 'Safety Goggles blocks powder',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	return 0;
};

/**
 * Check if paralysis move will fail
 */
export const checkParalysisMove: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const paralysisMoves = ['thunderwave', 'stunspore', 'glare', 'nuzzle', 'zapcannon'];

	if (!paralysisMoves.includes(moveId)) return 0;

	// Already paralyzed
	if (ctx.target.status === 'par') {
		ctx.adjustments.push({
			reason: 'Target already paralyzed',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Has other status
	if (ctx.target.status) {
		ctx.adjustments.push({
			reason: 'Target already has status',
			amount: -15,
			category: 'negative',
		});
		return -15;
	}

	// Electric types immune to Thunder Wave
	if (moveId === 'thunderwave' && ctx.target.types.includes('Electric')) {
		ctx.adjustments.push({
			reason: 'Electric type immune to Thunder Wave',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Ground types immune to Thunder Wave
	if (moveId === 'thunderwave' && ctx.target.types.includes('Ground')) {
		ctx.adjustments.push({
			reason: 'Ground type immune to Thunder Wave',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Limber prevents paralysis
	if (toID(ctx.target.ability) === 'limber') {
		ctx.adjustments.push({
			reason: 'Limber prevents paralysis',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	return 0;
};

/**
 * Check if burn move will fail
 * CFRU: ai_util.c BadIdeaToBurn lines 2951-2971
 */
export const checkBurnMove: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const burnMoves = ['willowisp', 'inferno', 'sacredfire'];

	if (!burnMoves.includes(moveId)) return 0;

	// Already burned
	if (ctx.target.status === 'brn') {
		ctx.adjustments.push({
			reason: 'Target already burned',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Has other status
	if (ctx.target.status) {
		ctx.adjustments.push({
			reason: 'Target already has status',
			amount: -15,
			category: 'negative',
		});
		return -15;
	}

	// Fire types immune to burn
	if (ctx.target.types.includes('Fire')) {
		ctx.adjustments.push({
			reason: 'Fire type immune to burn',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Water Veil, Water Bubble prevent burn
	const abilityId = toID(ctx.target.ability);
	if (['waterveil', 'waterbubble'].includes(abilityId)) {
		ctx.adjustments.push({
			reason: `${ctx.target.ability} prevents burn`,
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Magic Guard: burn deals no damage, so it's less useful
	// CFRU: ai_util.c line 2960
	if (abilityId === 'magicguard') {
		ctx.adjustments.push({
			reason: 'Magic Guard prevents burn damage',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check if poison move will fail
 * CFRU: ai_util.c BadIdeaToPoison lines 2876-2901
 */
export const checkPoisonMove: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const poisonMoves = ['toxic', 'poisonpowder', 'poisongas', 'poisonfang'];

	if (!poisonMoves.includes(moveId)) return 0;

	// Already poisoned
	if (ctx.target.status === 'psn' || ctx.target.status === 'tox') {
		ctx.adjustments.push({
			reason: 'Target already poisoned',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Has other status
	if (ctx.target.status) {
		ctx.adjustments.push({
			reason: 'Target already has status',
			amount: -15,
			category: 'negative',
		});
		return -15;
	}

	// Poison/Steel types immune to poison
	if (ctx.target.types.includes('Poison') || ctx.target.types.includes('Steel')) {
		ctx.adjustments.push({
			reason: 'Type immune to poison',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Immunity prevents poison
	const abilityId = toID(ctx.target.ability);
	if (abilityId === 'immunity') {
		ctx.adjustments.push({
			reason: 'Immunity prevents poison',
			amount: -20,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -20;
	}

	// Magic Guard: poison deals no damage, so it's less useful
	// CFRU: ai_util.c line 2889 - exception for Venoshock
	if (abilityId === 'magicguard') {
		// Check if attacker has Venoshock - poisoning still has value
		const hasVenoshock = ctx.attacker.moves?.some(m => toID(m.id) === 'venoshock');
		if (!hasVenoshock) {
			ctx.adjustments.push({
				reason: 'Magic Guard prevents poison damage',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

/**
 * Check if confusion move will fail
 */
export const checkConfusionMove: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const confusionMoves = ['confuseray', 'supersonic', 'sweetkiss', 'teeterdance', 'flatter', 'swagger'];

	if (!confusionMoves.includes(moveId)) return 0;

	// Already confused
	if (ctx.target.volatiles.has('confusion')) {
		ctx.adjustments.push({
			reason: 'Target already confused',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	// Own Tempo prevents confusion
	if (toID(ctx.target.ability) === 'owntempo') {
		ctx.adjustments.push({
			reason: 'Own Tempo prevents confusion',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	// Misty Terrain blocks confusion
	if (ctx.state.field.terrain === 'misty') {
		const isGrounded = !ctx.target.types.includes('Flying') &&
			toID(ctx.target.ability) !== 'levitate';

		if (isGrounded) {
			ctx.adjustments.push({
				reason: 'Misty Terrain blocks confusion',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

// =============================================================================
// Setup Move Checks
// =============================================================================

/**
 * Check if stat boost move is wasted
 */
export const checkStatBoostWasted: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category !== 'Status') return 0;

	const moveId = toID(ctx.move.id);

	// Map of boost moves to their stats and stages
	const boostMoves: { [key: string]: { stat: keyof typeof ctx.attacker.boosts; stages: number }[] } = {
		'swordsdance': [{ stat: 'atk', stages: 2 }],
		'dragondance': [{ stat: 'atk', stages: 1 }, { stat: 'spe', stages: 1 }],
		'nastyplot': [{ stat: 'spa', stages: 2 }],
		'calmmind': [{ stat: 'spa', stages: 1 }, { stat: 'spd', stages: 1 }],
		'irondefense': [{ stat: 'def', stages: 2 }],
		'amnesia': [{ stat: 'spd', stages: 2 }],
		'agility': [{ stat: 'spe', stages: 2 }],
		'rockpolish': [{ stat: 'spe', stages: 2 }],
		'autotomize': [{ stat: 'spe', stages: 2 }],
		'bulkup': [{ stat: 'atk', stages: 1 }, { stat: 'def', stages: 1 }],
		'workup': [{ stat: 'atk', stages: 1 }, { stat: 'spa', stages: 1 }],
		'growth': [{ stat: 'atk', stages: 1 }, { stat: 'spa', stages: 1 }],
		'howl': [{ stat: 'atk', stages: 1 }],
		'meditate': [{ stat: 'atk', stages: 1 }],
		'sharpen': [{ stat: 'atk', stages: 1 }],
		'harden': [{ stat: 'def', stages: 1 }],
		'withdraw': [{ stat: 'def', stages: 1 }],
		'tailglow': [{ stat: 'spa', stages: 3 }],
		'quiverdance': [{ stat: 'spa', stages: 1 }, { stat: 'spd', stages: 1 }, { stat: 'spe', stages: 1 }],
		'shellsmash': [{ stat: 'atk', stages: 2 }, { stat: 'spa', stages: 2 }, { stat: 'spe', stages: 2 }],
		'coil': [{ stat: 'atk', stages: 1 }, { stat: 'def', stages: 1 }, { stat: 'accuracy', stages: 1 }],
		'honeclaws': [{ stat: 'atk', stages: 1 }, { stat: 'accuracy', stages: 1 }],
	};

	const boostInfo = boostMoves[moveId];
	if (!boostInfo) return 0;

	let totalPenalty = 0;

	for (const boost of boostInfo) {
		const currentBoost = ctx.attacker.boosts[boost.stat] || 0;

		// Already at max
		if (currentBoost >= 6) {
			ctx.adjustments.push({
				reason: `${boost.stat} already at max`,
				amount: -100,
				category: 'negative',
			});
			totalPenalty -= 100;
		}
		// Would waste stages
		else if (currentBoost + boost.stages > 6) {
			const wastedStages = (currentBoost + boost.stages) - 6;
			const penalty = -5 * wastedStages;
			ctx.adjustments.push({
				reason: `Would waste ${wastedStages} stages of ${boost.stat}`,
				amount: penalty,
				category: 'negative',
			});
			totalPenalty += penalty;
		}
		// Already high (4+)
		else if (currentBoost >= 4) {
			ctx.adjustments.push({
				reason: `${boost.stat} already at +${currentBoost}`,
				amount: -5,
				category: 'negative',
			});
			totalPenalty -= 5;
		}
	}

	// Contrary reverses boosts
	if (toID(ctx.attacker.ability) === 'contrary') {
		ctx.adjustments.push({
			reason: 'Contrary will reverse boosts',
			amount: -100,
			category: 'negative',
		});
		return -100;
	}

	// Choice item locks prevent setup
	const itemId = toID(ctx.attacker.item);
	if (['choiceband', 'choicespecs', 'choicescarf'].includes(itemId)) {
		// Only matters if we've already used a move
		// For now, add a small penalty since setup with Choice is risky
		ctx.adjustments.push({
			reason: 'Choice item discourages setup',
			amount: -10,
			category: 'negative',
		});
		totalPenalty -= 10;
	}

	return totalPenalty;
};

// =============================================================================
// Terrain and Weather Checks
// =============================================================================

/**
 * Check if terrain blocks the move
 */
export const checkTerrainBlock: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const terrain = ctx.state.field.terrain;

	// Check if target is grounded
	const isGrounded = !ctx.target.types.includes('Flying') &&
		toID(ctx.target.ability) !== 'levitate' &&
		!ctx.target.volatiles.has('magnetrise') &&
		!ctx.target.volatiles.has('telekinesis');

	if (!isGrounded) return 0;

	// Electric Terrain blocks sleep
	if (terrain === 'electric') {
		const sleepMoves = ['spore', 'sleeppowder', 'hypnosis', 'sing', 'yawn', 'darkvoid', 'grasswhistle'];
		if (sleepMoves.includes(moveId)) {
			ctx.adjustments.push({
				reason: 'Electric Terrain blocks sleep on grounded Pokemon',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Misty Terrain blocks status
	if (terrain === 'misty') {
		const statusMoves = ['thunderwave', 'toxic', 'willowisp', 'spore', 'sleeppowder',
			'confuseray', 'swagger', 'flatter'];
		if (statusMoves.includes(moveId)) {
			ctx.adjustments.push({
				reason: 'Misty Terrain blocks status on grounded Pokemon',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Psychic Terrain blocks priority on grounded Pokemon
	if (terrain === 'psychic') {
		if (ctx.move.priority > 0 && ctx.move.target !== 'self') {
			ctx.adjustments.push({
				reason: 'Psychic Terrain blocks priority moves',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

/**
 * Check if weather move is redundant
 */
export const checkWeatherRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const weather = ctx.state.field.weather;

	const weatherMoves: { [key: string]: string } = {
		'sunnyday': 'sun',
		'raindance': 'rain',
		'sandstorm': 'sand',
		'hail': 'hail',
		'snowscape': 'snow',
	};

	const moveWeather = weatherMoves[moveId];
	if (!moveWeather) return 0;

	if (weather === moveWeather) {
		ctx.adjustments.push({
			reason: `${moveWeather} weather already active`,
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check if terrain move is redundant
 */
export const checkTerrainRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const terrain = ctx.state.field.terrain;

	const terrainMoves: { [key: string]: string } = {
		'electricterrain': 'electric',
		'grassyterrain': 'grassy',
		'mistyterrain': 'misty',
		'psychicterrain': 'psychic',
	};

	const moveTerrain = terrainMoves[moveId];
	if (!moveTerrain) return 0;

	if (terrain === moveTerrain) {
		ctx.adjustments.push({
			reason: `${moveTerrain} terrain already active`,
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

// =============================================================================
// Magic Bounce / Magic Coat Check
// =============================================================================

/**
 * Check if move will be bounced by Magic Bounce
 * Magic Bounce reflects moves with the 'reflectable' flag (same as Magic Coat)
 * This matches CFRU's FLAG_MAGIC_COAT_AFFECTED check
 */
export const checkMagicBounce: NegativeScoringFunction = (ctx) => {
	const targetAbility = toID(ctx.target.ability);

	// Only check if opponent's ability is revealed as Magic Bounce
	if (targetAbility !== 'magicbounce') {
		return 0;
	}

	// Use the 'reflectable' flag - same approach as CFRU's FLAG_MAGIC_COAT_AFFECTED
	// This automatically covers all moves that can be bounced by Magic Coat/Magic Bounce
	if (ctx.move.flags['reflectable']) {
		ctx.adjustments.push({
			reason: 'Magic Bounce will reflect this move',
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	return 0;
};

// =============================================================================
// Entry Hazard Checks
// =============================================================================

/**
 * Check if entry hazards are already set
 */
export const checkHazardsRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const opponentConditions = ctx.state.opponent.conditions;

	// Stealth Rock
	if (moveId === 'stealthrock') {
		if (opponentConditions.stealthrock) {
			ctx.adjustments.push({
				reason: 'Stealth Rock already set',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Spikes (max 3 layers)
	if (moveId === 'spikes') {
		if (opponentConditions.spikes >= 3) {
			ctx.adjustments.push({
				reason: 'Spikes at max layers',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Toxic Spikes (max 2 layers)
	if (moveId === 'toxicspikes') {
		if (opponentConditions.toxicspikes >= 2) {
			ctx.adjustments.push({
				reason: 'Toxic Spikes at max layers',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	// Sticky Web
	if (moveId === 'stickyweb') {
		if (opponentConditions.stickyweb) {
			ctx.adjustments.push({
				reason: 'Sticky Web already set',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

// =============================================================================
// Screens Redundancy Checks
// CFRU: ai_negatives.c lines 1528-1631
// =============================================================================

/**
 * Check if Light Screen is already active
 * CFRU: ai_negatives.c lines 1528-1534
 */
export const checkLightScreenRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'lightscreen') return 0;

	// Check our side conditions
	if (ctx.state.self.conditions.lightscreen > 0) {
		ctx.adjustments.push({
			reason: 'Light Screen already active',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Reflect is already active
 * CFRU: ai_negatives.c lines 1616-1631
 */
export const checkReflectRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'reflect') return 0;

	// Check our side conditions
	if (ctx.state.self.conditions.reflect > 0) {
		ctx.adjustments.push({
			reason: 'Reflect already active',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Aurora Veil is already active or conditions not met
 * CFRU: ai_negatives.c lines 1619-1625
 */
export const checkAuroraVeilRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'auroraveil') return 0;

	// Aurora Veil already active
	if (ctx.state.self.conditions.auroraveil > 0) {
		ctx.adjustments.push({
			reason: 'Aurora Veil already active',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Aurora Veil only works in Hail/Snow
	const weather = ctx.state.field.weather;
	if (weather !== 'hail' && weather !== 'snow') {
		ctx.adjustments.push({
			reason: 'Aurora Veil requires Hail/Snow',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

// =============================================================================
// Special Move Checks
// =============================================================================

/**
 * Check if Dream Eater will fail (target not asleep)
 * CFRU: ai_negatives.c lines 838-843
 */
export const checkDreamEater: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'dreameater') return 0;

	// Dream Eater only works on sleeping targets (or Comatose)
	const targetAbility = toID(ctx.target.ability);
	if (ctx.target.status !== 'slp' && targetAbility !== 'comatose') {
		ctx.adjustments.push({
			reason: 'Dream Eater fails on non-sleeping target',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if absorb/drain moves will hurt due to Liquid Ooze
 * CFRU: ai_negatives.c lines 784-785
 */
export const checkLiquidOoze: NegativeScoringFunction = (ctx) => {
	const targetAbility = toID(ctx.target.ability);

	if (targetAbility !== 'liquidooze') return 0;

	// Absorb moves will hurt the user instead
	const drainMoves = ['absorb', 'megadrain', 'gigadrain', 'drainingkiss',
		'drainpunch', 'leechlife', 'hornleech', 'paraboliccharge',
		'oblivionwing', 'strengthsap'];
	const moveId = toID(ctx.move.id);

	if (drainMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Liquid Ooze will damage user instead of healing',
			amount: -6,
			category: 'negative',
		});
		return -6;
	}

	return 0;
};

/**
 * Check if Roar/Whirlwind will fail (Suction Cups, Ingrain, no switch targets)
 * CFRU: ai_negatives.c lines 1371-1399
 */
export const checkRoar: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const phazingMoves = ['roar', 'whirlwind', 'dragontail', 'circlethrow'];
	if (!phazingMoves.includes(moveId)) return 0;

	const targetAbility = toID(ctx.target.ability);

	// Suction Cups prevents phazing
	if (targetAbility === 'suctioncups') {
		ctx.adjustments.push({
			reason: 'Suction Cups prevents phazing',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Ingrain (rooted) prevents phazing
	if (ctx.target.volatiles.has('ingrain')) {
		ctx.adjustments.push({
			reason: 'Ingrain prevents phazing',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Substitute will fail (already has sub, not enough HP)
 * CFRU: ai_negatives.c lines 1654-1658
 */
export const checkSubstitute: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'substitute') return 0;

	// Already has substitute
	if (ctx.attacker.volatiles.has('substitute')) {
		ctx.adjustments.push({
			reason: 'Already has Substitute',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Not enough HP (need >25%)
	if (ctx.attacker.hpPercent <= 25) {
		ctx.adjustments.push({
			reason: 'Not enough HP for Substitute',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Leech Seed will fail
 * CFRU: ai_negatives.c lines 1703-1711
 */
export const checkLeechSeed: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'leechseed') return 0;

	// Grass types are immune
	if (ctx.target.types.includes('Grass')) {
		ctx.adjustments.push({
			reason: 'Grass type immune to Leech Seed',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Already seeded
	if (ctx.target.volatiles.has('leechseed')) {
		ctx.adjustments.push({
			reason: 'Target already seeded',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Liquid Ooze makes Leech Seed hurt the user
	const targetAbility = toID(ctx.target.ability);
	if (targetAbility === 'liquidooze') {
		ctx.adjustments.push({
			reason: 'Liquid Ooze will damage user from Leech Seed',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check if Salt Cure will fail or have reduced value
 * Salt Cure is a Gen 9 move with secondary effect: applies 'saltcure' volatile
 * The volatile deals 1/8 maxHP per turn (1/4 for Water/Steel types)
 *
 * Blocked by:
 * - Substitute (blocks secondary effect)
 * - Magic Guard (prevents residual damage)
 * - Already salt cured
 * - Covert Cloak (blocks secondary effect) - handled separately by checkCovertCloak
 *
 * Note: CFRU does not have Salt Cure (Gen 9), so this follows Leech Seed pattern
 */
export const checkSaltCure: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'saltcure') return 0;

	// Already salt cured - secondary effect will fail
	if (ctx.target.volatiles.has('saltcure')) {
		ctx.adjustments.push({
			reason: 'Target already has Salt Cure',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Magic Guard prevents all residual damage
	const targetAbility = toID(ctx.target.ability);
	if (targetAbility === 'magicguard') {
		ctx.adjustments.push({
			reason: 'Magic Guard blocks Salt Cure damage',
			amount: -8,
			category: 'negative',
		});
		return -8;
	}

	// Substitute blocks the secondary effect (Salt Cure won't apply)
	// Note: The 40 base power damage still goes through, but the valuable part is the residual damage
	if (ctx.target.volatiles.has('substitute')) {
		ctx.adjustments.push({
			reason: 'Substitute blocks Salt Cure effect',
			amount: -8,
			category: 'negative',
		});
		return -8;
	}

	return 0;
};

/**
 * Check if Disable/Encore/Taunt/Torment will fail
 * CFRU: ai_negatives.c effect checks
 */
export const checkMentalMoveRedundant: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	// Disable - check if target already disabled
	if (moveId === 'disable') {
		if (ctx.target.volatiles.has('disable')) {
			ctx.adjustments.push({
				reason: 'Target already disabled',
				amount: -10,
				category: 'negative',
			});
			ctx.flags.hasNoEffect = true;
			return -10;
		}
	}

	// Encore - check if target already encored
	if (moveId === 'encore') {
		if (ctx.target.volatiles.has('encore')) {
			ctx.adjustments.push({
				reason: 'Target already encored',
				amount: -10,
				category: 'negative',
			});
			ctx.flags.hasNoEffect = true;
			return -10;
		}
	}

	// Taunt - check if target already taunted
	if (moveId === 'taunt') {
		if (ctx.target.volatiles.has('taunt')) {
			ctx.adjustments.push({
				reason: 'Target already taunted',
				amount: -10,
				category: 'negative',
			});
			ctx.flags.hasNoEffect = true;
			return -10;
		}
	}

	// Torment - check if target already tormented
	if (moveId === 'torment') {
		if (ctx.target.volatiles.has('torment')) {
			ctx.adjustments.push({
				reason: 'Target already tormented',
				amount: -10,
				category: 'negative',
			});
			ctx.flags.hasNoEffect = true;
			return -10;
		}
	}

	return 0;
};

/**
 * Check if Explosion/Self-Destruct is a bad idea
 */
export const checkExplosion: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (!['explosion', 'selfdestruct', 'mindblown', 'mistyexplosion'].includes(moveId)) {
		return 0;
	}

	// Damp prevents explosion
	// Would need to check all Pokemon on field for Damp
	const defAbility = toID(ctx.target.ability);
	if (defAbility === 'damp') {
		ctx.adjustments.push({
			reason: 'Damp prevents Explosion',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	// Don't explode if we have healthy Pokemon and won't KO
	if (!ctx.flags.canKO) {
		// Check if attacker has high HP
		if (ctx.attacker.hpPercent > 50) {
			ctx.adjustments.push({
				reason: 'Explosion without KO is wasteful',
				amount: -4,
				category: 'negative',
			});
			return -4;
		}
	}

	return 0;
};

/**
 * Check if Counter/Mirror Coat will fail or is risky
 * CFRU: ai_negatives.c lines 1731-1751
 *
 * Counter: Only works if hit by Physical move
 * Mirror Coat: Only works if hit by Special move
 * Metal Burst: Works against either but goes by Speed, not negative priority
 */
export const checkCounterMirrorCoat: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	// Counter - only works against physical moves
	if (moveId === 'counter') {
		// If target has no physical moves, Counter is likely useless
		const targetHasPhysical = ctx.target.moves?.some(m => {
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		}) ?? true; // Default to assuming they have physical if unknown

		if (!targetHasPhysical) {
			ctx.adjustments.push({
				reason: 'Counter fails - target has no physical moves',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}

		// Counter has -5 priority, so it always goes last
		// If target uses a status move this turn, Counter fails
		// (can't predict for certain, but bulky/support mons are more likely)
		const targetIsBulky = ctx.target.baseStats.hp >= 90 ||
			ctx.target.baseStats.def >= 100 || ctx.target.baseStats.spd >= 100;

		if (targetIsBulky) {
			ctx.adjustments.push({
				reason: 'Counter risky - bulky target may use status',
				amount: -3,
				category: 'negative',
			});
			return -3;
		}
	}

	// Mirror Coat - only works against special moves
	if (moveId === 'mirrorcoat') {
		const targetHasSpecial = ctx.target.moves?.some(m => {
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		}) ?? true;

		if (!targetHasSpecial) {
			ctx.adjustments.push({
				reason: 'Mirror Coat fails - target has no special moves',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}

		const targetIsBulky = ctx.target.baseStats.hp >= 90 ||
			ctx.target.baseStats.def >= 100 || ctx.target.baseStats.spd >= 100;

		if (targetIsBulky) {
			ctx.adjustments.push({
				reason: 'Mirror Coat risky - bulky target may use status',
				amount: -3,
				category: 'negative',
			});
			return -3;
		}
	}

	// Metal Burst - works against either, but uses Speed not priority
	if (moveId === 'metalburst') {
		// Metal Burst fails if user is faster (moves first)
		if (ctx.flags.goesFirst) {
			ctx.adjustments.push({
				reason: 'Metal Burst fails when faster - moves before being hit',
				amount: -10,
				category: 'negative',
			});
			return -10;
		}
	}

	return 0;
};

/**
 * Check if Belly Drum will fail or is a bad idea
 * CFRU: ai_negatives.c lines 2225-2230
 *
 * Belly Drum fails if HP <= 50%, and is risky if HP is not high enough
 * Also fails with Contrary ability (would lower Attack instead)
 */
export const checkBellyDrum: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'bellydrum') return 0;

	// Contrary makes Belly Drum lower Attack instead of raising
	if (toID(ctx.attacker.ability) === 'contrary') {
		ctx.adjustments.push({
			reason: 'Contrary will lower Attack instead of raising',
			amount: -100,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	// Belly Drum costs 50% HP to use
	if (ctx.attacker.hpPercent <= 50) {
		ctx.adjustments.push({
			reason: 'Belly Drum fails with HP <= 50%',
			amount: -100,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	// Even if it works, using it at low-ish HP is risky
	// You'll end up at very low HP after use
	if (ctx.attacker.hpPercent <= 70) {
		ctx.adjustments.push({
			reason: 'Belly Drum risky at low HP (will be <20% after)',
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	return 0;
};

/**
 * Check if Protect is overused (consecutive usage penalty)
 *
 * Simplified logic: If last move was a Protect-type move, penalize -20.
 *
 * Note: Quick Guard, Wide Guard, Crafty Shield have infinite usage (not penalized)
 */
export const checkProtectOveruse: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	// Protect-type moves that have limited consecutive usage
	const protectMoves = ['protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker',
		'obstruct', 'silktrap', 'burningbulwark', 'endure'];

	// Quick Guard, Wide Guard, Crafty Shield have infinite usage
	if (!protectMoves.includes(moveId)) return 0;

	// Check if last move was a Protect-type move
	const lastMoveId = ctx.attacker.lastMove;
	const lastMoveWasProtect = protectMoves.includes(lastMoveId);

	if (!lastMoveWasProtect) return 0;

	// Consecutive Protect usage - penalize heavily
	ctx.adjustments.push({
		reason: 'Consecutive Protect usage (likely to fail)',
		amount: -20,
		category: 'negative',
	});
	return -20;
};

/**
 * Check if healing is unnecessary
 */
export const checkHealingUnnecessary: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const healingMoves = ['recover', 'softboiled', 'milkdrink', 'slackoff', 'roost',
		'synthesis', 'moonlight', 'morningsun', 'shoreup', 'rest'];

	if (!healingMoves.includes(moveId)) return 0;

	// Don't heal at high HP
	if (ctx.attacker.hpPercent > 80) {
		ctx.adjustments.push({
			reason: 'Healing unnecessary at high HP',
			amount: -20,
			category: 'negative',
		});
		return -20;
	}

	if (ctx.attacker.hpPercent > 70) {
		ctx.adjustments.push({
			reason: 'Healing less effective at moderate HP',
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	if (ctx.attacker.hpPercent > 60) {
		ctx.adjustments.push({
			reason: 'Healing less effective at moderate HP',
			amount: -2,
			category: 'negative',
		});
		return -2;
	}

	// Rest when already asleep
	if (moveId === 'rest' && ctx.attacker.status === 'slp') {
		ctx.adjustments.push({
			reason: 'Already asleep, Rest fails',
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check if Sleep Talk or Snore will fail (not asleep or last turn of sleep)
 * CFRU: ai_negatives.c lines 1783-1795
 *
 * Sleep Talk and Snore only work while asleep. Additionally, if attacker
 * is on the last turn of sleep (sleepTurns === 1), they will wake up before
 * using the move, so it will fail.
 *
 * Comatose is a special case - always considered asleep.
 */
export const checkSleepTalkSnore: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'sleeptalk' && moveId !== 'snore') return 0;

	const attackerAbility = toID(ctx.attacker.ability);

	// Comatose always counts as asleep - move will work
	if (attackerAbility === 'comatose') return 0;

	// Not asleep - move will fail
	if (ctx.attacker.status !== 'slp') {
		ctx.adjustments.push({
			reason: `${ctx.move.name} fails when not asleep`,
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Last turn of sleep (sleepTurns === 1) - will wake up before move executes
	// Note: In PS, sleepTurns counts down, so 1 means this is the last turn
	if (ctx.attacker.sleepTurns === 1) {
		ctx.adjustments.push({
			reason: `${ctx.move.name} fails on last turn of sleep (will wake first)`,
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

// =============================================================================
// Doubles Partner Checks
// CFRU: ai_negatives.c lines 173, 220, 234, etc. (TARGETING_PARTNER checks)
// =============================================================================

/**
 * Check if attacking partner is generally a bad idea
 * In CFRU, attacking partner is usually penalized unless there's a good reason
 * (like triggering ability immunities)
 */
export const checkTargetingPartnerDamage: NegativeScoringFunction = (ctx) => {
	// Only applies in doubles when targeting partner
	if (!ctx.isTargetingPartner) return 0;

	// Status moves targeting partner might be good (handled elsewhere)
	if (ctx.move.category === 'Status') return 0;

	const targetAbility = toID(ctx.target.ability);
	const moveType = ctx.move.type;

	// Check if partner has an absorbing ability that benefits from this move type
	// In these cases, attacking partner is GOOD (handled in positives.ts)

	// Electric absorption abilities
	if (moveType === 'Electric' &&
		['voltabsorb', 'lightningrod', 'motordrive'].includes(targetAbility)) {
		return 0; // Don't penalize - this is handled in partner AI
	}

	// Water absorption abilities
	if (moveType === 'Water' &&
		['waterabsorb', 'dryskin', 'stormdrain'].includes(targetAbility)) {
		return 0; // Don't penalize - heal partner
	}

	// Fire absorption
	if (moveType === 'Fire' && targetAbility === 'flashfire') {
		return 0; // Don't penalize - power up partner's Fire moves
	}

	// Grass absorption
	if (moveType === 'Grass' && targetAbility === 'sapsipper') {
		return 0; // Don't penalize - boost partner's Attack
	}

	// Justified (Dark type boosts Attack)
	if (moveType === 'Dark' && targetAbility === 'justified') {
		// Only good if partner has physical moves and can use the boost
		if (ctx.target.boosts.atk < 6) {
			return 0; // Don't penalize - might be intentional
		}
	}

	// Default: penalize attacking partner with damaging moves
	// This is generally a bad idea unless there's a specific reason
	ctx.adjustments.push({
		reason: 'Attacking partner with damaging move',
		amount: -15,
		category: 'negative',
	});
	return -15;
};

/**
 * Check if status move targeting partner is a bad idea
 * Most status moves are bad on partner (paralyze, burn, etc.)
 */
export const checkTargetingPartnerStatus: NegativeScoringFunction = (ctx) => {
	// Only applies in doubles when targeting partner
	if (!ctx.isTargetingPartner) return 0;
	if (ctx.move.category !== 'Status') return 0;

	const moveId = toID(ctx.move.id);

	// Moves that are GOOD to use on partner
	const goodPartnerMoves = [
		'healbell', 'aromatherapy', // Heal status
		'helpinghand', // Boost partner
		'afteryou', // Speed manipulation
		'allyswitch', // Position swap
		'lifedew', // Healing
		'pollenpuff', // Heals partner
		'coaching', // Boost partner stats
		'decorate', // Boost partner stats
	];

	if (goodPartnerMoves.includes(moveId)) {
		return 0; // Don't penalize
	}

	// Healing moves on partner
	const healingMoves = ['recover', 'softboiled', 'milkdrink', 'slackoff', 'roost',
		'moonlight', 'morningsun', 'synthesis', 'shoreup'];
	if (healingMoves.includes(moveId)) {
		return 0; // Healing partner is fine (even if move targets self)
	}

	// Status moves that hurt partner - big penalty
	const badPartnerMoves = [
		'thunderwave', 'stunspore', 'glare', 'nuzzle', // Paralysis
		'willowisp', // Burn
		'toxic', 'poisonpowder', 'poisongas', // Poison
		'spore', 'sleeppowder', 'hypnosis', 'sing', 'yawn', // Sleep
		'confuseray', 'swagger', 'flatter', // Confusion
	];

	if (badPartnerMoves.includes(moveId)) {
		ctx.adjustments.push({
			reason: 'Using harmful status move on partner',
			amount: -100,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	// Stat lowering moves on partner
	if (ctx.move.boosts) {
		let anyLower = false;
		for (const stat of Object.keys(ctx.move.boosts) as (keyof typeof ctx.move.boosts)[]) {
			if (ctx.move.boosts[stat]! < 0) {
				anyLower = true;
				break;
			}
		}
		if (anyLower) {
			ctx.adjustments.push({
				reason: 'Lowering partner stats',
				amount: -100,
				category: 'negative',
			});
			ctx.flags.hasNoEffect = true;
			return -100;
		}
	}

	// Default small penalty for status moves on partner
	ctx.adjustments.push({
		reason: 'Status move on partner (no clear benefit)',
		amount: -5,
		category: 'negative',
	});
	return -5;
};

/**
 * Check if move will hit partner as spread damage
 * Spread moves (Earthquake, Surf, etc.) with target 'allAdjacent' hit partner
 *
 * Penalty scales with actual damage to partner (v1.1.20):
 * - Can KO partner: -25
 * - > 50% HP damage: -15
 * - > 25% HP damage: -10
 * - Low damage: -5
 *
 * Partner is immune or benefits (absorb abilities): 0 or positive (handled in positives.ts)
 */
export const checkSpreadMoveHitsPartner: NegativeScoringFunction = (ctx) => {
	// Only applies in doubles
	if (!ctx.state.isDoubles) return 0;

	// Check if move targets all adjacent (including partner)
	const moveTarget = ctx.move.target;
	if (moveTarget !== 'allAdjacent') return 0;

	// Check if we have a partner
	if (!ctx.partner || ctx.partner.fainted) return 0;

	const partnerAbility = toID(ctx.partner.ability);
	const moveType = ctx.move.type;

	// Check if partner is immune by type
	const typeEffect = getTypeEffectiveness(moveType, ctx.partner.types, ctx.cache);
	if (typeEffect === 0) return 0; // Partner immune by type

	// Check if partner has absorbing/beneficial ability
	// Electric absorption abilities
	if (moveType === 'Electric' &&
		['voltabsorb', 'lightningrod', 'motordrive'].includes(partnerAbility)) {
		return 0; // Don't penalize - positive handled elsewhere
	}
	// Water absorption abilities
	if (moveType === 'Water' &&
		['waterabsorb', 'dryskin', 'stormdrain'].includes(partnerAbility)) {
		return 0; // Don't penalize - heal/boost partner
	}
	// Fire absorption
	if (moveType === 'Fire' && partnerAbility === 'flashfire') {
		return 0; // Don't penalize - power up partner
	}
	// Grass absorption
	if (moveType === 'Grass' && partnerAbility === 'sapsipper') {
		return 0; // Don't penalize - boost partner
	}
	// Ground immunity
	if (moveType === 'Ground' && ['levitate', 'eartheater'].includes(partnerAbility)) {
		return 0; // Partner immune
	}

	// Calculate actual damage to partner
	// Use try-catch in case partner data is incomplete (e.g., in tests)
	let partnerDamage;
	try {
		// Calculate spread move damage reduction info
		// For allAdjacent: count all except attacker (opponents + partner)
		const numAliveOpponents = ctx.state.opponent.active.filter(p => !p.fainted).length;
		const numAlivePartners = ctx.state.self.active.filter(p => p !== ctx.attacker && !p.fainted).length;
		const spreadInfo = { isDoubles: true, numAliveTargets: numAliveOpponents + numAlivePartners };

		partnerDamage = calculateDamage(
			ctx.attacker,
			ctx.partner,
			ctx.move,
			ctx.state.field,
			ctx.cache,
			spreadInfo
		);
	} catch (e) {
		// If damage calculation fails (incomplete data), use a default penalty
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) will hit partner`,
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	// If damage result is invalid or zero damage, still apply small penalty
	if (!partnerDamage || partnerDamage.averagePercent === undefined) {
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) will hit partner`,
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	const damagePercent = partnerDamage.averagePercent;
	let penalty = 0;

	// Scale penalty based on damage to partner
	if (partnerDamage.canKO) {
		// Would KO partner - very bad!
		penalty = -25;
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) would KO partner!`,
			amount: penalty,
			category: 'negative',
		});
	} else if (damagePercent > 50) {
		// Heavy damage to partner
		penalty = -15;
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) deals ${Math.floor(damagePercent)}% to partner`,
			amount: penalty,
			category: 'negative',
		});
	} else if (damagePercent > 25) {
		// Moderate damage to partner
		penalty = -10;
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) deals ${Math.floor(damagePercent)}% to partner`,
			amount: penalty,
			category: 'negative',
		});
	} else if (damagePercent > 0) {
		// Low damage to partner
		penalty = -5;
		ctx.adjustments.push({
			reason: `Spread move (${ctx.move.id}) will hit partner`,
			amount: penalty,
			category: 'negative',
		});
	}

	return penalty;
};

// =============================================================================
// Contact Move Risk Checks
// CFRU: ai_util.c lines 3011-3067 (BadIdeaToMakeContactWith)
// =============================================================================

/**
 * Check if making contact with target is risky
 * Based on CFRU BadIdeaToMakeContactWith function
 *
 * Covers abilities: Effect Spore, Poison Point, Static, Flame Body, Cute Charm,
 * Aftermath, Gooey, Tangling Hair, Iron Barbs, Rough Skin, Mummy, Wandering Spirit,
 * Cotton Down, Perish Body, Pickpocket
 *
 * Also checks Rocky Helmet item
 */
export const checkContactRisk: NegativeScoringFunction = (ctx) => {
	// Only applies to contact moves
	if (!ctx.move.flags['contact']) return 0;

	// Status moves typically don't make contact, but double check
	if (ctx.move.category === 'Status') return 0;

	const attackerAbility = toID(ctx.attacker.ability);
	const targetAbility = toID(ctx.target.ability);
	const targetItem = toID(ctx.target.item);

	// Magic Guard user doesn't care about recoil damage
	const hasMagicGuard = attackerAbility === 'magicguard';

	let penalty = 0;

	// Effect Spore - 30% chance of Sleep/Paralysis/Poison
	if (targetAbility === 'effectspore') {
		// Only risky if not immune to status
		if (!ctx.attacker.status && !['overcoat'].includes(attackerAbility) &&
			toID(ctx.attacker.item) !== 'safetygoggles') {
			penalty -= 3;
			ctx.adjustments.push({
				reason: 'Effect Spore may inflict status on contact',
				amount: -3,
				category: 'negative',
			});
		}
	}

	// Poison Point - 30% chance of poison
	if (targetAbility === 'poisonpoint') {
		if (!ctx.attacker.status && !ctx.attacker.types.includes('Poison') &&
			!ctx.attacker.types.includes('Steel') && attackerAbility !== 'immunity') {
			penalty -= 2;
			ctx.adjustments.push({
				reason: 'Poison Point may poison on contact',
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Static - 30% chance of paralysis
	if (targetAbility === 'static') {
		if (!ctx.attacker.status && !ctx.attacker.types.includes('Electric') &&
			attackerAbility !== 'limber') {
			penalty -= 2;
			ctx.adjustments.push({
				reason: 'Static may paralyze on contact',
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Flame Body - 30% chance of burn
	if (targetAbility === 'flamebody') {
		if (!ctx.attacker.status && !ctx.attacker.types.includes('Fire') &&
			!['waterveil', 'waterbubble'].includes(attackerAbility)) {
			penalty -= 2;
			ctx.adjustments.push({
				reason: 'Flame Body may burn on contact',
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Cute Charm - 30% chance of infatuation
	if (targetAbility === 'cutecharm') {
		if (attackerAbility !== 'oblivious') {
			penalty -= 1;
			ctx.adjustments.push({
				reason: 'Cute Charm may infatuate on contact',
				amount: -1,
				category: 'negative',
			});
		}
	}

	// Gooey / Tangling Hair - Speed drop on contact
	if (['gooey', 'tanglinghair'].includes(targetAbility)) {
		if (ctx.attacker.boosts.spe > -6 && attackerAbility !== 'mirrorarmor' &&
			!['clearbody', 'fullmetalbody', 'whitesmoke'].includes(attackerAbility)) {
			penalty -= 2;
			ctx.adjustments.push({
				reason: `${ctx.target.ability} will lower Speed on contact`,
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Cotton Down - Speed drop on contact (all Pokemon on field)
	if (targetAbility === 'cottondown') {
		if (ctx.attacker.boosts.spe > -6) {
			penalty -= 2;
			ctx.adjustments.push({
				reason: 'Cotton Down will lower Speed on contact',
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Iron Barbs / Rough Skin - 1/8 HP damage
	if (['ironbarbs', 'roughskin'].includes(targetAbility)) {
		if (!hasMagicGuard) {
			// Bigger penalty if attacker is low HP
			const damagePenalty = ctx.attacker.hpPercent <= 20 ? -5 : -2;
			penalty += damagePenalty;
			ctx.adjustments.push({
				reason: `${ctx.target.ability} will deal damage on contact`,
				amount: damagePenalty,
				category: 'negative',
			});
		}
	}

	// Aftermath - 1/4 HP damage if contact KOs the target
	if (targetAbility === 'aftermath') {
		if (!hasMagicGuard && ctx.flags.canKO) {
			penalty -= 4;
			ctx.adjustments.push({
				reason: 'Aftermath will deal damage if target is KOd',
				amount: -4,
				category: 'negative',
			});
		}
	}

	// Mummy - Changes attacker's ability to Mummy
	if (targetAbility === 'mummy') {
		// Bad if attacker has a useful ability
		const usefulAbilities = ['hugepower', 'purepower', 'speedboost', 'technician',
			'toughclaws', 'sheerforce', 'adaptability', 'protean', 'libero'];
		if (usefulAbilities.includes(attackerAbility)) {
			penalty -= 5;
			ctx.adjustments.push({
				reason: 'Mummy will replace useful ability',
				amount: -5,
				category: 'negative',
			});
		} else {
			penalty -= 1;
			ctx.adjustments.push({
				reason: 'Mummy will change ability on contact',
				amount: -1,
				category: 'negative',
			});
		}
	}

	// Wandering Spirit - Swaps abilities
	if (targetAbility === 'wanderingspirit') {
		const usefulAbilities = ['hugepower', 'purepower', 'speedboost', 'technician',
			'toughclaws', 'sheerforce', 'adaptability', 'protean', 'libero'];
		if (usefulAbilities.includes(attackerAbility)) {
			penalty -= 5;
			ctx.adjustments.push({
				reason: 'Wandering Spirit will swap away useful ability',
				amount: -5,
				category: 'negative',
			});
		}
	}

	// Perish Body - Both get Perish Song effect
	if (targetAbility === 'perishbody') {
		penalty -= 5;
		ctx.adjustments.push({
			reason: 'Perish Body will inflict Perish Song on contact',
			amount: -5,
			category: 'negative',
		});
	}

	// Pickpocket - Steals item on contact
	if (targetAbility === 'pickpocket') {
		if (ctx.attacker.item && attackerAbility !== 'stickyhold') {
			penalty -= 2;
			ctx.adjustments.push({
				reason: 'Pickpocket may steal item on contact',
				amount: -2,
				category: 'negative',
			});
		}
	}

	// Rocky Helmet - 1/6 HP damage
	if (targetItem === 'rockyhelmet') {
		if (!hasMagicGuard) {
			const damagePenalty = ctx.attacker.hpPercent <= 20 ? -5 : -2;
			penalty += damagePenalty;
			ctx.adjustments.push({
				reason: 'Rocky Helmet will deal damage on contact',
				amount: damagePenalty,
				category: 'negative',
			});
		}
	}

	// Protective Pads negates all contact-triggered effects
	if (toID(ctx.attacker.item) === 'protectivepads') {
		// If we were going to be penalized, the Protective Pads negates it
		if (penalty < 0) {
			ctx.adjustments.push({
				reason: 'Protective Pads negates contact effects',
				amount: -penalty,
				category: 'positive',
			});
			return 0;
		}
	}

	return penalty;
};

// =============================================================================
// Pain Split / Destiny Bond / Future Sight / Trick / Recycle / Fling Checks
// CFRU: ai_negatives.c lines 1778-1782, 1829-1834, 2239-2244, 2452-2470, 2529-2540, 2916-2942
// =============================================================================

/**
 * Check if Pain Split is a bad idea
 * CFRU: ai_negatives.c lines 1778-1782
 *
 * Pain Split averages both Pokemon's HP.
 * Bad idea if attacker HP > average (will lose HP)
 */
export const checkPainSplit: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'painsplit') return 0;

	// Calculate what the HP would be after Pain Split
	// We use percentages since we don't have exact HP values
	const attackerHp = ctx.attacker.hpPercent;
	const targetHp = ctx.target.hpPercent;
	const averageHp = (attackerHp + targetHp) / 2;

	// If attacker has more HP than average, Pain Split hurts us
	if (attackerHp > averageHp) {
		ctx.adjustments.push({
			reason: `Pain Split bad - attacker HP (${Math.floor(attackerHp)}%) > average (${Math.floor(averageHp)}%)`,
			amount: -10,
			category: 'negative',
		});
		return -10;
	}

	return 0;
};

/**
 * Check if Destiny Bond is a bad idea
 * CFRU: ai_negatives.c lines 1829-1834
 *
 * Destiny Bond should not be used if:
 * 1. Already active (STATUS2_DESTINY_BOND)
 * 2. Counter hasn't expired (DestinyBondCounters[bankAtk] != 0)
 */
export const checkDestinyBond: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'destinybond') return 0;

	// Check if Destiny Bond is already active
	if (ctx.attacker.volatiles.has('destinybond')) {
		ctx.adjustments.push({
			reason: 'Destiny Bond already active',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Future Sight / Doom Desire will fail
 * CFRU: ai_negatives.c lines 2239-2244
 *
 * Future Sight fails if there's already a Future Sight pending on the target
 */
export const checkFutureSight: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'futuresight' && moveId !== 'doomdesire') return 0;

	// Check if target already has Future Sight pending
	if (ctx.target.volatiles.has('futuremove')) {
		ctx.adjustments.push({
			reason: 'Future Sight already pending on target',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Trick / Switcheroo will fail or is a bad idea
 * CFRU: ai_negatives.c lines 2452-2470
 *
 * Trick fails if:
 * 1. CanSwapItems returns false
 * 2. Both Pokemon have the same item
 * 3. Target has Sticky Hold
 */
export const checkTrick: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'trick' && moveId !== 'switcheroo') return 0;

	const attackerItem = toID(ctx.attacker.item);
	const targetItem = toID(ctx.target.item);
	const targetAbility = toID(ctx.target.ability);

	// Sticky Hold prevents item swap
	if (targetAbility === 'stickyhold') {
		ctx.adjustments.push({
			reason: 'Sticky Hold prevents item swap',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Same item (or both no item)
	if (attackerItem === targetItem) {
		ctx.adjustments.push({
			reason: 'Both have same item (or no item)',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Can't swap certain items (Mega Stones, Z-Crystals, Plates on Arceus, etc.)
	// These are handled by game mechanics, simplified check here
	const unswitchableItems = [
		'griseousorb', // Giratina
		'rustedsword', 'rustedshield', // Zacian/Zamazenta
	];

	// Check if attacker has unswitchable item
	if (unswitchableItems.some(item => attackerItem.includes(item))) {
		ctx.adjustments.push({
			reason: 'Cannot switch this item',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	return 0;
};

/**
 * Check if Recycle will fail
 * CFRU: ai_negatives.c lines 2529-2540
 *
 * Recycle fails if:
 * 1. No consumed item to recycle (SavedConsumedItems[bankAtk] == ITEM_NONE)
 * 2. Already holding an item (data->atkItem != ITEM_NONE)
 */
export const checkRecycle: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'recycle') return 0;

	// Check if already holding an item
	if (ctx.attacker.item) {
		ctx.adjustments.push({
			reason: 'Already holding an item',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Check if there's a consumed item to recycle
	// Note: We can't track consumed items in our system yet, so we assume there might be one
	// This check would need BattleTracker to track consumed items

	return 0;
};

/**
 * Check if Fling will fail
 * CFRU: ai_negatives.c lines 2916-2942
 *
 * Fling fails if:
 * 1. No item to fling
 * 2. Item cannot be flung (CanFling returns false)
 *
 * Also checks fling effects (burn, paralysis, poison, freeze) against target immunities
 */
export const checkFling: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'fling') return 0;

	const attackerItem = toID(ctx.attacker.item);
	const targetAbility = toID(ctx.target.ability);

	// No item to fling
	if (!attackerItem) {
		ctx.adjustments.push({
			reason: 'No item to fling',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Items that can't be flung (simplified list)
	const unflingableItems = [
		'assaultvest', // can't use status moves
		'choiceband', 'choicespecs', 'choicescarf', // when locked into other move
	];

	// Certain item types can't be flung
	if (attackerItem.endsWith('iumz') || // Z-Crystals
		attackerItem.endsWith('ite') || // Mega Stones
		attackerItem === 'redorb' || attackerItem === 'blueorb') { // Primal items
		ctx.adjustments.push({
			reason: 'Cannot fling this item',
			amount: -10,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -10;
	}

	// Check fling effects vs target immunities
	// Flame Orb - burns target
	if (attackerItem === 'flameorb') {
		if (ctx.target.types.includes('Fire') ||
			['waterveil', 'waterbubble'].includes(targetAbility)) {
			ctx.adjustments.push({
				reason: 'Target immune to burn from Flame Orb',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	// Toxic Orb - badly poisons target
	if (attackerItem === 'toxicorb') {
		if (ctx.target.types.includes('Poison') || ctx.target.types.includes('Steel') ||
			targetAbility === 'immunity') {
			ctx.adjustments.push({
				reason: 'Target immune to poison from Toxic Orb',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	// Light Ball - paralyzes target
	if (attackerItem === 'lightball') {
		if (ctx.target.types.includes('Electric') || ctx.target.types.includes('Ground') ||
			targetAbility === 'limber') {
			ctx.adjustments.push({
				reason: 'Target immune to paralysis from Light Ball',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	return 0;
};

/**
 * Check if semi-invulnerable moves (Fly, Dig, Dive, etc.) are a good idea
 * CFRU: ai_negatives.c lines 2246-2300
 *
 * These moves charge on turn 1 and hit on turn 2.
 * Bad if:
 * 1. Opponent has Protect and is faster
 * 2. Opponent has a move that hits during invulnerable state
 * 3. No Power Herb to skip charge turn
 *
 * Good if:
 * 1. Have Power Herb (instant attack)
 * 2. Would dodge a predicted attack
 */
export const checkSemiInvulnerable: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	const semiInvulnerableMoves = [
		'fly', 'bounce', 'skydrop', // In air
		'dig', // Underground
		'dive', // Underwater
		'phantomforce', 'shadowforce', // Vanished
		'solarbeam', 'solarblade', // Charging (not invulnerable but similar)
	];

	if (!semiInvulnerableMoves.includes(moveId)) return 0;

	const attackerItem = toID(ctx.attacker.item);

	// Power Herb skips charge turn - no penalty
	if (attackerItem === 'powerherb') {
		return 0;
	}

	// Solar Beam/Blade work instantly in sun
	if ((moveId === 'solarbeam' || moveId === 'solarblade') &&
		(ctx.state.field.weather === 'sun' || ctx.state.field.weather === 'desolateland')) {
		return 0;
	}

	// Check if opponent has protection moves and is faster
	const targetHasProtect = ctx.target.moves?.some(m => {
		const protectMoves = ['protect', 'detect', 'kingsshield', 'spikyshield',
			'banefulbunker', 'obstruct', 'silktrap'];
		return protectMoves.includes(toID(m));
	}) ?? false;

	if (targetHasProtect && !ctx.flags.goesFirst) {
		ctx.adjustments.push({
			reason: 'Opponent can Protect during charge turn',
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	// Check for moves that hit during semi-invulnerable state
	// Fly/Bounce: Thunder, Hurricane, Smack Down, Sky Uppercut, Twister
	// Dig: Earthquake, Magnitude, Fissure
	// Dive: Surf, Whirlpool

	if (moveId === 'fly' || moveId === 'bounce' || moveId === 'skydrop') {
		const airHittingMoves = ['thunder', 'hurricane', 'smackdown', 'skyuppercut', 'twister'];
		const targetHasAirHit = ctx.target.moves?.some(m => airHittingMoves.includes(toID(m))) ?? false;

		if (targetHasAirHit) {
			ctx.adjustments.push({
				reason: 'Opponent has move that hits airborne Pokemon',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	if (moveId === 'dig') {
		const groundHittingMoves = ['earthquake', 'magnitude', 'fissure'];
		const targetHasGroundHit = ctx.target.moves?.some(m => groundHittingMoves.includes(toID(m))) ?? false;

		if (targetHasGroundHit) {
			ctx.adjustments.push({
				reason: 'Opponent has Earthquake/Magnitude (hits Dig)',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	if (moveId === 'dive') {
		const waterHittingMoves = ['surf', 'whirlpool'];
		const targetHasWaterHit = ctx.target.moves?.some(m => waterHittingMoves.includes(toID(m))) ?? false;

		if (targetHasWaterHit) {
			ctx.adjustments.push({
				reason: 'Opponent has Surf/Whirlpool (hits Dive)',
				amount: -5,
				category: 'negative',
			});
			return -5;
		}
	}

	// General penalty for 2-turn moves (gives opponent free turn)
	ctx.adjustments.push({
		reason: 'Two-turn move gives opponent free action',
		amount: -3,
		category: 'negative',
	});
	return -3;
};

// =============================================================================
// Knock Off Check
// =============================================================================

/**
 * Check if Knock Off is less useful because target already lost item
 * - Target item is confirmed lost (saw -enditem message): -5
 *
 * Note: We use itemLost flag to distinguish:
 * - itemLost = false, item = '': Item unknown, assume has item (no penalty)
 * - itemLost = true, item = '': Item confirmed lost (penalty)
 * - itemLost = false, item = 'X': Item known to exist (no penalty)
 */
export const checkKnockOff: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'knockoff') return 0;

	// Only penalize if we've confirmed the item was lost
	if (ctx.target.itemLost) {
		ctx.adjustments.push({
			reason: 'Target already lost item (Knock Off less useful)',
			amount: -5,
			category: 'negative',
		});
		return -5;
	}

	return 0;
};

// =============================================================================
// Export all negative scorers
// =============================================================================

export const allNegativeScorers: NegativeScoringFunction[] = [
	// Doubles partner checks (run first as they're high priority)
	checkTargetingPartnerDamage,
	checkTargetingPartnerStatus,
	checkSpreadMoveHitsPartner,

	// Type and ability immunity
	checkTypeImmunity,
	checkTypeResistance,  // NEW: Penalize resisted moves
	checkAbilityTypeImmunity,
	checkItemTypeImmunity,
	checkCovertCloak,
	checkWonderGuard,
	checkSoundproof,
	checkBulletproof,
	checkStatBoostOnHit,

	// Low damage penalty (should run early so other bonuses can override)
	checkLowDamage,  // NEW: Penalize very low damage moves

	// Priority blocking abilities (CFRU: ai_negatives.c 339-346)
	checkPriorityBlock,

	// Stat drop related abilities (CFRU: ai_negatives.c 383-467)
	checkMirrorArmor,
	checkClearBody,
	checkHyperCutter,
	checkKeenEye,
	checkBigPecks,
	checkDefiant,
	checkCompetitive,
	checkFlowerVeil,
	checkContraryStatLower,

	// Mental move blocking (CFRU: ai_negatives.c 350-356)
	checkAromaVeil,

	// Status immunity abilities (CFRU: ai_negatives.c 478-500)
	checkShieldsDown,
	checkWonderSkin,
	checkLeafGuard,

	// Status moves
	checkSleepMove,
	checkParalysisMove,
	checkBurnMove,
	checkPoisonMove,
	checkConfusionMove,

	// Setup moves
	checkStatBoostWasted,

	// Terrain and weather
	checkTerrainBlock,
	checkWeatherRedundant,
	checkTerrainRedundant,

	// Magic Bounce
	checkMagicBounce,

	// Entry hazards
	checkHazardsRedundant,

	// Screens redundancy (CFRU: ai_negatives.c 1528-1631)
	checkLightScreenRedundant,
	checkReflectRedundant,
	checkAuroraVeilRedundant,

	// Special move effects (CFRU: ai_negatives.c 784-843, 1371-1711)
	checkDreamEater,
	checkLiquidOoze,
	checkRoar,
	checkSubstitute,
	checkLeechSeed,
	checkSaltCure,
	checkMentalMoveRedundant,
	checkCounterMirrorCoat,
	checkBellyDrum,

	// Special moves
	checkExplosion,
	checkProtectOveruse,
	checkHealingUnnecessary,
	checkSleepTalkSnore,  // CFRU: ai_negatives.c 1783-1795

	// Contact move risks (CFRU: ai_util.c 3011-3067)
	checkContactRisk,

	// New M2 checks (CFRU: ai_negatives.c various lines)
	checkPainSplit,
	checkDestinyBond,
	checkFutureSight,
	checkTrick,
	checkRecycle,
	checkFling,
	checkSemiInvulnerable,

	// Item removal
	checkKnockOff,
];
