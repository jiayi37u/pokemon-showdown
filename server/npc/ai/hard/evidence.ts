/** Refine complete preset hypotheses from public observations without turning guesses into facts. */
import { Dex, toID } from '../../../../sim/dex';
import type { AIPokemon, OpponentModel } from '../cfru/types';
import type { BattleEvidence } from '../cfru/util/battle-evidence';
import { buildAIMove } from '../cfru/state-builder';
import { compareActionOrder, compareSpeedOrder } from '../cfru/util/speed';
import { calculateDamage, type DamageCache } from './damage';
import { fieldWithActivePokemon } from '../cfru/util/mechanics';
import { computeStatsFromPreset } from '../cfru/util/opponent-presets';

/** Restore hidden configuration at the time of the observation, keeping public changes at that time. */
function project(observed: AIPokemon, candidate: AIPokemon): AIPokemon {
	const hp = Math.max(1, Math.floor(candidate.maxHp * observed.hpPercent / 100));
	return { ...observed, baseStats: candidate.baseStats, maxHp: candidate.maxHp, hp,
		item: observed.itemKnown || observed.itemLost ? observed.item : candidate.originalItem || candidate.item,
		itemAssumed: candidate.itemAssumed !== false,
		ability: observed.observedAbility || observed.abilityChanged ? observed.ability :
		candidate.observedAbility || candidate.ability,
	};
}

type Verdict = 'compatible' | 'unknown' | 'below' | 'above';

/** Below/above refer to the opposing stat constrained by the observation, not to preset identity. */
function assessEvidence(model: OpponentModel, evidence: BattleEvidence, cache?: DamageCache): Verdict {
	if (evidence.kind === 'selection') return 'unknown';
	const context = evidence.context;
	const all = [...context.self, ...context.opponents]
		.map(p => p.ident === evidence.opponent ? project(p, model.pokemon) : p);
	const first = all.find(p => p.ident === evidence.first), second = all.find(p => p.ident === evidence.second);
	if (!first || !second) return 'unknown';
	const ownFirst = context.self.some(p => p.ident === first.ident);
	const firstConditions = ownFirst ? context.selfConditions : context.opponentConditions;
	const secondConditions = ownFirst ? context.opponentConditions : context.selfConditions;
	const field = fieldWithActivePokemon(context.field, all);
	if (evidence.kind === 'speed' && evidence.speedSource === 'entry') {
		return compareSpeedOrder(first, second, field, firstConditions, secondConditions) >= 0 ?
			'compatible' : ownFirst ? 'above' : 'below';
	}
	const move = buildAIMove({ id: evidence.move }, 1, field.formatId);
	if (evidence.kind === 'speed') {
		// Move-last items/abilities and HP-dependent priority need richer order observations.
		if ([first, second].some(p => ['laggingtail', 'fullincense'].includes(toID(p.item)) ||
			['stall', 'galewings'].includes(toID(p.ability)))) return 'unknown';
		const response = buildAIMove({ id: evidence.response }, 1, field.formatId);
		// Observed first includes possible speed ties; one win never proves strictly faster.
		return compareActionOrder(first, second, move, [response], field, firstConditions, secondConditions) >= 0 ?
			'compatible' : ownFirst !== !!field.trickroom ? 'above' : 'below';
	}
	const allies = all.filter(p => p.ident !== second.ident &&
		context[ownFirst ? 'opponents' : 'self'].some(q => q.ident === p.ident));
	const numAliveTargets = all.filter(p => !p.fainted && p.ident !== first.ident &&
		(move.target === 'allAdjacent' || allies.includes(p) || p === second)).length;
	// The protocol omits Hidden Power's type. Use our known move or this opponent hypothesis's alternatives.
	const alternatives = move.id === 'hiddenpower' ? [...new Set((ownFirst ? first.moves : model.moves.map(m => m.id))
		.filter(id => id.startsWith('hiddenpower') && id !== 'hiddenpower'))] : [evidence.move];
	if (!alternatives.length) return 'unknown'; // An unknown type is not a Normal-type damage observation.
	// Percent display rounding contributes up to one HP interval at either end.
	const bounds = (percent: number) => [Math.floor((percent - 1) * second.maxHp / 100) + 1,
		Math.floor(percent * second.maxHp / 100)];
	const before = bounds(evidence.before!), after = bounds(evidence.after!);
	const loss = [Math.max(1, before[0] - after[1]), before[1] - after[0]];
	// The calculator already supplies the full damage roll range; HP display rounding is handled above.
	const results: Verdict[] = alternatives.map(id => {
		const damage = calculateDamage(first, second, buildAIMove({ id }, 1, field.formatId), field, undefined, {
			cache, isDoubles: context.isDoubles, numAliveTargets, activePokemon: all, defenderAllies: allies,
			attackerSideConditions: firstConditions, defenderSideConditions: secondConditions,
		});
		if (loss[0] <= damage.max && loss[1] >= damage.min) return 'compatible';
		return (loss[0] > damage.max) !== ownFirst ? 'below' : 'above';
	});
	return results.includes('compatible') ? 'compatible' :
		results.every(result => result === results[0]) ? results[0] : 'unknown';
}

