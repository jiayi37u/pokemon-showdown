/**
 * Hard-only CFRU strategy adaptations. Normal's rule registration and thresholds stay unchanged.
 * Sources: ai_advanced.c (roles/recovery/protect/setup), ai_positives.c (Taunt),
 * ai_switching.c (safe replacements, absorption, Natural Cure/Regenerator, Yawn, Perish Song).
 * This is a bounded heuristic evaluator, not a simulator or an exhaustive CFRU port.
 */
import { Dex, toID } from '../../../../sim/dex';
import { refineOpponentModels } from './evidence';
import {
	DEFAULT_AI_CONFIG, DISCOURAGED_SCORE, type AIPokemon, type AIMove, type BattleState, type MoveScore,
} from '../cfru/types';
import { ScoringEngine, allNegativeScorers, allPositiveScorers } from '../cfru/scoring';
import {
	rewardSetupMove, rewardDefensiveSetup, rewardHealing, rewardTaunt, rewardPivotMove, rewardScreens,
	rewardWishProtection,
} from '../cfru/scoring/positives';
import { checkRecoverySurvival } from '../cfru/scoring/negatives';
import { createCache } from '../cfru/util/cache';
import { calculateDamage, getSecondaryEffectDamage, getEffectiveHpAfterSecondary } from '../cfru/util/damage-calc';
import { resolveMove } from '../cfru/util/type-calc';
import {
	protectionMoves, protectsPendingWish, recoveryCuresStatus, estimatedMoveAccuracy,
} from '../cfru/util/move-effects';
import {
	directRecoveryAmount, selfActionOutcome, needsResidualReset, entryHazardDamage, flinchesOnHit,
} from '../cfru/util/turn-outcome';
import { compareActionOrder } from '../cfru/util/speed';
import {
	effectiveAbility, effectiveItem, replaceActivePokemon,
} from '../cfru/util/mechanics';
import {
	fightingStyle, hardMove, inferOpponent, predictOpponent, type OpponentHypothesis, type PredictedAction,
} from './opponent-model';

const replacedRewards = new Set([
	rewardSetupMove, rewardDefensiveSetup, rewardHealing, rewardTaunt, rewardPivotMove, rewardScreens,
	rewardWishProtection,
]);

export interface SwitchEvaluation {
	pokemon: AIPokemon;
	score: number;
	safe: boolean;
	hasFollowUp?: boolean;
	reasons: string[];
}

interface ReplacementHypothesis {
	pokemon: AIPokemon;
	weight: number;
	prior: number;
	threat: number;
}

export class HardEvaluation {
	readonly dex: ReturnType<typeof Dex.forFormat>;
	readonly state: BattleState;
	readonly formatId: string;
	private models = new Map<AIPokemon, OpponentHypothesis[]>();
	readonly inferenceNotes = new Map<AIPokemon, string[]>();
	private opposing = new Set<AIPokemon>();
	constructor(state: BattleState, formatId: string) {
		this.state = { ...state, field: { ...state.field, formatId } };
		this.formatId = formatId;
		this.dex = formatId ? Dex.forFormat(formatId) : Dex;
		for (const foe of [...state.opponent.team, ...(state.opponent.preview || [])]) {
			const { models, notes } = refineOpponentModels(foe, inferOpponent(foe, formatId), state.opponentEvidence);
			this.inferenceNotes.set(foe, notes);
			this.models.set(foe, models);
			this.opposing.add(foe);
			for (const model of models) this.opposing.add(model.pokemon);
		}
	}

	private sideOf(pokemon: AIPokemon): 'self' | 'opponent' {
		// Predicted users survive evaluator replacement during switch scoring. Object identity alone
		// cannot establish their side; ownerSide comes from the same public/request snapshot.
		return this.opposing.has(pokemon) || pokemon.ownerSide &&
			this.state.opponent.team.some(p => p.ownerSide === pokemon.ownerSide) ? 'opponent' : 'self';
	}

	private calculationState(...participants: AIPokemon[]): BattleState {
		let state = this.state;
		for (const pokemon of participants) {
			const current = state[this.sideOf(pokemon)].active.find(p => p === pokemon ||
				p.ownerSide && p.ownerSide === pokemon.ownerSide && p.slot === pokemon.slot);
			if (current && current !== pokemon) state = replaceActivePokemon(state, current, pokemon);
		}
		return state;
	}

	private baseScores(
		state: BattleState, actor: AIPokemon, moves: AIMove[], target: AIPokemon, prediction = false
	): MoveScore[] {
		// Each perspective/target gets its own cache; slot numbers overlap between sides.
		const config = { ...DEFAULT_AI_CONFIG, formatId: this.formatId, isDoubles: state.isDoubles };
		const engine = new ScoringEngine(config, createCache(state.turn));
		if (!prediction) engine.setScorers(allNegativeScorers.filter(fn => fn !== checkRecoverySurvival),
			allPositiveScorers.filter(fn => !replacedRewards.has(fn)));
		return engine.scoreMoves(state, actor, moves, target);
	}

