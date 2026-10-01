/**
 * CFRU AI - Positive Scoring Rules
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Positive scoring functions that increase move viability.
 * Based on CFRU ai_positives.c
 *
 * @license MIT
 */

import { Dex, toID } from '../../../../../sim/dex';
import type { ScoringContext, PositiveScoringFunction } from './index';
import { calculateDamage, canKnockOut, can2HKO, findStrongestMove } from '../util/damage-calc';
import { isFaster, goesFirst } from '../util/speed';
import { getTypeEffectiveness } from '../util/type-calc';

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
		if (ctx.flags.goesFirst) {
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
		if (ctx.flags.goesFirst) {
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

	if (ctx.attacker.types.includes(ctx.move.type)) {
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
	if (ctx.move.priority <= 0) return 0;

	// Priority move that can KO is very valuable
	if (ctx.flags.canKO) {
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
	if (ctx.flags.hasNoEffect) return 0;

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
		const dexMove = Dex.moves.get(m);
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

	let bonus = 0;

	// Bonus if target is faster
	if (!ctx.flags.goesFirst) {
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
			reason: 'Paralysis for speed control',
			amount: 4,
			category: 'positive',
		});
	}

	// Extra bonus for high accuracy
	if (ctx.move.accuracy === true || ctx.move.accuracy >= 90) {
		bonus += 2;
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
	if (toID(ctx.target.ability) === 'guts') {
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

	// Bonus if target lacks recovery
	const hasRecovery = ctx.target.moves.some(m => {
		return ['recover', 'softboiled', 'roost', 'slackoff', 'synthesis',
			'moonlight', 'morningsun', 'shoreup', 'rest'].includes(toID(m));
	});

	if (!hasRecovery) {
		bonus += 3;
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

	const attackerAbility = toID(ctx.attacker.ability);

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
	ctx.adjustments.push({
		reason: `${ctx.move.name} while asleep`,
		amount: 10,
		category: 'positive',
	});
	return 10;
};

// =============================================================================
// Setup Move Rewards
// =============================================================================

/**
 * Reward setup moves when appropriate
 * Based on CFRU ai_positives.c EFFECT_ATTACK_UP_2 and ai_advanced.c ShouldTryToSetUpStat
 *
 * Key considerations from CFRU:
 * 1. Don't set up if you'll die from chip damage (WillFaintFromSecondaryDamage)
 * 2. Don't set up if foe can 2HKO you (Can2HKO check)
 * 3. +2 boost doubles the stat - diminishing returns after that
 * 4. HP threshold matters - low HP means setup is risky
 * 5. If target's defense is boosted, your attack boost is more valuable
 */
export const rewardSetupMove: PositiveScoringFunction = (ctx) => {
	if (ctx.move.category !== 'Status') return 0;

	const moveId = toID(ctx.move.id);

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
	// HP-based safety check (CFRU: WillFaintFromSecondaryDamage, Can2HKO)
	// ==========================================================================
	const hpPercent = ctx.attacker.hpPercent;

	// Critical HP - don't setup, should be attacking or switching
	if (hpPercent <= 25) {
		return 0;
	}

	// Low HP - heavily discourage setup
	if (hpPercent <= 40) {
		// Only allow setup if we're faster and can survive one more turn
		if (!ctx.flags.goesFirst) {
			return 0;
		}
		// Even if faster, reduce bonus significantly
		bonus -= 11;
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

	const goesFirst = ctx.flags.goesFirst;
	const targetDefBoost = ctx.target.boosts.def || 0;
	const targetSpdBoost = ctx.target.boosts.spd || 0;

	// Attack boost moves
	if (atkBoostMoves.includes(moveId)) {
		// Check if we have physical moves (CFRU: RealPhysicalMoveInMoveset)
		const hasPhysicalMove = ctx.attacker.moves.some(m => {
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		});

		if (!hasPhysicalMove) return bonus; // No physical moves = no point boosting atk

		const currentAtk = ctx.attacker.boosts.atk || 0;

		// Can't boost further
		if (currentAtk >= 6) return bonus;

		// Base calculation
		if (currentAtk === 0) {
			// First boost: +2 = 2x damage = very valuable
			bonus += 10;
			if (moveId === 'swordsdance') bonus += 0; // No extra bonus for +2 move now
		} else if (currentAtk === 2) {
			// Second boost: +4 = 3x damage (1.5x increase from 2x)
			bonus += 5;
			if (moveId === 'swordsdance') bonus += 0;
		} else if (currentAtk === 4) {
			// Third boost: +6 = 4x damage (1.33x increase from 3x)
			// Diminishing returns - usually better to attack now
			bonus += 2;
		}

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
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		});

		if (!hasSpecialMove) return bonus;

		const currentSpa = ctx.attacker.boosts.spa || 0;

		if (currentSpa >= 6) return bonus;

		// Base calculation - same logic as attack
		if (currentSpa === 0) {
			bonus += 10;
			if (moveId === 'nastyplot' || moveId === 'tailglow') bonus += 0;
		} else if (currentSpa === 2) {
			bonus += 5;
			if (moveId === 'nastyplot' || moveId === 'tailglow') bonus += 0;
		} else if (currentSpa === 4) {
			bonus += 2;
		}

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

		if (currentSpe >= 6) return bonus;

		// Speed boost is most valuable when we're currently slower
		if (!goesFirst) {
			if (currentSpe === 0) {
				bonus += 10; // First speed boost when slower is very valuable
			} else if (currentSpe === 2) {
				bonus += 5;
			} else if (currentSpe === 4) {
				bonus += 2;
			}

			ctx.adjustments.push({
				reason: `Speed boost to outspeed (spe: +${currentSpe}, HP: ${Math.floor(hpPercent)}%)`,
				amount: bonus,
				category: 'positive',
			});
		} else {
			// Already faster - less valuable, but Dragon Dance still has attack component
			if (currentSpe < 4) {
				bonus += 2;
			}
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
	const mixedDefBoostMoves = ['cosmicpower', 'defend order', 'stockpile'];

	let bonus = 0;

	// ==========================================================================
	// HP-based safety check
	// ==========================================================================
	const hpPercent = ctx.attacker.hpPercent;

	// Critical HP - don't setup defensively, probably need to attack or switch
	if (hpPercent <= 25) {
		return 0;
	}

	// Low HP - defensive setup has some merit (can stall for recovery)
	if (hpPercent <= 40) {
		bonus -= 3;
	}

	// ==========================================================================
	// Check bad idea conditions (CFRU: BadIdeaToRaiseStatAgainst)
	// ==========================================================================
	const targetAbility = toID(ctx.target.ability);

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
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		}) ?? true; // Default to assuming physical moves if unknown

		// Check if we have Body Press (uses defense for damage)
		const hasBodyPress = ctx.attacker.moves?.includes('bodypress') ?? false;

		if (targetHasPhysical) {
			// Good idea to raise defense against physical attacker
			if (currentDef === 0) {
				bonus += 8;
				if (moveId === 'cottonguard' || moveId === 'irondefense') bonus += 2; // +2/+3 moves
			} else if (currentDef === 2) {
				bonus += 5;
			} else if (currentDef === 4) {
				bonus += 2;
			}

			if (bonus > 0) {
				ctx.adjustments.push({
					reason: `Defense boost vs physical attacker (def: +${currentDef})`,
					amount: bonus,
					category: 'positive',
				});
			}
		} else if (hasBodyPress) {
			// Body Press user - defense boosts increase damage
			if (currentDef === 0) {
				bonus += 10; // Body Press makes defense boost very valuable
			} else if (currentDef === 2) {
				bonus += 7;
			} else if (currentDef === 4) {
				bonus += 4;
			}

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
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		}) ?? true; // Default to assuming special moves if unknown

		if (targetHasSpecial) {
			// Good idea to raise special defense against special attacker
			if (currentSpd === 0) {
				bonus += 8;
				if (moveId === 'amnesia') bonus += 2; // +2 move
			} else if (currentSpd === 2) {
				bonus += 5;
			} else if (currentSpd === 4) {
				bonus += 2;
			}

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
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Physical' && dexMove.basePower > 0;
		}) ?? true;

		const targetHasSpecial = ctx.target.moves?.some(m => {
			const dexMove = Dex.moves.get(m);
			return dexMove.category === 'Special' && dexMove.basePower > 0;
		}) ?? true;

		if (targetHasPhysical && currentDef < 6) {
			if (currentDef === 0) bonus += 6;
			else if (currentDef === 2) bonus += 4;
			else if (currentDef === 4) bonus += 2;
		}

		if (targetHasSpecial && currentSpd < 6) {
			if (currentSpd === 0) bonus += 6;
			else if (currentSpd === 2) bonus += 4;
			else if (currentSpd === 4) bonus += 2;
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
				if (mon.types.includes('Flying') || toID(mon.ability) === 'levitate') return false;
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
			if (mon.types.includes('Flying') || toID(mon.ability) === 'levitate') return false;
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
	const healthyReserves = ctx.state.self.reserve.filter(mon => !mon.fainted && mon.hpPercent > 50).length;
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

	// Drain moves that heal the user based on damage dealt
	const drainMoves = [
		'absorb', 'megadrain', 'gigadrain', // Grass drains
		'drainpunch', // Fighting drain
		'drainingkiss', // Fairy drain
		'leechlife', // Bug drain
		'hornleech', // Grass drain
		'paraboliccharge', // Electric drain
		'oblivionwing', // Flying drain (75% heal)
		'strengthsap', // Special case - heals based on target's attack
		'dreamdreater', // Ghost drain (only works on sleeping)
	];

	if (!drainMoves.includes(moveId)) return 0;

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
	const moveId = toID(ctx.move.id);
	const healingMoves = ['recover', 'softboiled', 'milkdrink', 'slackoff', 'roost',
		'synthesis', 'moonlight', 'morningsun', 'shoreup'];

	if (!healingMoves.includes(moveId)) return 0;

	let bonus = 0;

	// More valuable at low HP
	if (ctx.attacker.hpPercent <= 30) {
		bonus = 12;
		ctx.adjustments.push({
			reason: 'Healing at critical HP',
			amount: 12,
			category: 'positive',
		});
	} else if (ctx.attacker.hpPercent <= 50) {
		bonus = 8;
		ctx.adjustments.push({
			reason: 'Healing at low HP',
			amount: 8,
			category: 'positive',
		});
	} else if (ctx.attacker.hpPercent <= 70) {
		bonus = 4;
		ctx.adjustments.push({
			reason: 'Healing at moderate HP',
			amount: 4,
			category: 'positive',
		});
	}

	// Less valuable if opponent can OHKO anyway
	// Would need damage calc from opponent's perspective

	return bonus;
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
	if (toID(ctx.target.item) === 'mentalherb') {
		return 0;
	}

	// CFRU Logic: Check gLastUsedMoves[bankDef]
	// If opponent hasn't used a move yet, Disable has no value
	const lastMove = ctx.target.lastMove;
	if (!lastMove) {
		return 0;
	}

	let bonus = 0;
	const lastMoveData = Dex.moves.get(lastMove);
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
		const effectiveness = Dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[0]);
		const effectiveness2 = ctx.attacker.types[1]
			? Dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[1])
			: 0;

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

/**
 * Reward Encore when opponent used a status/setup move
 * Based on CFRU ai_positives.c EFFECT_ENCORE (lines 955-968)
 *
 * Encore forces opponent to repeat their last move.
 * IMPORTANT: Encore only works on the LAST MOVE USED, not based on their moveset.
 *
 * Key considerations from CFRU:
 * 1. Check gLastUsedMoves[bankDef] - must have used a move
 * 2. Most valuable when locking into STATUS moves
 * 3. Also good if locking into a move that DOESN'T AFFECT US (type immunity)
 * 4. If slower, use predictedMove instead (not implemented yet)
 */
export const rewardEncore: PositiveScoringFunction = (ctx) => {
	if (toID(ctx.move.id) !== 'encore') return 0;

	// Check if target already encored (would fail)
	if (ctx.target.volatiles.has('encore')) {
		return 0;
	}

	// Mental Herb would cure Encore
	if (toID(ctx.target.item) === 'mentalherb') {
		return 0;
	}

	// CFRU Logic: Check gLastUsedMoves[bankDef]
	// If opponent hasn't used a move yet, Encore has no value
	const lastMove = ctx.target.lastMove;
	if (!lastMove) {
		return 0;
	}

	let bonus = 0;
	const lastMoveData = Dex.moves.get(lastMove);
	const lastMoveIsStatus = lastMoveData.category === 'Status';

	// CFRU line 961-964: Check if last move is Status OR doesn't affect us
	// Calculate if move is immune against us
	let isImmune = false;
	if (lastMoveData.basePower > 0) {
		const effectiveness1 = Dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[0]);
		const effectiveness2 = ctx.attacker.types[1]
			? Dex.getEffectiveness(lastMoveData.type, ctx.attacker.types[1])
			: 0;
		// Check for type immunity (e.g., Ground vs Flying)
		if (effectiveness1 === -Infinity || effectiveness2 === -Infinity) {
			isImmune = true;
		}
		// Also check common type immunities
		const moveType = toID(lastMoveData.type);
		const attackerTypes = ctx.attacker.types.map(t => toID(t));
		if (moveType === 'ground' && attackerTypes.includes('flying')) isImmune = true;
		if (moveType === 'electric' && attackerTypes.includes('ground')) isImmune = true;
		if ((moveType === 'normal' || moveType === 'fighting') && attackerTypes.includes('ghost')) isImmune = true;
		if (moveType === 'ghost' && attackerTypes.includes('normal')) isImmune = true;
		if (moveType === 'psychic' && attackerTypes.includes('dark')) isImmune = true;
		if (moveType === 'dragon' && attackerTypes.includes('fairy')) isImmune = true;
		if (moveType === 'poison' && attackerTypes.includes('steel')) isImmune = true;
	}

	// If we're faster, we can encore before they can change moves
	if (ctx.flags.goesFirst) {
		// CFRU: Lock into status moves OR moves that don't affect us
		if (lastMoveIsStatus) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Encore opponent into status move (${lastMove})`,
				amount: 4,
				category: 'positive',
			});
		} else if (isImmune) {
			bonus += 4;
			ctx.adjustments.push({
				reason: `Encore opponent into immune move (${lastMove})`,
				amount: 4,
				category: 'positive',
			});
		}
	} else {
		// CFRU line 966-967: If slower, use predictedMove
		// Since we don't have prediction yet, we use a simpler heuristic:
		// If they just used a status move, locking them is still good
		if (lastMoveIsStatus) {
			bonus += 3;
			ctx.adjustments.push({
				reason: `Encore status move when slower (${lastMove})`,
				amount: 3,
				category: 'positive',
			});
		}
	}

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
		const dexMove = Dex.moves.get(m);
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

	const partnerAbility = toID(ctx.target.ability);
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
					const dexMove = Dex.moves.get(m);
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
					const dexMove = Dex.moves.get(m);
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
				const dexMove = Dex.moves.get(m);
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
					const dexMove = Dex.moves.get(m);
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
					const dexMove = Dex.moves.get(m);
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
	const spreadInfo = { isDoubles: true, numAliveTargets };

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
				if (ctx.flags.goesFirst) {
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
		const dexMove = Dex.moves.get(m);
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

	const abilityId = toID(ctx.attacker.ability);
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
		if (ctx.attacker.types.includes('Water') || ctx.attacker.moves.some(m => Dex.moves.get(m).type === 'Water')) {
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
		if (ctx.attacker.types.includes('Fire') || ctx.attacker.moves.some(m => Dex.moves.get(m).type === 'Fire')) {
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
	const attackerSpeed = ctx.attacker.baseStats.spe;
	const defenderSpeed = ctx.target.baseStats.spe;

	if (attackerSpeed < defenderSpeed) {
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

	let bonus = 0;
	const targetAbility = toID(ctx.target.ability);

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

	// Bonus if target lacks recovery
	const hasRecovery = ctx.target.moves.some(m => {
		return ['recover', 'softboiled', 'roost', 'slackoff', 'synthesis',
			'moonlight', 'morningsun', 'shoreup', 'rest'].includes(toID(m));
	});

	if (!hasRecovery) {
		bonus += 2;
		ctx.adjustments.push({
			reason: 'Target lacks recovery',
			amount: 2,
			category: 'positive',
		});
	}

	return bonus;
};

// =============================================================================
// Knock Off Reward
// =============================================================================

/**
 * Reward Knock Off for removing opponent's item
 * - Target has item (or unknown): +5
 * - Target has item AND is bulky: extra +3
 * - Target already lost item (itemLost = true): no bonus (negative scorer will apply -5)
 *
 * Note: itemLost is set to true when we see -enditem message.
 * If itemLost is false and item is empty, we assume they have an unknown item.
 */
export const rewardKnockOff: PositiveScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'knockoff') return 0;

	// If target's item is confirmed lost, no bonus
	if (ctx.target.itemLost) {
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
	rewardDrainMove,
	rewardPivotMove,
	rewardHealing,
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
