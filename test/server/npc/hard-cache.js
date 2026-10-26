'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { DamageCache, calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { advancePosition, clonePosition, snapshotPosition, modelsFor } = require('../../../dist/server/npc/ai/hard/projection');

describe('Hard battle calculation caches', () => {
	const battles = [];
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function fixture(gen = 6, species = 'Mew', ability = 'Synchronize') {
		const battle = new Battle({ formatid: `gen${gen}customgame`, seed: '1,2,3,4',
			p1: { name: 'Own', team: [{ species, ability, moves: ['psychic', 'waterpulse', 'eruption'] }] },
			p2: { name: 'Foe', team: [{ species: 'Machamp', ability: 'No Guard', moves: ['splash'] }] } });
		battles.push(battle); battle.makeChoices();
		const state = projectedState(battle), cache = new DamageCache();
		const hit = (id = 'psychic', cached = true) => calculateDamage(state.self.active[0], state.opponent.active[0],
			hardMove(id, 1, state.field.formatId), state.field, undefined, {
				cache: cached ? cache : undefined,
				attackerSideConditions: state.self.conditions, defenderSideConditions: state.opponent.conditions,
			});
		return { state, cache, hit };
	}
	it('reuses rolls across target HP and public history changes but recalculates KO flags', () => {
		const { state, cache, hit } = fixture();
		const before = hit(), misses = cache.stats.misses;
		assert(!before.guaranteedKO);
		const target = state.opponent.active[0];
		target.hp = 1; target.hpPercent = 100 / target.maxHp;
		target.lastMove = 'splash'; target.activeMoveActions++;
		state.turn++; state.field.weatherTurns--; state.field.trickroomTurns--;
		state.opponent.conditions.spikes = 3;
		const after = hit();
		assert.equal(after.rolls, before.rolls);
		assert.equal(cache.stats.misses, misses);
		assert(after.guaranteedKO);
		assert.deepEqual(after, hit('psychic', false));
	});
	it('retains old damage when weather, stats or item hypotheses change and later recur', () => {
		const { state, cache, hit } = fixture();
		const actor = state.self.active[0], original = hit('waterpulse');
		const item = actor.item, known = actor.itemKnown;
		state.field.weather = 'rain'; state.field.weatherId = 'raindance'; state.field.weatherTurns = 5;
		const rain = hit('waterpulse');
		assert(rain.average > original.average);
		state.field.weatherTurns = 2;
		assert.equal(hit('waterpulse').rolls, rain.rolls, 'Weather duration is not hit damage');
		state.field.weather = ''; state.field.weatherId = ''; state.field.weatherTurns = -1;
		assert.equal(hit('waterpulse').rolls, original.rolls);
		actor.boosts.spa = 2;
		assert(hit('waterpulse').average > original.average);
		actor.boosts.spa = 0;
		actor.item = 'Choice Specs'; actor.itemKnown = true;
		assert(hit('waterpulse').average > original.average);
		actor.item = item; actor.itemKnown = known;
		assert.equal(hit('waterpulse').rolls, original.rolls);
		assert.equal(cache.stats.entries, 4);
	});
	for (const gen of [3, 6, 9]) {
		it(`matches uncached damage across HP-dependent mechanics in gen ${gen}`, () => {
			const { state, hit } = fixture(gen, 'Charizard', 'Blaze');
			const actor = state.self.active[0], target = state.opponent.active[0];
			for (const id of ['eruption', 'flail', 'fireblast', 'waterspout', 'superfang', 'endeavor', 'hiddenpowerice']) {
				for (const ownHP of [actor.maxHp, Math.floor(actor.maxHp / 4), 1, actor.maxHp]) {
					for (const foeHP of [target.maxHp, Math.floor(target.maxHp / 2), 1]) {
						actor.hp = ownHP; target.hp = foeHP;
						actor.hpPercent = 100 * ownHP / actor.maxHp; target.hpPercent = 100 * foeHP / target.maxHp;
						assert.deepEqual(hit(id), hit(id, false), `${id}: ${ownHP}/${foeHP}`);
					}
				}
			}
		});
	}
	it('tracks full-health defensive abilities without caching their damage at lower HP', () => {
		const { state, hit } = fixture();
		const target = state.opponent.active[0]; target.ability = 'Multiscale';
		const full = hit(); target.hp--;
		const damaged = hit();
		assert(damaged.average > full.average);
		assert.deepEqual(damaged, hit('psychic', false));
		target.hp = target.maxHp;
		assert.equal(hit().rolls, full.rolls);
	});
	it('keeps immunity checks live even when a damage roll is reusable', () => {
		const { state, cache, hit } = fixture();
		const damage = hit(), misses = cache.stats.misses;
		// Type immunity is a public interaction, separate from calculator roll reuse.
		state.opponent.active[0].types = ['Dark'];
		assert.equal(hit().average, 0);
		state.opponent.active[0].types = ['Fighting'];
		assert.equal(hit().rolls, damage.rolls);
		assert.equal(cache.stats.misses, misses);
	});
	it('shares one battle cache between matchups, hard scoring and turn projection', () => {
		const { state } = fixture();
		const matchups = new MatchupEvaluator(), actor = state.self.active[0], target = state.opponent.active[0];
		const move = hardMove('psychic', 1, state.field.formatId);
		matchups.attack(state, actor, target, move);
		const misses = matchups.damageCache.stats.misses;
		const model = { name: 'known', pokemon: target, weight: 1, matched: true,
			moves: target.moves.map(id => ({ id, availability: 1 })) };
		const evaluation = new HardEvaluation(state, state.field.formatId, new Map([[target, [model]]]), matchups.damageCache);
		evaluation.damage(actor, target, move);
		const sharedHits = matchups.damageCache.stats.hits;
		evaluation.baseScores(state, actor, [move], target);
		assert(matchups.damageCache.stats.hits > sharedHits, 'Base scoring uses the same cached calculator result');
		advancePosition(state, { id: 'move 1', move: 'psychic', prior: 100 },
			{ id: 'move 1', move: 'splash', prior: 100 }, () => undefined, 'mean', matchups.damageCache);
		assert.equal(matchups.damageCache.stats.misses, misses);
		assert(matchups.damageCache.stats.hits >= 2);
		const independent = new MatchupEvaluator();
		assert.equal(independent.damageCache.stats.entries, 0, 'Another battle owns an independent cache');
	});
	it('reuses immutable snapshot profiles while recomputing changed branch inputs', () => {
		const { state } = fixture();
		const target = state.opponent.active[0]; target.itemKnown = false;
		target.presetModels = [{ name: 'candidate', pokemon: { ...target, item: 'Leftovers' },
			weight: 1, matched: true, moves: [{ id: 'splash', availability: 1 }] }];
		snapshotPosition(state);
		const before = modelsFor(target); assert.equal(before[0].pokemon.item, 'Leftovers');
		assert.equal(modelsFor(target), before);
		const next = clonePosition(state), changed = next.opponent.active[0];
		changed.item = 'Life Orb'; changed.itemKnown = true;
		assert.equal(modelsFor(changed)[0].pokemon.item, 'Life Orb');
		assert.equal(modelsFor(target)[0].pokemon.item, 'Leftovers');
	});
	it('keeps the battle cache and hypotheses when scoring a replacement perspective', () => {
		const { state, cache } = fixture();
		const original = state.self.active[0], target = state.opponent.active[0];
		const entrant = { ...original, ident: 'p1: Reserve', slot: 2, active: false };
		state.self.team.push(entrant); state.self.reserve.push(entrant);
		const model = { name: 'known', pokemon: target, weight: 1, matched: true,
			moves: target.moves.map(id => ({ id, availability: 1 })) };
		const evaluator = new HardEvaluation(state, state.field.formatId, new Map([[target, [model]]]), cache);
		const predictions = evaluator.predictions(original), before = cache.stats.hits + cache.stats.misses;
		evaluator.scoreSwitch(entrant, predictions, false, original);
		assert(cache.stats.hits + cache.stats.misses > before, 'Nested replacement evaluator uses the caller cache');
	});
	it('injects one damage provider into primary scoring and status-turn threat checks', () => {
		const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
		const { createCache } = require('../../../dist/server/npc/ai/cfru/util/cache');
		const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
		const { state, cache } = fixture();
		const actor = state.self.active[0], foe = state.opponent.active[0];
		foe.moves = ['closecombat'];
		const calls = [];
		const provider = (a, b, m, field, unused, context) => {
			calls.push([a.ident, b.ident, m.id]);
			return calculateDamage(a, b, m, field, unused, { ...context, cache });
		};
		const engine = new ScoringEngine({ ...DEFAULT_AI_CONFIG, formatId: state.field.formatId }, createCache(state.turn), provider);
		engine.scoreMove(state, actor, hardMove('psychic', 1, state.field.formatId), foe);
		engine.scoreMove(state, actor, hardMove('calmmind', 1, state.field.formatId), foe);
		assert(calls.some(([a, b, m]) => a === actor.ident && b === foe.ident && m === 'psychic'));
		assert(calls.some(([a, b, m]) => a === foe.ident && b === actor.ident && m === 'closecombat'));
	});
});
