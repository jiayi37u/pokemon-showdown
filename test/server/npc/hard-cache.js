'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { DamageCache, calculateDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { prepareResidualEffects, fixedDamageKnockoutTurns, getEffectiveHpAfterSecondary } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
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
	it('reuses residual effects while preserving HP caps and an earlier weather KO', () => {
		const { state } = fixture();
		const actor = state.self.active[0];
		Object.assign(actor, { hp: 160, maxHp: 160, hpPercent: 100, item: 'leftovers', status: 'psn' });
		const events = prepareResidualEffects(actor, 'sand', '', state.field);
		const hpAfter = hp => getEffectiveHpAfterSecondary({ ...actor, hp, hpPercent: hp / 1.6 },
			'sand', '', state.field, Infinity, 0, events);
		assert.equal(hpAfter(160), 140);
		assert.equal(hpAfter(80), 60);
		assert.equal(hpAfter(10), 0, 'Leftovers cannot revive an earlier sandstorm KO');
		assert.equal(hpAfter(0), 0);
		const healthy = { ...actor, status: '' };
		const healing = prepareResidualEffects(healthy, '', '', state.field);
		assert.equal(getEffectiveHpAfterSecondary(healthy, '', '', state.field, Infinity, 0, healing), 160);
		assert.equal(getEffectiveHpAfterSecondary({ ...healthy, hp: 155 }, '', '', state.field, Infinity, 0, healing), 160);
	});
	it('matches ordered residuals across healing caps, Wish and partial-turn cutoffs', () => {
		const { state } = fixture();
		for (const [weather, item, ability, status] of [
			['sand', 'leftovers', 'synchronize', 'tox'], ['', 'blacksludge', 'synchronize', 'brn'],
			['rain', '', 'dryskin', 'slp'], ['hail', 'leftovers', 'icebody', 'psn'],
			['sun', 'stickybarb', 'magicguard', 'tox'], ['', '', 'poisonheal', 'tox'],
		]) {
			const actor = { ...state.self.active[0], maxHp: 160, item, ability, status, toxicCounter: 3,
				volatiles: new Set(['leechseed', 'partiallytrapped', 'curse', 'nightmare', 'saltcure']) };
			const field = { ...state.field, weather, terrain: 'grassy' };
			for (const wish of [0, 351.5]) {
				const effects = prepareResidualEffects(actor, weather, 'baddreams', field, wish);
				for (const hp of [0, 1, 9, 10, 11, 80, 159, 160]) {
					const pokemon = { ...actor, hp, hpPercent: 100 * hp / actor.maxHp };
					for (const before of [2, 8, 13, Infinity]) {
						assert.equal(getEffectiveHpAfterSecondary(pokemon, weather, 'baddreams', field, before, wish, effects),
							getEffectiveHpAfterSecondary(pokemon, weather, 'baddreams', field, before, wish));
					}
				}
			}
		}
	});
	it('preserves a Wish cap followed by poison and the Perish Song cutoff', () => {
		const { state } = fixture();
		const actor = { ...state.self.active[0], hp: 50, maxHp: 100, hpPercent: 50,
			status: 'tox', toxicCounter: 9, item: '', volatiles: new Set() };
		const effects = prepareResidualEffects(actor, '', '', state.field, 200);
		assert.deepEqual(effects, { change: 140, ceiling: 40, knockoutThreshold: 0 });
		assert.equal(getEffectiveHpAfterSecondary(actor, '', '', state.field, Infinity, 200, effects), 40);
		assert.equal(fixedDamageKnockoutTurns(100, 50, effects), 2,
			'The healing cap leaves a second-hit KO despite the positive uncapped recovery');
		actor.volatiles.add('perish0');
		assert.equal(getEffectiveHpAfterSecondary(actor, '', '', state.field, Infinity, 200, effects), 0);
		assert.equal(getEffectiveHpAfterSecondary(actor, '', '', state.field, 9, 200, effects), 100);
	});
	it('finishes before the final Leftovers recovery and matches fixed-event turn settlement', () => {
		const { state } = fixture();
		const actor = { ...state.self.active[0], maxHp: 394, item: 'leftovers', status: '', volatiles: new Set() };
		const effects = prepareResidualEffects(actor, '', '', state.field);
		assert.equal(fixedDamageKnockoutTurns(394, 100, effects), 5);
		assert.equal(fixedDamageKnockoutTurns(394, 24, effects), Infinity);
		for (const status of ['', 'tox', 'brn']) {
			actor.status = status; actor.toxicCounter = 3;
			const fixed = prepareResidualEffects(actor, '', '', state.field);
			for (const initial of [1, 90, 166, 394]) for (const damage of [0, 24, 63.8125, 100, 394]) {
				let hp = initial, turns = 0;
				const seen = new Set();
				while (hp > 0) {
					if (seen.has(hp)) { turns = Infinity; break; }
					seen.add(hp); turns++;
					hp -= damage;
					if (hp > 0) hp = getEffectiveHpAfterSecondary({ ...actor, hp, hpPercent: 100 * hp / actor.maxHp },
						'', '', state.field);
				}
				assert.equal(fixedDamageKnockoutTurns(initial, damage, fixed), turns);
			}
		}
	});
	it('keeps the opposing ability in residual facts across repeated matchup queries', () => {
		const { state } = fixture();
		state.self.active[0].status = 'slp';
		const foe = state.opponent.active[0], evaluator = new MatchupEvaluator();
		const sustain = ability => {
			foe.ability = ability;
			const result = evaluator.pairs(state, [[0, 0]])[0];
			assert.deepEqual(result, new MatchupEvaluator().pairs(state, [[0, 0]])[0]);
			return result.self.sustain;
		};
		assert.equal(sustain('noguard'), 1);
		assert(sustain('baddreams') < 1);
		assert.equal(sustain('noguard'), 1);
	});
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
	for (const gen of [3, 4, 6, 9]) {
		it(`reuses ordinary attacks across attacker HP changes in gen ${gen}`, () => {
			const { state, cache, hit } = fixture(gen);
			const actor = state.self.active[0], original = hit(), misses = cache.stats.misses;
			for (const amount of [Math.floor(actor.maxHp / 3), 1, actor.maxHp]) {
				actor.hp = amount; actor.hpPercent = 100 * amount / actor.maxHp;
				assert.equal(hit().rolls, original.rolls);
				assert.deepEqual(hit(), hit('psychic', false));
			}
			assert.equal(cache.stats.misses, misses);
		});
		it(`retains the HP threshold only for a matching low-health ability in gen ${gen}`, () => {
			const { state, cache, hit } = fixture(gen, 'Charizard', 'Blaze');
			const actor = state.self.active[0], full = hit('fireblast');
			actor.hp = Math.floor(actor.maxHp / 3) + 1;
			assert.equal(hit('fireblast').average, full.average);
			actor.hp--;
			const low = hit('fireblast');
			assert(low.average > full.average);
			assert.deepEqual(low, hit('fireblast', false));
			const unrelated = hit(), misses = cache.stats.misses;
			actor.hp = actor.maxHp;
			assert.equal(hit().rolls, unrelated.rolls, 'Blaze does not make Psychic depend on HP');
			assert.equal(cache.stats.misses, misses);
			assert.equal(hit('fireblast').rolls, full.rolls);
		});
	}
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
	for (const inferred of [false, true]) it(`reuses ${inferred ? 'inferred' : 'known'} snapshot profiles without stale branch inputs`, () => {
		const { state } = fixture();
		const target = state.opponent.active[0]; target.itemKnown = false; target.item = 'Leftovers';
		if (inferred) target.presetModels = [{ name: 'candidate', pokemon: { ...target, item: 'Leftovers' },
			weight: 1, matched: true, moves: [{ id: 'splash', availability: 1 }] }];
		snapshotPosition(state);
		const before = modelsFor(target); assert.equal(before[0].pokemon.item, 'Leftovers');
		assert.equal(modelsFor(target), before);
		const next = clonePosition(state), changed = next.opponent.active[0];
		changed.item = 'Life Orb'; changed.itemKnown = true;
		assert.equal(modelsFor(changed)[0].pokemon.item, 'Life Orb');
		assert.equal(modelsFor(target)[0].pokemon.item, 'Leftovers');
	});
	it('shares weighted matchup results only for the same ordered model inputs', () => {
		const state = clonePosition(fixture().state);
		const target = state.opponent.active[0];
		target.presetModels = [0.25, 0.75].map((weight, i) => ({ name: String(i), weight, matched: true,
			pokemon: { ...target, baseStats: { ...target.baseStats, atk: i ? 350 : 100 } },
			moves: [{ id: 'closecombat', availability: 1 }] }));
		const before = structuredClone(state), evaluator = new MatchupEvaluator();
		const pair = evaluator.pairs(state, [[0, 0]])[0], next = clonePosition(state);
		next.field.weatherTurns--;
		assert.equal(evaluator.pairs(next, [[0, 0]])[0], pair, 'Field clocks do not change a stationary matchup');
		assert.deepEqual(state, before, 'Reusing a weighted result does not mutate its inputs');
		target.presetModels = target.presetModels.map((model, i) => ({ ...model, weight: i ? 0.25 : 0.75 }));
		const changed = evaluator.pairs(state, [[0, 0]])[0];
		assert.notEqual(changed, pair, 'Different weights cannot alias a cached weighted result');
		assert.deepEqual(changed, new MatchupEvaluator().pairs(state, [[0, 0]])[0]);
		target.presetModels.reverse();
		assert.notEqual(evaluator.pairs(state, [[0, 0]])[0], changed, 'Summation order remains part of the key');
		assert.deepEqual(evaluator.assess(state), new MatchupEvaluator().assess(state));
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