function compatible(model: OpponentModel, evidence: BattleEvidence, cache?: DamageCache): boolean {
	return ['compatible', 'unknown'].includes(assessEvidence(model, evidence, cache));
}

type Stat = keyof AIPokemon['baseStats'];
const stats: Stat[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

function evidenceStat(e: BattleEvidence): Stat | undefined {
	if (e.kind === 'speed') return 'spe';
	const move = Dex.forFormat(e.context.field.formatId || '').moves.get(e.move);
	if (move.overrideOffensivePokemon || move.damage || move.damageCallback || move.basePowerCallback) return;
	if (e.first === e.opponent) return move.overrideOffensiveStat || (move.category === 'Physical' ? 'atk' : 'spa');
	return move.overrideDefensiveStat || (move.category === 'Physical' ? 'def' : 'spd');
}

/** Fit one legal spread near the prior, never one search branch per possible EV allocation.
 * For each HP value, damage/order is monotone in the affected stat, so binary searches bound its EVs.
 * The shared 508-EV budget prevents combining six independent maximum stats.
 */
function fitSpread(
	model: OpponentModel, history: readonly BattleEvidence[], cache?: DamageCache
): OpponentModel | undefined {
	if (history.every(e => compatible(model, e, cache))) return model;
	if (!model.spread) return;
	const dex = Dex.forFormat(history[0].context.field.formatId || '');
	if (dex.gen < 3) return;
	const base = dex.species.get(model.pokemon.species).baseStats;
	const prior = Object.fromEntries(stats.map(stat => [stat,
		Math.floor((model.spread!.evs ? model.spread!.evs[stat] || 0 : 85) / 4),
	])) as Record<Stat, number>;
	const groups = new Map<Stat, BattleEvidence[]>();
	for (const e of history) {
		const stat = evidenceStat(e);
		if (!stat) { if (!compatible(model, e, cache)) return; else continue; }
		if (!groups.has(stat)) groups.set(stat, []);
		groups.get(stat)!.push(e);
	}
	const make = (units: Record<Stat, number>): OpponentModel => {
		const evs = Object.fromEntries(stats.map(stat => [stat, units[stat] * 4]));
		const spread = { ...model.spread, evs };
		const values = computeStatsFromPreset(base, model.pokemon.level, spread);
		return { ...model, spread, pokemon: { ...model.pokemon, baseStats: values, maxHp: values.hp,
			hp: Math.max(model.pokemon.fainted ? 0 : 1, Math.floor(values.hp * model.pokemon.hpPercent / 100)),
		} };
	};
	let best: OpponentModel | undefined, bestCost = Infinity, bestSquared = Infinity;
	// Try the prior HP first; only evaluate other HP values when a smaller change is still possible.
	for (const hp of [prior.hp, ...Array.from({ length: 64 }, (_, i) => i).filter(i => i !== prior.hp)]) {
		if (Math.abs(hp - prior.hp) > bestCost) continue;
		const units = { ...prior, hp }, lows = { ...prior, hp }, highs = { ...prior, hp };
		let feasible = true;
		for (const stat of stats.filter(s => s !== 'hp')) {
			let lower = 0, upper = 63;
			for (const e of groups.get(stat) || []) {
				const verdicts = new Map<number, Verdict>();
				const at = (value: number) => {
					if (!verdicts.has(value)) verdicts.set(value, assessEvidence(make({ ...units, [stat]: value }), e, cache));
					return verdicts.get(value)!;
				};
				// Unknown observations do not narrow a range or lend support to a preset.
				if (at(lower) === 'unknown' || at(upper) === 'unknown') continue;
				if (at(upper) === 'below' || at(lower) === 'above') { feasible = false; break; }
				let lo = lower, hi = upper;
				while (lo < hi) {
					const mid = Math.floor((lo + hi) / 2);
					if (at(mid) === 'below') lo = mid + 1; else hi = mid;
				}
				lower = lo; lo = lower; hi = upper;
				while (lo < hi) {
					const mid = Math.ceil((lo + hi) / 2);
					if (at(mid) === 'above') hi = mid - 1; else lo = mid;
				}
				upper = lo;
				if (at(lower) !== 'compatible' || at(upper) !== 'compatible') { feasible = false; break; }
			}
			if (!feasible) break;
			lows[stat] = lower; highs[stat] = upper;
			units[stat] = Math.max(lower, Math.min(upper, prior[stat]));
		}
		if (!feasible || stats.reduce((sum, stat) => sum + lows[stat], 0) > 127) continue;
		let total = stats.reduce((sum, stat) => sum + units[stat], 0);
		while (total > 127) {
			// Minimize displacement from the prior; squared displacement breaks equal-cost ties.
			const donors = stats.filter(stat => stat !== 'hp' && units[stat] > lows[stat]);
			donors.sort((a, b) => (prior[a] - units[a]) - (prior[b] - units[b]));
			units[donors[0]]--; total--;
		}
		const cost = stats.reduce((sum, stat) => sum + Math.abs(units[stat] - prior[stat]), 0);
		const squared = stats.reduce((sum, stat) => sum + (units[stat] - prior[stat]) ** 2, 0);
		if (cost > bestCost || cost === bestCost && squared >= bestSquared) continue;
		const fitted = make(units);
		if (!history.every(e => compatible(fitted, e, cache))) continue;
		fitted.statRanges = Object.fromEntries([...groups.keys()].map(stat => {
			const available = 127 - stats.filter(s => s !== stat).reduce((sum, s) => sum + lows[s], 0);
			return [stat, [make({ ...units, [stat]: lows[stat] }).pokemon.baseStats[stat],
				make({ ...units, [stat]: Math.min(highs[stat], available) }).pokemon.baseStats[stat]]];
		}));
		best = fitted; bestCost = cost; bestSquared = squared;
	}
	return best;
}

/** Only an observation beyond non-Choice stat ceilings permits a new Choice item. */
function exceptionalChoiceModels(
	pokemon: AIPokemon, models: OpponentModel[], history: readonly BattleEvidence[], cache?: DamageCache
): OpponentModel[] {
	const formatId = history[0]?.context.field.formatId || '';
	if (!models.length || pokemon.presetModels || formatId.includes('randombattle') ||
		pokemon.itemKnown || pokemon.originalItem || pokemon.itemLost || (pokemon.usedMoves?.length || 0) > 1) return [];
	const dex = Dex.forFormat(formatId);
	if (dex.gen < 3) return [];
	const species = dex.species.get(pokemon.species);
	const inferred = new Set<string>();
	for (const e of history) {
		if (e.first !== pokemon.ident) continue;
		const stat = evidenceStat(e);
		if (!stat || !['atk', 'spa', 'spe'].includes(stat)) continue;
		const item = stat === 'spe' ? 'choicescarf' : stat === 'atk' ? 'choiceband' : 'choicespecs';
		if (dex.items.get(item).gen > dex.gen || models.some(model => toID(model.pokemon.item) === item)) continue;
		const maximum = computeStatsFromPreset(species.baseStats, pokemon.level, {
			nature: stat === 'spe' ? 'Timid' : stat === 'atk' ? 'Adamant' : 'Modest', evs: { [stat]: 252 },
		})[stat];
		if (models.every(model => assessEvidence({ ...model, pokemon: { ...model.pokemon,
			item: ['choiceband', 'choicespecs', 'choicescarf'].includes(toID(model.pokemon.item)) ? '' : model.pokemon.item,
			baseStats: { ...model.pokemon.baseStats, [stat]: maximum },
		} }, e, cache) === 'below')) inferred.add(item);
	}
	return [...inferred].flatMap(item => models.map(model => fitSpread({ ...model,
		name: `${model.name} (${item} inferred from exceptional evidence)`,
		pokemon: { ...model.pokemon, item, itemAssumed: true },
	}, history, cache)).filter((model): model is OpponentModel => !!model));
}

export function refineOpponentModels(
	pokemon: AIPokemon, models: OpponentModel[], history: readonly BattleEvidence[] = [], cache?: DamageCache
): { models: OpponentModel[], notes: string[] } {
	const relevant = history.filter(e => e.opponent === pokemon.ident &&
		e.context.opponents.some(p => p.ident === pokemon.ident && p.species === pokemon.species));
	const notes: string[] = [];
	if (!relevant.length || pokemon.itemChanged || pokemon.abilityChanged || pokemon.volatiles.has('transform')) {
		return { models, notes };
	}
	const closed = !!pokemon.presetModels || (relevant[0].context.field.formatId || '').includes('randombattle');
	// A public Hidden Power gets the same catalogue type candidates under every item/spread hypothesis.
	const types = [...new Set(models.flatMap(m => m.moves.map(move => move.id))
		.filter(id => id.startsWith('hiddenpower') && id !== 'hiddenpower'))];
	if (!closed && types.length && pokemon.moves.some(id => toID(id) === 'hiddenpower')) models = models.map(model => {
		const moves = [...model.moves.filter(m => m.id !== 'hiddenpower'),
			...types.filter(id => !model.moves.some(m => m.id === id)).map(id => ({ id, availability: 1 }))];
		const knowledge = model.pokemon.moveKnowledge;
		return { ...model, moves, pokemon: { ...model.pokemon, moveKnowledge: knowledge ? { ...knowledge,
			presetCandidates: [...new Set([...knowledge.presetCandidates, ...types])],
		} : undefined } };
	});
	const publicMatches = models.filter(model => !relevant.some(e => e.excludedItems?.includes(toID(model.pokemon.item))));
	if (publicMatches.length) {
		if (publicMatches.length < models.length) {
			notes.push(`public item effects: ${models.length} -> ${publicMatches.length} presets`);
		}
		models = publicMatches;
	} else {
		// Keep the spreads and moves, but do not keep assuming an item contradicted by public effects.
		models = models.map(model => ({ ...model, pokemon: { ...model.pokemon, item: '', itemAssumed: false } }));
		notes.push('public effects exclude all preset items; item remains unknown');
	}
	// Lack of a calculable move type must not give one preset an advantage over another.
	const observations = relevant.filter(e => e.kind !== 'selection');
	const usable = observations.filter(e => models.every(model => assessEvidence(model, e, cache) !== 'unknown'));
	if (usable.length < observations.length) notes.push('unresolved observations retained without filtering presets');
	let remaining = models.map(model => closed ? (usable.every(e => compatible(model, e, cache)) ? model : undefined) :
		fitSpread(model, usable, cache)).filter((model): model is OpponentModel => !!model);
	if (!remaining.length && !closed) remaining = exceptionalChoiceModels(pokemon, models, usable, cache);
	if (!remaining.length) {
		notes.push('battle evidence conflicts with all feasible preset spreads; retained uncertainty');
		remaining = models;
	} else {
		if (remaining.length < models.length) {
			notes.push(`speed/damage evidence: ${models.length} -> ${remaining.length} presets`);
		}
		for (const model of remaining) {
			const prior = models.find(m => m.name === model.name && m.spread?.nature === model.spread?.nature);
			if (!prior) { notes.push(model.name); continue; }
			const changes = stats.filter(stat => model.pokemon.baseStats[stat] !== prior.pokemon.baseStats[stat]);
			if (changes.length) notes.push(`${model.name}: estimated stats ${changes.map(stat =>
				`${stat} ${prior.pokemon.baseStats[stat]} -> ${model.pokemon.baseStats[stat]}`).join(', ')}`);
		}
	}
	const total = remaining.reduce((sum, model) => sum + model.weight, 0);
	return { models: remaining.map(model => ({ ...model, weight: model.weight / total })), notes };
}