	predictions(actor: AIPokemon): Map<AIPokemon, PredictedAction[]> {
		return new Map(this.state.opponent.active.filter(p => !p.fainted).map(foe => [foe,
			predictOpponent(this.calculationState(actor), foe, actor, this.formatId, (state, attacker, moves, target) =>
				this.baseScores(state, attacker, moves, target, true), this.models.get(foe), this.retreatConfidence(actor, foe)),
		]));
	}

	/** The same evidence-refined hypotheses feed scoring and disposable search worlds. */
	opponentModels(pokemon: AIPokemon): readonly OpponentHypothesis[] {
		return this.models.get(pokemon) || inferOpponent(pokemon, this.formatId);
	}

	/** Priority and speed order, including speed ties (50%, never a guaranteed first strike). */
	first(actor: AIPokemon, foe: AIPokemon, move: AIMove, response: AIMove): number {
		const state = this.calculationState(actor, foe);
		return (compareActionOrder(actor, foe, move, [response], state.field,
			state[this.sideOf(actor)].conditions, state[this.sideOf(foe)].conditions) + 1) / 2;
	}

	private responseFirst(actor: AIPokemon, foe: AIPokemon, move: AIMove, response: PredictedAction): number {
		const selected = response.selectedMove || response.move;
		return selected ? this.first(actor, response.user || foe, move, selected) : 1;
	}

	damage(actor: AIPokemon, target: AIPokemon, move: AIMove, defenderAllies?: readonly AIPokemon[]) {
		const models = this.models.get(target);
		if (!models?.length) return this.rawDamage(actor, target, move, defenderAllies);
		const values = models.map(model => ({ model, result: this.rawDamage(actor, model.pokemon, move, defenderAllies),
			scale: target.maxHp / model.pokemon.maxHp }));
		const average = values.reduce((n, v) => n + v.model.weight * v.result.average * v.scale, 0);
		return { ...values[0].result, average,
			min: Math.min(...values.map(v => v.result.min * v.scale)),
			max: Math.max(...values.map(v => v.result.max * v.scale)),
		};
	}

	private rawDamage(actor: AIPokemon, target: AIPokemon, move: AIMove, defenderAllies?: readonly AIPokemon[]) {
		const state = this.calculationState(actor, target);
		move = resolveMove(actor, move, state.field, target);
		const actorSide = this.sideOf(actor);
		const targetSide = this.sideOf(target);
		const spread = ['allAdjacent', 'allAdjacentFoes'].includes(move.target);
		const foes = state[actorSide === 'self' ? 'opponent' : 'self'].active;
		const allies = state[actorSide].active;
		const targets = foes.filter(p => !p.fainted).length +
			(move.target === 'allAdjacent' ? allies.filter(p => p !== actor && !p.fainted).length : 0);
		const result = calculateDamage(actor, target, move, state.field, undefined,
			{ isDoubles: state.isDoubles, numAliveTargets: spread ? targets : 1,
				attackerSideConditions: state[actorSide].conditions,
				defenderSideConditions: state[targetSide].conditions,
				defenderAllies: defenderAllies || state[targetSide].active,
				isAllyTarget: actorSide === targetSide,
				activePokemon: [...state.self.active, ...state.opponent.active],
			});
		return result;
	}

	incoming(
		actor: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>, defenderAllies?: readonly AIPokemon[]
	): number {
		let damage = 0;
		for (const [foe, actions] of predictions) {
			for (const action of actions) {
				if (action.move) damage += action.weight * this.damage(action.user || foe, actor, action.move, defenderAllies).average;
			}
		}
		return damage;
	}

	/** An upper weighted quantile prevents a likely switch from making a lethal attack look safe. */
	incomingRisk(
		actor: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>, defenderAllies?: readonly AIPokemon[],
		beforeMove?: AIMove, respectRevealedAttacks = false
	): number {
		let risk = 0;
		let expected = 0;
		for (const [foe, actions] of predictions) {
			const outcomes = actions.map(a => ({ weight: a.weight,
				damage: a.move ? this.damage(a.user || foe, actor, a.move, defenderAllies).max *
				(beforeMove && this.responseFirst(actor, foe, beforeMove, a) === 1 ? 0 : 1) : 0,
			})).sort((a, b) => a.damage - b.damage);
			expected += outcomes.reduce((sum, outcome) => sum + outcome.weight * outcome.damage, 0);
			if (respectRevealedAttacks) {
				// Choosing a move is uncertain; an observed lethal option is still an unsafe entry.
				const revealed = new Set<string>(foe.moves.map(toID));
				const known = new Map<string, { damage: number, weight: number }>();
				for (const action of actions) {
					if (!action.move || action.move.category === 'Status' || !revealed.has(action.move.id)) continue;
					const value = known.get(action.move.id) || { damage: 0, weight: 0 };
					value.damage += action.weight * this.damage(action.user || foe, actor, action.move, defenderAllies).average;
					value.weight += action.weight;
					known.set(action.move.id, value);
				}
				const floor = Math.max(0, ...[...known.values()].filter(v => v.weight > 0).map(v => v.damage / v.weight));
				for (const outcome of outcomes) outcome.damage = Math.max(outcome.damage, floor);
			}
			let cumulative = 0;
			for (const outcome of outcomes) {
				cumulative += outcome.weight;
				if (cumulative >= 0.85) { risk += outcome.damage; break; }
			}
		}
		return Math.max(risk, beforeMove ? expected : this.incoming(actor, predictions, defenderAllies));
	}

