/**
 * CFRU AI - Positive Scoring Rules
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Positive scoring functions that increase move viability.
 * Based on CFRU ai_positives.c
 *
 * @license MIT
 */

import { effectiveAbility, effectiveItem, effectivePriority, defensiveAbility } from '../util/mechanics';
import { BASE_SCORE, DISCOURAGED_SCORE } from '../types';
import { buildAIMove } from '../state-builder';

import { itemRemovalFailure } from '../util/items';
import { toID } from '../../../../../sim/dex';
import type { ScoringContext, PositiveScoringFunction } from './index';
import { calculateDamage, canKnockOut, can2HKO, findStrongestMove } from '../util/damage-calc';
import { actsBeforeTarget, attacksFirst, compareSpeedOrder } from '../util/speed';
import {
	recoveryRecipients, recoveryCuresStatus, secondaryEffectFailure, statusFailure, canRestoreUserHp, recoveryKind,
} from '../util/move-effects';
import { getTypeEffectiveness, resolveMove } from '../util/type-calc';
import { canHaveOpponentMoves, getOpponentMoveKnowledge } from '../util/opponent-presets';
import { getHazeBenefit, painSplitValue } from './negatives';

/** Ordinary speed order, independent of either move's priority bracket. */
function speedOrder(ctx: ScoringContext): number {
	return compareSpeedOrder(ctx.attacker, ctx.target, ctx.state.field, ctx.state.self.conditions,
		(ctx.isTargetingPartner ? ctx.state.self : ctx.state.opponent).conditions);
}

/** Interpolate the existing 0/+2/+4 reward anchors; lowered stats retain the first-boost reward. */
function setupReward(stage: number, first = 10, second = 5, third = 2): number {
	if (stage <= 0) return first;
	if (stage >= 6) return 0;
	const anchors = [first, second, third, 0];
	const index = Math.floor(stage / 2);
	return Math.ceil((anchors[index] + (stage % 2 ? anchors[index + 1] : anchors[index])) / 2);
}

/** Unknown slots are not evidence that a target lacks recovery. */
function targetLacksRecovery(ctx: ScoringContext): boolean {
	const knowledge = ctx.target.moveKnowledge ||
		getOpponentMoveKnowledge(ctx.target.species, ctx.target.moves, ctx.config.formatId);
	const moves = [...ctx.target.moves, ...knowledge.revealedMoves,
		...knowledge.presetCandidates.filter(id => canHaveOpponentMoves(knowledge, [id]))];
	if (moves.some(id => canRestoreUserHp({ id }, ctx.state.field))) return false;
	const slots = knowledge.revealedMoves.length + knowledge.remainingSlots;
	return knowledge.remainingSlots === 0 || (knowledge.slots?.length || 0) >= slots ||
		!!knowledge.movePools?.length && knowledge.movePools.every(pool => pool.length >= slots);
}

// =============================================================================
// Damage Move Rewards
// =============================================================================

/**
 * Reward moves that can knock out the target
 */
export const rewardKnockout: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	let bonus = 0;

	if (ctx.flags.canKO) {
		// Base KO bonus
		bonus += 20;
		ctx.adjustments.push({
			reason: 'Can knock out target',
			amount: 20,
			category: 'positive',
		});

		// Extra bonus for going first (guaranteed KO)
		if (ctx.flags.goesFirst && (speedOrder(ctx) > 0 ||
			ctx.damageResult && ctx.damageResult.average >= ctx.target.hp)) {
			bonus += 5;
			ctx.adjustments.push({
				reason: 'Outspeeds (safe KO)',
				amount: 5,
				category: 'positive',
			});
		}

		// Extra bonus for high accuracy
		if (ctx.move.accuracy === true || ctx.move.accuracy >= 100) {
			bonus += 3;
			ctx.adjustments.push({
				reason: 'Reliable accuracy for KO',
				amount: 3,
				category: 'positive',
			});
		}

		return bonus;
	}

	// Bonus for 2HKO
	if (ctx.flags.can2HKO) {
		bonus += 8;
		ctx.adjustments.push({
			reason: 'Can 2HKO target',
			amount: 8,
			category: 'positive',
		});

		// Extra bonus if we outspeed
		if (ctx.flags.goesFirst && speedOrder(ctx) > 0) {
			bonus += 2;
			ctx.adjustments.push({
				reason: 'Outspeeds (favorable 2HKO)',
				amount: 2,
				category: 'positive',
			});
		}
	}

	return bonus;
};

/**
 * Reward high damage moves
 */
export const rewardHighDamage: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;
	if (!ctx.damageResult) return 0;

	const damagePercent = ctx.damageResult.averagePercent;
	let bonus = 0;

	// Scale bonus based on damage percentage
	if (damagePercent >= 75) {
		bonus = 10;
		ctx.adjustments.push({
			reason: `High damage (${Math.floor(damagePercent)}%)`,
			amount: bonus,
			category: 'positive',
		});
	} else if (damagePercent >= 50) {
		bonus = Math.floor(damagePercent / 10);
		ctx.adjustments.push({
			reason: `Moderate damage (${Math.floor(damagePercent)}%)`,
			amount: bonus,
			category: 'positive',
		});
	} else if (damagePercent >= 30) {
		bonus = 2;
		ctx.adjustments.push({
			reason: `Decent damage (${Math.floor(damagePercent)}%)`,
			amount: bonus,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward STAB moves
 */
export const rewardSTAB: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;
	const data = ctx.dex.moves.get(ctx.move.id);
	if (data.damage || data.damageCallback) return 0;

	if (ctx.attacker.types.includes(ctx.move.type) ||
		(ctx.attacker.terastallized && ctx.attacker.originalTypes?.includes(ctx.move.type))) {
		ctx.adjustments.push({
			reason: 'STAB bonus',
			amount: 3,
			category: 'positive',
		});
		return 3;
	}

	return 0;
};

/**
 * Reward super effective moves
 */
export const rewardSuperEffective: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	if (!ctx.flags.isSuperEffective) return 0;

	const effectiveness = ctx.damageResult?.effectiveness ?? 1;
	const bonus = effectiveness >= 4 ? 15 : 5;

	ctx.adjustments.push({
		reason: `Super effective (${effectiveness}x)`,
		amount: bonus,
		category: 'positive',
	});

	return bonus;
};

/**
 * Reward priority moves that can KO
 */
export const rewardPriorityKO: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;
	if (effectivePriority(ctx.attacker, ctx.move, ctx.state.field) <= 0) return 0;
	if (!ctx.flags.goesFirst || speedOrder(ctx) >= 0) return 0;

	// Priority move that can KO is very valuable
	if (ctx.damageResult && ctx.damageResult.average >= ctx.target.hp) {
		ctx.adjustments.push({
			reason: 'Priority KO',
			amount: 10,
			category: 'positive',
		});
		return 10;
	}

	// Priority move when we'd otherwise be KO'd
	// This would require more context about opponent's moves

	return 0;
};

// =============================================================================
// Status Move Rewards
// =============================================================================

/**
 * Reward sleep moves
 * Do not reward if move has no effect (e.g., Sleep Clause violation)
 */
export const rewardSleepMove: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const sleepMoves = ['spore', 'sleeppowder', 'hypnosis', 'sing', 'grasswhistle',
		'lovelykiss', 'darkvoid', 'yawn'];

	if (!sleepMoves.includes(moveId)) return 0;

	// Don't reward if move has no effect (Sleep Clause, immunity, etc.)
	if (ctx.flags.hasNoEffect || ctx.flags.isImmune ||
		statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;

	let bonus = 0;

	// Base bonus for sleep (very disruptive)
	bonus += 12;

	// Higher bonus for more accurate sleep moves
	if (ctx.move.accuracy === true || ctx.move.accuracy >= 90) {
		bonus += 4;
	} else if (ctx.move.accuracy >= 75) {
		bonus += 2;
	}

	// Bonus if target is a setup threat
	const targetHasSetup = ctx.target.moves.some(m => {
		const dexMove = ctx.dex.moves.get(m);
		return dexMove.boosts || ['swordsdance', 'dragondance', 'nastyplot', 'calmmind',
			'quiverdance', 'shellsmash', 'bulkup'].includes(toID(m));
	});

	if (targetHasSetup) {
		bonus += 4;
	}

	ctx.adjustments.push({
		reason: 'Sleep is disruptive',
		amount: bonus,
		category: 'positive',
	});

	return bonus;
};

