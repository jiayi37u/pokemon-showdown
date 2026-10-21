/**
 * CFRU AI - Negative Scoring Rules
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Negative scoring functions that reduce move viability.
 * Based on CFRU ai_negatives.c
 *
 * @license MIT
 */

import { toID } from '../../../../../sim/dex';
import type { ScoringContext, NegativeScoringFunction } from './index';
import { BASE_SCORE, DISCOURAGED_SCORE, type AIPokemon, type AIMove, type BattleState } from '../types';
import { getTypeEffectiveness, getMoveInteraction, resolveMove } from '../util/type-calc';
import { buildAIMove } from '../state-builder';
import { effectiveAbility, defensiveAbility, effectiveItem, grounded, rulesDex } from '../util/mechanics';
import {
	delayedMoveFailure, fieldEffectFailure, inflictedStatus, statusFailure, volatileEffectFailure,
	beneficialTargets, recoveryRecipients, recoveryCuresStatus, boostRecipients, boostChanges, boostsCanChange,
	recoveryKind, painSplitRecovery, mustSkipMove,
} from '../util/move-effects';
import { itemMoveFailure, itemRemovalFailure } from '../util/items';
import { compareActionOrder, compareSpeedOrder } from '../util/speed';
import { directRecoveryAmount, selfActionOutcome } from '../util/turn-outcome';
import { calculateDamage, willFaintFromSecondaryDamage } from '../util/damage-calc';
import { canHaveOpponentMoves, getOpponentMoveKnowledge, getOpponentThreatMoves } from '../util/opponent-presets';

/** Public attacks that can punish a status turn, with defensive boosts applied only after acting. */
export function statusTurnIncomingDamage(
	state: BattleState, attacker: AIPokemon, action: AIMove, beforeOnly = false, includeResidual = true
): number {
	const dex = rulesDex(state.field);
	const after = { ...attacker, boosts: { ...attacker.boosts } };
	const ability = effectiveAbility(attacker, state.field);
	const multiplier = ability === 'contrary' ? -1 : ability === 'simple' ? 2 : 1;
	for (const [stat, stages] of Object.entries(dex.moves.get(action.id).boosts || {})) {
		const key = stat as keyof typeof after.boosts;
		after.boosts[key] = Math.max(-6, Math.min(6, after.boosts[key] + stages * multiplier));
	}
	let total = 0;
	const foes = state.opponent.active.filter(p => !p.fainted);
	for (const foe of foes) {
		const knowledge = foe.moveKnowledge;
		const ids = knowledge ? [...knowledge.revealedMoves, ...knowledge.presetCandidates] :
			getOpponentThreatMoves(foe.species, foe.moves, state.field.formatId);
		if (mustSkipMove(foe, ids, state.field)) continue;
		let strongest = 0;
		for (const id of ids) {
			const move = buildAIMove({ id }, 1, state.field.formatId);
			if (move.category === 'Status' || ['suckerpunch', 'thunderclap'].includes(move.id)) continue;
			const first = compareActionOrder(attacker, foe, action, [move], state.field,
				state.self.conditions, state.opponent.conditions) > 0;
			if (beforeOnly && first) continue;
			const defender = first ? after : attacker;
			const spread = ['allAdjacent', 'allAdjacentFoes'].includes(move.target);
			const targets = state.self.active.filter(p => !p.fainted).length +
				(move.target === 'allAdjacent' ? state.opponent.active.filter(p => !p.fainted && p !== foe).length : 0);
			const damage = calculateDamage(foe, defender, move, state.field, undefined, {
				isDoubles: state.isDoubles, numAliveTargets: spread ? targets : 1,
				attackerSideConditions: state.opponent.conditions, defenderSideConditions: state.self.conditions,
				defenderAllies: state.self.active, activePokemon: [...state.self.active, ...state.opponent.active],
			});
			let incoming = damage.average;
			// A single ordinary hit cannot bypass an intact substitute or full-health survival item.
			// Multiple foes/hits can break that protection before the lethal hit, so retain their full threat.
			if (foes.length === 1 && !move.multihit && effectiveAbility(foe, state.field) !== 'parentalbond') {
				const bypasses = move.flags.bypasssub || dex.gen >= 6 && move.flags.sound ||
					dex.gen >= 6 && effectiveAbility(foe, state.field) === 'infiltrator';
				if (attacker.volatiles.has('substitute') && !bypasses) incoming = 0;
				const survival = effectiveItem(attacker, state.field) === 'focussash' || dex.gen >= 5 &&
					defensiveAbility(foe, attacker, move, state.field) === 'sturdy';
				if (survival && attacker.hp === attacker.maxHp && action.id !== 'bellydrum') {
					incoming = Math.min(incoming, attacker.hp - 1);
				}
			}
			strongest = Math.max(strongest, incoming);
		}
		total += strongest;
	}
	const remaining = attacker.hp - total;
	const survivor = { ...attacker, hp: remaining, hpPercent: remaining / attacker.maxHp * 100 };
	if (includeResidual && remaining > 0 && willFaintFromSecondaryDamage(survivor, state.field.weather,
		foes[0] ? effectiveAbility(foes[0], state.field) : '', state.field)) return attacker.hp;
	return total;
}

