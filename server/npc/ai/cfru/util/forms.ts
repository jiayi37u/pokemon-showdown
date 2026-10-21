/** Project an authorized own Mega evolution without changing tracked battle facts. */
import { Dex } from '../../../../../sim/dex';
import type { AIPokemon, BattleState } from '../types';
import { effectiveAbility, fieldWithActivePokemon, replaceActivePokemon } from './mechanics';
import { getEffectiveSpeed } from './speed';

export function megaEvolutionState(state: BattleState, actor: AIPokemon): BattleState | null {
	const dex = Dex.forFormat(state.field.formatId || 'gen9customgame');
	const before = dex.species.get(actor.species);
	const evolution = dex.items.get(actor.item).megaStone?.[before.baseSpecies];
	if (before.isMega || !evolution) return null;
	const after = dex.species.get(evolution);
	const stats = { ...actor.baseStats };
	// Requests expose actual stats, but not nature. Keep a conservative bound on the stat delta.
	for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
		const delta = Math.floor(2 * (after.baseStats[stat] - before.baseStats[stat]) * actor.level / 100);
		stats[stat] = Math.max(1, stats[stat] + Math.floor(delta * (delta > 0 ? 0.9 : 1.1)));
	}
	const mega: AIPokemon = { ...actor, species: after.name, types: after.types, ability: after.abilities[0],
		baseStats: stats,
		queuedPriorityAbility: dex.gen <= 6 ? effectiveAbility(actor, state.field) : undefined,
		queuedSpeed: dex.gen <= 6 ? getEffectiveSpeed(actor, state.field, state.self.conditions) : undefined };
	const result = replaceActivePokemon(state, actor, mega);
	if (!['primordialsea', 'desolateland', 'deltastream'].includes(result.field.weatherId || '')) {
		const ability = effectiveAbility(mega, result.field);
		if (ability === 'drought') result.field.weatherId = 'sunnyday';
		if (ability === 'drizzle') result.field.weatherId = 'raindance';
		result.field = fieldWithActivePokemon(result.field, [...result.self.active, ...result.opponent.active]);
	}
	return result;
}