/**
 * Reward paralysis moves
 */
export const rewardParalysisMove: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const paralysisMoves = ['thunderwave', 'stunspore', 'glare', 'nuzzle'];

	if (!paralysisMoves.includes(moveId)) return 0;
	if (ctx.flags.hasNoEffect || ctx.flags.isImmune ||
		statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;

	let bonus = 0;

	// Bonus if target is faster
	if (speedOrder(ctx) < 0 && !ctx.state.field.trickroom) {
		bonus += 8;
		ctx.adjustments.push({
			reason: 'Paralysis on faster target',
			amount: 8,
			category: 'positive',
		});
	} else {
		// Still useful for potential full paralysis
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Paralysis for potential full paralysis',
			amount: 4,
			category: 'positive',
		});
	}

	// Extra bonus for high accuracy
	if (ctx.move.accuracy === true || ctx.move.accuracy >= 90) {
		bonus += 2;
		ctx.adjustments.push({ reason: 'Reliable accuracy for paralysis', amount: 2, category: 'positive' });
	}

	return bonus;
};

/**
 * Reward burn moves against physical attackers
 */
export const rewardBurnMove: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const burnMoves = ['willowisp', 'inferno'];

	if (!burnMoves.includes(moveId)) return 0;
	if (ctx.flags.hasNoEffect || ctx.flags.isImmune ||
		statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;

	let bonus = 0;

	// Big bonus against physical attackers
	if (ctx.target.baseStats.atk > ctx.target.baseStats.spa) {
		bonus += 10;
		ctx.adjustments.push({
			reason: 'Burn on physical attacker',
			amount: 10,
			category: 'positive',
		});
	} else {
		// Still useful for residual damage
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Burn for residual damage',
			amount: 4,
			category: 'positive',
		});
	}

	// Extra if they don't have Guts
	if (effectiveAbility(ctx.target, ctx.state.field) === 'guts') {
		bonus -= 8;
		ctx.adjustments.push({
			reason: 'Target has Guts',
			amount: -8,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward toxic on walls/stall targets
 */
export const rewardToxic: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'toxic') return 0;
	if (ctx.flags.hasNoEffect || ctx.flags.isImmune ||
		statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;

	let bonus = 0;

	// Bonus against bulky Pokemon
	const isBulky = ctx.target.baseStats.hp >= 90 ||
		ctx.target.baseStats.def >= 90 ||
		ctx.target.baseStats.spd >= 90;

	if (isBulky) {
		bonus += 8;
		ctx.adjustments.push({
			reason: 'Toxic against bulky target',
			amount: 8,
			category: 'positive',
		});
	} else {
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Toxic for residual damage',
			amount: 4,
			category: 'positive',
		});
	}

	if (targetLacksRecovery(ctx)) {
		bonus += 3;
		ctx.adjustments.push({
			reason: 'No recovery in revealed moves or compatible presets',
			amount: 3,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward Sleep Talk and Snore when asleep
 * CFRU: ai_positives.c lines 982-986
 *
 * These moves only work while asleep, so give a significant bonus when
 * the attacker is sleeping and has more than 1 turn of sleep remaining.
 *
 * ATTACKER_ASLEEP in CFRU is defined as:
 *   (data->atkStatus1 & STATUS1_SLEEP && data->atkStatus1 > 1)
 * which means: asleep AND more than 1 turn remaining
 */
export const rewardSleepTalkSnore: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'sleeptalk' && moveId !== 'snore') return 0;

	const attackerAbility = effectiveAbility(ctx.attacker, ctx.state.field);

	// Comatose always counts as asleep - always reward
	if (attackerAbility === 'comatose') {
		ctx.adjustments.push({
			reason: `${ctx.move.name} works with Comatose`,
			amount: 10,
			category: 'positive',
		});
		return 10;
	}

	// Must be asleep
	if (ctx.attacker.status !== 'slp') return 0;

	// Must have more than 1 turn of sleep remaining
	// (if sleepTurns is 1, we'll wake up before using the move - handled in negatives)
	// (if sleepTurns is 0 or unknown, be conservative and still reward)
	if (ctx.attacker.sleepTurns === 1) return 0;

	// Asleep with turns remaining - this is the ideal time to use Sleep Talk/Snore
	const bonus = (ctx.attacker.sleepTurns || 0) > 1 ? 30 : 10;
	ctx.adjustments.push({
		reason: `${ctx.move.name} while asleep`,
		amount: bonus,
		category: 'positive',
	});
	return bonus;
};

// =============================================================================
// Setup Move Rewards
// =============================================================================

/**
 * Reward setup moves when appropriate
 * Based on CFRU ai_positives.c EFFECT_ATTACK_UP_2 and ai_advanced.c ShouldTryToSetUpStat
 *
 * Rewards diminish with existing boosts and missing HP. Low-HP setup is discouraged
 * by checkStatusOpportunity; this rule does not predict survival against incoming damage.
 */
export const rewardSetupMove: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category !== 'Status') return 0;

	const moveId = toID(ctx.move.id);

	const attacks = ctx.attacker.moves.map(id => buildAIMove({ id }, 1, ctx.state.field.formatId))
		.filter(move => move.category !== 'Status');
	if (attacks.length && attacks.every(move =>
		defensiveAbility(ctx.attacker, ctx.target, move, ctx.state.field) === 'unaware')) {
		const boosts = ctx.dex.moves.get(moveId).boosts;
		const usefulSpeed = boosts?.spe && speedOrder(ctx) <= 0 && !ctx.state.field.trickroom;
		const indirect = ctx.attacker.moves.some(id => ['storedpower', 'powertrip', 'batonpass'].includes(toID(id)));
		if (!indirect) {
			const amount = usefulSpeed ? 4 : 0;
			if (amount) ctx.adjustments.push({ reason: 'Setup retains utility beyond ignored offensive boosts',
				amount, category: 'positive' });
			return amount;
		}
	}

	// Attack boosting moves
	const atkBoostMoves = ['swordsdance', 'dragondance', 'bellydrum', 'howl'];
	// Special Attack boosting moves
	const spaBoostMoves = ['nastyplot', 'calmmind', 'quiverdance', 'tailglow'];
	// Speed boosting moves
	const speBoostMoves = ['agility', 'rockpolish', 'autotomize', 'shiftgear'];
	// Mixed/utility
	const mixedBoostMoves = ['bulkup', 'workup', 'growth', 'coil', 'shellsmash'];

	let bonus = 0;

	// ==========================================================================
	// HP-based opportunity check
	// ==========================================================================
	const hpPercent = ctx.attacker.hpPercent;

	if (hpPercent <= 40) {
		return 0;
	}

	// Moderate HP - slight penalty
	if (hpPercent <= 60) {
		bonus -= 6;
	}

	// ==========================================================================
	// Stat boost value calculation
	// +2 = 2x damage, +4 = 3x damage, +6 = 4x damage
	// So the first +2 is the most impactful (2x), subsequent boosts have diminishing returns
	// ==========================================================================

	const slower = speedOrder(ctx) <= 0 && !ctx.state.field.trickroom;
	const targetDefBoost = ctx.target.boosts.def || 0;
	const targetSpdBoost = ctx.target.boosts.spd || 0;

	// Attack boost moves
	if (atkBoostMoves.includes(moveId)) {
		// Check if we have physical moves (CFRU: RealPhysicalMoveInMoveset)
		const hasPhysicalMove = ctx.attacker.moves.some(m => {
			const dexMove = resolveMove(ctx.attacker, buildAIMove({ id: m }, 1, ctx.state.field.formatId),
				ctx.state.field, ctx.target);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		});

		if (!hasPhysicalMove) return Math.max(0, bonus); // No physical moves = no point boosting atk

		const currentAtk = ctx.attacker.boosts.atk || 0;

		// Can't boost further
		if (currentAtk >= 6) return Math.max(0, bonus);

		bonus += setupReward(currentAtk);

		// Belly Drum special case - max attack in one turn
		if (moveId === 'bellydrum' && hpPercent > 55 && currentAtk < 6) {
			bonus += 10;
		}

		// Target's defense boost makes our attack boost more valuable
		// If target used Iron Defense (+2 def), our Swords Dance is more necessary
		if (targetDefBoost > 0 && currentAtk < 4) {
			bonus += Math.min(targetDefBoost, 4); // Up to +4 bonus
		}

		if (bonus > 0) {
			ctx.adjustments.push({
				reason: `Attack boost (atk: +${currentAtk}, def: +${targetDefBoost}, HP: ${Math.floor(hpPercent)}%)`,
				amount: bonus,
				category: 'positive',
			});
		}
	}

	// Special Attack boost moves
	if (spaBoostMoves.includes(moveId)) {
		const hasSpecialMove = ctx.attacker.moves.some(m => {
			const dexMove = resolveMove(ctx.attacker, buildAIMove({ id: m }, 1, ctx.state.field.formatId),
				ctx.state.field, ctx.target);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		});

		if (!hasSpecialMove) return Math.max(0, bonus);

		const currentSpa = ctx.attacker.boosts.spa || 0;

		if (currentSpa >= 6) return Math.max(0, bonus);

		bonus += setupReward(currentSpa);

		// Target's special defense boost makes our special attack boost more valuable
		if (targetSpdBoost > 0 && currentSpa < 4) {
			bonus += Math.min(targetSpdBoost, 4);
		}

		if (bonus > 0) {
			ctx.adjustments.push({
				reason: `Sp.Atk boost (spa: +${currentSpa}, spd: +${targetSpdBoost}, HP: ${Math.floor(hpPercent)}%)`,
				amount: bonus,
				category: 'positive',
			});
		}
	}

	// Speed boost moves - valuable when slower
	if (speBoostMoves.includes(moveId)) {
		const currentSpe = ctx.attacker.boosts.spe || 0;

		if (currentSpe >= 6) return Math.max(0, bonus);

		// Speed boost is most valuable when we're currently slower
		if (slower) {
			bonus += setupReward(currentSpe);
		} else {
			// Already faster - less valuable, but Dragon Dance still has attack component
			if (currentSpe < 4) {
				bonus += 2;
			}
		}
		if (bonus > 0) {
			ctx.adjustments.push({
				reason: slower ? `Speed boost to outspeed (spe: +${currentSpe}, HP: ${Math.floor(hpPercent)}%)` :
				'Speed boost for potential future matchups', amount: bonus, category: 'positive',
			});
		}
	}

	// Mixed boost moves
	if (mixedBoostMoves.includes(moveId)) {
		const currentAtk = ctx.attacker.boosts.atk || 0;
		const currentSpa = ctx.attacker.boosts.spa || 0;

		// Can still benefit from either stat boost
		if (currentAtk < 6 || currentSpa < 6) {
			if (moveId === 'shellsmash') {
				// Shell Smash is powerful but risky - need HP
				if (hpPercent > 60) {
					bonus += 12;
				} else if (hpPercent > 40) {
					bonus += 6;
				}
			} else {
				// Other mixed boosters
				if (currentAtk < 4 || currentSpa < 4) {
					bonus += 6;
				} else {
					bonus += 3;
				}
			}

			// Target's defenses matter
			if ((targetDefBoost > 0 || targetSpdBoost > 0) && (currentAtk < 4 || currentSpa < 4)) {
				bonus += Math.min(targetDefBoost + targetSpdBoost, 4);
			}

			if (bonus > 0) {
				ctx.adjustments.push({
					reason: `Mixed boost (atk: +${currentAtk}, spa: +${currentSpa}, HP: ${Math.floor(hpPercent)}%)`,
					amount: bonus,
					category: 'positive',
				});
			}
		}
	}

	return Math.max(0, bonus);
};