	/** Expected progress uses each response's configuration, and never spends damage after fainting. */
	private attackOutlook(actor: AIPokemon, target: AIPokemon, move: AIMove,
		predictions: Map<AIPokemon, PredictedAction[]>) {
		if (move.category === 'Status') return { progress: 0, finish: 0 };
		const responses = predictions.get(target) || [];
		let progress = 0, finish = 0, staying = 0;
		for (const response of responses) {
			if (response.switching) continue;
			const foe = response.user || target;
			const damage = this.damage(actor, foe, move).average;
			const incoming = response.move ? this.damage(foe, actor, response.move).average : 0;
			const first = this.responseFirst(actor, target, move, response);
			const hit = estimatedMoveAccuracy(actor, foe, move, this.state.field) / 100;
			const canAct = incoming >= actor.hp ? first : 1;
			progress += response.weight * hit * canAct * Math.min(1, damage / Math.max(1, foe.hp));
			if (!foe.volatiles.has('substitute') && damage >= foe.hp) finish += response.weight * first * hit;
			staying += response.weight;
		}
		return { progress: staying ? progress / staying : 0, finish: staying ? finish / staying : 0 };
	}

	private recoveryAmount(actor: AIPokemon, move: AIMove): number {
		return directRecoveryAmount(actor, move, this.state.field);
	}

	/** Keep lethal branches separate until after evaluating action order and residual damage. */
	private recoveryOutlook(actor: AIPokemon, move: AIMove, predictions: Map<AIPokemon, PredictedAction[]>) {
		let branches = [{ weight: 1, before: 0, after: 0 }];
		for (const [foe, actions] of predictions) {
			const responses = actions.flatMap(action => {
				const user = action.user || foe;
				const damage = action.move ? this.damage(user, actor, action.move).average : 0;
				const first = this.responseFirst(actor, foe, move, action);
				return [
					{ weight: action.weight * first, before: 0, after: damage },
					{ weight: action.weight * (1 - first), before: damage, after: 0 },
				].filter(r => r.weight > 0);
			});
			if (!responses.length) continue;
			branches = branches.flatMap(b => responses.map(r => ({
				weight: b.weight * r.weight, before: b.before + r.before, after: b.after + r.after,
			})));
		}
		const ability = [...predictions.keys()].some(p => effectiveAbility(p, this.state.field) === 'baddreams') ?
			'baddreams' : '';
		let survival = 0, recovered = 0, preventsKO = 0;
		for (const branch of branches) {
			const outcome = selfActionOutcome(actor, move, this.state.field, branch.before, branch.after, ability);
			if (outcome.endHp > 0) survival += branch.weight;
			if (outcome.acted) recovered += branch.weight * outcome.recovered;
			if (outcome.endHp > 0 && outcome.recovered > 0 &&
				selfActionOutcome(actor, hardMove('splash', 1, this.formatId), this.state.field,
					branch.before, branch.after, ability).endHp <= 0) preventsKO += branch.weight;
		}
		return { survival, recovered, preventsKO };
	}

	/** Public reserves and preview species bound switch predictions; no actual opposing sets are read. */
	private switchTargets(actor: AIPokemon, outgoing: AIPokemon): ReplacementHypothesis[] {
		const attacks = actor.moves.map((id, i) => hardMove(id, i + 1, this.formatId)).filter(m => m.category !== 'Status');
		const targets = [...this.state.opponent.reserve, ...(this.state.opponent.preview || [])]
			.filter(p => !p.fainted && (!outgoing.ownerSide || p.ownerSide === outgoing.ownerSide))
			.flatMap(p => (this.models.get(p) || inferOpponent(p, this.formatId)).flatMap(model => {
				const pokemon = { ...model.pokemon, slot: outgoing.slot };
				pokemon.hp -= this.entryDamage(pokemon, this.state.opponent.conditions);
				if (pokemon.hp <= 0) return [];
				pokemon.hpPercent = 100 * pokemon.hp / pokemon.maxHp;
				const threat = Math.max(0, ...attacks.map(m => this.damage(actor, pokemon, m).average / pokemon.hp));
				return [{ pokemon, weight: model.weight / (0.2 + threat), prior: model.weight, threat }];
			}));
		const total = targets.reduce((n, p) => n + p.weight, 0);
		return targets.map(p => ({ ...p, weight: p.weight / total }));
	}

	/** A bad current matchup is not enough: retreat needs a plausible destination. */
	private retreatConfidence(actor: AIPokemon, foe: AIPokemon): number {
		const destinations = new Map<string, { safe: number, total: number }>();
		for (const candidate of this.switchTargets(actor, foe)) {
			const p = candidate.pokemon;
			const key = p.ident || `${p.ownerSide}:${p.species}`;
			const value = destinations.get(key) || { safe: 0, total: 0 };
			value.total += candidate.prior;
			if (candidate.threat < 0.5) value.safe += candidate.prior;
			destinations.set(key, value);
		}
		// Unknown reserves remain possible, but do not justify treating a switch as the likely action.
		return [...destinations.values()].some(value => value.safe >= value.total / 2) ? 0.6 : 0.2;
	}