/** A spin's clearing utility exists only after a successful hit, independently of its damage. */
export function spinClearingBenefit(ctx: ScoringContext): number {
	if (!['rapidspin', 'mortalspin'].includes(ctx.move.id) || ctx.flags.hasNoEffect || ctx.flags.isImmune ||
		!ctx.damageResult?.max) return 0;
	const { state, attacker, target } = ctx;
	const ability = effectiveAbility(attacker, state.field);
	const data = ctx.dex.moves.get(ctx.move.id);
	if (ability === 'sheerforce' && (data.secondary || data.secondaries)) return 0;
	if (ctx.move.flags.contact && ability !== 'magicguard' && ability !== 'longreach' &&
		effectiveItem(attacker, state.field) !== 'protectivepads' && !target.volatiles.has('substitute')) {
		const recoil = (effectiveItem(target, state.field) === 'rockyhelmet' ? Math.floor(attacker.maxHp / 6) : 0) +
			(['roughskin', 'ironbarbs'].includes(effectiveAbility(target, state.field)) ? Math.floor(attacker.maxHp / 8) : 0);
		if (recoil >= attacker.hp) return 0;
	}
	const own = state.self.conditions;
	let saved = 0;
	for (const mon of state.self.reserve.filter(p => !p.fainted)) {
		if (effectiveItem(mon, state.field) === 'heavydutyboots') continue;
		const monAbility = effectiveAbility(mon, state.field);
		const magicGuard = monAbility === 'magicguard';
		if (!magicGuard && own.stealthrock) saved += 12.5 * getTypeEffectiveness('Rock', mon.types);
		if (!grounded(mon, state.field)) continue;
		if (!magicGuard && own.spikes) saved += 100 / (own.spikes === 1 ? 8 : own.spikes === 2 ? 6 : 4);
		if (own.toxicspikes && !mon.status && !mon.types.some(type => ['Poison', 'Steel'].includes(type)) &&
			!['immunity', 'pastelveil', 'poisonheal', 'magicguard'].includes(monAbility)) saved += 10;
		if (own.stickyweb && !['contrary', 'clearbody', 'whitesmoke', 'fullmetalbody'].includes(monAbility) &&
			effectiveItem(mon, state.field) !== 'clearamulet') saved += 10;
	}
	const releases = ability !== 'magicguard' && attacker.volatiles.has('leechseed') ||
		attacker.volatiles.has('partiallytrapped');
	return (saved ? 12 + Math.min(18, Math.floor(saved / 5)) : 0) + (releases ? 8 : 0);
}

/** A legal but discouraged choice must not recover its baseline through unrelated rewards. */
function discourageMove(ctx: ScoringContext, reason: string): number {
	ctx.skipPositiveScoring = true;
	ctx.flags.discouraged = true;
	const amount = Math.min(0, DISCOURAGED_SCORE - (ctx.score ?? BASE_SCORE));
	ctx.adjustments.push({ reason, amount, category: 'negative' });
	return amount;
}

/** Conservative opportunities for attacks that depend on the opponent's action. */
export const checkConditionalAttack: NegativeScoringFunction = ctx => {
	if (ctx.move.id === 'focuspunch') {
		if (ctx.attacker.volatiles.has('substitute') || ctx.target.status === 'slp') return 0;
		return discourageMove(ctx, 'Focus Punch needs our substitute or a sleeping target');
	}
	if (!['suckerpunch', 'thunderclap'].includes(ctx.move.id)) return 0;
	const side = ctx.isTargetingPartner ? ctx.state.self : ctx.state.opponent;
	const slower = compareSpeedOrder(ctx.attacker, ctx.target, ctx.state.field,
		ctx.state.self.conditions, side.conditions) < 0;
	const last = ctx.dex.moves.get(ctx.target.lastMove || '');
	if (slower && last.exists && last.category !== 'Status') return 0;
	return discourageMove(ctx, 'Conditional priority needs a faster target whose last move was an attack');
};