/**
 * Reward defensive setup moves (Iron Defense, Amnesia, Cotton Guard, etc.)
 * Based on CFRU GoodIdeaToRaiseDefenseAgainst and GoodIdeaToRaiseSpDefenseAgainst
 *
 * Key considerations:
 * 1. Check if opponent likely uses physical/special moves
 * 2. Body Press users benefit more from defense boosts
 * 3. Don't boost if opponent has Unaware (boosts ignored)
 * 4. Don't boost if opponent has phazing moves (Roar/Whirlwind)
 */
export const rewardDefensiveSetup: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category !== 'Status') return 0;

	const moveId = toID(ctx.move.id);

	// Defense boosting moves
	const defBoostMoves = ['irondefense', 'cottonguard', 'harden', 'withdraw', 'acidarmor', 'barrier', 'shelter'];
	// Special Defense boosting moves
	const spdBoostMoves = ['amnesia'];
	// Mixed defense boosting moves
	const mixedDefBoostMoves = ['cosmicpower', 'defendorder', 'stockpile'];

	let bonus = 0;

	// ==========================================================================
	// HP-based safety check
	// ==========================================================================
	const hpPercent = ctx.attacker.hpPercent;

	// checkStatusOpportunity also suppresses unrelated rewards in this situation.
	if (hpPercent <= 40) {
		return 0;
	}

	// ==========================================================================
	// Check bad idea conditions (CFRU: BadIdeaToRaiseStatAgainst)
	// ==========================================================================
	const targetAbility = effectiveAbility(ctx.target, ctx.state.field);

	// Unaware ignores stat boosts - don't setup against it
	if (targetAbility === 'unaware') {
		return 0;
	}

	// Opponent with phazing moves will just force us out
	const phazingMoves = ['roar', 'whirlwind', 'dragontail', 'circlethrow'];
	const hasPhazingMove = ctx.target.moves?.some(m => phazingMoves.includes(toID(m)));
	if (hasPhazingMove) {
		return 0;
	}

	// Check if opponent used moves that lower the stat we're boosting
	// (simplified - CFRU has more sophisticated move tracking)

	// ==========================================================================
	// Defense boost moves
	// ==========================================================================
	if (defBoostMoves.includes(moveId)) {
		const currentDef = ctx.attacker.boosts.def || 0;

		// Can't boost further
		if (currentDef >= 6) return bonus;

		// Check if opponent likely uses physical moves
		const targetHasPhysical = ctx.target.moves?.some(m => {
			const dexMove = ctx.dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		}) ?? true; // Default to assuming physical moves if unknown

		// Check if we have Body Press (uses defense for damage)
		const hasBodyPress = ctx.attacker.moves?.includes('bodypress') ?? false;

		if (targetHasPhysical) {
			// Good idea to raise defense against physical attacker
			bonus += setupReward(currentDef, ['cottonguard', 'irondefense'].includes(moveId) ? 10 : 8);

			if (bonus > 0) {
				ctx.adjustments.push({
					reason: `Defense boost vs physical attacker (def: +${currentDef})`,
					amount: bonus,
					category: 'positive',
				});
			}
		} else if (hasBodyPress) {
			// Body Press user - defense boosts increase damage
			bonus += setupReward(currentDef, 10, 7, 4);

			if (bonus > 0) {
				ctx.adjustments.push({
					reason: `Defense boost for Body Press (def: +${currentDef})`,
					amount: bonus,
					category: 'positive',
				});
			}
		}
	}

	// ==========================================================================
	// Special Defense boost moves
	// ==========================================================================
	if (spdBoostMoves.includes(moveId)) {
		const currentSpd = ctx.attacker.boosts.spd || 0;

		// Can't boost further
		if (currentSpd >= 6) return bonus;

		// Check if opponent likely uses special moves
		const targetHasSpecial = ctx.target.moves?.some(m => {
			const dexMove = ctx.dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		}) ?? true; // Default to assuming special moves if unknown

		if (targetHasSpecial) {
			// Good idea to raise special defense against special attacker
			bonus += setupReward(currentSpd, moveId === 'amnesia' ? 10 : 8);

			if (bonus > 0) {
				ctx.adjustments.push({
					reason: `Sp.Def boost vs special attacker (spd: +${currentSpd})`,
					amount: bonus,
					category: 'positive',
				});
			}
		}
	}

	// ==========================================================================
	// Mixed defensive boost moves (Cosmic Power, Defend Order)
	// ==========================================================================
	if (mixedDefBoostMoves.includes(moveId)) {
		const currentDef = ctx.attacker.boosts.def || 0;
		const currentSpd = ctx.attacker.boosts.spd || 0;

		// Can't boost further
		if (currentDef >= 6 && currentSpd >= 6) return bonus;

		// Check opponent's likely attack type
		const targetHasPhysical = ctx.target.moves?.some(m => {
			const dexMove = ctx.dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		}) ?? true;

		const targetHasSpecial = ctx.target.moves?.some(m => {
			const dexMove = ctx.dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		}) ?? true;

		if (targetHasPhysical && currentDef < 6) {
			bonus += setupReward(currentDef, 6, 4, 2);
		}

		if (targetHasSpecial && currentSpd < 6) {
			bonus += setupReward(currentSpd, 6, 4, 2);
		}

		if (bonus > 0) {
			ctx.adjustments.push({
				reason: `Mixed defense boost (def: +${currentDef}, spd: +${currentSpd})`,
				amount: bonus,
				category: 'positive',
			});
		}
	}

	return Math.max(0, bonus);
};

