/** Project an authorized own Mega evolution without changing tracked battle facts. */
import { Dex } from '../../../../../sim/dex';
import type { AIPokemon, BattleState } from '../types';
import { effectiveAbility, fieldWithActivePokemon, replaceActivePokemon, tracedAbility } from './mechanics';
import { getEffectiveSpeed } from './speed';
import { computeStatsFromPreset } from './opponent-presets';

export function megaEvolutionState(state: BattleState, actor: AIPokemon, resolveEntry = true): BattleState | null {
	const dex = Dex.forFormat(state.field.formatId || 'gen9customgame');
	const before = dex.species.get(actor.species);
	const evolution = dex.items.get(actor.item).megaStone?.[before.baseSpecies];
	if (before.isMega || !evolution) return null;
	const after = dex.species.get(evolution);
	const stats = actor.statSpread ? computeStatsFromPreset(after.baseStats, actor.level, actor.statSpread) :
		{ ...actor.baseStats };
	// Legacy snapshots without a spread use the neutral stat delta, without a directional penalty.
	if (!actor.statSpread) for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
		const delta = Math.floor(2 * (after.baseStats[stat] - before.baseStats[stat]) * actor.level / 100);
		stats[stat] = Math.max(1, stats[stat] + delta);
	}
	stats.hp = actor.maxHp;
	const mega: AIPokemon = { ...actor, species: after.name, types: after.types, ability: after.abilities[0],
		observedAbility: after.abilities[0], abilityChanged: false,
		baseStats: stats,
		queuedPriorityAbility: dex.gen <= 6 ? effectiveAbility(actor, state.field) : undefined,
		queuedSpeed: dex.gen <= 6 ? getEffectiveSpeed(actor, state.field, state.self.conditions) : undefined };
	const result = replaceActivePokemon(state, actor, mega);
	if (!resolveEntry) return result;
	const copied = tracedAbility(mega, result.opponent.active, result.field);
	if (copied) { mega.ability = copied; mega.abilityChanged = true; }
	if (!['primordialsea', 'desolateland', 'deltastream'].includes(result.field.weatherId || '')) {
		const ability = effectiveAbility(mega, result.field);
		if (ability === 'drought') result.field.weatherId = 'sunnyday';
		if (ability === 'drizzle') result.field.weatherId = 'raindance';
	}
	result.field = fieldWithActivePokemon(result.field, [...result.self.active, ...result.opponent.active]);
	return result;
}