/** Conservative opportunities for setup and utility moves, separate from confirmed failures. */
export const checkStatusOpportunity: NegativeScoringFunction = ctx => {
	if (ctx.move.category !== 'Status') return 0;
	const data = ctx.dex.moves.get(ctx.move.id);
	// Healing and field-clearing moves retain their independent purpose at low HP.
	const setup = data.target === 'self' && !recoveryKind(ctx.move, ctx.state.field) && data.id !== 'tidyup' &&
		(data.boosts && Object.values(data.boosts).some(stages => stages > 0) ||
			['bellydrum', 'stockpile'].includes(data.id));
	const nonGhostCurse = data.id === 'curse' && !ctx.attacker.types.includes('Ghost');
	if ((setup || nonGhostCurse) && ctx.attacker.hpPercent <= 40) {
		return discourageMove(ctx, 'Setup discouraged at 40% HP or less');
	}
	if ((setup || nonGhostCurse) && statusTurnIncomingDamage(ctx.state, ctx.attacker, ctx.move) >= ctx.attacker.hp -
		(data.id === 'bellydrum' ? Math.floor(ctx.attacker.maxHp / 2) : 0)) {
		return discourageMove(ctx, 'Setup cannot survive the available opposing attacks');
	}
	if (setup && data.boosts) {
		const raised = Object.entries(data.boosts).filter(([, stages]) => stages > 0).map(([stat]) => stat);
		const indirectBenefit = ctx.attacker.moves.some(id => ['storedpower', 'powertrip', 'batonpass'].includes(toID(id)));
		const foes = ctx.state.opponent.active.filter(p => !p.fainted);
		if (!indirectBenefit && raised.length &&
			raised.every(stat => ['atk', 'def', 'spa', 'spd', 'accuracy', 'evasion'].includes(stat)) &&
			foes.length && foes.every(p => effectiveAbility(p, ctx.state.field) === 'unaware' &&
				ctx.attacker.moves.every(id => {
					const move = ctx.dex.moves.get(id);
					return move.category === 'Status' || defensiveAbility(ctx.attacker, p, move, ctx.state.field) === 'unaware';
				}))) {
			return discourageMove(ctx, 'Unaware ignores the useful stat boosts in this matchup');
		}
		if (!indirectBenefit && raised.length && raised.every(stat => stat === 'spe') &&
			(ctx.state.field.trickroom || compareSpeedOrder(ctx.attacker, ctx.target, ctx.state.field,
				ctx.state.self.conditions, ctx.state.opponent.conditions) > 0)) {
			return discourageMove(ctx, 'Speed-only setup cannot improve the current speed order');
		}
		if (!indirectBenefit && raised.length && raised.every(stat => stat === 'atk' || stat === 'spa')) {
			const usableAttack = ctx.attacker.moves.some(id => {
				const move = ctx.dex.moves.get(id);
				// Called attacks can use different stats; do not assume they have no benefit.
				if (['naturepower', 'metronome', 'copycat', 'assist', 'mirrormove'].includes(move.id)) return true;
				if (move.category === 'Status' || move.damage || move.damageCallback || move.ohko ||
					move.overrideOffensivePokemon === 'target') return false;
				// Every active foe must ignore this boost before we discard its offensive value.
				if (ctx.state.opponent.active.filter(p => !p.fainted).every(p =>
					defensiveAbility(ctx.attacker, p, move, ctx.state.field) === 'unaware')) {
					return false;
				}
				const resolved = resolveMove(ctx.attacker, buildAIMove({ id }, 1, ctx.state.field.formatId),
					ctx.state.field, ctx.target);
				const stat = move.overrideOffensiveStat || (resolved.category === 'Physical' ? 'atk' : 'spa');
				return raised.some(raisedStat => raisedStat === stat);
			});
			if (!usableAttack) return discourageMove(ctx, 'No attack benefits from the offensive boost');
		}
	}
	if (['disable', 'taunt'].includes(data.id) && ctx.dex.gen >= 5 &&
		effectiveItem(ctx.target, ctx.state.field) === 'mentalherb') {
		return discourageMove(ctx, 'Mental Herb would immediately cure the disruption');
	}
	if (data.id === 'disable' && !ctx.target.lastMove) {
		return discourageMove(ctx, 'Disable has no observed last move to target');
	}
	if (data.id === 'taunt') {
		const knowledge = ctx.target.moveKnowledge ||
			getOpponentMoveKnowledge(ctx.target.species, ctx.target.moves, ctx.config.formatId);
		if (!knowledge.remainingSlots && knowledge.revealedMoves.every(id => ctx.dex.moves.get(id).category !== 'Status')) {
			return discourageMove(ctx, 'All revealed move slots are attacks; Taunt has no known benefit');
		}
	}
	if (data.id === 'helpinghand') {
		const partner = ctx.state.self.active.find(mon => mon.slot !== ctx.attacker.slot && !mon.fainted);
		if (partner?.moves.length && partner.moves.every(id => {
			const move = ctx.dex.moves.get(id);
			if (['naturepower', 'metronome', 'copycat', 'assist', 'mirrormove', 'sleeptalk'].includes(move.id)) return false;
			return move.category === 'Status' || !!(move.damage || move.damageCallback || move.ohko);
		})) return discourageMove(ctx, 'Helping Hand has no partner attack to amplify');
	}
	return 0;
};

/** Legal utility moves need a concrete benefit; their failure checks remain independent. */
export const checkUtilityOpportunity: NegativeScoringFunction = ctx => {
	const { state, attacker, move } = ctx;
	if (['healingwish', 'lunardance'].includes(move.id)) {
		const reserves = state.self.reserve.filter(p => !p.fainted);
		if (!reserves.length) {
			ctx.flags.hasNoEffect = true;
			ctx.adjustments.push({
				reason: 'No replacement can receive the sacrificial healing', amount: -100, category: 'negative',
			});
			return -100;
		}
		const patient = reserves.some(p => p.hpPercent < 75 || p.status &&
			!['guts', 'poisonheal', 'quickfeet'].includes(effectiveAbility(p, state.field)));
		if (!patient) return discourageMove(ctx, 'No reserve needs enough healing to justify the sacrifice');
		if (attacker.hpPercent > 80 && !attacker.status && statusTurnIncomingDamage(state, attacker, move) < attacker.hp) {
			return discourageMove(ctx, 'Preserve a healthy supporter instead of sacrificing it');
		}
	}
	if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(move.id) &&
		state.opponent.remaining !== undefined &&
		state.opponent.remaining <= state.opponent.active.filter(p => !p.fainted).length) {
		return discourageMove(ctx, 'No opposing reserve remains to hit entry hazards');
	}
	if (move.id === 'substitute' && !attacker.volatiles.has('substitute') &&
		statusTurnIncomingDamage(state, attacker, move, true, false) + Math.floor(attacker.maxHp / 4) >= attacker.hp) {
		return discourageMove(ctx, 'Cannot survive to pay the HP cost before acting');
	}
	if (move.id === 'substitute' && !attacker.volatiles.has('substitute') &&
		state.self.conditions.wishes?.[attacker.slot] !== 1) {
		const hp = attacker.hp - Math.floor(attacker.maxHp / 4);
		if (hp > 0 && willFaintFromSecondaryDamage({ ...attacker, hp, hpPercent: hp / attacker.maxHp * 100 },
			state.field.weather, effectiveAbility(ctx.target, state.field), state.field)) {
			return discourageMove(ctx, 'Substitute leaves insufficient HP for residual damage');
		}
	}
	if (move.id === 'defog') {
		const own = state.self.conditions;
		const other = state.opponent.conditions;
		const clears = own.stealthrock || own.spikes || own.toxicspikes || own.stickyweb ||
			other.reflect || other.lightscreen || other.auroraveil || other.safeguard || other.mist ||
			(ctx.dex.gen >= 8 && state.field.terrain);
		if (!clears && ctx.target.boosts.evasion <= 0) {
			return discourageMove(ctx, 'Defog has no clearing benefit or boosted evasion to remove');
		}
	}
	return 0;
};