// =============================================================================
// Entry Hazard Rewards
// =============================================================================

/**
 * Reward entry hazards
 */
export const rewardHazards: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	let bonus = 0;

	// Stealth Rock
	if (moveId === 'stealthrock') {
		// Don't use if already up on opponent's side
		if (ctx.state.opponent.conditions.stealthrock) {
			// Already set - no bonus (will be handled by negatives)
			return 0;
		}

		// Check opponent's remaining Pokemon for Rock weakness
		let weakPokemonCount = 0;
		for (const mon of ctx.state.opponent.team) {
			if (mon.fainted) continue;
			const effectiveness = getTypeEffectiveness('Rock', mon.types);
			if (effectiveness >= 2) weakPokemonCount++;
		}

		bonus = 6 + weakPokemonCount * 2;
		ctx.adjustments.push({
			reason: `Stealth Rock value (${weakPokemonCount} weak Pokemon)`,
			amount: bonus,
			category: 'positive',
		});
	}

	// Spikes
	if (moveId === 'spikes') {
		const currentLayers = ctx.state.opponent.conditions.spikes;
		if (currentLayers < 3) {
			bonus = 4;
			ctx.adjustments.push({
				reason: `Spikes (layer ${currentLayers + 1})`,
				amount: bonus,
				category: 'positive',
			});
		}
	}

	// Toxic Spikes
	if (moveId === 'toxicspikes') {
		const currentLayers = ctx.state.opponent.conditions.toxicspikes;
		if (currentLayers < 2) {
			// Check if opponent has grounded Pokemon that can be poisoned
			const poisonableCount = ctx.state.opponent.team.filter(mon => {
				if (mon.fainted) return false;
				if (mon.types.includes('Poison') || mon.types.includes('Steel')) return false;
				if (mon.types.includes('Flying') || effectiveAbility(mon, ctx.state.field) === 'levitate') return false;
				return true;
			}).length;

			if (poisonableCount > 0) {
				bonus = 4 + poisonableCount;
				ctx.adjustments.push({
					reason: `Toxic Spikes (${poisonableCount} poisonable)`,
					amount: bonus,
					category: 'positive',
				});
			}
		}
	}

	// Sticky Web
	if (moveId === 'stickyweb') {
		// Check if opponent has fast grounded Pokemon
		const fastGroundedCount = ctx.state.opponent.team.filter(mon => {
			if (mon.fainted) return false;
			if (mon.types.includes('Flying') || effectiveAbility(mon, ctx.state.field) === 'levitate') return false;
			return mon.baseStats.spe >= 90;
		}).length;

		if (fastGroundedCount > 0) {
			bonus = 4 + fastGroundedCount * 2;
			ctx.adjustments.push({
				reason: `Sticky Web (${fastGroundedCount} fast grounded)`,
				amount: bonus,
				category: 'positive',
			});
		}
	}

	return bonus;
};

// =============================================================================
// Utility Move Rewards
// =============================================================================

/**
 * Reward pivoting moves (U-turn, Volt Switch)
 */
export const rewardPivotMove: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const pivotMoves = ['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport'];

	if (!pivotMoves.includes(moveId)) return 0;
	const reserves = ctx.state.self.reserve.filter(mon => !mon.fainted && !mon.active && mon.hp > 0 &&
		(!ctx.attacker.ownerSide || !mon.ownerSide || mon.ownerSide === ctx.attacker.ownerSide));
	if (!reserves.length) return 0;

	let bonus = 0;

	// Good if we have a bad matchup
	if (ctx.flags.isSuperEffective) {
		// We deal super effective damage, less need to switch
		bonus = 2;
	} else {
		// Neutral or resisted matchup, pivoting is valuable
		bonus = 6;
	}

	// Extra bonus if we have healthy reserves
	const healthyReserves = reserves.filter(mon => mon.hpPercent > 50).length;
	if (healthyReserves > 0) {
		bonus += 2;
	}

	ctx.adjustments.push({
		reason: 'Pivot move for momentum',
		amount: bonus,
		category: 'positive',
	});

	return bonus;
};

/**
 * Reward drain moves (Drain Punch, Giga Drain, etc.)
 * Based on CFRU ai_positives.c EFFECT_ABSORB and ShouldRecover logic
 *
 * Key considerations:
 * 1. Drain moves are more valuable when HP is low
 * 2. Check if healing would prevent a KO
 * 3. Liquid Ooze makes drain moves dangerous (handled in negatives)
 */
