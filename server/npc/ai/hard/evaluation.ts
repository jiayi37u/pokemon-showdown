/**
 * Hard-only CFRU strategy adaptations. Normal's rule registration and thresholds stay unchanged.
 * Sources: ai_advanced.c (roles/recovery/protect/setup), ai_positives.c (Taunt),
 * ai_switching.c (safe replacements, absorption, Natural Cure/Regenerator, Yawn, Perish Song).
 * This is a bounded heuristic evaluator, not a simulator or an exhaustive CFRU port.
 */
import { Dex, toID } from '../../../../sim/dex';
import { DEFAULT_AI_CONFIG, type AIPokemon, type AIMove, type BattleState, type MoveScore } from '../cfru/types';
import { ScoringEngine, allNegativeScorers, allPositiveScorers } from '../cfru/scoring';
import {
	rewardSetupMove, rewardDefensiveSetup, rewardHealing, rewardTaunt, rewardPivotMove, rewardScreens,
} from '../cfru/scoring/positives';
import { createCache } from '../cfru/util/cache';
import { calculateDamage, getSecondaryEffectDamage } from '../cfru/util/damage-calc';
import { getEffectiveSpeed } from '../cfru/util/speed';
import {
	fightingStyle, hardMove, inferOpponent, predictOpponent, type OpponentHypothesis, type PredictedAction,
} from './opponent-model';

const replacedRewards = new Set([
	rewardSetupMove, rewardDefensiveSetup, rewardHealing, rewardTaunt, rewardPivotMove, rewardScreens,
]);
const protectionMoves = new Set([
	'protect', 'detect', 'kingsshield', 'spikyshield', 'banefulbunker', 'silktrap', 'burningbulwark',
]);

export interface SwitchEvaluation {
	pokemon: AIPokemon;
	score: number;
	safe: boolean;
	reasons: string[];
}

export class HardEvaluation {
	readonly dex: ReturnType<typeof Dex.forFormat>;
	readonly state: BattleState;
	readonly formatId: string;
	private models = new Map<AIPokemon, OpponentHypothesis[]>();
	private opposing = new Set<AIPokemon>();
	constructor(state: BattleState, formatId: string) {
		this.state = state;
		this.formatId = formatId;
		this.dex = formatId ? Dex.forFormat(formatId) : Dex;
		for (const foe of state.opponent.team) {
			const models = inferOpponent(foe, formatId);
			this.models.set(foe, models);
			this.opposing.add(foe);
			for (const model of models) this.opposing.add(model.pokemon);
		}
	}

	private baseScores(
		state: BattleState, actor: AIPokemon, moves: AIMove[], target: AIPokemon, prediction = false
	): MoveScore[] {
		// Each perspective/target gets its own cache; slot numbers overlap between sides.
		const config = { ...DEFAULT_AI_CONFIG, formatId: this.formatId, isDoubles: state.isDoubles };
		const engine = new ScoringEngine(config, createCache(state.turn));
		if (!prediction) engine.setScorers(allNegativeScorers, allPositiveScorers.filter(fn => !replacedRewards.has(fn)));
		return engine.scoreMoves(state, actor, moves, target);
	}

	predictions(actor: AIPokemon): Map<AIPokemon, PredictedAction[]> {
		return new Map(this.state.opponent.active.filter(p => !p.fainted).map(foe => [foe,
			predictOpponent(this.state, foe, actor, this.formatId, (state, attacker, moves, target) =>
				this.baseScores(state, attacker, moves, target, true), this.models.get(foe)),
		]));
	}

	/** Priority and speed order, including speed ties (50%, never a guaranteed first strike). */
	first(actor: AIPokemon, foe: AIPokemon, move: AIMove, response: AIMove): number {
		const priority = (p: AIPokemon, m: AIMove) => m.priority +
			(toID(p.ability) === 'prankster' && m.category === 'Status' ? 1 : 0) +
			(toID(p.ability) === 'galewings' && m.type === 'Flying' && p.hp === p.maxHp ? 1 : 0) +
			(toID(p.ability) === 'triage' && m.flags.heal ? 3 : 0);
		const delta = priority(actor, move) - priority(foe, response);
		if (delta) return delta > 0 ? 1 : 0;
		const ownSide = !this.opposing.has(actor);
		const a = getEffectiveSpeed(actor, this.state.field, this.state[ownSide ? 'self' : 'opponent'].conditions);
		const b = getEffectiveSpeed(foe, this.state.field, this.state[ownSide ? 'opponent' : 'self'].conditions);
		if (a === b) return 0.5;
		return (a > b) !== this.state.field.trickroom ? 1 : 0;
	}