// =============================================================================
// Type and Ability Immunity Checks
// =============================================================================

/** Confirmed failures and immunities use the same rule result as damage and switching. */
export const checkMoveImmunity: NegativeScoringFunction = ctx => {
	const result = getMoveInteraction(ctx.attacker, ctx.target, ctx.move, ctx.state.field, {
		isAllyTarget: ctx.isTargetingPartner,
		activePokemon: [...ctx.state.self.active, ...ctx.state.opponent.active],
		defenderAllies: (ctx.isTargetingPartner ? ctx.state.self : ctx.state.opponent).active,
	});
	if (!result.blockedBy) return 0;
	ctx.flags.isImmune = !result.failed;
	ctx.flags.hasNoEffect = true;
	ctx.adjustments.push({ reason: result.blockedBy, amount: -100, category: 'negative' });
	return -100;
};

export const checkFieldEffect: NegativeScoringFunction = ctx => {
	const failure = fieldEffectFailure(ctx.state, ctx.attacker, ctx.move);
	if (!failure) return 0;
	ctx.flags.hasNoEffect = true;
	ctx.adjustments.push({ reason: failure, amount: -100, category: 'negative' });
	return -100;
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
	if (ctx.damageResult && ctx.damageResult.average >= ctx.target.hp) return 0;

	const effectiveness = ctx.damageResult?.effectiveness ??
		getTypeEffectiveness(ctx.move.type, ctx.target.types, ctx.cache);

	// Only penalize resisted moves (effectiveness < 1, but not immune)
	if (effectiveness === 0) return 0; // Immunity handled by checkMoveImmunity

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
	if (ctx.damageResult.average >= ctx.target.hp || spinClearingBenefit(ctx) > 0) return 0;

	const damagePercent = ctx.damageResult.averagePercent;

	// Only penalize if below the threshold where rewardHighDamage kicks in
	// This avoids double-penalizing already penalized immune/resisted moves
	if (ctx.flags.isImmune || ctx.flags.hasNoEffect) return 0;
	// Guaranteed, eligible status gives weak attacks an independent purpose.
	const data = ctx.dex.moves.get(ctx.move.id);
	const secondaries = data.secondaries || (data.secondary ? [data.secondary] : []);
	if (secondaries.some(effect => effect.chance === 100 && effect.status &&
		!statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move, effect.status))) return 0;

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
 * Check for Covert Cloak blocking secondary effects
 * Covert Cloak prevents additional effects from damaging moves
 */
export const checkCovertCloak: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const itemId = effectiveItem(ctx.target, ctx.state.field);
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
 * Check for abilities that boost stats when hit
 */
export const checkStatBoostOnHit: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category === 'Status') return 0;

	const abilityId = effectiveAbility(ctx.target, ctx.state.field);
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
 * Check for Mirror Armor reflecting stat drops
 * CFRU: ai_negatives.c lines 394-401
 */
export const checkMirrorArmor: NegativeScoringFunction = (ctx) => {
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = effectiveAbility(ctx.target, ctx.state.field);

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
	const abilityId = effectiveAbility(ctx.target, ctx.state.field);

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
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

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
	const abilityId = effectiveAbility(ctx.target, ctx.state.field);

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
 * Check for Wonder Skin reducing status move accuracy
 * CFRU: ai_negatives.c lines 487-490
 * Note: This doesn't fully block but makes status less reliable
 */
export const checkWonderSkin: NegativeScoringFunction = (ctx) => {
	const abilityId = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

	if (abilityId !== 'wonderskin') return 0;

	// Wonder Skin caps status move accuracy at 50%.
	if (ctx.move.category === 'Status' && ctx.move.accuracy !== true && ctx.move.accuracy > 50) {
		ctx.adjustments.push({
			reason: 'Wonder Skin caps status move accuracy at 50%',
			amount: -5,
			category: 'negative',
		});
		return -5;
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
		'mirrorshot', 'mudshot', 'octazooka',
		// Evasion lowering
		'sweetscent', 'defog',
	];

	return statLoweringMoves.includes(moveId);
}

// =============================================================================
// Status Move Checks
// =============================================================================

/** Only pure status moves can be wholly invalidated by failure to inflict status. */
export const checkStatusMove: NegativeScoringFunction = ctx => {
	if (ctx.move.category !== 'Status') return 0;
	const status = inflictedStatus(ctx.move, ctx.state, ctx.attacker);
	const failure = statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move, status);
	if (failure) {
		const boosts = rulesDex(ctx.state.field).moves.get(ctx.move.id).boosts;
		if (boosts && Object.entries(boosts).some(([stat, value]) =>
			(value || 0) > 0 && ctx.target.boosts[stat as keyof typeof ctx.target.boosts] < 6)) {
			ctx.adjustments.push({ reason: `${failure}; stat boost can still apply`, amount: -10, category: 'negative' });
			return -10;
		}
		ctx.flags.hasNoEffect = true;
		ctx.adjustments.push({ reason: failure, amount: -100, category: 'negative' });
		return -100;
	}
	if (['brn', 'psn', 'tox'].includes(status) && effectiveAbility(ctx.target, ctx.state.field) === 'magicguard' &&
		!(status !== 'brn' && ctx.attacker.moves.some(m => toID(m) === 'venoshock'))) {
		ctx.adjustments.push({
			reason: `Magic Guard prevents ${status === 'brn' ? 'burn' : 'poison'} damage`, amount: -10, category: 'negative',
		});
		return -10;
	}
	return 0;
};