export const rewardDrainMove: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const moveId = toID(ctx.move.id);

	if (recoveryKind(ctx.move, ctx.state.field) !== 'drain' ||
		defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field) === 'liquidooze') return 0;

	let bonus = 0;
	const hpPercent = ctx.attacker.hpPercent;

	// Liquid Ooze check is in negatives.ts - if target has it, don't reward

	// Base value for drain move - healing while dealing damage is valuable
	// More valuable at lower HP
	if (hpPercent <= 30) {
		bonus += 8;
		ctx.adjustments.push({
			reason: 'Drain move at critical HP',
			amount: 8,
			category: 'positive',
		});
	} else if (hpPercent <= 50) {
		bonus += 5;
		ctx.adjustments.push({
			reason: 'Drain move at low HP',
			amount: 5,
			category: 'positive',
		});
	} else if (hpPercent <= 75) {
		bonus += 3;
		ctx.adjustments.push({
			reason: 'Drain move at moderate HP',
			amount: 3,
			category: 'positive',
		});
	} else {
		// Still small bonus at high HP - healing is always somewhat useful
		bonus += 1;
		ctx.adjustments.push({ reason: 'Drain move at high HP', amount: 1, category: 'positive' });
	}

	// Extra bonus for Oblivion Wing (75% heal instead of 50%)
	if (moveId === 'oblivionwing') {
		bonus += 2;
		ctx.adjustments.push({
			reason: 'Oblivion Wing heals 75%',
			amount: 2,
			category: 'positive',
		});
	}

	// ShouldRecover logic from CFRU:
	// If opponent can KO us, and healing would save us, big bonus
	// This would require damage calculation from opponent's perspective
	// Simplified: if we're slower and low HP, drain is more valuable
	if (!ctx.flags.goesFirst && hpPercent <= 50) {
		bonus += 3;
		ctx.adjustments.push({
			reason: 'Slower + low HP - drain helps survival',
			amount: 3,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward healing moves when appropriate
 */
export const rewardHealing: PositiveScoringFunction = (ctx) => {
	const recipients = recoveryRecipients(ctx.state, ctx.attacker, ctx.target, ctx.move);
	if (!recipients.length) return 0;
	const hp = Math.min(...recipients.map(p => p.hpPercent));
	let bonus = hp <= 30 ? 12 : hp <= 50 ? 8 : hp <= 70 ? 4 : 0;
	if (bonus) ctx.adjustments.push({ reason: 'Healing an injured recipient', amount: bonus, category: 'positive' });
	if (recoveryCuresStatus(ctx.move) && recipients.some(p => p.status)) {
		bonus += 5;
		ctx.adjustments.push({ reason: "Recovery cures a recipient's status", amount: 5, category: 'positive' });
	}
	return bonus;
};

export const rewardPainSplit: PositiveScoringFunction = ctx => {
	if (ctx.move.id !== 'painsplit') return 0;
	const value = painSplitValue(ctx);
	const amount = Math.max(0, value.score - BASE_SCORE);
	if (amount) ctx.adjustments.push({ reason: value.reason, amount, category: 'positive' });
	return amount;
};

/**
 * Reward screens (Light Screen, Reflect)
 */
export const rewardScreens: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	let bonus = 0;

	if (moveId === 'lightscreen') {
		if (ctx.state.self.conditions.lightscreen === 0) {
			// Check opponent's Special attackers
			const hasSpecialThreat = ctx.state.opponent.team.some(mon =>
				!mon.fainted && mon.baseStats.spa > mon.baseStats.atk
			);

			if (hasSpecialThreat) {
				bonus = 6;
				ctx.adjustments.push({
					reason: 'Light Screen vs special threats',
					amount: 6,
					category: 'positive',
				});
			}
		}
	}

	if (moveId === 'reflect') {
		if (ctx.state.self.conditions.reflect === 0) {
			const hasPhysicalThreat = ctx.state.opponent.team.some(mon =>
				!mon.fainted && mon.baseStats.atk > mon.baseStats.spa
			);

			if (hasPhysicalThreat) {
				bonus = 6;
				ctx.adjustments.push({
					reason: 'Reflect vs physical threats',
					amount: 6,
					category: 'positive',
				});
			}
		}
	}

	if (moveId === 'auroraveil') {
		// Aurora Veil only works in hail/snow
		if (ctx.state.field.weather === 'hail' || ctx.state.field.weather === 'snow') {
			if (ctx.state.self.conditions.auroraveil === 0) {
				bonus = 10;
				ctx.adjustments.push({
					reason: 'Aurora Veil (both screens)',
					amount: 10,
					category: 'positive',
				});
			}
		}
	}

	return bonus;
};

/**
 * Reward Trick Room in appropriate situations
 */
export const rewardTrickRoom: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'trickroom') return 0;

	// If Trick Room is already up, don't use it again
	if (ctx.state.field.trickroom) {
		return 0;
	}

	// Check if our team benefits from Trick Room
	const slowAllies = ctx.state.self.team.filter(mon =>
		!mon.fainted && mon.baseStats.spe <= 60
	).length;

	const fastOpponents = ctx.state.opponent.team.filter(mon =>
		!mon.fainted && mon.baseStats.spe >= 80
	).length;

	let bonus = 0;

	if (slowAllies >= 2 && fastOpponents >= 1) {
		bonus = 8 + slowAllies * 2;
		ctx.adjustments.push({
			reason: `Trick Room benefits (${slowAllies} slow allies)`,
			amount: bonus,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward Disable when opponent used a threatening move
 * Based on CFRU ai_positives.c EFFECT_DISABLE (lines 935-952)
 *
 * Disable prevents opponent from using the move they last used.
 * IMPORTANT: Disable only works on the LAST MOVE USED, not any move in their moveset.
 *
 * Key considerations:
 * 1. Only valuable if opponent actually used a move worth disabling
 * 2. More valuable if we're faster (can disable before they act again)
 * 3. Mental Herb cures Disable
 */
export const rewardDisable: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'disable') return 0;

	// Check if target already disabled (would fail)
	if (ctx.target.volatiles.has('disable')) {
		return 0;
	}

	// Mental Herb would cure Disable
	if (ctx.dex.gen >= 5 && effectiveItem(ctx.target, ctx.state.field) === 'mentalherb') {
		return 0;
	}

	// CFRU Logic: Check gLastUsedMoves[bankDef]
	// If opponent hasn't used a move yet, Disable has no value
	const lastMove = ctx.target.lastMove;
	if (!lastMove) {
		return 0;
	}

	let bonus = 0;
	const lastMoveData = ctx.dex.moves.get(lastMove);
	const lastMoveIsStatus = lastMoveData.category === 'Status';

	// If we're faster, we can disable before they act again
	if (ctx.flags.goesFirst) {
		// CFRU: Lock into status moves is valuable
		if (lastMoveIsStatus) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Disable opponent's status move (${lastMove})`,
				amount: 4,
				category: 'positive',
			});
		} else {
			// Disabling an attacking move is still useful
			bonus += 2;
			ctx.adjustments.push({
				reason: `Disable opponent's last move (${lastMove})`,
				amount: 2,
				category: 'positive',
			});
		}

		// Extra bonus if the move we're disabling is super effective against us
		const effectiveness = ctx.dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[0]);
		const effectiveness2 = ctx.attacker.types[1] ?
			ctx.dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[1]) : 0;

		if (effectiveness > 0 || effectiveness2 > 0) {
			bonus += 2;
			ctx.adjustments.push({
				reason: 'Disable super effective move',
				amount: 2,
				category: 'positive',
			});
		}
	} else {
		// Slower - less reliable, small bonus only if last move was status
		if (lastMoveIsStatus) {
			bonus += 2;
			ctx.adjustments.push({
				reason: `Disable status move when slower (${lastMove})`,
				amount: 2,
				category: 'positive',
			});
		}
	}

	return bonus;
};

/** Reward a reliable interruption of the target's last status move. */
export const rewardEncore: PositiveScoringFunction = (ctx) => {
	if (ctx.move.id !== 'encore' || ctx.target.volatiles.has('encore')) return 0;
	if (ctx.dex.gen >= 5 && effectiveItem(ctx.target, ctx.state.field) === 'mentalherb') return 0;
	const last = ctx.dex.moves.get(ctx.target.lastMove || '');
	if (!last.exists || last.category !== 'Status' || last.flags.failencore || last.isZ || last.isMax) return 0;
	if (!actsBeforeTarget(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;
	const bonus = BASE_SCORE + 20 - DISCOURAGED_SCORE;
	ctx.adjustments.push({
		reason: `Encore interrupts the last status move (${last.name})`, amount: bonus, category: 'positive',
	});
	return bonus;
};

/**
 * Reward Taunt against setup/stall
 */
export const rewardTaunt: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'taunt') return 0;

	let bonus = 0;

	// Check if opponent has status moves in known moveset
	const hasStatusMoves = ctx.target.moves.some(m => {
		const dexMove = ctx.dex.moves.get(m);
		return dexMove.category === 'Status';
	});

	if (hasStatusMoves) {
		bonus = 8;
		ctx.adjustments.push({
			reason: 'Taunt against status user',
			amount: 8,
			category: 'positive',
		});
	}

	// Extra bonus against bulky Pokemon (likely walls)
	if (ctx.target.baseStats.hp >= 90 || ctx.target.baseStats.def >= 90 || ctx.target.baseStats.spd >= 90) {
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Taunt against potential wall',
			amount: 4,
			category: 'positive',
		});
	}

	return bonus;
};

// =============================================================================
// Doubles-Specific Rewards
// =============================================================================

/**
 * Reward attacking partner with absorbing/stat-boosting abilities
 * Based on CFRU ai_partner.c lines 62-179
 *
 * This handles intentional partner attacks to trigger beneficial abilities:
 * - Volt Absorb / Water Absorb / Dry Skin: Heal partner
 * - Motor Drive / Lightning Rod / Storm Drain / Sap Sipper: Stat boosts
 * - Flash Fire: Fire move power boost
 * - Justified / Rattled / Steam Engine: Attack/Speed boosts
 *
 * CFRU uses IncreaseHealPartnerViability (+8~+10) and IncreaseHelpingHandViability (+6~+8)
 */
