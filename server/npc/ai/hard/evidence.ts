/** Refine complete preset hypotheses from public observations without turning guesses into facts. */
import { toID } from '../../../../sim/dex';
import type { AIPokemon, OpponentModel } from '../cfru/types';
import type { BattleEvidence } from '../cfru/util/battle-evidence';
import { buildAIMove } from '../cfru/state-builder';
import { compareActionOrder } from '../cfru/util/speed';
import { calculateDamage } from '../cfru/util/damage-calc';
import { fieldWithActivePokemon } from '../cfru/util/mechanics';
import { alternativeOpponentModels } from './opponent-model';

/** Restore hidden configuration at the time of the observation, keeping public changes at that time. */
function project(observed: AIPokemon, candidate: AIPokemon): AIPokemon {
	const hp = Math.max(1, Math.floor(candidate.maxHp * observed.hpPercent / 100));
	return { ...observed, baseStats: candidate.baseStats, maxHp: candidate.maxHp, hp,
		item: observed.itemKnown || observed.itemLost ? observed.item : candidate.originalItem || candidate.item,
		itemAssumed: true,
		ability: observed.observedAbility || observed.abilityChanged ? observed.ability :
		candidate.observedAbility || candidate.ability,
	};
}

function compatible(model: OpponentModel, evidence: BattleEvidence): boolean {
	const context = evidence.context;
	const all = [...context.self, ...context.opponents]
		.map(p => p.ident === evidence.opponent ? project(p, model.pokemon) : p);
	const first = all.find(p => p.ident === evidence.first), second = all.find(p => p.ident === evidence.second);
	if (!first || !second) return true;
	const ownFirst = context.self.some(p => p.ident === first.ident);
	const firstConditions = ownFirst ? context.selfConditions : context.opponentConditions;
	const secondConditions = ownFirst ? context.opponentConditions : context.selfConditions;
	const field = fieldWithActivePokemon(context.field, all);
	const move = buildAIMove({ id: evidence.move }, 1, field.formatId);
	if (evidence.kind === 'speed') {
		// Move-last items/abilities and HP-dependent priority need richer order observations.
		if ([first, second].some(p => ['laggingtail', 'fullincense'].includes(toID(p.item)) ||
			['stall', 'galewings'].includes(toID(p.ability)))) return true;
		const response = buildAIMove({ id: evidence.response }, 1, field.formatId);
		// Observed first includes possible speed ties; one win never proves strictly faster.
		return compareActionOrder(first, second, move, [response], field, firstConditions, secondConditions) >= 0;
	}
	const allies = all.filter(p => p.ident !== second.ident &&
		context[ownFirst ? 'opponents' : 'self'].some(q => q.ident === p.ident));
	const numAliveTargets = all.filter(p => !p.fainted && p.ident !== first.ident &&
		(move.target === 'allAdjacent' || allies.includes(p) || p === second)).length;
	// The protocol omits Hidden Power's type. Use our known move or this opponent hypothesis's alternatives.
	const alternatives = move.id === 'hiddenpower' ? [...new Set((ownFirst ? first.moves : model.moves.map(m => m.id))
		.filter(id => id.startsWith('hiddenpower') && id !== 'hiddenpower'))] : [evidence.move];
	if (!alternatives.length) return true; // An unknown type is not a Normal-type damage observation.
	// Percent display rounding contributes up to one HP interval at either end.
	const bounds = (percent: number) => [Math.floor((percent - 1) * second.maxHp / 100) + 1,
		Math.floor(percent * second.maxHp / 100)];
	const before = bounds(evidence.before!), after = bounds(evidence.after!);
	const loss = [Math.max(1, before[0] - after[1]), before[1] - after[0]];
	// This is an estimator, not the PS oracle. Allow a margin beyond the damage roll range.
	return alternatives.some(id => {
		const damage = calculateDamage(first, second, buildAIMove({ id }, 1, field.formatId), field, undefined, {
			isDoubles: context.isDoubles, numAliveTargets, activePokemon: all, defenderAllies: allies,
			attackerSideConditions: firstConditions, defenderSideConditions: secondConditions,
		});
		const margin = Math.max(2, Math.ceil(damage.max * 0.08));
		return loss[0] <= damage.max + margin && loss[1] >= damage.min - margin;
	});
}

/** Keep bounded, weighted coverage across item/stat/move combinations instead of taking the first N. */
function boundedModels(models: OpponentModel[]): OpponentModel[] {
	if (models.length <= 24) return models;
	const total = models.reduce((sum, m) => sum + m.weight, 0);
	const selected = new Map<OpponentModel, number>();
	let index = 0, cumulative = models[0].weight;
	for (let i = 0; i < 24; i++) {
		const point = (i + 0.5) * total / 24;
		while (index < models.length - 1 && cumulative < point) cumulative += models[++index].weight;
		selected.set(models[index], (selected.get(models[index]) || 0) + 1);
	}
	return [...selected].map(([model, weight]) => ({ ...model, weight }));
}

export function refineOpponentModels(
	pokemon: AIPokemon, models: OpponentModel[], history: readonly BattleEvidence[] = []
): { models: OpponentModel[], notes: string[] } {
	const relevant = history.filter(e => e.opponent === pokemon.ident &&
		e.context.opponents.some(p => p.ident === pokemon.ident && p.species === pokemon.species));
	const notes: string[] = [];
	if (!relevant.length || pokemon.itemChanged || pokemon.abilityChanged || pokemon.volatiles.has('transform')) {
		return { models, notes };
	}
	let remaining = models;
	// Exact action-order constraints take precedence over approximate damage estimates.
	for (const kind of ['speed', 'damage'] as const) {
		const evidence = relevant.filter(e => e.kind === kind);
		if (!evidence.length) continue;
		const candidates = remaining.filter(model => evidence.every(e => compatible(model, e)));
		if (!candidates.length) {
			// Reconsider all initial profiles: a speed contradiction can also be explained by a new item/spread.
			const formatId = relevant[0].context.field.formatId || '';
			const expanded = boundedModels([...alternativeOpponentModels(pokemon, models, formatId)]
				.filter(model => relevant.every(e => compatible(model, e))));
			if (expanded.length) {
				remaining = expanded;
				notes.push(`${kind} evidence supports ${expanded.length} inferred configurations outside presets`);
				continue;
			}
			notes.push(`${kind} evidence conflicts with all remaining presets; retained uncertainty`);
			continue;
		}
		if (candidates.length < remaining.length) {
			notes.push(`${kind} evidence (${evidence.length} observations): ${remaining.length} -> ${candidates.length} presets`);
			remaining = candidates;
		}
	}
	const total = remaining.reduce((sum, model) => sum + model.weight, 0);
	return { models: remaining.map(model => ({ ...model, weight: model.weight / total })), notes };
}