	damage(actor: AIPokemon, target: AIPokemon, move: AIMove) {
		const models = this.models.get(target);
		if (!models?.length) return this.rawDamage(actor, target, move);
		const values = models.map(model => ({ model, result: this.rawDamage(actor, model.pokemon, move),
			scale: target.maxHp / model.pokemon.maxHp }));
		const average = values.reduce((n, v) => n + v.model.weight * v.result.average * v.scale, 0);
		return { ...values[0].result, average,
			min: Math.min(...values.map(v => v.result.min * v.scale)),
			max: Math.max(...values.map(v => v.result.max * v.scale)),
		};
	}

	private rawDamage(actor: AIPokemon, target: AIPokemon, move: AIMove) {
		const spread = ['allAdjacent', 'allAdjacentFoes'].includes(move.target);
		const foes = this.opposing.has(actor) ? this.state.self.active : this.state.opponent.active;
		const allies = this.opposing.has(actor) ? this.state.opponent.active : this.state.self.active;
		const targets = foes.filter(p => !p.fainted).length +
			(move.target === 'allAdjacent' ? allies.filter(p => p !== actor && !p.fainted).length : 0);
		const result = calculateDamage(actor, target, move, this.state.field, undefined,
			{ isDoubles: this.state.isDoubles && spread, numAliveTargets: targets });
		const conditions = this.state[this.opposing.has(target) ? 'opponent' : 'self'].conditions;
		const screen = conditions.auroraveil || (move.category === 'Physical' ? conditions.reflect : conditions.lightscreen);
		if (!screen || toID(actor.ability) === 'infiltrator' ||
			['brickbreak', 'psychicfangs'].includes(move.id)) return result;
		const factor = this.state.isDoubles ? 2 / 3 : 0.5;
		return { ...result, min: result.min * factor, max: result.max * factor, average: result.average * factor };
	}

	incoming(actor: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>): number {
		let damage = 0;
		for (const [foe, actions] of predictions) {
			for (const action of actions) {
				if (action.move) damage += action.weight * this.damage(action.user || foe, actor, action.move).average;
			}
		}
		return damage;
	}

	/** An upper weighted quantile prevents a likely switch from making a lethal attack look safe. */
	incomingRisk(actor: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>): number {
		let risk = 0;
		for (const [foe, actions] of predictions) {
			const outcomes = actions.map(a => ({ weight: a.weight,
				damage: a.move ? this.damage(a.user || foe, actor, a.move).max : 0,
			})).sort((a, b) => a.damage - b.damage);
			let cumulative = 0;
			for (const outcome of outcomes) {
				cumulative += outcome.weight;
				if (cumulative >= 0.85) { risk += outcome.damage; break; }
			}
		}
		return Math.max(risk, this.incoming(actor, predictions));
	}

	private recoveryAmount(actor: AIPokemon, move: AIMove): number {
		const data = this.dex.moves.get(move.id);
		if (data.heal) return actor.maxHp * data.heal[0] / data.heal[1];
		if (move.id === 'rest') return actor.maxHp;
		const weather = this.state.field.weather;
		if (['synthesis', 'moonlight', 'morningsun'].includes(move.id)) {
			return actor.maxHp * (weather === 'sun' ? 2 / 3 : weather ? 1 / 4 : 1 / 2);
		}
		if (move.id === 'shoreup') return actor.maxHp * (weather === 'sand' ? 2 / 3 : 1 / 2);
		return 0;
	}