export const rewardPartnerAbsorption: PositiveScoringFunction = (ctx) => {
	// Only applies in doubles when targeting partner
	if (!ctx.state.isDoubles) return 0;
	if (!ctx.isTargetingPartner) return 0;
	if (ctx.move.category === 'Status') return 0;

	const partnerAbility = effectiveAbility(ctx.target, ctx.state.field);
	const moveType = ctx.move.type;
	let bonus = 0;

	// Electric type - healing or stat boost abilities
	if (moveType === 'Electric') {
		if (partnerAbility === 'voltabsorb') {
			// Heal partner - CFRU: IncreaseHealPartnerViability
			// Check if partner needs healing
			if (ctx.target.hpPercent < 100) {
				const healBonus = ctx.target.hpPercent <= 50 ? 10 : 6;
				bonus += healBonus;
				ctx.adjustments.push({
					reason: `Volt Absorb heals partner (${ctx.target.hpPercent}% HP)`,
					amount: healBonus,
					category: 'positive',
				});
			}
		} else if (partnerAbility === 'motordrive') {
			// Speed boost - CFRU: IncreaseHelpingHandViability + speed check
			if (ctx.target.boosts.spe < 6) {
				bonus += 8;
				ctx.adjustments.push({
					reason: 'Motor Drive boosts partner Speed',
					amount: 8,
					category: 'positive',
				});
			}
		} else if (partnerAbility === 'lightningrod') {
			// SpA boost - CFRU: IncreaseHelpingHandViability + special move check
			if (ctx.target.boosts.spa < 6) {
				// Extra value if partner has special moves
				const hasSpecialMoves = ctx.target.moves?.some(m => {
					const dexMove = ctx.dex.moves.get(m);
					return dexMove.category === 'Special' && dexMove.basePower > 0;
				}) ?? false;

				if (hasSpecialMoves) {
					bonus += 8;
					ctx.adjustments.push({
						reason: 'Lightning Rod boosts partner SpA (has special moves)',
						amount: 8,
						category: 'positive',
					});
				}
			}
		}
	}

	// Water type - healing or stat boost abilities
	if (moveType === 'Water') {
		if (partnerAbility === 'waterabsorb' || partnerAbility === 'dryskin') {
			// Heal partner - CFRU: IncreaseHealPartnerViability
			if (ctx.target.hpPercent < 100) {
				const healBonus = ctx.target.hpPercent <= 50 ? 10 : 6;
				bonus += healBonus;
				ctx.adjustments.push({
					reason: `${ctx.target.ability} heals partner (${ctx.target.hpPercent}% HP)`,
					amount: healBonus,
					category: 'positive',
				});
			}
		} else if (partnerAbility === 'stormdrain') {
			// SpA boost - CFRU: IncreaseHelpingHandViability + special move check
			if (ctx.target.boosts.spa < 6) {
				const hasSpecialMoves = ctx.target.moves?.some(m => {
					const dexMove = ctx.dex.moves.get(m);
					return dexMove.category === 'Special' && dexMove.basePower > 0;
				}) ?? false;

				if (hasSpecialMoves) {
					bonus += 8;
					ctx.adjustments.push({
						reason: 'Storm Drain boosts partner SpA (has special moves)',
						amount: 8,
						category: 'positive',
					});
				}
			}
		}
	}

	// Fire type - Flash Fire
	if (moveType === 'Fire') {
		if (partnerAbility === 'flashfire') {
			// Check if partner has Fire moves and Flash Fire not already active
			// CFRU: !(gBattleResources->flags->flags[bankAtkPartner] & RESOURCE_FLAG_FLASH_FIRE)
			// We can't track this exactly, so just check if partner has Fire moves
			const hasFireMoves = ctx.target.moves?.some(m => {
				const dexMove = ctx.dex.moves.get(m);
				return dexMove.type === 'Fire' && dexMove.basePower > 0;
			}) ?? false;

			if (hasFireMoves) {
				bonus += 8;
				ctx.adjustments.push({
					reason: 'Flash Fire boosts partner Fire moves',
					amount: 8,
					category: 'positive',
				});
			}
		}
	}

	// Grass type - Sap Sipper
	if (moveType === 'Grass') {
		if (partnerAbility === 'sapsipper') {
			// Attack boost - CFRU: IncreaseHelpingHandViability + physical move check
			if (ctx.target.boosts.atk < 6) {
				const hasPhysicalMoves = ctx.target.moves?.some(m => {
					const dexMove = ctx.dex.moves.get(m);
					return dexMove.category === 'Physical' && dexMove.basePower > 0;
				}) ?? false;

				if (hasPhysicalMoves) {
					bonus += 8;
					ctx.adjustments.push({
						reason: 'Sap Sipper boosts partner Attack (has physical moves)',
						amount: 8,
						category: 'positive',
					});
				}
			}
		}
	}

	// Dark type - Justified
	if (moveType === 'Dark') {
		if (partnerAbility === 'justified') {
			// Attack boost - CFRU: check physical moves + won't KO partner
			if (ctx.target.boosts.atk < 6) {
				const hasPhysicalMoves = ctx.target.moves?.some(m => {
					const dexMove = ctx.dex.moves.get(m);
					return dexMove.category === 'Physical' && dexMove.basePower > 0;
				}) ?? false;

				// CFRU: Don't do this if we'd KO partner
				if (hasPhysicalMoves && !ctx.damageResult?.canKO) {
					bonus += 8;
					ctx.adjustments.push({
						reason: 'Justified boosts partner Attack (has physical moves)',
						amount: 8,
						category: 'positive',
					});
				}
			}
		}
	}

	// Dark/Ghost/Bug - Rattled
	if (['Dark', 'Ghost', 'Bug'].includes(moveType)) {
		if (partnerAbility === 'rattled') {
			// Speed boost - CFRU: check won't KO partner
			if (ctx.target.boosts.spe < 6 && !ctx.damageResult?.canKO) {
				bonus += 6;
				ctx.adjustments.push({
					reason: 'Rattled boosts partner Speed',
					amount: 6,
					category: 'positive',
				});
			}
		}
	}

	// Fire/Water - Steam Engine
	if (['Fire', 'Water'].includes(moveType)) {
		if (partnerAbility === 'steamengine') {
			// +6 Speed - CFRU: IncreaseHelpingHandViability + won't KO partner
			if (ctx.target.boosts.spe < 6 && !ctx.damageResult?.canKO) {
				bonus += 10;
				ctx.adjustments.push({
					reason: 'Steam Engine massively boosts partner Speed (+6)',
					amount: 10,
					category: 'positive',
				});
			}
		}
	}

	return bonus;
};

/**
 * Reward spread moves in doubles
 *
 * v1.1.21: Enhanced to calculate KO/damage bonuses for OTHER targets
 * Since the scoring system already calculates KO bonus for ctx.target,
 * this function adds bonuses for additional opponents hit by spread moves.
 *
 * For spread moves that can KO multiple opponents:
 * - First KO bonus: handled by rewardKnockout (ctx.target)
 * - Additional KO bonuses: handled here (other opponents)
 *
 * v1.1.22: Only give base spread bonus if the move is effective against
 * at least one other opponent. If the spread move only hits one opponent
 * effectively (others immune/very low damage), it's essentially a single-target
 * move with side effects, and shouldn't get the spread bonus.
 */
