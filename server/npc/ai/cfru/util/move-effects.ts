/** Effect eligibility over public snapshots, shared by failure scoring and effect rewards. */
import { Dex, toID } from '../../../../../sim/dex';
import type { AIPokemon, AIMove, BattleState } from '../types';
import { effectiveAbility, defensiveAbility, effectiveItem, grounded, normalizeWeather, rulesDex } from './mechanics';
import { getMoveInteraction } from './type-calc';

/** Existing field/side effects that make a status move fail, independent of tactical value. */
export function fieldEffectFailure(state: BattleState, attacker: AIPokemon, move: AIMove): string | undefined {
	if (move.category !== 'Status') return;
	if (move.id === 'allyswitch') {
		const gameType = state.field.formatId ? Dex.formats.get(state.field.formatId).gameType :
			state.isDoubles ? 'doubles' : 'singles';
		if (!['doubles', 'triples'].includes(gameType)) return 'Ally Switch requires control of both allied positions';
		if (gameType === 'triples' && attacker.slot === 2) return 'Ally Switch cannot move the middle position';
		if (!state.self.active.some(p => p.slot !== attacker.slot && !p.fainted)) return 'No ally available to swap with';
	}
	if (move.target === 'adjacentAlly' &&
		!state.self.active.some(p => p.slot !== attacker.slot && !p.fainted)) {
		return 'No ally available for this move';
	}
	const data = rulesDex(state.field).moves.get(move.id);
	const weather: Record<string, string> = {
		sunnyday: 'sun', raindance: 'rain', sandstorm: 'sand', hail: 'hail', snow: 'snow',
	};
	if (data.weather && ['primordialsea', 'desolateland', 'deltastream'].includes(state.field.weatherId || '')) {
		return 'Extreme weather prevents ordinary weather changes';
	}
	if (data.weather && weather[toID(data.weather)] === normalizeWeather(state.field.weatherId ?? state.field.weather)) {
		return 'Weather already active';
	}
	if (data.terrain && toID(data.terrain).replace(/terrain$/, '') === state.field.terrain) return 'Terrain already active';
	const conditions = move.target === 'foeSide' ? state.opponent.conditions : state.self.conditions;
	const effect = toID(data.sideCondition);
	const limits: Record<string, number> = { spikes: 3, toxicspikes: 2, stealthrock: 1, stickyweb: 1,
		reflect: 1, lightscreen: 1, auroraveil: 1, tailwind: 1, safeguard: 1 };
	if (limits[effect] && Number(conditions[effect as keyof typeof conditions]) >= limits[effect]) {
		return `${move.name} already active or at max layers`;
	}
	if (move.id === 'auroraveil' && !['hail', 'snow'].includes(state.field.weather)) {
		return 'Aurora Veil requires Hail/Snow';
	}
	if (move.id === 'wish' && (state.self.conditions.wishes?.[attacker.slot] || 0) > 0) return 'Wish is already pending';
}

/** Slot occupancy is independent of the Pokemon currently occupying that position. */
export function delayedMoveFailure(state: BattleState, target: AIPokemon, move: AIMove): string | undefined {
	if (!['futuresight', 'doomdesire'].includes(move.id)) return;
	const side = state.self.active.includes(target) ? state.self : state.opponent;
	if ((side.conditions.futureMoves?.[target.slot] || 0) > 0) return 'Future attack already pending on target position';
}

/** Volatile effects with prerequisites beyond ordinary type/ability immunity. */
export function volatileEffectFailure(
	state: BattleState, attacker: AIPokemon, target: AIPokemon, move: AIMove
): string | undefined {
	const dex = rulesDex(state.field);
	const transfer = dex.moves.get(move.id).selfSwitch;
	if (transfer === 'copyvolatile' || transfer === 'shedtail') {
		if (attacker.volatiles.has('commanded')) return 'Commanded Pokemon cannot pass effects';
		if (state.self.active.some(p => p.slot === attacker.slot) &&
			!state.self.reserve.some(p => !p.fainted)) return 'No reserve available to receive effects';
		if (transfer === 'shedtail') {
			if (attacker.volatiles.has('substitute')) return 'Already has Substitute';
			if (attacker.hp <= Math.ceil(attacker.maxHp / 2)) return 'Not enough HP for Shed Tail';
		}
	}
	if (move.id === 'destinybond' && (dex.gen >= 7 || dex.currentMod === 'mmo') &&
		attacker.volatiles.has('destinybond')) return 'Consecutive Destiny Bond fails';
	if (move.id === 'substitute') {
		if (attacker.volatiles.has('substitute')) return 'Already has Substitute';
		const tooWeak = dex.gen === 1 ? attacker.hp < Math.floor(attacker.maxHp / 4) :
			attacker.hp <= attacker.maxHp / 4 || attacker.maxHp === 1;
		if (tooWeak) return 'Not enough HP for Substitute';
	}
	if (move.id === 'leechseed') {
		if (target.volatiles.has('leechseed')) return 'Target already seeded';
		if (target.volatiles.has('substitute') &&
			!(dex.gen >= 6 && effectiveAbility(attacker, state.field) === 'infiltrator')) {
			return 'Substitute blocks Leech Seed';
		}
	}
}