	scoreMoves(
		actor: AIPokemon, moves: AIMove[], target: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>
	): MoveScore[] {
		const models = this.models.get(target) || [{ pokemon: target, weight: 1 }];
		const groups = models.map(model => ({ weight: model.weight,
			scores: this.baseScores(this.calculationState(actor, model.pokemon), actor, moves, model.pokemon),
		}));
		const scores = groups[0].scores;
		for (let i = 0; i < scores.length; i++) {
			const result = scores[i];
			result.score = groups.reduce((n, group) => n + group.weight * group.scores[i].score, 0);
			result.flags = { ...result.flags,
				isImmune: groups.every(g => g.scores[i].flags.isImmune),
				hasNoEffect: groups.every(g => g.scores[i].flags.hasNoEffect),
				discouraged: groups.every(g => g.scores[i].flags.discouraged),
			};
			result.breakdown = { ...result.breakdown, final: result.score,
				negatives: groups.reduce((n, g) => n + g.weight * g.scores[i].breakdown.negatives, 0),
				positives: groups.reduce((n, g) => n + g.weight * g.scores[i].breakdown.positives, 0),
				details: [{ amount: result.score - 100, category: 'positive', reason: 'Base score across compatible opponent sets' }],
			};
		}
		const role = fightingStyle(actor, this.formatId);
		const switchProbability = (predictions.get(target) || []).reduce((n, a) => n + (a.switching ? a.weight : 0), 0);
		const switchTargets = switchProbability ? this.switchTargets(actor, target) : [];
		for (const result of scores) {
			const { move } = result;
			const data = this.dex.moves.get(move.id);
			const add = (amount: number, reason: string) => {
				result.score += amount;
				result.breakdown.styleAdjust += amount;
				result.breakdown.details.push({ amount, reason, category: 'style' });
			};
			let canHitReplacement = false;
			if (move.category !== 'Status' && (!this.state.isDoubles ||
				['normal', 'any', 'adjacentFoe'].includes(move.target)) && switchTargets.length) {
				const switchedScore = switchTargets.reduce((sum, candidate) => {
					const state = replaceActivePokemon(this.state, target, candidate.pokemon);
					const score = this.baseScores(state, actor, [move], candidate.pokemon)[0];
					if (!score.flags.hasNoEffect && !score.flags.isImmune) canHitReplacement = true;
					return sum + candidate.weight * score.score;
				}, 0);
				add(switchProbability * (switchedScore - result.score),
					'Predicted switch: evaluate damage against public replacement candidates');
			}
			if ((result.flags.hasNoEffect || result.flags.isImmune) && !canHitReplacement) {
				add(-result.score, 'Move has no effect');
				result.breakdown.final = result.score;
				continue;
			}
			if (canHitReplacement) result.flags = { ...result.flags, hasNoEffect: false, isImmune: false };
			const actions = predictions.get(target) || [];
			const incoming = this.incoming(actor, predictions);
			const fakeOut = move.id === 'fakeout';
			const canFlinch = flinchesOnHit(actor, target, move, this.state.field);
			let beforeDamage = 0;
			for (const [foe, responses] of predictions) {
				for (const response of responses) {
					if (!response.move) continue;
					const damage = this.damage(response.user || foe, actor, response.move).average;
					const first = this.responseFirst(actor, foe, move, response);
					beforeDamage += response.weight * damage * (1 - first);
				}
			}
			if (move.category !== 'Status') {
				if (fakeOut && canFlinch) add(22, 'CFRU Fake Out: free damage on entry');
				const outlook = this.attackOutlook(actor, target, move, predictions);
				const replacementProgress = switchTargets.reduce((sum, candidate) => sum + candidate.weight *
					Math.min(1, this.damage(actor, candidate.pokemon, move).average / candidate.pokemon.hp), 0);
				// Unseen reserves in no-preview formats are unknown, not guaranteed damage immunity.
				const knownSwitchWeight = switchTargets.length ? switchProbability : 0;
				add(24 * ((1 - knownSwitchWeight) * outlook.progress + knownSwitchWeight * replacementProgress),
					'Expected damage progress across staying and switching responses');
				add(20 * (1 - switchProbability) * outlook.finish, 'First-strike finishing opportunity across opponent sets');
				if (beforeDamage >= actor.hp) add(-65, 'Predicted to faint before attacking');
				if (data.selfSwitch && this.state.self.reserve.some(p => !p.fainted)) {
					add(incoming > actor.hp / 2 ? 10 : 3, 'CFRU pivot: deal damage while leaving a bad matchup');
				}
			} else if (['healingwish', 'lunardance'].includes(move.id)) {
				const recipient = this.sacrificeRecipient(actor);
				const value = recipient && beforeDamage < actor.hp ?
					60 + recipient.value - 0.6 * actor.hpPercent : 0;
				add(value - result.score, 'Sacrifice recovery: value a specific recipient against losing the user');
			} else if (this.recoveryAmount(actor, move)) {
				const outlook = this.recoveryOutlook(actor, move, predictions);
				const cures = actor.status && (recoveryCuresStatus(move) || move.id === 'rest' && actor.status !== 'slp');
				if (outlook.survival < 0.85) {
					add(Math.min(result.score, DISCOURAGED_SCORE * outlook.survival) - result.score,
						'Recovery is unsafe across predicted actions and residual damage');
				} else if (outlook.recovered <= 0 && !cures) {
					add(Math.min(result.score, DISCOURAGED_SCORE) - result.score, 'Recovery has no HP or status benefit');
				} else {
					add(30 * outlook.recovered / actor.maxHp, 'Recovery value across surviving action branches');
					add(22 * outlook.preventsKO, 'Healing prevents KO in predicted surviving branches');
					if (role === 'stall' || role === 'cleric') add(4, 'Recovery supports this fighting style');
					if (move.id === 'rest' && !['chesto', 'lum'].some(id => effectiveItem(actor, this.state.field) === `${id}berry`)) {
						add(-8, 'Rest incurs sleep');
					}
				}
			} else if (move.id === 'taunt') {
				let blocked = 0;
				for (const action of actions) {
					if ((action.selectedMove || action.move)?.category === 'Status') {
						blocked += action.weight * this.responseFirst(actor, target, move, action);
					}
				}
				add(blocked * 25, 'CFRU Taunt: interrupt predicted status action');
				if (target.moves.length && fightingStyle(target, this.formatId) !== 'attacker') {
					add(5, 'Restrict future support/setup actions');
				}
				if (beforeDamage >= actor.hp) add(-70, 'Cannot Taunt before fainting');
			} else if (protectionMoves.has(move.id)) {
				const item = effectiveItem(actor, this.state.field);
				const ability = effectiveAbility(actor, this.state.field);
				const residual = getSecondaryEffectDamage(target, this.state.field.weather,
					effectiveAbility(actor, this.state.field), this.state.field);
				const passiveHeal = actor.hp < actor.maxHp && (item === 'leftovers' ||
					(item === 'blacksludge' && actor.types.includes('Poison')));
				const pendingWish = protectsPendingWish(this.state, actor, move);
				const usefulOrb = !actor.status &&
					((item === 'toxicorb' && ability === 'poisonheal') || (item === 'flameorb' && ability === 'guts'));
				const ownResidual = getSecondaryEffectDamage(actor, this.state.field.weather,
					effectiveAbility(target, this.state.field), this.state.field);
				add(pendingWish ? Math.min(40, Math.floor((100 - actor.hpPercent) * 0.8)) : ownResidual >= actor.hp ? -90 :
					residual > 0 || passiveHeal || usefulOrb || target.volatiles.has('yawn') ? 16 : -12,
				'CFRU ShouldProtect: wait only when the turn produces a benefit');
				if (!pendingWish && !(residual > 0 || passiveHeal || usefulOrb || target.volatiles.has('yawn'))) {
					add(Math.min(result.score, DISCOURAGED_SCORE) - result.score, 'Protection has no concrete end-of-turn benefit');
				}
				if (actor.lastMove && protectionMoves.has(toID(actor.lastMove))) {
					add(-35, 'Repeated protection risks failure');
				}
			} else if (move.id === 'wish') {
				// Only this position's occupant or a legal replacement can receive its Wish.
				const needsHealing = [actor, ...this.state.self.reserve].filter(p => !p.fainted && p.hpPercent < 65);
				const protection = actor.moves.some(id => protectionMoves.has(toID(id)));
				const canReceive = incoming < actor.hp && (protection || 2 * incoming < actor.hp);
				const safeRecipient = this.state.self.reserve.some(p => !p.fainted && p.hpPercent < 65 &&
					p.hp > this.entryDamage(p) + this.incomingRisk(p, predictions));
				add(this.state.self.conditions.wishes?.[actor.slot] || !needsHealing.length ? -90 :
					canReceive || safeRecipient ? 28 : -65, 'CFRU Wish: heal a surviving recipient after the delay');
			} else if (['healbell', 'aromatherapy'].includes(move.id)) {
				const patients = this.state.self.team.filter(p => !p.fainted && p.status &&
					!(move.id === 'healbell' && effectiveAbility(p, this.state.field) === 'soundproof') &&
					!['guts', 'poisonheal', 'quickfeet'].includes(effectiveAbility(p, this.state.field)));
				add(patients.length ? 20 + 8 * patients.length : -90, 'CFRU cleric: cure useful team status');
			} else if (['reflect', 'lightscreen', 'auroraveil'].includes(move.id)) {
				let reduced = 0;
				for (const [foe, responses] of predictions) for (const response of responses) {
					if (!response.move || response.move.category === 'Status') continue;
					const category = response.move.category;
					if (move.id === 'auroraveil' || category === (move.id === 'reflect' ? 'Physical' : 'Special')) {
						reduced += response.weight * this.damage(response.user || foe, actor, response.move).average *
							this.responseFirst(actor, foe, move, response) * (this.state.isDoubles ? 1 / 3 : 1 / 2);
					}
				}
				add(reduced ? 12 + 30 * reduced / actor.maxHp : -15, 'CFRU screens: prioritize the predicted damage category');
				if (incoming >= actor.hp && incoming - reduced < actor.hp) add(25, 'Screen prevents the predicted KO');
			} else if (move.id === 'substitute') {
				const cost = Math.floor(actor.maxHp / 4);
				let useful = 0;
				for (const response of actions) {
					if (response.switching) { useful += response.weight; continue; }
					if (!response.move) continue;
					const first = this.responseFirst(actor, target, move, response);
					const blocked = response.move.category === 'Status' && response.move.target !== 'self';
					const survives = response.move.category !== 'Status' &&
						this.damage(response.user || target, actor, response.move).max < cost;
					if (!response.move.flags.bypasssub && effectiveAbility(response.user || target, this.state.field) !== 'infiltrator' &&
						(blocked || survives)) useful += response.weight * first;
				}
				add(actor.hp <= cost + beforeDamage ? -90 : 35 * useful - 15,
					'CFRU Substitute: pay HP only for protection or a setup window');
			} else if (data.boosts && data.target === 'self') {
				const useful = Object.entries(data.boosts).some(([stat, boost]) =>
					boost && boost > 0 && actor.boosts[stat as keyof AIPokemon['boosts']] < 6);
				if (!useful) add(-50, 'No useful boost remains');
				else if (this.incomingRisk(actor, predictions) >= actor.hp) add(-65, 'CFRU setup: do not boost into a predicted KO');
				else {
					const switching = actions.reduce((n, a) => n + (a.switching ? a.weight : 0), 0);
					add(24 * switching + (1 - switching) * (incoming < actor.hp / 3 ? 16 : -8),
						'CFRU setup: exploit a switch or low incoming damage');
					if (role === 'setup') add(4, 'Setup fighting style');
				}
			} else if (beforeDamage >= actor.hp && move.target !== 'allySide') {
				add(-65, 'Predicted to faint before using support move');
			}
			if (data.forceSwitch) {
				const boosted = Math.max(target.boosts.atk, target.boosts.spa, target.boosts.spe,
					target.boosts.def, target.boosts.spd);
				const reserves = (this.state.opponent.remaining || 0) > this.state.opponent.active.length ||
					this.state.opponent.reserve.some(p => !p.fainted);
				const hazards = this.state.opponent.conditions;
				const useful = boosted > 0 || hazards.stealthrock || hazards.spikes || hazards.toxicspikes;
				add(!reserves || target.volatiles.has('perish1') ? -50 : useful ? 20 + 8 * Math.max(0, boosted) : -25,
					'CFRU phazing: remove boosts or exploit entry hazards');
			}
			if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(move.id) &&
				this.state.opponent.remaining === 1) add(-80, 'No opposing replacement remains to hit hazards');
			if (move.id === 'defog') {
				const own = this.state.self.conditions;
				const other = this.state.opponent.conditions;
				const helps = own.stealthrock || own.spikes || own.toxicspikes || own.stickyweb ||
					other.reflect || other.lightscreen || other.auroraveil;
				if (!helps) add(-35, 'Defog has no hazards or opposing screens to remove');
			}
			if (role === 'hazards' && ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(move.id)) {
				add(4, 'Entry-hazard fighting style');
			}
			if (role === 'screens' && ['reflect', 'lightscreen', 'auroraveil'].includes(move.id)) {
				add(4, 'Screen support fighting style');
			}
			if (move.category === 'Status' &&
				this.incomingRisk(actor, predictions, undefined, move) >= actor.hp) {
				add(Math.min(result.score, DISCOURAGED_SCORE) - result.score,
					'Support is unsafe before acting across predicted responses');
			}
			if (move.category === 'Status' && beforeDamage >= actor.hp) {
				add(-result.score, 'Cannot use support before the predicted KO');
			}
			if (result.flags.discouraged && !this.recoveryAmount(actor, move)) {
				add(Math.min(result.score, DISCOURAGED_SCORE) - result.score, 'Retain the shared tactical opportunity limit');
			}
			result.score = Math.max(0, result.score);
			result.breakdown.final = result.score;
		}
		return scores;
	}

	entryDamage(pokemon: AIPokemon, conditions = this.state.self.conditions): number {
		return entryHazardDamage(pokemon, conditions, this.state.field);
	}

	/** Plan the immediate recipient as part of choosing a sacrifice, rather than generic replacement ranking. */
	sacrificeRecipient(actor: AIPokemon): { pokemon: AIPokemon, value: number } | undefined {
		return this.state.self.reserve.filter(p => !p.fainted && (!actor.ownerSide || p.ownerSide === actor.ownerSide) &&
			(p.hpPercent < 75 || p.status) && (this.dex.gen <= 4 ? p.hp : p.maxHp) > this.entryDamage(p)).map(pokemon => {
			const healed = { ...pokemon, hp: pokemon.maxHp, hpPercent: 100, status: '', sleepTurns: 0 };
			const evaluation = this.scoreSwitch(healed, this.predictions(healed), true);
			const value = 80 * (1 - pokemon.hp / pokemon.maxHp) + (pokemon.status ? 20 : 0) +
				Math.min(15, Math.max(-30, evaluation.score / 2));
			return { pokemon, value };
		}).sort((a, b) => b.value - a.value)[0];
	}

	/** Replacement value combines entry cost, attainable damage, initiative and survival. */
	scoreSwitch(pokemon: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>, forced: boolean,
		actor?: AIPokemon): SwitchEvaluation {
		if (actor && this.state.self.active.includes(actor)) {
			const state = replaceActivePokemon(this.state, actor, pokemon);
			return new HardEvaluation(state, this.formatId).scoreSwitch(pokemon, predictions, forced, actor);
		}
		const hazards = this.entryDamage(pokemon);
		const entered = { ...pokemon, hp: Math.max(0, pokemon.hp - hazards) };
		entered.hpPercent = 100 * entered.hp / entered.maxHp;
		const allies = this.state.self.active.filter(p => p !== actor && p !== pokemon);
		const incoming = forced ? 0 : this.incomingRisk(entered, predictions, allies, undefined, true);
		const afterHit = { ...entered, hp: entered.hp - incoming };
		const remaining = forced ? afterHit.hp : getEffectiveHpAfterSecondary(afterHit, this.state.field.weather,
			this.state.opponent.active.some(p => effectiveAbility(p, this.state.field) === 'baddreams') ? 'baddreams' : '',
			this.state.field);
		const reasons = [`Entry hazards ${hazards} HP; predicted switch-in damage ${incoming.toFixed(1)} HP`];
		let score = -25 * hazards / pokemon.maxHp - 35 * incoming / Math.max(1, pokemon.hp);
		if (remaining <= 0) {
			return { pokemon, score: score - 100, safe: false,
				reasons: [...reasons, 'Would faint on entry, to the predicted attack, or to residual damage'] };
		}
		if (!forced && actor && this.state.self.conditions.wishes?.[actor.slot] === 1) {
			const healing = Math.min(pokemon.maxHp - remaining, actor.maxHp / 2);
			score += 40 * healing / pokemon.maxHp;
			reasons.push(`Wish recipient can recover ${healing.toFixed(1)} HP after surviving entry`);
		}
		let hasFollowUp = false;
		const nextTurn = { ...entered, hp: remaining, hpPercent: 100 * remaining / entered.maxHp };
		// The entry attack is already committed; the following turn can target the replacement.
		const nextPredictions = this.predictions(nextTurn);
		const matchups: number[] = [];
		for (const foe of this.state.opponent.active.filter(p => !p.fainted)) {
			const moves = pokemon.moves.map((id, i) => hardMove(id, i + 1, this.formatId));
			const responses = nextPredictions.get(foe) || [];
			if (moves.some(move => move.category !== 'Status' &&
				this.damage(nextTurn, foe, move).average >= Math.min(foe.hp, foe.maxHp / 10) &&
				this.incomingRisk(nextTurn, nextPredictions, allies, move) < remaining)) hasFollowUp = true;
			// A replacement only earns offensive value for damage it can deliver before fainting.
			let matchup = Math.max(0, ...moves.filter(move => move.category !== 'Status').map(move =>
				responses.reduce((value, response) => {
					const user = response.user || foe;
					const damage = this.damage(nextTurn, user, move).average;
					const retaliation = response.move ? this.damage(user, nextTurn, response.move, allies).average : 0;
					const first = this.responseFirst(nextTurn, foe, move, response);
					const available = retaliation >= remaining ? first : 1;
					const progress = Math.min(1, damage / Math.max(1, user.hp));
					return value + response.weight * available * (12 * progress +
						(damage >= user.hp ? 31 : damage * 2 >= user.hp && retaliation * 2 < remaining ? 8 : 0));
				}, 0)));
			if (moves.some(move => this.recoveryAmount(nextTurn, move) &&
				this.recoveryOutlook(nextTurn, move, nextPredictions).survival >= 0.85)) hasFollowUp = true;
			const attacking = moves.filter(move => move.category !== 'Status').sort((a, b) =>
				this.damage(nextTurn, foe, b).average - this.damage(nextTurn, foe, a).average)[0];
			let first = 0, resisted = 0, lost = 0;
			for (const response of responses) {
				if (!response.move) continue;
				const user = response.user || foe;
				const damage = this.damage(user, nextTurn, response.move, allies);
				const order = attacking ? this.responseFirst(nextTurn, foe, attacking, response) : 0;
				first += response.weight * order;
				if (response.move.category !== 'Status' && (damage.effectiveness < 1 || damage.average === 0)) {
					resisted += response.weight;
				}
				if (damage.average >= remaining) {
					const finish = attacking && this.damage(nextTurn, user, attacking).average >= user.hp;
					lost += response.weight * (finish ? 1 - order : 1);
				}
			}
			matchup += 14 * first + 17 * resisted - 39 * lost;
			matchups.push(matchup);
		}
		score += matchups.length ? Math.min(...matchups) : 0;
		reasons.push(`CFRU replacement matchup score ${score.toFixed(1)}`);
		return { pokemon, score, safe: true, hasFollowUp, reasons };
	}

	/** Return a reason only when switching beats a useful action, with urgent effects bypassing cooldown. */
	switchReason(actor: AIPokemon, bestMove: MoveScore, replacement: SwitchEvaluation,
		predictions: Map<AIPokemon, PredictedAction[]>, coolingDown: boolean): string | null {
		if (!replacement.safe) return null;
		if (actor.volatiles.has('perish1') || actor.volatiles.has('perish0')) {
			return 'CFRU Perish Song: escape the final countdown';
		}
		const incoming = this.incomingRisk(actor, predictions);
		const move = bestMove.move;
		const foes = this.state.opponent.active.filter(p => !p.fainted);
		// High-confidence first-strike finishes take precedence over preserving HP.
		if (foes.length === 1 && this.attackOutlook(actor, foes[0], move, predictions).finish >= 0.8) return null;

		if (foes.length === 1 && move.accuracy === 100 && !bestMove.flags.hasNoEffect && !bestMove.flags.isImmune &&
			getEffectiveHpAfterSecondary(actor, this.state.field.weather, effectiveAbility(foes[0], this.state.field),
				this.state.field) > 0 && (predictions.get(foes[0]) || []).every(response =>
			response.switching || flinchesOnHit(actor, response.user || foes[0], move, this.state.field) &&
			this.damage(actor, response.user || foes[0], move).average > 0 &&
			(!response.move || this.responseFirst(actor, foes[0], move, response) === 1))) {
			return null;
		}

		if (this.state.self.conditions.wishes?.[actor.slot] === 1 &&
			actor.hpPercent >= 65 && replacement.pokemon.hpPercent < 65) {
			return 'CFRU Wish: pass delayed recovery to a safe injured teammate';
		}
		const foeAbility = foes[0] ? effectiveAbility(foes[0], this.state.field) : '';
		const recovery = this.recoveryAmount(actor, move) ? this.recoveryOutlook(actor, move, predictions) : undefined;
		const curesAttrition = (move.id === 'rest' || recoveryCuresStatus(move)) && recovery && recovery.survival >= 0.85;
		if (!curesAttrition && needsResidualReset(actor, this.state.field, foeAbility) && replacement.score > -20) {
			return 'CFRU residual damage: reset escalating attrition before spending another turn';
		}
		if (bestMove.score >= 115 && recovery && recovery.survival >= 0.85 && recovery.recovered > 0) return null;
		if (bestMove.score <= DISCOURAGED_SCORE && (replacement.score >= 0 || replacement.hasFollowUp)) {
			return 'CFRU no useful action: leave an unproductive matchup';
		}
		if (bestMove.score >= 115 && protectsPendingWish(this.state, actor, move)) return null;
		if (move.category === 'Status' && bestMove.score > 60 && !bestMove.flags.hasNoEffect && !bestMove.flags.isImmune &&
			this.dex.moves.get(move.id).selfSwitch && (move.accuracy === true || move.accuracy === 100) &&
			this.incomingRisk(actor, predictions, undefined, move) < actor.hp) {
			// Support pivots leave without contact/recoil damage; damaging pivots need that extra risk assessment.
			return null;
		}
		if (incoming >= actor.hp && replacement.score > -20) {
			return 'CFRU avoid death: a surviving replacement can take the predicted move';
		}
		if (coolingDown) return null;
		const ability = effectiveAbility(actor, this.state.field);
		const item = effectiveItem(actor, this.state.field);
		const locked = !!actor.lastMove &&
			['choiceband', 'choicespecs', 'choicescarf'].includes(item);
		if (locked && bestMove.score < 110 && replacement.score >= 0) {
			return 'CFRU locked move: leave an ineffective choice lock';
		}
		if (actor.status === 'slp' && !actor.moves.some(id => ['sleeptalk', 'snore'].includes(toID(id))) &&
			incoming >= actor.hp / 3 && replacement.score >= 14) {
			return 'CFRU sleep: avoid giving away another damaging turn';
		}

		if (actor.volatiles.has('yawn') && !actor.status && actor.hpPercent > 25 &&
			!['naturalcure', 'earlybird', 'shedskin', 'insomnia', 'vitalspirit'].includes(ability) &&
			!['lumberry', 'chestoberry'].includes(item) &&
			!actor.moves.some(id => ['sleeptalk', 'snore'].includes(toID(id))) && replacement.score >= 0) {
			return 'CFRU Yawn: avoid sleep';
		}
		if (ability === 'naturalcure' && actor.status &&
			this.entryDamage(actor) < actor.maxHp / 4 && replacement.score >= 0) {
			return 'CFRU Natural Cure: clear status safely';
		}
		if (ability === 'regenerator' && actor.hpPercent <= 50 && incoming >= actor.hp / 2 &&
			this.entryDamage(actor) < actor.maxHp / 3 && replacement.score >= 0) {
			return 'CFRU Regenerator: preserve a threatened attacker';
		}
		if (bestMove.score < 100 && replacement.score >= 14) return 'CFRU bad moves: switch to a better matchup';
		const attackingStats = new Set(actor.moves.map(id => this.dex.moves.get(id).category)
			.filter(category => category !== 'Status').map(category => category === 'Physical' ? 'atk' : 'spa'));
		if (attackingStats.size && [...attackingStats].every(stat => actor.boosts[stat] <= -2) &&
			replacement.score >= 14) {
			return 'CFRU offensive drops: reset weakened offenses';
		}
		if (incoming >= actor.hp / 2 && replacement.score >= 31 &&
			Math.max(actor.boosts.atk, actor.boosts.spa, actor.boosts.spe) <= 0) {
			return 'CFRU preserve sweeper: prefer a safe replacement with KO pressure';
		}
		return null;
	}
}