export const rewardSpreadMove: PositiveScoringFunction = (ctx) => {
	if (!ctx.state.isDoubles) return 0;
	if (ctx.move.category === 'Status') return 0;

	const spreadTargets = ['allAdjacentFoes', 'allAdjacent'];
	if (!spreadTargets.includes(ctx.move.target)) return 0;

	// Get all active opponents except the current target
	const otherOpponents = ctx.state.opponent.active.filter(
		mon => !mon.fainted && mon !== ctx.target
	);

	if (otherOpponents.length === 0) return 0;

	let bonus = 0;
	let effectiveAgainstOthers = false; // Track if spread is actually useful against other targets

	// Calculate spread move damage reduction info
	// For allAdjacentFoes: count alive opponents
	// For allAdjacent: count all except attacker
	const numAliveOpponents = ctx.state.opponent.active.filter(p => !p.fainted).length;
	const numAlivePartners = ctx.state.self.active.filter(p => p !== ctx.attacker && !p.fainted).length;
	const numAliveTargets = ctx.move.target === 'allAdjacent'
		? numAliveOpponents + numAlivePartners
		: numAliveOpponents;
	const spreadInfo = {
		isDoubles: true, numAliveTargets,
		defenderAllies: ctx.state.opponent.active,
		activePokemon: [...ctx.state.self.active, ...ctx.state.opponent.active],
		attackerSideConditions: ctx.state.self.conditions,
		defenderSideConditions: ctx.state.opponent.conditions,
	};

	// Calculate damage and KO potential for other opponents
	for (const otherTarget of otherOpponents) {
		try {
			const damageResult = calculateDamage(
				ctx.attacker,
				otherTarget,
				ctx.move,
				ctx.state.field,
				ctx.cache,
				spreadInfo
			);

			if (!damageResult) continue;

			// Check if move is effective (not immune, deals meaningful damage)
			const isEffective = damageResult.effectiveness > 0 && damageResult.averagePercent >= 15;

			// KO bonus for second target
			if (damageResult.canKO) {
				effectiveAgainstOthers = true;
				bonus += 20;
				ctx.adjustments.push({
					reason: `Spread move KOs ${otherTarget.species}`,
					amount: 20,
					category: 'positive',
				});

				// Extra bonus for going first (safe double KO)
				const knowledge = otherTarget.moveKnowledge;
				const responses = (knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] : otherTarget.moves)
					.map(id => buildAIMove({ id }, 1, ctx.state.field.formatId));
				if (ctx.flags.canKO && ctx.flags.goesFirst && attacksFirst(ctx.attacker, otherTarget, ctx.move,
					responses, ctx.state.field, ctx.state.self.conditions, ctx.state.opponent.conditions)) {
					bonus += 5;
					ctx.adjustments.push({
						reason: 'Outspeeds for double KO',
						amount: 5,
						category: 'positive',
					});
				}
			} else if (damageResult.hitsToKO <= 2) {
				// 2HKO bonus for second target
				effectiveAgainstOthers = true;
				bonus += 6;
				ctx.adjustments.push({
					reason: `Spread move can 2HKO ${otherTarget.species}`,
					amount: 6,
					category: 'positive',
				});
			} else if (damageResult.averagePercent >= 30) {
				// Moderate damage bonus
				effectiveAgainstOthers = true;
				bonus += 3;
				ctx.adjustments.push({
					reason: `Spread move deals ${Math.floor(damageResult.averagePercent)}% to ${otherTarget.species}`,
					amount: 3,
					category: 'positive',
				});
			} else if (isEffective) {
				// Low but non-trivial damage - mark as effective but no bonus
				effectiveAgainstOthers = true;
			}
		} catch (e) {
			// If damage calculation fails, don't assume effectiveness
			// This is more conservative - only give spread bonus when we can verify effectiveness
			continue;
		}
	}

	// Only give base spread bonus if the move is effective against at least one other opponent
	// This prevents rewarding a spread move that only hits one target effectively
	// (e.g., Earthquake that KOs one opponent but the other is Flying type)
	if (effectiveAgainstOthers) {
		bonus += 6;
		ctx.adjustments.push({
			reason: 'Spread move hits multiple targets',
			amount: 6,
			category: 'positive',
		});
	}

	return bonus;
};

/**
 * Reward Helping Hand in doubles
 */
export const rewardHelpingHand: PositiveScoringFunction = (ctx) => {
	if (!ctx.state.isDoubles) return 0;
	if (toID(ctx.move.id) !== 'helpinghand') return 0;

	// Check if partner can benefit
	const partner = ctx.state.self.active.find(mon =>
		mon.slot !== ctx.attacker.slot && !mon.fainted
	);

	if (!partner) return 0;

	// Check if partner has strong attacking move
	const partnerHasAttack = partner.moves.some(m => {
		const dexMove = ctx.dex.moves.get(m);
		return dexMove.category !== 'Status' && dexMove.basePower >= 80;
	});

	if (partnerHasAttack) {
		ctx.adjustments.push({
			reason: 'Helping Hand boosts partner',
			amount: 6,
			category: 'positive',
		});
		return 6;
	}

	return 0;
};

// =============================================================================
// Weather/Terrain Team Benefit
// =============================================================================

/**
 * Reward weather moves that benefit the team
 * Based on CFRU ai_positives.c EFFECT_RAIN_DANCE/SUNNY_DAY/SANDSTORM/HAIL (lines 1407-1814)
 *
 * Simplified version - checks if attacker benefits from weather
 */
export const rewardWeatherMove: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	const weatherMoves: { [key: string]: string } = {
		'raindance': 'RainDance',
		'sunnyday': 'SunnyDay',
		'sandstorm': 'Sandstorm',
		'hail': 'Hail',
		'snowscape': 'Snow',
		'chillyreception': 'Snow',
	};

	if (!weatherMoves[moveId]) return 0;

	const abilityId = effectiveAbility(ctx.attacker, ctx.state.field);
	let bonus = 0;

	// Rain Dance benefits
	if (moveId === 'raindance') {
		// Speed boost abilities
		if (abilityId === 'swiftswim') {
			bonus += 10;
			ctx.adjustments.push({
				reason: 'Rain Dance + Swift Swim (speed double)',
				amount: 10,
				category: 'positive',
			});
		}
		// Recovery abilities
		if (abilityId === 'raindish' || abilityId === 'dryskin' || abilityId === 'hydration') {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Rain Dance + ${ctx.attacker.ability}`,
				amount: 4,
				category: 'positive',
			});
		}
		// Water type moves benefit
		if (ctx.attacker.types.includes('Water') || ctx.attacker.moves.some(m => ctx.dex.moves.get(m).type === 'Water')) {
			bonus += 3;
			ctx.adjustments.push({
				reason: 'Rain Dance boosts Water moves',
				amount: 3,
				category: 'positive',
			});
		}
	}

	// Sunny Day benefits
	if (moveId === 'sunnyday') {
		// Speed boost abilities
		if (abilityId === 'chlorophyll') {
			bonus += 10;
			ctx.adjustments.push({
				reason: 'Sunny Day + Chlorophyll (speed double)',
				amount: 10,
				category: 'positive',
			});
		}
		// Other sun abilities
		if (['solarpower', 'flowergift', 'harvest', 'leafguard'].includes(abilityId)) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Sunny Day + ${ctx.attacker.ability}`,
				amount: 4,
				category: 'positive',
			});
		}
		// Fire type moves benefit
		if (ctx.attacker.types.includes('Fire') || ctx.attacker.moves.some(m => ctx.dex.moves.get(m).type === 'Fire')) {
			bonus += 3;
			ctx.adjustments.push({
				reason: 'Sunny Day boosts Fire moves',
				amount: 3,
				category: 'positive',
			});
		}
		// Solar Beam doesn't need charge
		if (ctx.attacker.moves.some(m => ['solarbeam', 'solarblade'].includes(toID(m)))) {
			bonus += 4;
			ctx.adjustments.push({
				reason: 'Sunny Day enables instant Solar Beam',
				amount: 4,
				category: 'positive',
			});
		}
	}

	// Sandstorm benefits
	if (moveId === 'sandstorm') {
		// Speed boost abilities
		if (abilityId === 'sandrush') {
			bonus += 10;
			ctx.adjustments.push({
				reason: 'Sandstorm + Sand Rush (speed double)',
				amount: 10,
				category: 'positive',
			});
		}
		// Other sand abilities
		if (['sandveil', 'sandforce'].includes(abilityId)) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Sandstorm + ${ctx.attacker.ability}`,
				amount: 4,
				category: 'positive',
			});
		}
		// Rock type SpD boost
		if (ctx.attacker.types.includes('Rock')) {
			bonus += 3;
			ctx.adjustments.push({
				reason: 'Sandstorm boosts Rock SpD',
				amount: 3,
				category: 'positive',
			});
		}
		// Immune to sandstorm damage
		const sandImmune = ctx.attacker.types.some(t => ['Rock', 'Ground', 'Steel'].includes(t)) ||
			['magicguard', 'overcoat', 'sandveil', 'sandrush', 'sandforce'].includes(abilityId);
		if (sandImmune && !bonus) {
			bonus += 2;
			ctx.adjustments.push({
				reason: 'Immune to Sandstorm damage',
				amount: 2,
				category: 'positive',
			});
		}
	}

	// Hail/Snow benefits
	if (moveId === 'hail' || moveId === 'snowscape' || moveId === 'chillyreception') {
		// Speed boost abilities
		if (abilityId === 'slushrush') {
			bonus += 10;
			ctx.adjustments.push({
				reason: 'Hail/Snow + Slush Rush (speed double)',
				amount: 10,
				category: 'positive',
			});
		}
		// Other snow abilities
		if (['snowcloak', 'icebody', 'forecast'].includes(abilityId)) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Hail/Snow + ${ctx.attacker.ability}`,
				amount: 4,
				category: 'positive',
			});
		}
		// Blizzard never misses
		if (ctx.attacker.moves.some(m => toID(m) === 'blizzard')) {
			bonus += 4;
			ctx.adjustments.push({
				reason: 'Hail/Snow enables 100% Blizzard',
				amount: 4,
				category: 'positive',
			});
		}
		// Aurora Veil enabled
		if (ctx.attacker.moves.some(m => toID(m) === 'auroraveil')) {
			bonus += 5;
			ctx.adjustments.push({
				reason: 'Hail/Snow enables Aurora Veil',
				amount: 5,
				category: 'positive',
			});
		}
	}

	return bonus;
};