/** Includes damaging moves' secondary status without treating their damage as ineffective. */
export function inflictedStatus(move: AIMove, state: BattleState, attacker?: AIPokemon): string {
	const data = rulesDex(state.field).moves.get(move.id);
	if (move.id === 'fling' && attacker) return rulesDex(state.field).items.get(attacker.item).fling?.status || '';
	if (move.id === 'yawn') return 'slp';
	if (data.volatileStatus === 'confusion') return 'confusion';
	return data.status || data.secondary?.status || data.secondaries?.find(s => s.status)?.status || '';
}

export function statusFailure(
	state: BattleState, attacker: AIPokemon, target: AIPokemon, move: AIMove,
	status = inflictedStatus(move, state, attacker)
): string | undefined {
	if (!status) return;
	const field = state.field;
	const dex = rulesDex(field);
	const allied = attacker === target || state.self.active.includes(target);
	const side = allied ? state.self : state.opponent;
	const ability = defensiveAbility(attacker, target, move, field);
	const interaction = getMoveInteraction(attacker, target, move, field,
		{ defenderAllies: side.active, isAllyTarget: allied });
	if (interaction.blockedBy) return interaction.blockedBy;
	if (status === 'confusion') {
		if (target.volatiles.has('confusion')) return 'Target already confused';
		if (ability === 'owntempo') return 'Own Tempo prevents confusion';
	} else if (target.status && move.id !== 'rest') {
		return status === 'slp' ? 'Target already has status condition' : 'Target already has status';
	}
	if (status !== 'confusion' && ability === 'comatose') return 'Comatose prevents status';
	if (status !== 'confusion' && ability === 'shieldsdown' && toID(target.species) === 'miniormeteor' &&
		!target.volatiles.has('transform')) return 'Shields Down blocks status in Meteor form';
	if (move.id === 'yawn' && target.volatiles.has('yawn')) return 'Yawn fails: target is already drowsy';
	if (target.volatiles.has('substitute') && attacker !== target &&
		!(dex.gen >= 6 && (move.flags.sound || effectiveAbility(attacker, field) === 'infiltrator'))) {
		return 'Substitute blocks status';
	}
	if (side.conditions.safeguard && !allied && effectiveAbility(attacker, field) !== 'infiltrator') {
		return 'Safeguard blocks status';
	}
	if (grounded(target, field)) {
		if (field.terrain === 'electric' && status === 'slp') return 'Electric Terrain blocks sleep';
		if (field.terrain === 'misty' && (status !== 'confusion' || dex.gen >= 7)) return 'Misty Terrain blocks status';
	}
	if (status !== 'confusion' && ability === 'leafguard' && field.weather === 'sun') {
		return 'Leaf Guard blocks status in sun';
	}
	const corrosion = ['psn', 'tox'].includes(status) && effectiveAbility(attacker, state.field) === 'corrosion';
	if (status !== 'confusion' && !corrosion && !dex.getImmunity(status, target.types)) return 'Type immune to status';
	const blockers: Record<string, string[]> = {
		slp: ['insomnia', 'vitalspirit', 'sweetveil'], par: ['limber'],
		brn: ['waterveil', 'waterbubble'], psn: ['immunity', 'pastelveil'], tox: ['immunity', 'pastelveil'],
		frz: ['magmaarmor'],
	};
	if (blockers[status]?.includes(ability)) return `${target.ability} prevents ${status}`;
	for (const holder of [target, ...side.active]) {
		if (holder.fainted) continue;
		const protection = defensiveAbility(attacker, holder, move, field);
		if ((status === 'slp' && protection === 'sweetveil') ||
			(['psn', 'tox'].includes(status) && protection === 'pastelveil') ||
			(status !== 'confusion' && target.types.includes('Grass') && protection === 'flowerveil' && attacker !== target)) {
			return `${holder.ability} protects team from status`;
		}
	}
	if (status === 'slp') {
		if ([...state.self.active, ...state.opponent.active].some(p =>
			!p.fainted && p.volatiles.has('uproar')) && ability !== 'soundproof') return 'Uproar prevents sleep';
		if (field.formatId && !allied) {
			const rules = Dex.formats.getRuleTable(Dex.formats.get(field.formatId));
			const stadium = rules.has('stadiumsleepclause');
			if ((stadium || rules.has('sleepclausemod')) && side.team.some(p =>
				!p.fainted && p.status === 'slp' && (!target.ownerSide || p.ownerSide === target.ownerSide) &&
				(stadium || !p.sleepSelfInflicted))) return 'Sleep Clause: opponent already has sleeping Pokemon';
		}
	}
	// A secondary status can be blocked while the damaging move remains useful.
	if (move.category !== 'Status') return secondaryEffectFailure(state, attacker, target, move);
}

/** A blocked secondary effect does not invalidate the attack's damage. */
export function secondaryEffectFailure(
	state: BattleState, attacker: AIPokemon, target: AIPokemon, move: AIMove
): string | undefined {
	const dex = rulesDex(state.field);
	const data = dex.moves.get(move.id);
	const fling = move.id === 'fling' && dex.items.get(attacker.item).fling;
	if (!data.secondary && !data.secondaries?.length && !(fling && (fling.status || fling.volatileStatus))) return;
	const ability = defensiveAbility(attacker, target, move, state.field);
	if (effectiveItem(target, state.field) === 'covertcloak' || ability === 'shielddust' ||
		(effectiveAbility(attacker, state.field) === 'sheerforce' && !fling)) return 'Secondary effect is suppressed';
	if (target.volatiles.has('substitute') &&
		!(dex.gen >= 6 && (move.flags.sound || effectiveAbility(attacker, state.field) === 'infiltrator'))) {
		return 'Substitute blocks secondary effect';
	}
}