	scoreMoves(
		actor: AIPokemon, moves: AIMove[], target: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>
	): MoveScore[] {
		const models = this.models.get(target) || [{ pokemon: target, weight: 1 }];
		const groups = models.map(model => ({ weight: model.weight,
			scores: this.baseScores(this.state, actor, moves, model.pokemon),
		}));
		const scores = groups[0].scores;
		for (let i = 0; i < scores.length; i++) {
			const result = scores[i];
			result.score = groups.reduce((n, group) => n + group.weight * group.scores[i].score, 0);
			result.flags = { ...result.flags,
				isImmune: groups.every(g => g.scores[i].flags.isImmune),
				hasNoEffect: groups.every(g => g.scores[i].flags.hasNoEffect),
			};
			result.breakdown = { ...result.breakdown, final: result.score,
				negatives: groups.reduce((n, g) => n + g.weight * g.scores[i].breakdown.negatives, 0),
				positives: groups.reduce((n, g) => n + g.weight * g.scores[i].breakdown.positives, 0),
				details: [{ amount: result.score - 100, category: 'positive', reason: 'Base score across compatible opponent sets' }],
			};
		}
		const role = fightingStyle(actor, this.formatId);
		for (const result of scores) {
			const { move } = result;
			const data = this.dex.moves.get(move.id);
			const add = (amount: number, reason: string) => {
				result.score += amount;
				result.breakdown.styleAdjust += amount;
				result.breakdown.details.push({ amount, reason, category: 'style' });
			};
			if (result.flags.hasNoEffect || result.flags.isImmune) {
				add(-result.score, 'Move has no effect');
				result.breakdown.final = result.score;
				continue;
			}
			const actions = predictions.get(target) || [];
			const incoming = this.incoming(actor, predictions);
			const outgoing = this.damage(actor, target, move);
			const fakeOut = move.id === 'fakeout';
			const canFlinch = !actor.activeMoveActions && !actor.lastMove &&
				!['innerfocus', 'shielddust'].includes(toID(target.ability)) &&
				!target.volatiles.has('substitute');
			if (fakeOut && (actor.activeMoveActions || actor.lastMove)) {
				add(-result.score, 'Fake Out only works on the first action after entry');
				result.breakdown.final = 0;
				continue;
			}
			let prevented = 0;
			let beforeDamage = 0;
			for (const [foe, responses] of predictions) {
				for (const response of responses) {
					if (!response.move) continue;
					const damage = this.damage(response.user || foe, actor, response.move).average;
					const first = this.first(actor, response.user || foe, move, response.move);
					beforeDamage += response.weight * damage * (1 - first);
					if (foe === target && !target.volatiles.has('substitute') && (outgoing.min >= target.hp || (fakeOut && canFlinch))) {
						prevented += response.weight * damage * first * (move.accuracy === true ? 1 : move.accuracy / 100);
					}
				}
			}
			if (move.category !== 'Status') {
				if (fakeOut && canFlinch) add(22, 'CFRU Fake Out: free damage on entry');
				add(-35 * Math.min(1, Math.max(0, incoming - prevented) / Math.max(1, actor.hp)),
					'Expected damage after accounting for first-strike KO');
				if (beforeDamage >= actor.hp) add(-65, 'Predicted to faint before attacking');
				if (data.selfSwitch && this.state.self.reserve.some(p => !p.fainted)) {
					add(incoming > actor.hp / 2 ? 10 : 3, 'CFRU pivot: deal damage while leaving a bad matchup');
				}
			} else if (this.recoveryAmount(actor, move)) {
				const heal = this.recoveryAmount(actor, move);
				const recovered = Math.min(heal, Math.max(0, actor.maxHp - actor.hp + beforeDamage));
				if (beforeDamage >= actor.hp || actor.hp + recovered <= incoming) {
					add(-result.score, 'CFRU ShouldRecover: healing cannot prevent the predicted KO');
				} else {
					add(30 * recovered / actor.maxHp, 'Recovery value after action order and missing HP');
					if (incoming >= actor.hp && actor.hp + recovered > incoming) {
						add(22, 'Healing prevents the predicted KO');
					}
					if (role === 'stall' || role === 'cleric') add(4, 'Recovery supports this fighting style');
					if (move.id === 'rest' && !['chesto', 'lum'].some(id => toID(actor.item) === `${id}berry`)) {
						add(-8, 'Rest incurs sleep');
					}
				}
			} else if (move.id === 'taunt') {
				let blocked = 0;
				for (const action of actions) {
					if (action.move?.category === 'Status') {
						blocked += action.weight * this.first(actor, action.user || target, move, action.move);
					}
				}
				add(blocked * 25, 'CFRU Taunt: interrupt predicted status action');
				if (target.moves.length && fightingStyle(target, this.formatId) !== 'attacker') {
					add(5, 'Restrict future support/setup actions');
				}
				if (beforeDamage >= actor.hp) add(-70, 'Cannot Taunt before fainting');
			} else if (protectionMoves.has(move.id)) {
				const residual = getSecondaryEffectDamage(target, this.state.field.weather, actor.ability);
				const passiveHeal = actor.hp < actor.maxHp && (toID(actor.item) === 'leftovers' ||
					(toID(actor.item) === 'blacksludge' && actor.types.includes('Poison')));
				const pendingWish = this.state.self.conditions.wish === 1 && actor.hp < actor.maxHp;
				const usefulOrb = !actor.status && ((toID(actor.item) === 'toxicorb' && toID(actor.ability) === 'poisonheal') ||
					(toID(actor.item) === 'flameorb' && toID(actor.ability) === 'guts'));
				const ownResidual = getSecondaryEffectDamage(actor, this.state.field.weather, target.ability);
				add(ownResidual >= actor.hp ? -90 : pendingWish ? 40 :
					residual > 0 || passiveHeal || usefulOrb || target.volatiles.has('yawn') ? 16 : -12,
				'CFRU ShouldProtect: wait only when the turn produces a benefit');
				if (actor.lastMove && protectionMoves.has(toID(actor.lastMove))) {
					add(-35, 'Repeated protection risks failure');
				}
			} else if (move.id === 'wish') {
				const needsHealing = this.state.self.team.filter(p => !p.fainted && p.hpPercent < 65);
				const protection = actor.moves.some(id => protectionMoves.has(toID(id)));
				const canReceive = incoming < actor.hp && (protection || 2 * incoming < actor.hp);
				const safeRecipient = this.state.self.reserve.some(p => !p.fainted && p.hpPercent < 65 &&
					p.hp > this.entryDamage(p) + this.incomingRisk(p, predictions));
				add(this.state.self.conditions.wish || !needsHealing.length ? -90 :
					canReceive || safeRecipient ? 28 : -65, 'CFRU Wish: heal a surviving recipient after the delay');
			} else if (['healbell', 'aromatherapy'].includes(move.id)) {
				const patients = this.state.self.team.filter(p => !p.fainted && p.status &&
					!(move.id === 'healbell' && toID(p.ability) === 'soundproof') &&
					!['guts', 'poisonheal', 'quickfeet'].includes(toID(p.ability)));
				add(patients.length ? 20 + 8 * patients.length : -90, 'CFRU cleric: cure useful team status');
			} else if (['reflect', 'lightscreen', 'auroraveil'].includes(move.id)) {
				let reduced = 0;
				for (const [foe, responses] of predictions) for (const response of responses) {
					if (!response.move || response.move.category === 'Status') continue;
					const category = response.move.category;
					if (move.id === 'auroraveil' || category === (move.id === 'reflect' ? 'Physical' : 'Special')) {
						reduced += response.weight * this.damage(response.user || foe, actor, response.move).average *
							this.first(actor, response.user || foe, move, response.move) * (this.state.isDoubles ? 1 / 3 : 1 / 2);
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
					const first = this.first(actor, response.user || target, move, response.move);
					const blocked = response.move.category === 'Status' && response.move.target !== 'self';
					const survives = response.move.category !== 'Status' &&
						this.damage(response.user || target, actor, response.move).max < cost;
					if (!response.move.flags.bypasssub && toID((response.user || target).ability) !== 'infiltrator' &&
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
			if (move.category === 'Status' && beforeDamage >= actor.hp) {
				add(-result.score, 'Cannot use support before the predicted KO');
			}
			result.score = Math.max(0, result.score);
			result.breakdown.final = result.score;
		}
		return scores;
	}

	entryDamage(pokemon: AIPokemon): number {
		if (['magicguard'].includes(toID(pokemon.ability)) || toID(pokemon.item) === 'heavydutyboots') return 0;
		const conditions = this.state.self.conditions;
		let damage = conditions.stealthrock ? Math.max(1, Math.floor(pokemon.maxHp / 8 *
			2 ** this.dex.getEffectiveness('Rock', pokemon.types))) : 0;
		const grounded = this.state.field.gravity || toID(pokemon.item) === 'ironball' ||
			(!pokemon.types.includes('Flying') && toID(pokemon.ability) !== 'levitate' && toID(pokemon.item) !== 'airballoon');
		if (grounded && conditions.spikes) {
			damage += Math.max(1, Math.floor(pokemon.maxHp * [0, 1 / 8, 1 / 6, 1 / 4][conditions.spikes]));
		}
		return damage;
	}

	/** CFRU replacement weights: KO +31, outspeed +14, resist all +17, 2HKO +2, faint -39. */
	scoreSwitch(pokemon: AIPokemon, predictions: Map<AIPokemon, PredictedAction[]>, forced: boolean): SwitchEvaluation {
		const hazards = this.entryDamage(pokemon);
		const entered = { ...pokemon, hp: Math.max(0, pokemon.hp - hazards) };
		entered.hpPercent = 100 * entered.hp / entered.maxHp;
		const incoming = forced ? 0 : this.incomingRisk(entered, predictions);
		const remaining = entered.hp - incoming;
		const reasons = [`Entry hazards ${hazards} HP; predicted switch-in damage ${incoming.toFixed(1)} HP`];
		let score = -25 * hazards / pokemon.maxHp - 35 * incoming / Math.max(1, pokemon.hp);
		if (remaining <= 0) {
			return { pokemon, score: score - 100, safe: false,
				reasons: [...reasons, 'Would faint on entry or to the predicted attack'] };
		}
		if (!forced && this.state.self.conditions.wish === 1) {
			const healing = Math.min(pokemon.maxHp - remaining, this.state.self.active[0].maxHp / 2);
			score += 40 * healing / pokemon.maxHp;
			reasons.push(`Wish recipient can recover ${healing.toFixed(1)} HP after surviving entry`);
		}
		const matchups: number[] = [];
		for (const foe of this.state.opponent.active.filter(p => !p.fainted)) {
			const moves = pokemon.moves.map((id, i) => hardMove(id, i + 1, this.formatId));
			const best = Math.max(0, ...moves.map(move => this.damage(entered, foe, move).average));
			const responses = predictions.get(foe) || [];
			let matchup = best >= foe.hp ? 31 : best * 2 >= foe.hp ? 2 : 0;
			const attacking = moves.find(move => move.category !== 'Status');
			if (attacking && responses.length &&
				responses.every(r => !r.move || this.first(entered, r.user || foe, attacking, r.move) === 1)) {
				matchup += 14;
			}
			const resistsAll = responses.some(r => r.move && r.move.category !== 'Status') && responses.every(r => {
				if (!r.move || r.move.category === 'Status') return true;
				const damage = this.damage(r.user || foe, entered, r.move);
				return damage.effectiveness < 1 || damage.average === 0;
			});
			if (resistsAll) matchup += 17;
			if (responses.some(r => r.move && this.damage(r.user || foe, entered, r.move).average >= remaining)) matchup -= 39;
			matchups.push(matchup);
		}
		score += matchups.length ? Math.min(...matchups) : 0;
		reasons.push(`CFRU replacement matchup score ${score.toFixed(1)}`);
		return { pokemon, score, safe: true, reasons };
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
		// A safe first-strike KO takes precedence over saving HP, exactly as in CFRU's Regenerator check.
		if (foes.length === 1 && !foes[0].volatiles.has('substitute') &&
			(move.accuracy === true || move.accuracy === 100) && this.damage(actor, foes[0], move).min >= foes[0].hp &&
			(predictions.get(foes[0]) || []).every(a => !a.move || this.first(actor, a.user || foes[0], move, a.move) === 1)) {
			return null;
		}
		if (this.state.self.conditions.wish === 1 && actor.hpPercent >= 65 && replacement.pokemon.hpPercent < 65) {
			return 'CFRU Wish: pass delayed recovery to a safe injured teammate';
		}
		if (bestMove.score >= 115 && this.recoveryAmount(actor, move)) return null;
		if (incoming >= actor.hp && replacement.score > -20) {
			return 'CFRU avoid death: a surviving replacement can take the predicted move';
		}
		if (coolingDown) return null;
		const locked = ['choiceband', 'choicespecs', 'choicescarf'].includes(toID(actor.item)) && !!actor.lastMove;
		if (locked && bestMove.score < 110 && replacement.score >= 0) {
			return 'CFRU locked move: leave an ineffective choice lock';
		}
		if (actor.status === 'slp' && !actor.moves.some(id => ['sleeptalk', 'snore'].includes(toID(id))) &&
			incoming >= actor.hp / 3 && replacement.score >= 14) {
			return 'CFRU sleep: avoid giving away another damaging turn';
		}
		if (getSecondaryEffectDamage(actor, this.state.field.weather, foes[0]?.ability || '') >= actor.maxHp / 4 &&
			replacement.score >= 14 && (actor.status === 'tox' || actor.volatiles.has('leechseed'))) {
			return 'CFRU residual damage: reset escalating attrition';
		}
		if (actor.volatiles.has('yawn') && !actor.status && actor.hpPercent > 25 &&
			!['naturalcure', 'earlybird', 'shedskin', 'insomnia', 'vitalspirit'].includes(toID(actor.ability)) &&
			!['lumberry', 'chestoberry'].includes(toID(actor.item)) &&
			!actor.moves.some(id => ['sleeptalk', 'snore'].includes(toID(id))) && replacement.score >= 0) {
			return 'CFRU Yawn: avoid sleep';
		}
		if (toID(actor.ability) === 'naturalcure' && actor.status &&
			this.entryDamage(actor) < actor.maxHp / 4 && replacement.score >= 0) {
			return 'CFRU Natural Cure: clear status safely';
		}
		if (toID(actor.ability) === 'regenerator' && actor.hpPercent <= 50 && incoming >= actor.hp / 2 &&
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