/**
 * Reward Tailwind when slower
 * Based on CFRU ai_positives.c IncreaseTailwindViability (ai_advanced.c:2972)
 *
 * Key logic: If attacker is slower than defender, speed control is very valuable
 */
export const rewardTailwind: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'tailwind') return 0;

	// Check if Tailwind already active
	if (ctx.state.self.conditions.tailwind > 0) {
		return 0;
	}

	let bonus = 0;

	// CFRU: If we're slower than opponent, Tailwind is very valuable
	if (speedOrder(ctx) < 0 && !ctx.state.field.trickroom) {
		// Significant speed disadvantage - Tailwind is very valuable
		bonus += 12;
		ctx.adjustments.push({
			reason: 'Tailwind to outspeed opponent',
			amount: 12,
			category: 'positive',
		});
	} else {
		// Already faster - less need but still useful for team
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Tailwind for team speed support',
			amount: 4,
			category: 'positive',
		});
	}

	// Extra bonus in doubles (helps partner too)
	if (ctx.state.isDoubles) {
		bonus += 4;
		ctx.adjustments.push({
			reason: 'Tailwind helps doubles partner',
			amount: 4,
			category: 'positive',
		});
	}

	// Extra bonus if we have slow sweepers in reserve
	const slowReserves = ctx.state.self.reserve.filter(mon =>
		!mon.fainted && mon.baseStats.spe < 80 && (mon.baseStats.atk >= 100 || mon.baseStats.spa >= 100)
	).length;

	if (slowReserves > 0) {
		bonus += slowReserves * 2;
		ctx.adjustments.push({
			reason: `Tailwind benefits ${slowReserves} slow sweeper(s)`,
			amount: slowReserves * 2,
			category: 'positive',
		});
	}

	return bonus;
};

// =============================================================================
// Residual Damage Moves
// =============================================================================

/**
 * Reward Salt Cure - Gen 9 move with strong residual damage
 * 1/8 maxHP per turn normally, 1/4 maxHP for Water/Steel types
 *
 * Based on CFRU Leech Seed logic pattern (ai_positives.c:914)
 * Salt Cure is not in CFRU but we apply similar evaluation principles
 */
export const rewardSaltCure: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);
	if (moveId !== 'saltcure') return 0;
	if (secondaryEffectFailure(ctx.state, ctx.attacker, ctx.target, ctx.move)) return 0;

	let bonus = 0;
	const targetAbility = effectiveAbility(ctx.target, ctx.state.field);

	// Check immunities - CFRU pattern: early return for blocked cases
	// Magic Guard prevents Salt Cure damage
	if (targetAbility === 'magicguard') {
		return 0;
	}

	// Already salt cured (shouldn't use again)
	if (ctx.target.volatiles.has('saltcure')) {
		return 0;
	}

	// Base bonus - residual damage is always useful (like Leech Seed: +3)
	bonus += 3;
	ctx.adjustments.push({
		reason: 'Salt Cure residual damage',
		amount: 3,
		category: 'positive',
	});

	// Extra bonus for Water/Steel types (1/4 damage instead of 1/8)
	const isWaterOrSteel = ctx.target.types.includes('Water') || ctx.target.types.includes('Steel');
	if (isWaterOrSteel) {
		bonus += 10;
		ctx.adjustments.push({
			reason: 'Salt Cure vs Water/Steel (1/4 HP)',
			amount: 10,
			category: 'positive',
		});
	}

	// Extra bonus against bulky targets (they'll take more total damage over time)
	const isBulky = ctx.target.baseStats.hp >= 90 ||
		ctx.target.baseStats.def >= 90 ||
		ctx.target.baseStats.spd >= 90;

	if (isBulky) {
		bonus += 8;
		ctx.adjustments.push({
			reason: 'Salt Cure against bulky target',
			amount: 8,
			category: 'positive',
		});
	}

	if (targetLacksRecovery(ctx)) {
		bonus += 2;
		ctx.adjustments.push({
			reason: 'No recovery in revealed moves or compatible presets',
			amount: 2,
			category: 'positive',
		});
	}

	return bonus;
};

// =============================================================================
// Knock Off Reward
// =============================================================================

/** Reward possible removal (+5), with extra value against bulky targets (+3). */
export const rewardKnockOff: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'knockoff') return 0;

	// Removal eligibility is independent of Knock Off's damage.
	if (itemRemovalFailure(ctx.attacker, ctx.target, ctx.move, ctx.state.field)) {
		return 0;
	}

	let bonus = 0;

	// Base bonus for item removal utility
	bonus += 5;
	ctx.adjustments.push({
		reason: 'Knock Off item removal utility',
		amount: 5,
		category: 'positive',
	});

	// Extra bonus against bulky targets (item removal hurts them more)
	// Only if target still has item
	const isBulky = ctx.target.baseStats.hp >= 90 ||
		ctx.target.baseStats.def >= 90 ||
		ctx.target.baseStats.spd >= 90;

	if (isBulky) {
		bonus += 3;
		ctx.adjustments.push({
			reason: 'Knock Off vs bulky target',
			amount: 3,
			category: 'positive',
		});
	}

	return bonus;
};

/** Reward the net value of Haze, capped at 140 after its 20-point turn cost. */
export const rewardHaze: PositiveScoringFunction = ctx => {
	if (ctx.move.id !== 'haze') return 0;
	const { net, reason } = getHazeBenefit(ctx);
	if (net <= 0) return 0;
	const bonus = Math.min(60, net);
	ctx.adjustments.push({
		reason: `Haze: net benefit ${net} (${reason})${net > 60 ? '; capped at +60' : ''}`,
		amount: bonus,
		category: 'positive',
	});
	return bonus;
};

// =============================================================================
// Export all positive scorers
// =============================================================================

export const allPositiveScorers: PositiveScoringFunction[] = [
	// Damage moves
	rewardKnockout,
	rewardHighDamage,
	rewardSTAB,
	rewardSuperEffective,
	rewardPriorityKO,

	// Status moves
	rewardSleepMove,
	rewardParalysisMove,
	rewardBurnMove,
	rewardToxic,
	rewardSleepTalkSnore,  // CFRU: ai_positives.c 982-986

	// Setup moves
	rewardSetupMove,
	rewardDefensiveSetup,

	// Entry hazards
	rewardHazards,

	// Utility moves
	rewardHaze,
	rewardDrainMove,
	rewardPivotMove,
	rewardHealing,
	rewardPainSplit,
	rewardScreens,
	rewardTrickRoom,
	rewardDisable,
	rewardEncore,
	rewardTaunt,

	// Doubles-specific
	rewardPartnerAbsorption,
	rewardSpreadMove,
	rewardHelpingHand,

	// Weather/Terrain and Speed Control
	rewardWeatherMove,
	rewardTailwind,

	// Residual damage moves
	rewardSaltCure,

	// Item removal
	rewardKnockOff,
];