/** Team status cures fail when no living teammate has a status condition. */
export const checkTeamStatusCure: NegativeScoringFunction = ctx => {
	if (!['aromatherapy', 'healbell'].includes(toID(ctx.move.id))) return 0;
	if (ctx.state.self.team.some(mon => !mon.fainted && mon.status && mon.status !== 'fnt')) return 0;

	ctx.adjustments.push({
		reason: `${ctx.move.name} fails: no teammate has a status condition`,
		amount: -100,
		category: 'negative',
	});
	ctx.flags.hasNoEffect = true;
	return -100;
};

// =============================================================================
// Setup Move Checks
// =============================================================================

/** Shared field-wide Haze value; independent of the selected target. */
export function getHazeBenefit(ctx: ScoringContext): { net: number, hasChanges: boolean, reason: string } {
	const stageValues = [0, 5, 20, 28, 36, 44, 52];
	let enemyBoosts = 0;
	let allyDrops = 0;
	let allyBoosts = 0;
	let enemyDrops = 0;
	for (const side of ['self', 'opponent'] as const) {
		for (const pokemon of ctx.state[side].active) {
			if (pokemon.fainted) continue;
			for (const stage of Object.values(pokemon.boosts)) {
				const value = stageValues[Math.abs(stage)];
				if (side === 'self') {
					if (stage > 0) allyBoosts += value;
					else allyDrops += value;
				} else {
					if (stage > 0) enemyBoosts += value;
					else enemyDrops += value;
				}
			}
		}
	}
	return {
		net: enemyBoosts + allyDrops - allyBoosts - enemyDrops,
		hasChanges: enemyBoosts + allyDrops + allyBoosts + enemyDrops > 0,
		reason: `enemy boosts +${enemyBoosts}, ally drops +${allyDrops}, ally boosts -${allyBoosts}, enemy drops -${enemyDrops}`,
	};
}

/** Penalize wasted Haze and the turn spent resetting the field. */
export const checkHaze: NegativeScoringFunction = ctx => {
	if (ctx.move.id !== 'haze') return 0;
	const { net, hasChanges, reason } = getHazeBenefit(ctx);
	if (net <= 0) {
		return discourageMove(ctx, hasChanges ? `Haze: no net benefit (${reason})` : 'Haze: no stat changes to clear');
	}
	ctx.adjustments.push({ reason: 'Haze: turn cost', amount: -20, category: 'negative' });
	return -20;
};

/**
 * Check if stat boost move is wasted
 */
export const checkStatBoostWasted: NegativeScoringFunction = (ctx) => {
	if (ctx.move.category !== 'Status') return 0;

	const data = ctx.dex.moves.get(ctx.move.id);
	const recipientBoosts = boostChanges(ctx.move, ctx.state);
	if (recipientBoosts && (['gearup', 'magneticflux', 'acupressure', 'decorate', 'coaching'].includes(ctx.move.id) ||
		['adjacentAlly', 'adjacentAllyOrSelf'].includes(data.target))) {
		const recipients = boostRecipients(ctx.state, ctx.attacker, ctx.target, ctx.move);
		if (!recipients.some(p => boostsCanChange(p, recipientBoosts, ctx.state))) {
			ctx.flags.hasNoEffect = true;
			ctx.adjustments.push({ reason: 'No recipient can receive these stat changes', amount: -100, category: 'negative' });
			return -100;
		}
		if (recipients.every(p => effectiveAbility(p, ctx.state.field) === 'contrary')) {
			return discourageMove(ctx, 'Contrary turns beneficial boosts into stat drops');
		}
	}
	if (data.target !== 'self' || !data.boosts) return 0;
	const ability = effectiveAbility(ctx.attacker, ctx.state.field);
	const multiplier = ability === 'contrary' ? -1 : ability === 'simple' ? 2 : 1;
	const boosts = Object.entries(data.boosts).map(([stat, stages]) => ({
		stat: stat as keyof typeof ctx.attacker.boosts,
		stages: stages * multiplier * (data.id === 'growth' && ctx.dex.gen >= 5 && ctx.state.field.weather === 'sun' ? 2 : 1),
	}));
	const improvements = boosts.filter(boost => boost.stages > 0);
	const usable = improvements.filter(boost => ctx.attacker.boosts[boost.stat] < 6);
	// Moves with additional effects must not be declared useless just because their boosts are capped.
	const otherEffects = data.onHit || data.onTryHit || data.onAfterHit || data.onAfterMove ||
		data.volatileStatus || recoveryKind(ctx.move, ctx.state.field) || data.sideCondition || data.weather || data.terrain;
	if (!usable.length && !otherEffects) {
		ctx.skipPositiveScoring = true;
		ctx.flags.hasNoEffect = boosts.every(boost => {
			const current = ctx.attacker.boosts[boost.stat];
			return boost.stages > 0 ? current >= 6 : current <= -6;
		});
		if (!ctx.flags.hasNoEffect) return discourageMove(ctx, 'No useful stat increase remains');
		ctx.adjustments.push({ reason: 'No useful stat increase remains', amount: -100, category: 'negative' });
		return -100;
	}
	let totalPenalty = 0;
	for (const boost of improvements) {
		const current = ctx.attacker.boosts[boost.stat];
		const wasted = Math.max(0, current + boost.stages - 6);
		const penalty = wasted ? -5 * wasted : current >= 4 ? -5 : 0;
		if (!penalty) continue;
		ctx.adjustments.push({
			reason: `Diminishing ${boost.stat} boost at +${current}`, amount: penalty, category: 'negative',
		});
		totalPenalty += penalty;
	}

	// Choice item locks prevent setup
	const itemId = effectiveItem(ctx.attacker, ctx.state.field);
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
// Magic Bounce / Magic Coat Check
// =============================================================================

/**
 * Check if move will be bounced by Magic Bounce
 * Magic Bounce reflects moves with the 'reflectable' flag (same as Magic Coat)
 * This matches CFRU's FLAG_MAGIC_COAT_AFFECTED check
 */
export const checkMagicBounce: NegativeScoringFunction = (ctx) => {
	const targetAbility = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

	// Use the effective known or estimated ability, including Mold Breaker and suppression.
	if (targetAbility !== 'magicbounce') {
		return 0;
	}

	// Use the 'reflectable' flag - same approach as CFRU's FLAG_MAGIC_COAT_AFFECTED
	// This automatically covers all moves that can be bounced by Magic Coat/Magic Bounce
	if (ctx.move.flags['reflectable']) {
		return discourageMove(ctx, 'Magic Bounce will reflect this move');
	}

	return 0;
};

// =============================================================================
// Special Move Checks
// =============================================================================

/**
 * Check if absorb/drain moves will hurt due to Liquid Ooze
 * CFRU: ai_negatives.c lines 784-785
 */
export const checkLiquidOoze: NegativeScoringFunction = (ctx) => {
	const targetAbility = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);

	if (targetAbility !== 'liquidooze') return 0;

	if (recoveryKind(ctx.move, ctx.state.field) === 'drain') {
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

	const targetAbility = defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field);
	const owner = ctx.target.ownerSide;
	const remaining = owner ? ctx.state.opponent.remainingByOwner?.[owner] : ctx.state.opponent.remaining;
	const active = ctx.state.opponent.active.filter(p => !p.fainted && (!owner || p.ownerSide === owner)).length;
	const noReserve = remaining !== undefined && remaining <= active;
	const reason = targetAbility === 'suctioncups' ? 'Suction Cups prevents phazing' :
		ctx.target.volatiles.has('ingrain') ? 'Ingrain prevents phazing' :
		noReserve ? "No reserve in the target owner's party" : '';
	if (reason) {
		const amount = ctx.move.category === 'Status' ? -100 : -10;
		ctx.flags.hasNoEffect = ctx.move.category === 'Status';
		ctx.adjustments.push({ reason, amount, category: 'negative' });
		return amount;
	}

	if (ctx.move.category === 'Status') {
		const hazards = ctx.state.opponent.conditions;
		const boosted = Object.values(ctx.target.boosts).some(stage => stage > 0);
		if (!boosted && !(hazards.stealthrock || hazards.spikes || hazards.toxicspikes || hazards.stickyweb)) {
			return discourageMove(ctx, 'Phazing has no boosts to remove or entry hazards to exploit');
		}
	}

	return 0;
};

export const checkVolatileEffect: NegativeScoringFunction = ctx => {
	const failure = volatileEffectFailure(ctx.state, ctx.attacker, ctx.target, ctx.move);
	if (failure) {
		ctx.flags.hasNoEffect = true;
		ctx.adjustments.push({ reason: failure, amount: -100, category: 'negative' });
		return -100;
	}
	if (ctx.move.id === 'leechseed' &&
		defensiveAbility(ctx.attacker, ctx.target, ctx.move, ctx.state.field) === 'liquidooze') {
		ctx.adjustments.push({ reason: 'Liquid Ooze will damage user from Leech Seed', amount: -10, category: 'negative' });
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
		return -10;
	}

	// Magic Guard prevents all residual damage
	const targetAbility = effectiveAbility(ctx.target, ctx.state.field);
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
		const amount = Math.min(0, DISCOURAGED_SCORE - ctx.score);
		ctx.adjustments.push({ reason: 'Encore needs a useful interruption opportunity', amount, category: 'negative' });
		return amount;
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

	if (ctx.dex.moves.get(moveId).selfdestruct && !ctx.flags.canKO && ctx.attacker.hpPercent > 50) {
		return discourageMove(ctx, 'Sacrificing a healthy user without a KO is wasteful');
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
	if (!['counter', 'mirrorcoat', 'metalburst'].includes(moveId)) return 0;
	const knowledge = ctx.target.moveKnowledge ||
		getOpponentMoveKnowledge(ctx.target.species, ctx.target.moves, ctx.config.formatId);
	const possibleMoves = [...ctx.target.moves, ...knowledge.revealedMoves,
		...knowledge.presetCandidates.filter(id => canHaveOpponentMoves(knowledge, [id]))];
	const slots = knowledge.revealedMoves.length + knowledge.remainingSlots;
	const complete = knowledge.remainingSlots === 0 || (knowledge.slots?.length || 0) >= slots ||
		!!knowledge.movePools?.length && knowledge.movePools.every(pool => pool.length >= slots);
	const canUseCategory = (category: string) => !complete || possibleMoves.some(id => {
		const move = ctx.dex.moves.get(id);
		return move.exists && move.category === category;
	});

	// Counter - only works against physical moves
	if (moveId === 'counter') {
		if (!canUseCategory('Physical')) {
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
		if (!canUseCategory('Special')) {
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
 * Contrary lowers Attack instead and is discouraged rather than treated as a failed move.
 */
export const checkBellyDrum: NegativeScoringFunction = (ctx) => {
	const moveId = toID(ctx.move.id);

	if (moveId !== 'bellydrum') return 0;

	if (ctx.attacker.boosts.atk >= 6) {
		ctx.flags.hasNoEffect = true;
		ctx.adjustments.push({ reason: 'Belly Drum fails at maximum Attack', amount: -100, category: 'negative' });
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

	if (effectiveAbility(ctx.attacker, ctx.state.field) === 'contrary') {
		return discourageMove(ctx, 'Contrary will lower Attack instead of raising');
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
 * Consecutive use receives the shared discouraged score.
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
	if (ctx.state.self.conditions.wishes?.[ctx.attacker.slot] !== 1 &&
		willFaintFromSecondaryDamage(ctx.attacker, ctx.state.field.weather,
			effectiveAbility(ctx.target, ctx.state.field), ctx.state.field)) {
		return discourageMove(ctx, 'Protection cannot prevent lethal residual damage');
	}

	// Check if last move was a Protect-type move
	const lastMoveId = ctx.attacker.lastMove;
	const lastMoveWasProtect = protectMoves.includes(lastMoveId);

	if (!lastMoveWasProtect) return 0;

	return discourageMove(ctx, 'Consecutive Protect usage (likely to fail)');
};

/** Normal uses the strongest public attack; Hard evaluates weighted response branches instead. */
export const checkRecoverySurvival: NegativeScoringFunction = ctx => {
	const recipients = recoveryRecipients(ctx.state, ctx.attacker, ctx.target, ctx.move);
	if (directRecoveryAmount(ctx.attacker, ctx.move, ctx.state.field) && recipients.includes(ctx.attacker)) {
		const before = statusTurnIncomingDamage(ctx.state, ctx.attacker, ctx.move, true, false);
		const total = statusTurnIncomingDamage(ctx.state, ctx.attacker, ctx.move, false, false);
		const outcome = selfActionOutcome(ctx.attacker, ctx.move, ctx.state.field, before,
			Math.max(0, total - before), effectiveAbility(ctx.target, ctx.state.field));
		if (!outcome.acted || outcome.endHp <= 0) {
			return discourageMove(ctx, 'Recovery cannot keep the user alive through the turn');
		}
	}
	return 0;
};

/**
 * Check if healing is unnecessary
 */
export const checkHealingUnnecessary: NegativeScoringFunction = (ctx) => {
	const recipients = recoveryRecipients(ctx.state, ctx.attacker, ctx.target, ctx.move);
	if (!recipients.length) return 0;
	if (recoveryCuresStatus(ctx.move) && recipients.some(p => p.status)) return 0;
	const hp = Math.min(...recipients.map(p => p.hpPercent));
	if (hp > 80) return discourageMove(ctx, 'Healing unnecessary: recipients have high HP');
	const amount = hp > 70 ? -5 : hp > 60 ? -2 : 0;
	if (amount) {
		ctx.adjustments.push({ reason: 'Healing less effective at moderate HP', amount, category: 'negative' });
		return amount;
	}

	// Whether the user wakes before acting belongs to the shared sleep gate.
	return 0;
};

/**
 * Gate moves by publicly confirmed sleep and wake turns.
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

	if (moveId !== 'sleeptalk' && moveId !== 'snore') {
		if (ctx.attacker.status === 'slp' && (ctx.attacker.sleepTurns || 0) > 1 &&
			!ctx.dex.moves.get(moveId).sleepUsable) {
			ctx.adjustments.push({ reason: 'Cannot use this move during confirmed sleep', amount: -100, category: 'negative' });
			ctx.flags.hasNoEffect = true;
			return -100;
		}
		return 0;
	}

	const attackerAbility = effectiveAbility(ctx.attacker, ctx.state.field);

	// Comatose always counts as asleep - move will work
	if (attackerAbility === 'comatose') return 0;

	// Not asleep - move will fail
	if (ctx.attacker.status !== 'slp') {
		ctx.adjustments.push({
			reason: `${ctx.move.name} fails when not asleep`,
			amount: -100,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -100;
	}

	// Last turn of sleep (sleepTurns === 1) - will wake up before move executes
	// Note: In PS, sleepTurns counts down, so 1 means this is the last turn
	if (ctx.attacker.sleepTurns === 1) {
		ctx.adjustments.push({
			reason: `${ctx.move.name} fails on last turn of sleep (will wake first)`,
			amount: -100,
			category: 'negative',
		});
		ctx.flags.hasNoEffect = true;
		return -100;
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

	const targetAbility = effectiveAbility(ctx.target, ctx.state.field);
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

	if (goodPartnerMoves.includes(moveId) || beneficialTargets(ctx.state, ctx.attacker, ctx.move)?.includes(ctx.target)) {
		return 0; // Don't penalize
	}

	if (recoveryRecipients(ctx.state, ctx.attacker, ctx.target, ctx.move).length) return 0;

	// Status moves that hurt partner - big penalty
	const badPartnerMoves = [
		'thunderwave', 'stunspore', 'glare', 'nuzzle', // Paralysis
		'willowisp', // Burn
		'toxic', 'poisonpowder', 'poisongas', // Poison
		'spore', 'sleeppowder', 'hypnosis', 'sing', 'yawn', // Sleep
		'confuseray', 'swagger', 'flatter', // Confusion
	];

	if (badPartnerMoves.includes(moveId)) {
		return discourageMove(ctx, 'Using harmful status move on partner');
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
			return discourageMove(ctx, 'Lowering partner stats');
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

	const numAliveOpponents = ctx.state.opponent.active.filter(p => !p.fainted).length;
	const numAlivePartners = ctx.state.self.active.filter(p => p !== ctx.attacker && !p.fainted).length;
	const partnerDamage = calculateDamage(ctx.attacker, ctx.partner, ctx.move, ctx.state.field, ctx.cache, {
		isDoubles: true, numAliveTargets: numAliveOpponents + numAlivePartners,
		isAllyTarget: true, defenderAllies: ctx.state.self.active,
		activePokemon: [...ctx.state.self.active, ...ctx.state.opponent.active],
		attackerSideConditions: ctx.state.self.conditions, defenderSideConditions: ctx.state.self.conditions,
	});

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

	const attackerAbility = effectiveAbility(ctx.attacker, ctx.state.field);
	const targetAbility = effectiveAbility(ctx.target, ctx.state.field);
	const targetItem = effectiveItem(ctx.target, ctx.state.field);

	// Magic Guard user doesn't care about recoil damage
	const hasMagicGuard = attackerAbility === 'magicguard';

	let penalty = 0;

	// Effect Spore - 30% chance of Sleep/Paralysis/Poison
	if (targetAbility === 'effectspore') {
		// Only risky if not immune to status
		if (!ctx.attacker.status && !['overcoat'].includes(attackerAbility) &&
			effectiveItem(ctx.attacker, ctx.state.field) !== 'safetygoggles') {
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
	if (effectiveItem(ctx.attacker, ctx.state.field) === 'protectivepads') {
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

/** Pain Split value is based on the user's capped HP change, not either side's HP percentage alone. */
export function painSplitValue(ctx: ScoringContext): { score: number, reason: string } {
	const recovered = painSplitRecovery(ctx.attacker, ctx.target);
	const percent = recovered / ctx.attacker.maxHp * 100;
	return {
		score: percent <= 0 ? DISCOURAGED_SCORE : percent < 10 ? 80 : percent < 25 ? 100 : percent < 50 ? 110 : 120,
		reason: `Pain Split HP change: ${recovered >= 0 ? '+' : ''}${recovered} (${percent.toFixed(1)}% of max HP)`,
	};
}

export const checkPainSplit: NegativeScoringFunction = ctx => {
	if (ctx.move.id !== 'painsplit') return 0;
	const value = painSplitValue(ctx);
	if (value.score > BASE_SCORE) return 0;
	ctx.skipPositiveScoring = true;
	ctx.flags.discouraged = true;
	const amount = Math.min(0, value.score - (ctx.score ?? BASE_SCORE));
	ctx.adjustments.push({ reason: value.reason, amount, category: 'negative' });
	return amount;
};

export const checkFutureSight: NegativeScoringFunction = ctx => {
	const failure = delayedMoveFailure(ctx.state, ctx.target, ctx.move);
	if (!failure) return 0;
	ctx.flags.hasNoEffect = true;
	ctx.adjustments.push({ reason: failure, amount: -100, category: 'negative' });
	return -100;
};

/** Eligibility is shared with damage; identical-item and blocked-status penalties are tactical. */
export const checkItemMove: NegativeScoringFunction = ctx => {
	if (!['trick', 'switcheroo', 'recycle', 'fling', 'naturalgift'].includes(ctx.move.id)) return 0;
	const failure = itemMoveFailure(ctx.attacker, ctx.target, ctx.move, ctx.state.field);
	if (failure) {
		ctx.flags.hasNoEffect = true;
		ctx.adjustments.push({ reason: failure, amount: -100, category: 'negative' });
		return -100;
	}
	if (['trick', 'switcheroo'].includes(ctx.move.id) && ctx.attacker.item &&
		toID(ctx.attacker.item) === toID(ctx.target.item)) {
		ctx.adjustments.push({ reason: 'Swapping identical items offers little benefit', amount: -10, category: 'negative' });
		return -10;
	}
	if (ctx.move.id === 'fling') {
		const status = statusFailure(ctx.state, ctx.attacker, ctx.target, ctx.move);
		if (status) {
			ctx.adjustments.push({ reason: `Fling status unavailable: ${status}`, amount: -5, category: 'negative' });
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

	const attackerItem = effectiveItem(ctx.attacker, ctx.state.field);

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

/** Losing removal utility does not make Knock Off's damage ineffective. */
export const checkKnockOff: NegativeScoringFunction = ctx => {
	if (ctx.move.id !== 'knockoff') return 0;
	const failure = itemRemovalFailure(ctx.attacker, ctx.target, ctx.move, ctx.state.field);
	if (!failure) return 0;
	ctx.adjustments.push({ reason: `Knock Off utility unavailable: ${failure}`, amount: -5, category: 'negative' });
	return -5;
};

// =============================================================================
// Export all negative scorers
// =============================================================================

export const allNegativeScorers: NegativeScoringFunction[] = [
	checkSleepTalkSnore,
	checkMoveImmunity,
	checkConditionalAttack,
	checkFieldEffect,
	// Partner effects after confirmed immunities
	checkTargetingPartnerDamage,
	checkTargetingPartnerStatus,
	checkSpreadMoveHitsPartner,

	// Type and ability immunity
	checkTypeResistance,
	checkCovertCloak,
	checkStatBoostOnHit,

	// Low damage penalty (should run early so other bonuses can override)
	checkLowDamage,  // NEW: Penalize very low damage moves

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

	// Status immunity abilities (CFRU: ai_negatives.c 478-500)
	checkWonderSkin,

	// Status moves
	checkTeamStatusCure,
	checkStatusMove,

	// Setup moves and stat resets
	checkStatBoostWasted,
	checkStatusOpportunity,
	checkUtilityOpportunity,
	checkHaze,

	// Magic Bounce
	checkMagicBounce,

	// Special move effects (CFRU: ai_negatives.c 784-843, 1371-1711)
	checkLiquidOoze,
	checkRoar,
	checkVolatileEffect,
	checkSaltCure,
	checkMentalMoveRedundant,
	checkCounterMirrorCoat,
	checkBellyDrum,

	// Special moves
	checkExplosion,
	checkProtectOveruse,
	checkHealingUnnecessary,
	checkRecoverySurvival,

	// Contact move risks (CFRU: ai_util.c 3011-3067)
	checkContactRisk,

	// New M2 checks (CFRU: ai_negatives.c various lines)
	checkPainSplit,
	checkFutureSight,
	checkItemMove,
	checkSemiInvulnerable,

	// Item removal
	checkKnockOff,
];
