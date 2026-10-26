'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { advancePosition, beginTurn, continueTurn, bindOpponent, clonePosition, switchIn, modelsFor, knownMoves, hp, usableMove, actionOutcomes, supportsMove, applyEntryEffects, applyRecovery, boosts } = require('../../../dist/server/npc/ai/hard/projection');
const { searchPosition, Search, optimisticValue, pessimisticValue } = require('../../../dist/server/npc/ai/hard/search');
const { calculateDamage, selectDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { hardMove, hardMoveId } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { selectMoveCandidates } = require('../../../dist/server/npc/ai/cfru/scoring');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const mon = (species, moves, rest = {}) => ({ species, moves, ...rest });
const action = move => ({ id: `move ${move}`, move, prior: 100 });
const battles = [];
function fixture(own, foe) {
	const b = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Own', team: own }, p2: { name: 'Foe', team: foe } });
	battles.push(b); b.makeChoices();
	const state = projectedState(b);
	const evaluator = new HardEvaluation(state, 'gen6customgame');
	evaluator.models = new Map(state.opponent.team.map(p => [p, [{ name: 'observed', pokemon: p, weight: 1,
		matched: true, moves: p.moves.map(id => ({ id, availability: 1 })) }]]));
	return { b, state, evaluator };
}
const step = (state, own, foe, policy) => advancePosition(state, action(own), action(foe),
	(s, side) => s[side].reserve.find(p => !p.fainted), policy);
const damage = (state, id) => calculateDamage(state.self.active[0], state.opponent.active[0], hardMove(id, 1, 'gen6customgame'), state.field);
const scoresFor = (search, state, moves, side = 'self') => Object.fromEntries(
	[...search.scoreActions(state, side, moves.map(action))].map(([a, score]) => [a.move, score.score]));

describe('Hard damage-based state search', () => {
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function compareBounded(f, actions, replacing = false) {
		const run = prune => searchPosition(f.state, f.evaluator, actions.map(a => ({ ...a })), new Map(),
			new MatchupEvaluator(), replacing, { prune });
		const full = run(false), bounded = run(true);
		assert(full.choice, full.reason);
		assert.equal(bounded.choice, full.choice, `${full.reason}\n${bounded.reason}`);
		for (const value of bounded.values) {
			const expected = full.values.find(v => v.id === value.id).value;
			if (value.upperBound) assert(value.value >= expected - 1e-8, `Invalid upper bound for ${value.id}`);
			else if (value.lowerBound) {
				assert(value.value <= expected + 1e-8, `Invalid lower bound for ${value.id}`);
				assert(value.upperValue >= expected - 1e-8, `Invalid winning upper bound for ${value.id}`);
			} else assert(Math.abs(value.value - expected) < 1e-8, `Changed exact value for ${value.id}`);
		}
		assert(bounded.nodes <= full.nodes, 'The optimized search expands a subset of the reference tree');
		return { full, bounded };
	}
	it('matches full search with burns, hazards, random phazing and opposing pivots', () => {
		const f = fixture([mon('Garchomp', ['dragontail', 'toxic', 'stealthrock'], { item: 'Rocky Helmet' }),
			mon('Excadrill', ['earthquake', 'ironhead'], { ability: 'Mold Breaker' }), mon('Volcanion', ['steameruption'])],
		[mon('Rotom-Wash', ['hydropump', 'willowisp', 'voltswitch'], { ability: 'Levitate', item: 'Leftovers' }),
			mon('Tornadus-Therian', ['hurricane', 'uturn'], { ability: 'Regenerator' }), mon('Serperior', ['leafstorm'])]);
		f.state.self.active[0].status = 'brn'; f.state.opponent.conditions.stealthrock = true;
		const actions = ['dragontail', 'toxic', 'stealthrock'].map(action).concat(f.state.self.reserve.map(p =>
			({ id: `switch ${p.slot}`, switchTo: p, prior: 100 })));
		const { full, bounded } = compareBounded(f, actions);
		assert(bounded.nodes < full.nodes, `${full.reason}\n${bounded.reason}`);
	});
	it('preserves shared pivot choices across hidden profiles when bounding continuations', () => {
		const f = fixture([mon('Jolteon', ['voltswitch', 'thunderbolt']), mon('Skarmory', ['ironhead']),
			mon('Garchomp', ['earthquake'])], [mon('Mew', ['earthquake', 'icebeam', 'nastyplot']), mon('Blissey', ['seismictoss'])]);
		const foe = f.state.opponent.active[0];
		foe.presetModels = [0.2, 0.8].map((weight, i) => ({ name: `hidden ${i}`, weight, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, atk: i ? 100 : 300, spa: i ? 300 : 100 } },
			moves: foe.moves.map(id => ({ id, availability: 1 })) }));
		f.evaluator.models.set(foe, foe.presetModels);
		compareBounded(f, ['voltswitch', 'thunderbolt'].map(action));
	});
	it('matches full search through consecutive pivots and hazard KOs with uncertain recipients', () => {
		for (const health of [1, 30, 80]) {
			const f = fixture([mon('Zapdos', ['voltswitch', 'heatwave']), mon('Metagross', ['bulletpunch'])],
				[mon('Rotom-Wash', ['voltswitch', 'hydropump'], { ability: 'Levitate' }),
					mon('Tornadus-Therian', ['uturn', 'hurricane'], { ability: 'Regenerator' }), mon('Serperior', ['leafstorm'])]);
			f.state.opponent.conditions.stealthrock = true;
			hp(f.state.opponent.active[0], 60); hp(f.state.opponent.reserve[0], health);
			const recipient = f.state.opponent.reserve[1];
			recipient.presetModels = [0.2, 0.8].map((weight, i) => ({ name: `spread ${i}`, weight, matched: true,
				pokemon: { ...recipient, baseStats: { ...recipient.baseStats, spd: i ? 250 : 120 } },
				moves: recipient.moves.map(id => ({ id, availability: 1 })) }));
			f.evaluator.models.set(recipient, recipient.presetModels);
			compareBounded(f, ['voltswitch', 'heatwave'].map(action));
		}
	});
	it('preserves replacement decisions and stable ties after work reordering', () => {
		const f = fixture([mon('Magikarp', ['splash']), mon('Mew', ['tackle'], { name: 'First' }),
			mon('Mew', ['tackle'], { name: 'Second' })],
		[mon('Mew', ['tackle'])]);
		hp(f.state.self.active[0], 0);
		const actions = f.state.self.reserve.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 100 }));
		const { bounded } = compareBounded(f, actions, true);
		assert.equal(bounded.choice, actions[0].id);
	});
	it('matches full search when setup, recovery and damage compete for the second action', () => {
		const f = fixture([mon('Mew', ['calmmind', 'psychic', 'recover', 'icebeam']),
			mon('Scizor', ['bulletpunch', 'uturn'])],
		[mon('Garchomp', ['earthquake', 'dragonclaw', 'swordsdance']), mon('Blissey', ['seismictoss', 'softboiled'])]);
		hp(f.state.self.active[0], 170);
		compareBounded(f, ['calmmind', 'psychic', 'recover', 'icebeam'].map(action));
	});
	it('retains the original winner of equal-valued attacking continuations', () => {
		const f = fixture([mon('Mew', ['pound', 'scratch'])], [mon('Blissey', ['tackle', 'pound'])]);
		const { bounded } = compareBounded(f, ['scratch', 'pound'].map(action));
		assert.equal(bounded.choice, 'move scratch');
	});
	it('resumes a partial continuation without treating its upper bound as an exact cached value', () => {
		const f = fixture([mon('Mew', ['icebeam'])], [mon('Garchomp', ['earthquake', 'dragonclaw']),
			mon('Blissey', ['seismictoss'])]);
		const search = new Search(new MatchupEvaluator());
		const work = search.continuation(f.state, action('icebeam'), true);
		search.advanceContinuation(work);
		assert(work.pending.length > 0);
		assert.equal(work.leaves, undefined);
		const upper = work.upper, partialNodes = search.nodes;
		const exact = search.continuationValue(f.state, action('icebeam'));
		assert(upper >= exact - 1e-9);
		assert(search.nodes > partialNodes);
		const nodes = search.nodes;
		assert.equal(search.continuationValue(f.state, action('icebeam')), exact);
		assert.equal(search.nodes, nodes);
	});
	it('stops once the root choice is certain without requiring an exact reported value', () => {
		const f = fixture([mon('Mew', ['psychic', 'calmmind', 'recover'])], [mon('Pikachu', ['splash'])]);
		const { bounded, full } = compareBounded(f, [action('recover')]);
		assert.equal(bounded.nodes, 0, bounded.reason);
		assert.deepEqual(bounded.values, [], 'No invented value is needed for the only candidate');
		assert(bounded.nodes < full.nodes, `${bounded.reason}\n${full.reason}`);
	});
	it('isolates preset recipients and their mutable state across entry branches', () => {
		const f = fixture([mon('Mew', ['roar'])], [mon('Mew', ['splash']), mon('Machamp', ['closecombat'])]);
		f.state.opponent.conditions.stickyweb = true;
		const p = f.state.opponent.reserve[0]; p.itemKnown = false;
		p.presetModels = ['leftovers', 'lifeorb'].map(item => ({ name: item, pokemon: { ...p, item },
			moves: [{ id: 'closecombat', availability: 1 }], weight: 0.5, matched: true }));
		const search = new Search(new MatchupEvaluator(), f.state);
		const run = () => search.transitions(f.state, action('roar'), action('splash'), false);
		const leaves = run();
		assert.equal(leaves.length, 2);
		assert.deepEqual(leaves.map(b => b.state.opponent.active[0].boosts.spe), [-1, -1]);
		assert.notEqual(leaves[0].state.opponent.active[0].boosts, leaves[1].state.opponent.active[0].boosts);
		assert.equal(p.boosts.spe, 0);
		f.state.opponent.reserve[0].presetModels.reverse();
		assert.deepEqual(run().map(b => b.state.opponent.active[0].boosts.spe), [-1, -1]);
		const before = structuredClone(leaves[1].state);
		switchIn(leaves[0].state, 'opponent', leaves[0].state.opponent.reserve[0]);
		assert.deepEqual(leaves[1].state, before, 'Leaving one branch must not reset another branch');
	});
	it('shares entry, boosts and recovery effects without changing the evaluated snapshot', () => {
		const f = fixture([mon('Metagross', ['rest'], { ability: 'Clear Body' }), mon('Mew', ['splash'])],
			[mon('Mew', ['splash'])]);
		const actor = f.state.self.active[0], copy = clonePosition(f.state).self.active[0];
		const side = { ...f.state.self.conditions, stickyweb: true };
		applyEntryEffects(copy, side, f.state.field);
		assert.equal(copy.boosts.spe, 0, 'Clear Body blocks the entry stat drop in shared mechanics');
		copy.ability = 'Contrary'; applyEntryEffects(copy, side, f.state.field);
		assert.equal(copy.boosts.spe, 1);
		copy.ability = 'Simple'; boosts(copy, { atk: 2 }, f.state);
		assert.equal(copy.boosts.atk, 4);
		copy.ability = 'Insomnia'; hp(copy, 1);
		applyRecovery(f.state, 'self', copy, hardMove('rest', 1, f.state.field.formatId));
		assert.equal(copy.hp, 1, 'Rest cannot recover through a sleep immunity');
		copy.ability = 'Clear Body'; copy.item = 'Chesto Berry'; copy.itemKnown = true;
		applyRecovery(f.state, 'self', copy, hardMove('rest', 1, f.state.field.formatId));
		assert.equal(copy.hp, copy.maxHp); assert.equal(copy.status, ''); assert.equal(copy.item, '');
		assert.equal(actor.boosts.atk, 0); assert.equal(actor.boosts.spe, 0); assert.equal(actor.item, '');
	});
	it('stops expanding first-turn responses once a root is provably dominated', () => {
		const f = fixture([mon('Landorus-Therian', ['earthquake', 'explosion'])],
			[mon('Magikarp', ['tackle', 'flail', 'bounce'], { level: 1 })]);
		const { full, bounded } = compareBounded(f, ['earthquake', 'explosion'].map(action));
		assert.equal(bounded.choice, 'move earthquake');
		assert.equal(full.nodes, 6, 'All three responses are evaluated for both attacks');
		assert.equal(bounded.nodes, 4, 'One drawing response already bounds Explosion below the guaranteed win');
	});
	it('reuses opposing responses across own actions without mutating their bound snapshots', () => {
		const f = fixture([mon('Mew', ['psychic', 'icebeam'])], [mon('Machamp', ['closecombat', 'knockoff'])]);
		const search = new Search(new MatchupEvaluator());
		const first = search.continuation(f.state, action('psychic'));
		const second = search.continuation(f.state, action('icebeam'));
		assert.equal(first.responses, second.responses);
		const before = first.responses.map(r => clonePosition(r.state));
		search.continuationBranches(f.state, action('psychic'));
		assert.deepEqual(second.responses.map(r => r.state), before);
		search.continuationBranches(f.state, action('icebeam'));
		assert(search.reused.responses > 0);
	});
	it('keeps unresolved rare profiles in the bound instead of extrapolating the evaluated majority', () => {
		const f = fixture([mon('Mew', ['splash'])], [mon('Mew', ['splash'])]);
		const foe = f.state.opponent.active[0];
		foe.presetModels = [['synchronize', 0.99], ['pressure', 0.01]].map(([ability, weight]) => ({
			name: ability, weight, matched: true, pokemon: { ...foe, ability },
			moves: [{ id: 'splash', availability: 1 }],
		}));
		const search = new Search(new MatchupEvaluator());
		search.value = state => state.opponent.active[0].ability === 'pressure' ? 10000 : -100;
		const work = search.continuation(f.state, action('splash'), true);
		search.advanceContinuation(work);
		assert.equal(work.upper, Infinity, 'The unseen 1% profile has no proven bound yet');
		assert.equal(search.continuationValue(f.state, action('splash')), 1);
		assert.equal(work.upper, 1);
	});
	it('uses the whole random-recipient expectation when bounding a completed response', () => {
		const f = fixture([mon('Mew', ['roar'])], [mon('Blissey', ['splash']),
			mon('Pikachu', ['splash']), mon('Garchomp', ['splash'])]);
		f.state.opponent.active[0].volatiles.add('trapped');
		const search = new Search(new MatchupEvaluator());
		search.value = state => state.opponent.active[0].species === 'Pikachu' ? 100 : -90;
		const work = search.continuation(f.state, action('roar'));
		search.advanceContinuation(work);
		assert.equal(work.upper, 5);
		assert.equal(search.continuationValue(f.state, action('roar')), 5);
	});
	it('bounds opposing entry choices without promoting random profiles to selectable outcomes', () => {
		const leaf = (choice, value, weight) => ({ config: 0, configWeight: 1, reply: 'pivot', value, weight,
			entries: [{ key: 'entry', side: 'opponent', choice, depth: 0 }] });
		const leaves = [leaf('A', 100, 0.1), leaf('A', -100, 0.9), leaf('B', 20, 0.5), leaf('B', 40, 0.5)];
		assert.equal(optimisticValue(leaves), -80, 'Opponent chooses the recipient with the lower expectation');
		assert.equal(optimisticValue(leaves, false), 30, 'Shared continuation worlds relax control, not chance');
		leaves[0].value = Infinity;
		assert.equal(optimisticValue(leaves), 30, 'A complete opposing alternative bounds an unresolved recipient');
		assert.equal(optimisticValue(leaves, false), Infinity);
	});
	it('does not give a shared opposing entrant knowledge of hidden configurations', () => {
		const leaves = [0, 1].flatMap(config => ['A', 'B'].map((choice, i) => ({
			config, configWeight: 0.5, reply: 'pivot', value: config === i ? 100 : -100, weight: 1,
			entries: [{ key: 'shared', side: 'opponent', choice, depth: 0 }],
		})));
		assert.equal(optimisticValue(leaves), 100, 'Independent opposing minima would incorrectly give -100');
		for (const b of leaves) b.entries[0].key = `observable ${b.config}`;
		assert.equal(optimisticValue(leaves), -100, 'Distinct public observations permit independent choices');
	});
	it('keeps incomplete information sets and nested entries conservative', () => {
		const leaves = [0, 1].flatMap(config => ['A', 'B'].map(choice => ({
			config, configWeight: 0.5, reply: 'pivot', value: choice === 'A' ? 10 : 100, weight: 1,
			entries: [{ key: 'shared', side: 'opponent', choice, depth: 0 }],
		})));
		assert.equal(optimisticValue(leaves.slice(1)), 100, 'A shared choice must not erase a hidden configuration');
		leaves[0].entries.push({ key: 'nested', side: 'self', choice: 'C', depth: 1 });
		assert.equal(optimisticValue(leaves), 100);
		leaves[0].entries.pop(); leaves[0].weight = 0.1;
		assert.equal(optimisticValue(leaves), 100, 'Unequal recipient mass cannot be silently renormalized');
	});
	it('bounds resolved shared and independent entry trees with partial leaf estimates', () => {
		const search = new Search(new MatchupEvaluator());
		for (let seed = 1; seed <= 64; seed++) {
			let rng = seed;
			const random = () => ((rng = Math.imul(rng, 1664525) + 1013904223 >>> 0) / 2 ** 32);
			const leaves = [0, 1].flatMap(config => ['attack', 'pivot'].flatMap(reply => {
				const base = { config, configWeight: config ? 0.1 : 0.9, reply };
				const ordinary = { ...base, weight: 0.2, value: random() * 200 - 100, entries: [] };
				const shared = seed % 2;
				return [ordinary, ...['A', 'B'].flatMap(choice => [0.25, 0.75].map(weight => ({
					...base, weight: weight * 0.8, value: random() * 200 - 100,
					entries: [{ key: shared ? 'shared' : `${config}/${reply}`,
						side: seed % 3 ? 'opponent' : 'self', choice, depth: 0 }],
				})))];
			}));
			search.continuationBranches = () => leaves;
			const exact = search.continuationValue();
			assert(optimisticValue(leaves) >= exact - 1e-9, `Complete bound, seed ${seed}`);
			assert(pessimisticValue(leaves) <= exact + 1e-9, `Complete lower bound, seed ${seed}`);
			const partial = leaves.map(b => ({ ...b, value: random() < 0.3 ? Infinity : b.value + random() * 50 }));
			assert(optimisticValue(partial) >= exact - 1e-9, `Partial bound, seed ${seed}`);
			const lower = leaves.map(b => ({ ...b, value: random() < 0.3 ? -Infinity : b.value - random() * 50 }));
			assert(pessimisticValue(lower) <= exact + 1e-9, `Partial lower bound, seed ${seed}`);
		}
	});
	it('bounds nested shared entries with chance weights without flattening them to leaf extrema', () => {
		const search = new Search(new MatchupEvaluator());
		for (let seed = 1; seed <= 64; seed++) {
			let rng = seed;
			const random = () => ((rng = Math.imul(rng, 1664525) + 1013904223 >>> 0) / 2 ** 32);
			const leaves = [0, 1].flatMap(config => ['attack', 'pivot'].flatMap(reply =>
				['A', 'B'].flatMap(first => ['C', 'D'].flatMap(second => [0.2, 0.8].map(weight => ({
					config, reply, configWeight: config ? 0.3 : 0.7, weight, value: random() * 200 - 100,
					entries: [
						{ key: seed % 2 ? 'shared' : `first/${config}/${reply}`, side: seed % 3 ? 'self' : 'opponent', choice: first, depth: 0 },
						{ key: seed % 2 ? `second/${first}` : `second/${config}/${reply}/${first}`,
							side: seed % 3 ? 'opponent' : 'self', choice: second, depth: 1 },
					],
				}))))));
			search.continuationBranches = () => leaves;
			const exact = search.continuationValue();
			assert(optimisticValue(leaves) >= exact - 1e-9, `upper ${seed}`);
			assert(pessimisticValue(leaves) <= exact + 1e-9, `lower ${seed}`);
			assert(optimisticValue(leaves.map(b => ({ ...b, value: random() < 0.3 ? Infinity : b.value + 10 }))) >= exact - 1e-9);
			assert(pessimisticValue(leaves.map(b => ({ ...b, value: random() < 0.3 ? -Infinity : b.value - 10 }))) <= exact + 1e-9);
		}
		const leaves = ['A', 'B'].flatMap(first => ['C', 'D'].flatMap(second => [0.1, 0.9].map(weight => ({
			config: 0, configWeight: 1, reply: 'pivot', weight,
			value: first === 'A' ? (second === 'C' ? (weight === 0.1 ? 100 : -100) : 30) : 20,
			entries: [{ key: 'first', side: 'self', choice: first, depth: 0 },
				{ key: `second/${first}`, side: 'opponent', choice: second, depth: 1 }],
		}))));
		assert.equal(optimisticValue(leaves), 20, 'max(min(-80,30),min(20,20)) = 20, not the best leaf 100');
	});
	it('can pause inside a pivot response and resume without replaying completed recipients', () => {
		const f = fixture([mon('Mew', ['splash'])], [mon('Mew', ['uturn']), mon('Pikachu', ['splash']), mon('Garchomp', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		let entrySelections = 0;
		search.entryChoices = (state, side) => { entrySelections++; return state[side].reserve.filter(p => !p.fainted); };
		const responses = search.responses(f.state).filter(r => r.action.move === 'uturn');
		assert.equal(responses.length, 1);
		search.responses = () => responses;
		entrySelections = 0;
		const visited = [];
		search.value = state => { visited.push(state.opponent.active[0].species); return visited.at(-1) === 'Pikachu' ? -100 : 100; };
		const work = search.continuation(f.state, action('splash'));
		search.prepareContinuation(work);
		assert.equal(search.nodes, 0, 'Checkpoint discovery does not visit the replacement states');
		assert.equal(entrySelections, 0, 'Entry candidates are evaluated only when the checkpoint is visited');
		const independent = new Set([...work.expansions.values()].flatMap(e => e.frontier.flatMap(({ node }) =>
			[...node.entries, ...(node.checkpoint ? [node.checkpoint] : [])].map(d => d.key))));
		search.advanceContinuation(work, independent);
		assert.deepEqual(visited, ['Pikachu']);
		assert.equal(search.continuationUpper(work, independent), -100);
		assert.equal(work.leaves, undefined, 'The other recipient remains unexpanded');
		assert.equal(search.continuationValue(f.state, action('splash')), -100);
		assert.deepEqual(visited, ['Pikachu', 'Garchomp']);
		assert.equal(entrySelections, 1, 'Resuming a checkpoint reuses its candidates');
	});
	it('projects damage from absorption-ability attackers without redirecting it back to themselves', () => {
		for (const [species, ability, move] of [['Gastrodon', 'Storm Drain', 'scald'], ['Raichu', 'Lightning Rod', 'thunderbolt']]) {
			const f = fixture([mon(species, [move], { ability })], [mon('Mew', ['splash'])]);
			const next = step(f.state, move, 'splash');
			assert.equal(f.state.opponent.active[0].hp - next.opponent.active[0].hp,
				Math.floor(damage(f.state, move).average));
			assert(next.opponent.active[0].hp < f.state.opponent.active[0].hp);
		}
	});
	it('carries successful item exchanges into continuation scoring and cache identity', () => {
		const { positionKey } = require('../../../dist/server/npc/ai/hard/projection');
		for (const move of ['trick', 'switcheroo']) {
			const f = fixture([mon('Rotom-Wash', [move], { item: 'Choice Scarf' })],
				[mon('Gastrodon', ['splash'], { ability: 'Storm Drain', item: 'Leftovers' })]);
			const next = step(f.state, move, 'splash'), actor = next.self.active[0], target = next.opponent.active[0];
			assert.deepEqual(actor.itemExchange, { given: 'choicescarf', received: 'leftovers' });
			assert.equal(target.itemExchange, undefined);
			assert.equal(new HardEvaluation(next, 'gen6customgame').scoreMoves(actor,
				[hardMove(move, 1, 'gen6customgame')], target, new Map())[0].score, 60);
			const other = clonePosition(next);
			delete other.self.active[0].itemExchange;
			assert.notEqual(positionKey(next), positionKey(other));
			assert.equal(f.state.self.active[0].itemExchange, undefined, 'The root state is immutable');
		}
	});
	it('does not discourage an initial exchange, a failed exchange, or receiving a Choice item', () => {
		for (const [item, ability, expected] of [['Choice Band', 'Storm Drain', true], ['Leftovers', 'Sticky Hold', false]]) {
			const f = fixture([mon('Rotom-Wash', ['trick'], { item: 'Choice Scarf' })],
				[mon('Gastrodon', ['splash'], { ability, item })]);
			const next = step(f.state, 'trick', 'splash');
			assert.equal(!!next.self.active[0].itemExchange, expected);
			const score = new HardEvaluation(next, 'gen6customgame').scoreMoves(next.self.active[0],
				[hardMove('trick', 1, 'gen6customgame')], next.opponent.active[0], new Map())[0];
			assert.equal(score.flags.fixedScore, undefined);
		}
	});
	it('evolves on generated actions for either side and preserves the resource on switches', () => {
		const team = [mon('Diancie', ['moonblast', 'protect'], { item: 'Diancite' }), mon('Magikarp', ['splash'])];
		const f = fixture(team, team), search = new Search(new MatchupEvaluator());
		for (const side of ['self', 'opponent']) {
			const moves = search.choices(f.state, side).filter(a => a.move);
			assert(moves.length && moves.every(a => a.mega));
			f.state[side].megaUsedByOwner = { [f.state[side].active[0].ownerSide]: true };
			assert(search.choices(f.state, side).filter(a => a.move).every(a => !a.mega));
			delete f.state[side].megaUsedByOwner;
		}
		const own = search.choices(f.state, 'self').find(a => a.move);
		// The transition only spends Mega for an actual evolving action, never a switch.
		const checkpoint = beginTurn(f.state, own,
			{ id: 'switch 2', switchTo: f.state.opponent.reserve[0], prior: 0 });
		assert.equal(checkpoint.state.self.active[0].species, 'Diancie', 'Voluntary switches precede Mega');
		continueTurn(checkpoint);
		assert.equal(checkpoint.state.self.active[0].species, 'Diancie-Mega');
		assert(checkpoint.state.self.megaUsedByOwner[f.state.self.active[0].ownerSide]);
		assert(!checkpoint.state.opponent.megaUsedByOwner?.[f.state.opponent.active[0].ownerSide]);
	});
	it('keeps a low-ranked protection candidate when waiting wins through residual damage', () => {
		const f = fixture([mon('Blissey', ['tackle', 'pound', 'watergun', 'protect'])],
			[mon('Alakazam', ['psychic'], { ability: 'Inner Focus' })]);
		hp(f.state.self.active[0], 10); hp(f.state.opponent.active[0], 10);
		f.state.opponent.active[0].status = 'brn';
		const actions = ['tackle', 'pound', 'watergun', 'protect'].map((move, i) =>
			({ ...action(move), prior: i === 3 ? 1 : 120 - i }));
		const result = searchPosition(f.state, f.evaluator, actions, new Map());
		assert.equal(result.choice, 'move protect', result.reason);
	});
	it('retains useful Pain Split recovery in hard candidate scoring', () => {
		const f = fixture([mon('Rotom-Wash', ['voltswitch', 'painsplit'], { ability: 'Levitate' })],
			[mon('Volcanion', ['steameruption'], { ability: 'Water Absorb' })]);
		const actor = f.state.self.active[0], target = f.state.opponent.active[0];
		actor.maxHp = 304; hp(actor, 235);
		target.maxHp = 363; hp(target, 363);
		const search = new Search(new MatchupEvaluator());
		const score = [...search.scoreActions(f.state, 'self', [action('painsplit')]).values()][0];
		assert.equal(score.flags.discouraged, false);
		assert.equal(score.score, 100);
		assert(search.choices(f.state, 'self').some(a => a.move === 'painsplit'));
	});
	it('copies Water Absorb on Mega evolution before resolving attacks, matching the simulator', () => {
		const f = fixture([mon('Alakazam', ['psychic'], { ability: 'Magic Guard', item: 'Alakazite' })],
			[mon('Volcanion', ['steameruption'], { ability: 'Water Absorb' })]);
		hp(f.state.self.active[0], 100); f.b.p1.active[0].hp = 100;
		const turn = beginTurn(f.state, { ...action('psychic'), mega: true }, action('steameruption'));
		const next = continueTurn(turn);
		f.b.makeChoices('move 1 mega', 'move 1');
		assert.equal(next.self.active[0].ability, f.b.p1.active[0].ability);
		assert.equal(next.self.active[0].ability, 'waterabsorb');
		assert.equal(next.self.active[0].hp, f.b.p1.active[0].hp);
		assert(next.self.active[0].hp > 100);
		assert.equal(f.state.self.active[0].ability, 'magicguard', 'Knowledge snapshots are immutable');
	});
	it('copies the incoming opponent after a voluntary switch and triggers the copied entry ability', () => {
		const f = fixture([mon('Alakazam', ['splash'], { ability: 'Magic Guard', item: 'Alakazite' })],
			[mon('Volcanion', ['splash'], { ability: 'Water Absorb' }),
				mon('Landorus-Therian', ['splash'], { ability: 'Intimidate' })]);
		const own = { ...action('splash'), mega: true }, foe = { id: 'switch 2', switchTo: f.state.opponent.reserve[0], prior: 0 };
		const search = new Search(new MatchupEvaluator());
		const next = search.transitions(f.state, own, foe, false)[0].state;
		f.b.makeChoices('move 1 mega', 'switch 2');
		assert.equal(next.self.active[0].species, 'Alakazam-Mega');
		assert.equal(next.self.active[0].ability, f.b.p1.active[0].ability);
		assert.equal(next.self.active[0].ability, 'intimidate');
		assert.equal(next.self.active[0].boosts.atk, f.b.p1.active[0].boosts.atk);
		assert.equal(next.opponent.active[0].boosts.atk, f.b.p2.active[0].boosts.atk);
		assert.equal(next.opponent.active[0].boosts.atk, -1);
	});
	it('restores Trace on leaving and copies the new opponent on reentry', () => {
		const f = fixture([mon('Alakazam', ['splash'], { ability: 'Magic Guard', item: 'Alakazite' }), mon('Mew', ['splash'])],
			[mon('Volcanion', ['splash'], { ability: 'Water Absorb' }), mon('Rotom-Wash', ['splash'], { ability: 'Levitate' })]);
		const turn = beginTurn(f.state, { ...action('splash'), mega: true }, action('splash'));
		const next = continueTurn(turn), zam = next.self.active[0];
		assert.equal(zam.ability, 'waterabsorb');
		switchIn(next, 'self', next.self.reserve[0]);
		assert.equal(zam.ability.toLowerCase(), 'trace');
		switchIn(next, 'opponent', next.opponent.reserve[0]);
		switchIn(next, 'self', zam);
		assert.equal(zam.ability, 'levitate');
	});
	it('uses the same copied immunity for a reserve matchup and its projected entry', () => {
		const f = fixture([mon('Mew', ['splash']), mon('Alakazam-Mega', ['psychic'], { ability: 'Trace' })],
			[mon('Volcanion', ['steameruption'], { ability: 'Water Absorb' })]);
		const zam = f.state.self.reserve[0]; hp(zam, 20);
		const matchup = new MatchupEvaluator().assess(f.state).matrix[1][0];
		assert.equal(matchup.self.counter, 1);
		const next = clonePosition(f.state); switchIn(next, 'self', next.self.reserve[0]);
		assert.equal(next.self.active[0].ability, 'waterabsorb');
		assert.equal(damage(next, 'psychic').average > 0, true);
		assert.equal(zam.ability, 'trace');
	});
	it('uses the baseline boundary rather than the top score or effect exemptions', () => {
		const moves = ['thunderbolt', 'icebeam', 'watergun', 'quickattack', 'uturn', 'gigadrain', 'knockoff', 'rapidspin'];
		const f = fixture([mon('Mew', moves), mon('Magikarp', ['splash'])],
			[mon('Gyarados', ['splash'], { item: 'Leftovers' }), mon('Garchomp', ['earthquake'], { item: 'Yache Berry' })]);
		const search = new Search(new MatchupEvaluator());
		const kept = search.choices(f.state, 'self', moves.map(move => ({ ...action(move), prior: 1 })))
			.map(a => a.move);
		// Ice Beam is just over 100; Giga Drain just under it. Even Water Gun remains
		// because the boundary gap is small, despite Thunderbolt's much higher score.
		assert.deepEqual([...kept].sort(), [...moves].sort());
		const separated = search.choices(f.state, 'self', ['thunderbolt', 'rapidspin', 'uturn'].map(action));
		assert.deepEqual(separated.map(a => a.move), ['thunderbolt'], 'No independent pivot or clearing exemption');
	});
	it('filters ineffective support through scores without using unavailable reserves to rescue it', () => {
		const f = fixture([mon('Heatran', ['earthpower', 'willowisp'])],
			[mon('Volcanion', ['steameruption']), mon('Garchomp', ['earthquake'])]);
		f.state.opponent.active[0].volatiles.add('partiallytrapped');
		const search = new Search(new MatchupEvaluator());
		const actions = ['earthpower', 'willowisp'].map(move => ({ ...action(move), prior: 1000 }));
		const before = clonePosition(f.state);
		const kept = search.choices(f.state, 'self', actions);
		assert.equal(actions.find(a => a.move === 'willowisp').prior, 0);
		assert(!kept.some(a => a.move === 'willowisp'));
		assert(kept.some(a => a.move === 'earthpower'));
		assert(search.pruned.scores > 0);
		assert.deepEqual(clonePosition(f.state), before);
	});
	it('weights support against replacement recipients instead of keeping any possible high-scoring target', () => {
		const f = fixture([mon('Heatran', ['earthpower', 'willowisp'])],
			[mon('Volcanion', ['flamethrower']), mon('Garchomp', ['earthquake'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		const replacements = f.evaluator.switchTargets(actor, foe);
		const score = probability => f.evaluator.scoreMoves(actor, [hardMove('willowisp', 1, 'gen6customgame')], foe,
			new Map([[foe, [
				{ move: null, weight: 1 - probability, switching: false, user: foe },
				{ move: null, weight: probability, switching: true, user: foe },
			]]]), replacements)[0].score;
		assert.equal(score(0), 0);
		assert(score(1) > 60);
		assert(Math.abs(score(0.2) - score(1) * 0.2) < 1e-9);
		assert(score(0.2) < 60, 'A remote favorable recipient does not justify this action');
	});
	it('retains the best legal move when all moves score poorly and switching is impossible', () => {
		const f = fixture([mon('Mew', ['toxic', 'thunderwave'])], [mon('Steelix', ['earthquake'])]);
		const actions = ['toxic', 'thunderwave'].map(action);
		const search = new Search(new MatchupEvaluator());
		const kept = search.choices(f.state, 'self', actions);
		assert(actions.every(a => a.prior <= 60));
		assert(kept.length && kept.every(a => a.move), 'Do not emit an illegal pass');
		assert(kept.every(a => a.prior === Math.max(...actions.map(a => a.prior))));
	});
	it('scores priority for finishing races and damage before a lethal hit without independent pruning', () => {
		const moves = ['bodyslam', 'quickattack'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['tackle'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		const search = new Search(new MatchupEvaluator());
		const scores = () => scoresFor(search, f.state, moves);
		actor.baseStats.spe = 100; foe.baseStats.spe = 200; foe.baseStats.atk = 10;
		assert(scores().bodyslam > scores().quickattack, 'Survives and cannot finish: stronger damage scores higher');
		hp(foe, 1);
		assert(scores().quickattack > scores().bodyslam, 'Priority finishes before the faster response');
		actor.baseStats.spe = 300;
		assert.equal(scores().quickattack, scores().bodyslam, 'Already faster: priority has no additional reward');
		assert.equal(search.choices(f.state, 'self').length, 2, 'Both high-scoring finishing options remain');
		hp(foe, foe.maxHp); actor.baseStats.spe = 100; foe.baseStats.atk = 10000;
		assert(scores().quickattack > scores().bodyslam, 'Otherwise dies before dealing any damage');
		foe.moves = ['extremespeed'];
		assert(scores().quickattack < scores().bodyslam, 'Cannot salvage damage before an earlier lethal response');
	});
	it('scores actual attack order including opposing priority and Trick Room', () => {
		const moves = ['bodyslam', 'extremespeed'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['quickattack'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 300; foe.baseStats.spe = 100; foe.baseStats.atk = 10000;
		const search = new Search(new MatchupEvaluator()), scores = () => scoresFor(search, f.state, moves);
		assert(scores().extremespeed > scores().bodyslam);
		foe.moves = ['tackle']; foe.baseStats.atk = 10; hp(foe, 1);
		assert.equal(scores().extremespeed, scores().bodyslam);
		f.state.field.trickroom = true;
		assert(scores().extremespeed > scores().bodyslam);
	});
	it('weights priority benefits over speed presets instead of trusting the representative speed', () => {
		const moves = ['bodyslam', 'quickattack'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['tackle'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 200; hp(foe, 1);
		foe.presetModels = [100, 300].map(spe => ({ name: `speed ${spe}`, weight: 0.5, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, spe } }, moves: [{ id: 'tackle', availability: 1 }] }));
		const search = new Search(new MatchupEvaluator()), scores = () => scoresFor(search, f.state, moves);
		assert(scores().quickattack > scores().bodyslam);
		foe.presetModels = [{ ...foe.presetModels[0], weight: 1 }];
		assert.equal(scores().quickattack, scores().bodyslam);
	});
	it('gets clearing and item removal value from tactical scores', () => {
		const moves = ['bodyslam', 'rapidspin', 'knockoff'];
		const f = fixture([mon('Mew', moves), mon('Blissey', ['splash'])], [mon('Mew', ['splash'])]);
		const search = new Search(new MatchupEvaluator()), foe = f.state.opponent.active[0];
		foe.types = ['Normal']; foe.item = '';
		foe.itemKnown = true; foe.itemAssumed = false;
		const empty = scoresFor(search, f.state, moves);
		assert(empty.rapidspin < empty.bodyslam); assert(empty.knockoff < empty.bodyslam);
		f.state.self.conditions.stealthrock = true; foe.itemKnown = false;
		const useful = scoresFor(search, f.state, moves);
		assert(useful.rapidspin > 100 && useful.rapidspin > empty.rapidspin);
		assert(useful.knockoff > 100 && useful.knockoff > empty.knockoff);
		assert(search.choices(f.state, 'self').some(a => a.move === 'rapidspin'));
		assert(search.choices(f.state, 'self').some(a => a.move === 'knockoff'));
	});
	it('does not score an unavailable replacement as a possible recipient', () => {
		const moves = ['thunderbolt', 'magicalleaf'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['tackle']), mon('Magikarp', ['splash'])]);
		f.state.opponent.active[0].types = ['Normal'];
		f.state.opponent.active[0].volatiles.add('trapped');
		f.state.opponent.reserve[0].types = ['Rock'];
		const search = new Search(new MatchupEvaluator());
		assert.equal(search.destinations(f.state, 'opponent').length, 1);
		const before = scoresFor(search, f.state, moves);
		f.state.opponent.reserve[0].types = ['Water', 'Flying'];
		assert.deepEqual(scoresFor(search, f.state, moves), before);
		f.state.opponent.active[0].moves.push('uturn');
		assert.equal(search.destinations(f.state, 'opponent').length, 2);
	});
	it('prunes by score gap for attacks and support alike without effect exceptions', () => {
		const score = (id, value) => ({ move: hardMove(id, 1, 'gen6customgame'), score: value,
			flags: { hasNoEffect: false, isImmune: false } });
		const choices = [score('earthquake', 120), score('stealthrock', 120), score('rapidspin', 80), score('uturn', 80)];
		assert.deepEqual(selectMoveCandidates(choices, 20), choices.slice(0, 2));
		assert.deepEqual(selectMoveCandidates([score('tackle', 55), score('pound', 50)], 20).map(s => s.score), [55, 50]);
		assert.deepEqual(selectMoveCandidates([score('tackle', 120), score('pound', 100), score('watergun', 101)], 20)
			.map(s => s.score), [120, 100, 101]);
		for (const [values, expected] of [
			[[170, 120, 80, 80], [170, 120]],
			[[120, 100, 80, 80], [120, 100, 80, 80]],
			[[120, 101, 80], [120, 101]],
			[[80, 170, 80, 120], [170, 120]],
			[[99, 70, 20], [99, 70, 20]],
		]) {
			assert.deepEqual(selectMoveCandidates(values.map(n => score('tackle', n)), 20)
				.map(s => s.score), expected);
		}
		assert.equal(selectMoveCandidates(Array.from({ length: 8 }, () => score('tackle', 100)), 20).length, 8);
	});

	it('does not switch into the main attack merely to resist a weaker move', () => {
		const f = fixture([mon('Excadrill', ['earthquake', 'ironhead', 'rapidspin', 'stealthrock'], {
			ability: 'Mold Breaker', nature: 'Jolly', item: 'Leftovers',
			evs: { hp: 176, atk: 12, def: 28, spd: 252, spe: 40 },
		})], [mon('Rotom-Wash', ['hydropump', 'willowisp', 'painsplit'], {
			ability: 'Levitate', nature: 'Bold', item: 'Leftovers', evs: { hp: 248, def: 252, spe: 8 },
		}), mon('Metagross', ['earthquake', 'stealthrock'], { item: 'Metagrossite' }),
		mon('Serperior', ['leafstorm', 'reflect']), mon('Tornadus-Therian', ['hurricane'])]);
		const search = new Search(new MatchupEvaluator());
		const entries = search.entryChoices(f.state, 'opponent', 'switch').map(p => p.species);
		assert(!entries.includes('Metagross'), entries.join(', '));
		assert(entries.includes('Serperior') || entries.includes('Tornadus-Therian'), 'Keep a real defensive improvement');
		const moves = search.choices(f.state, 'self').map(a => a.move);
		assert(!moves.includes('rapidspin'), 'A possible incoming hazard setter does not justify empty Spin');
		assert(moves.includes('earthquake'));
	});
	it('shares pressure after the conceded attack with entry selection', () => {
		const f = fixture([mon('Mew', ['tackle'])], [mon('Mew', ['tackle'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 100; foe.baseStats.spe = 200;
		const hit = calculateDamage(foe, actor, hardMove('tackle', 1, 'gen6customgame'), f.state.field).average;
		hp(actor, Math.floor(hit * 1.5));
		const pair = new MatchupEvaluator().assess(f.state).matrix[0][0].self;
		assert(pair.pressure > 0, 'Staying can deal damage after one hit');
		assert.equal(pair.entryPressure, 0, 'Conceding an entry hit leaves no attack before the next hit');
		assert.equal(pair.entrySustain, 0);
	});
	it('charges entry loss against the bound profile HP instead of the representative maximum', () => {
		const f = fixture([mon('Mew', ['tackle'])], [mon('Mew', ['splash']), mon('Blissey', ['splash'])]);
		f.state.self.active[0].baseStats.atk = 200;
		const active = f.state.opponent.active[0], reserve = f.state.opponent.reserve[0];
		for (const p of [active, reserve]) { p.maxHp = 100; hp(p, 100); }
		active.baseStats.def = 100; reserve.baseStats.def = 200;
		reserve.presetModels = [{ name: 'known spread', weight: 1, matched: true,
			pokemon: { ...reserve, baseStats: { ...reserve.baseStats } }, moves: [{ id: 'splash', availability: 1 }] }];
		const entries = () => new Search(new MatchupEvaluator()).entryChoices(f.state, 'opponent', 'switch').map(p => p.slot);
		assert.deepEqual(entries(), [reserve.slot]);
		reserve.maxHp = 1000; hp(reserve, 1000);
		assert.deepEqual(entries(), [reserve.slot], 'A different representative HP must not fabricate hazard damage');
	});
	it('does not let conditional Sucker Punch remove an unconditional attack', () => {
		const f = fixture([mon('Mew', ['bite', 'suckerpunch'])], [mon('Mew', ['tackle', 'swordsdance'])]);
		const search = new Search(new MatchupEvaluator());
		assert(search.choices(f.state, 'self').some(a => a.move === 'bite'));
		f.state.opponent.active[0].moves = ['swordsdance'];
		assert(!search.choices(f.state, 'self').some(a => a.move === 'suckerpunch'));
	});
	it('resumes independent pivot branches without replaying damage, PP or the turn ending', () => {
		const f = fixture([mon('Jolteon', ['voltswitch']), mon('Garchomp', ['splash']), mon('Blissey', ['splash'])],
			[mon('Mew', ['tackle'])]);
		f.state.self.active[0].projection = { pp: { voltswitch: 10 } };
		const original = clonePosition(f.state);
		const checkpoint = beginTurn(f.state, action('voltswitch'), action('tackle'));
		assert.equal(continueTurn(checkpoint), undefined);
		assert.equal(checkpoint.pending.cause, 'pivot');
		const foeHP = checkpoint.state.opponent.active[0].hp;
		assert(foeHP < f.state.opponent.active[0].hp);
		for (const entrant of checkpoint.state.self.reserve) {
			const state = clonePosition(checkpoint.state);
			switchIn(state, 'self', entrant);
			const result = continueTurn({ state, remaining: [...checkpoint.remaining] });
			assert.equal(result.opponent.active[0].hp, foeHP);
			assert.equal(result.self.team[0].projection.pp.voltswitch, 9);
			assert.equal(result.turn, original.turn + 1);
			const expected = advancePosition(original, action('voltswitch'), action('tackle'),
				s => s.self.reserve.find(p => p.species === entrant.species));
			assert.deepEqual(clonePosition(result), clonePosition(expected));
		}
		assert.deepEqual(clonePosition(f.state), original);
	});
	it('keeps cached choices isolated from hypothetical branches and invalidates changed participants', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam'])], [mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator(), f.state);
		const original = search.choices(f.state, 'self').map(a => a.move);
		const future = clonePosition(f.state); hp(future.self.active[0], 100);
		search.choices(future, 'self');
		assert.deepEqual(search.choices(f.state, 'self').map(a => a.move), original);
		assert.equal(search.reused.choices, 1);
		f.state.opponent.active[0].types = ['Ground', 'Dragon'];
		assert.deepEqual(search.choices(f.state, 'self').map(a => a.move), ['icebeam']);
	});

	it('unions representative attacks across different defensive presets', () => {
		const f = fixture([mon('Mew', ['earthquake', 'psychic'])], [mon('Mew', ['splash'])]);
		const target = f.state.opponent.active[0];
		target.presetModels = [[1000, 20], [20, 1000]].map(([def, spd], i) => ({
			name: `defense ${i}`, weight: 0.5, matched: true,
			pokemon: { ...target, baseStats: { ...target.baseStats, def, spd } },
			moves: [{ id: 'splash', availability: 1 }],
		}));
		const search = new Search(new MatchupEvaluator()), actions = ['earthquake', 'psychic'].map(action);
		assert.deepEqual([...search.choices(f.state, 'self', actions)].map(a => a.move).sort(), ['earthquake', 'psychic']);
		target.presetModels = [target.presetModels[0]];
		assert.deepEqual([...search.choices(f.state, 'self', actions)].map(a => a.move), ['psychic']);
	});
	it('does not let a stronger pivot erase the option to attack without leaving', () => {
		const f = fixture([mon('Mew', ['thundershock', 'voltswitch']), mon('Magikarp', ['splash'])],
			[mon('Gyarados', ['splash'])]);
		const choices = new Search(new MatchupEvaluator()).choices(f.state, 'self');
		assert(choices.some(a => a.move === 'thundershock'));
		assert(choices.some(a => a.move === 'voltswitch'));
	});
	it('returns current request action identifiers instead of stale cached identities', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam'])], [mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator()), actions = ['thunderbolt', 'icebeam'].map(action);
		search.choices(f.state, 'self', actions);
		const renamed = actions.map(a => ({ ...a, id: a.id + ' renamed' }));
		assert(search.choices(f.state, 'self', renamed).every(a => a.id.endsWith(' renamed')));
	});

	it('expands every root when the boundary gap is small without count caps', () => {
		const moves = ['reflect', 'lightscreen', 'safeguard', 'mist', 'tailwind', 'protect'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['tackle'])]);
		const result = searchPosition(f.state, f.evaluator, moves.map((move, i) =>
			({ ...action(move), prior: i })), new Map());
		assert.deepEqual(result.values.map(v => v.id).sort(), moves.map(id => `move ${id}`).sort(), result.reason);
	});
	it('does not cap favorable switches or free replacements', () => {
		const f = fixture(['Magikarp', 'Garchomp', 'Dragonite', 'Gengar', 'Machamp', 'Alakazam']
			.map((species, i) => mon(species, [i ? 'tackle' : 'splash'])), [mon('Magikarp', ['tackle'])]);
		const search = new Search(new MatchupEvaluator());
		assert.equal(search.choices(f.state, 'self').filter(a => a.switchTo).length, 5);
		hp(f.state.self.active[0], 0);
		assert.equal(search.choices(f.state, 'self').filter(a => a.switchTo).length, 5);
	});
	it('holds a clear advantage and narrows the disadvantaged side to the active recipient', () => {
		const f = fixture([mon('Garchomp', ['earthquake', 'thunderbolt'], { evs: { atk: 252, spe: 252 }, nature: 'Jolly' }),
			mon('Scizor', ['splash'])], [mon('Heatran', ['icebeam', 'flamethrower']), mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		assert(search.favorableStay(f.state, 'self'));
		assert(!search.choices(f.state, 'self').some(a => a.switchTo));
		// Garchomp still covers the Water/Flying replacement.
		assert(search.choices(f.state, 'self').some(a => a.move === 'thunderbolt'));
		// Heatran need not cover Scizor when Garchomp is expected to stay.
		assert(search.choices(f.state, 'opponent').some(a => a.move === 'icebeam'));
		assert.deepEqual(search.destinations(f.state, 'self').map(p => p.species), ['Garchomp']);
		assert(search.choices(f.state, 'opponent').some(a => a.switchTo));
	});
	it('retains a wounded Regenerator users advantage without generating voluntary switches', () => {
		const f = fixture([mon('Tornadus-Therian', ['hurricane', 'heatwave', 'knockoff', 'uturn'],
			{ ability: 'Regenerator', item: 'Assault Vest' }), mon('Rotom-Wash', ['hydropump'], { ability: 'Levitate' })],
		[mon('Excadrill', ['stealthrock', 'rapidspin', 'earthquake', 'ironhead'], { ability: 'Mold Breaker' })]);
		hp(f.state.self.active[0], f.state.self.active[0].maxHp * 0.76);
		hp(f.state.opponent.active[0], f.state.opponent.active[0].maxHp * 0.82);
		f.state.opponent.active[0].status = 'brn';
		for (const rocks of [false, true]) {
			f.state.self.conditions.stealthrock = rocks;
			const search = new Search(new MatchupEvaluator());
			assert(search.favorableStay(f.state, 'self'));
			assert(!search.choices(f.state, 'self').some(a => a.switchTo));
			const reversed = { ...f.state, self: f.state.opponent, opponent: f.state.self };
			assert(!new Search(new MatchupEvaluator()).choices(reversed, 'opponent').some(a => a.switchTo));
			assert(search.entryChoices(f.state, 'self', 'free').length, 'A required pivot entry remains available');
		}
	});
	it('does not override a winning matchup just to cure status with Natural Cure', () => {
		const f = fixture([mon('Celebi', ['psychic'], { ability: 'Natural Cure' }), mon('Mew', ['psychic'])],
			[mon('Machop', ['tackle'])]);
		f.state.self.active[0].status = 'psn';
		const search = new Search(new MatchupEvaluator());
		assert(search.favorableStay(f.state, 'self'));
		assert(!search.choices(f.state, 'self').some(a => a.switchTo));
		const next = clonePosition(f.state); switchIn(next, 'self', next.self.reserve[0]);
		assert.equal(next.self.reserve.find(p => p.species === 'Celebi').status, '');
	});
	it('keeps the matchup advantage against Taunt and Will-O-Wisp when direct attacks win', () => {
		const f = fixture([mon('Rotom-Wash', ['hydropump', 'voltswitch', 'willowisp', 'painsplit'], { ability: 'Levitate' }),
			mon('Metagross', ['earthquake']), mon('Tornadus-Therian', ['hurricane'])],
		[mon('Heatran', ['magmastorm', 'earthpower', 'taunt', 'willowisp'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		hp(actor, 110); hp(foe, 4); foe.status = 'par';
		const search = new Search(new MatchupEvaluator());
		const assertStays = () => {
			const pair = search.assess(f.state).matrix[0][0];
			assert.equal(pair.self.check, 1); assert.equal(pair.opponent.check, 0);
			assert(search.favorableStay(f.state, 'self'));
			const choices = search.choices(f.state, 'self');
			assert(choices.some(a => a.move === 'hydropump'));
			assert(!choices.some(a => a.switchTo), 'Do not override the matchup merely because disruption is present');
		};
		assertStays();
		// Even when Heatran can act first, these moves do not invalidate the direct KO.
		foe.status = ''; hp(foe, 100); actor.baseStats.spe = 20;
		assertStays();
	});
	it('reuses choices for identical snapshots and recomputes scores after a public change', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam'])], [mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		let computations = 0;
		const scoreActions = search.scoreActions.bind(search);
		search.scoreActions = (...args) => { computations++; return scoreActions(...args); };
		assert(search.choices(f.state, 'self').some(a => a.move === 'thunderbolt'));
		search.choices(clonePosition(f.state), 'self'); assert.equal(computations, 1);
		f.state.opponent.active[0].types = ['Ground', 'Dragon'];
		const choices = search.choices(f.state, 'self');
		assert.equal(computations, 2);
		assert(choices.some(a => a.move === 'icebeam'));
		assert(!choices.some(a => a.move === 'thunderbolt'));
		const value = search.continuationValue(f.state, action('icebeam')), nodes = search.nodes;
		assert.equal(search.continuationValue(clonePosition(f.state), action('icebeam')), value);
		assert.equal(search.nodes, nodes);
	});
	it('filters both pivot selections and free replacements through their entry matchups', () => {
		const team = [mon('Mew', ['uturn']), mon('Blissey', ['splash']), mon('Garchomp', ['splash'])];
		const f = fixture(team, team), search = new Search(new MatchupEvaluator());
		const pivots = search.transitions(f.state, action('uturn'), action('uturn'), false);
		assert.equal(pivots.length, 2);
		assert(pivots.every(b => b.entries.length === 2));
		assert.equal(new Set(pivots.map(b => `${b.state.self.active[0].ident}/${b.state.opponent.active[0].ident}`)).size, 2);
		hp(f.state.self.active[0], 1);
		const entries = search.transitions(f.state, action('splash'), action('seismictoss'), false);
		assert.deepEqual(entries.map(b => b.state.self.active[0].species).sort(), ['Garchomp']);
	});
	it('uses the same entry policy for voluntary switching and a pivot with an opposing action pending', () => {
		const f = fixture([mon('Mew', ['uturn']), mon('Alakazam', ['psychic']), mon('Gengar', ['psychic'])],
			[mon('Machamp', ['closecombat'])]);
		hp(f.state.self.reserve[0], 100); hp(f.state.opponent.active[0], 180);
		f.state.self.active[0].volatiles.add('yawn');
		const search = new Search(new MatchupEvaluator());
		const names = context => search.entryChoices(f.state, 'self', context).map(p => p.species);
		assert(names('free').includes('Alakazam'), 'Can finish before receiving an attack on the next turn');
		assert(names('exposed').includes('Gengar'), 'Can enter into the pending attack');
		assert.deepEqual(names('switch'), names('exposed'));
	});
	it('re-evaluates pivot recipients against the occupant after a voluntary switch', () => {
		const f = fixture([mon('Skarmory', ['ironhead', 'roost'],
			{ nature: 'Careful', evs: { hp: 252, spd: 252 }, item: 'Leftovers' }), mon('Charizard', ['surf'])],
		[mon('Rotom-Wash', ['voltswitch']), mon('Heatran', ['flamethrower'], { ability: 'Flash Fire' }),
			mon('Excadrill', ['earthquake', 'ironhead', 'rockslide']), mon('Metagross', ['meteormash'])]);
		f.state.self.reserve[0].baseStats.spe = 10;
		const search = new Search(new MatchupEvaluator());
		const staying = search.transitions(f.state, action('roost'), action('voltswitch'), false);
		assert(staying.every(b => !['Excadrill', 'Metagross'].includes(b.state.opponent.active[0].species)));
		const switched = search.transitions(f.state,
			{ id: 'switch 2', switchTo: f.state.self.reserve[0], prior: 100 }, action('voltswitch'), false);
		assert(switched.some(b => b.state.opponent.active[0].species === 'Excadrill'));
	});
	it('uses the public belief pool to filter entries consistently across hidden stat profiles', () => {
		const f = fixture([mon('Jolteon', ['voltswitch']), mon('Skarmory', ['ironhead']), mon('Garchomp', ['earthquake'])],
			[mon('Mew', ['icebeam', 'thunderbolt'])]);
		const foe = f.state.opponent.active[0];
		foe.presetModels = [50, 400].map(spa => ({ name: `spa ${spa}`, weight: 0.5, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, spa } },
			moves: foe.moves.map(id => ({ id, availability: 1 })) }));
		const search = new Search(new MatchupEvaluator(), f.state);
		const choices = modelsFor(foe).map(model => {
			const state = clonePosition(f.state); bindOpponent(state, foe, model);
			return search.entryChoices(state, 'self', 'exposed').map(p => p.species);
		});
		assert.deepEqual(choices[0], choices[1]);
	});
	it('does not let a fast pivot choose its recipient after seeing a queued opposing attack', () => {
		const f = fixture([mon('Jolteon', ['voltswitch']), mon('Skarmory', ['splash']), mon('Garchomp', ['splash'])],
			[mon('Mew', ['earthquake', 'icebeam'])]);
		f.state.opponent.active[0].baseStats.atk = f.state.opponent.active[0].baseStats.spa = 10;
		const search = new Search(new MatchupEvaluator());
		search.value = state => (state.self.active[0].species === 'Skarmory') ===
			(state.opponent.active[0].lastMove === 'earthquake') ? 10 : -10;
		assert.equal(search.continuationValue(f.state, action('voltswitch')), -10);
	});
	it('uses one pivot recipient across indistinguishable hidden configurations', () => {
		const f = fixture([mon('Jolteon', ['voltswitch']), mon('Skarmory', ['splash']), mon('Garchomp', ['splash'])],
			[mon('Mew', ['splash'])]);
		const foe = f.state.opponent.active[0];
		foe.observedAbility = '';
		foe.presetModels = ['pressure', 'synchronize'].map(ability => ({ name: ability, weight: 0.5, matched: true,
			pokemon: { ...foe, ability }, moves: [{ id: 'splash', availability: 1 }] }));
		const search = new Search(new MatchupEvaluator());
		search.value = state => (state.self.active[0].species === 'Skarmory') ===
			(state.opponent.active[0].ability === 'pressure') ? 10 : -10;
		assert.equal(search.continuationValue(f.state, action('voltswitch')), 0);
	});
	it('weights random phazing uniformly instead of choosing the best recipient', () => {
		const f = fixture([mon('Mew', ['roar'])],
			[mon('Blissey', ['splash']), mon('Pikachu', ['splash']), mon('Garchomp', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		const outcomes = search.transitions(f.state, action('roar'), action('splash'), false);
		assert.deepEqual(outcomes.map(o => o.weight), [0.5, 0.5]);
		assert(outcomes.every(o => !o.entries.length));
		// Isolate phazing from the opponent's voluntary switches.
		f.state.opponent.active[0].volatiles.add('trapped');
		search.value = state => state.opponent.active[0].species === 'Pikachu' ? 10 : -10;
		assert.equal(search.continuationValue(f.state, action('roar')), 0);
	});
	it('lets the opponent choose its free replacement against our team', () => {
		const f = fixture([mon('Mew', ['seismictoss'])],
			[mon('Magikarp', ['splash']), mon('Pikachu', ['splash']), mon('Garchomp', ['splash'])]);
		hp(f.state.opponent.active[0], 1); f.state.opponent.active[0].volatiles.add('trapped');
		const search = new Search(new MatchupEvaluator());
		search.value = state => state.opponent.active[0].species === 'Pikachu' ? 10 : -10;
		assert.equal(search.continuationValue(f.state, action('seismictoss')), -10);
	});
	it('releases binding damage on source switch or KO, without transferring it to the replacement', () => {
		const f = fixture([mon('Mew', ['firespin']), mon('Landorus-Therian', ['splash'])],
			[mon('Blissey', ['splash', 'seismictoss'], { item: 'Leftovers' })]);
		const bound = step(f.state, 'firespin', 'splash');
		assert(bound.opponent.active[0].volatiles.has('partiallytrapped'));
		assert.equal(bound.opponent.active[0].trapSource, f.state.self.active[0].ident);
		const health = bound.opponent.active[0].hp, heal = Math.floor(bound.opponent.active[0].maxHp / 16);
		const switched = advancePosition(bound, { id: 'switch 2', switchTo: bound.self.reserve[0], prior: 0 },
			action('splash'), () => undefined);
		assert.equal(switched.opponent.active[0].hp, health + heal);
		assert(!switched.opponent.active[0].volatiles.has('partiallytrapped'));
		assert.equal(switched.opponent.active[0].trapSource, undefined);
		const returned = advancePosition(switched, { id: 'switch 1', switchTo: switched.self.reserve[0], prior: 0 },
			action('splash'), () => undefined);
		assert(!returned.opponent.active[0].volatiles.has('partiallytrapped'));
		hp(bound.self.active[0], 1);
		const knockedOut = step(bound, 'splash', 'seismictoss');
		assert(knockedOut.self.active[0].fainted);
		assert.equal(knockedOut.opponent.active[0].hp, health + heal);
		// Poison resolves before binding, regardless of which side owns the source.
		bound.self.active[0].status = 'psn';
		const reversed = { ...bound, self: bound.opponent, opponent: bound.self };
		const poisoned = step(reversed, 'splash', 'splash');
		assert(poisoned.opponent.active[0].fainted);
		assert.equal(poisoned.self.active[0].hp, health + heal);
	});
	it('keeps parameterized attacks through the search action and damage boundary', () => {
		const f = fixture([mon('Tornadus-Therian', ['hiddenpowerice'])], [mon('Landorus-Therian', ['splash'])]);
		const move = hardMove('hiddenpowerice', 1, 'gen6customgame');
		const next = step(f.state, hardMoveId(move), 'splash');
		assert.equal(f.state.opponent.active[0].hp - next.opponent.active[0].hp,
			Math.floor(damage(f.state, 'hiddenpowerice').average));
		assert.equal(hardMove(hardMoveId(hardMove('return50', 1, 'gen6customgame')), 1, 'gen6customgame').basePower, 50);
	});
	it('uses the same active-item restrictions in search and matchup valuation', () => {
		const f = fixture([mon('Mew', ['psychic', 'softboiled'], { item: 'Assault Vest' })], [mon('Mew', ['splash'])]);
		hp(f.state.self.active[0], 100);
		assert(!usableMove(f.state, 'self', 'softboiled'));
		assert.equal(step(f.state, 'softboiled', 'splash').self.active[0].hp, 100);
		f.state.field.magicroom = true;
		assert(usableMove(f.state, 'self', 'softboiled'));
		assert(step(f.state, 'softboiled', 'splash').self.active[0].hp > 100);
		const g = fixture([mon('Hydreigon', ['darkpulse', 'dragonpulse'], { item: 'Choice Specs' })],
			[mon('Azumarill', ['splash'])]);
		g.state.self.active[0].lastMove = 'dragonpulse';
		assert(!usableMove(g.state, 'self', 'darkpulse'));
		assert.equal(new MatchupEvaluator().assess(g.state).matrix[0][0].self.pressure, 0);
		g.state.self.active[0].lastMove = '';
		assert(new MatchupEvaluator().assess(g.state).matrix[0][0].self.pressure > 0);
	});
	it('resolves Gen 6 sacrifice healing before entry hazards, including a 1 HP recipient', () => {
		for (const move of ['healingwish', 'lunardance']) {
			const f = fixture([mon('Latias', [move]), mon('Mew', ['psychic'])], [mon('Blissey', ['splash'])]);
			const recipient = f.state.self.reserve[0]; hp(recipient, 100); recipient.status = 'tox';
			f.state.self.conditions.stealthrock = true;
			let next = step(f.state, move, 'splash');
			assert(next.self.active[0].fainted);
			assert.equal(next.self.conditions.healingWishes[1], move);
			switchIn(next, 'self', next.self.reserve[0]);
			assert.equal(next.self.active[0].hp, recipient.maxHp - Math.floor(recipient.maxHp / 8));
			assert.equal(next.self.active[0].status, '');
			assert(!next.self.conditions.healingWishes[1]);
			if (move === 'lunardance') assert.equal(next.self.active[0].projection.pp.psychic, 16);
			const result = searchPosition(f.state, f.evaluator, [action(move)], new Map());
			assert.equal(result.choice, `move ${move}`, result.reason);
			hp(recipient, 1); next = step(f.state, move, 'splash');
			switchIn(next, 'self', next.self.reserve[0]);
			assert.equal(next.self.active[0].hp, recipient.maxHp - Math.floor(recipient.maxHp / 8));
		}
	});
	it('enumerates Sleep Talk calls without sampling, picking the best call, or spending called PP', () => {
		const f = fixture([mon('Snorlax', ['rest', 'sleeptalk', 'bodyslam'])], [mon('Mew', ['splash'])]);
		const p = f.state.self.active[0]; p.status = 'slp';
		p.sleepTurns = 3; hp(p, 100);
		p.projection = { pp: { rest: 10, sleeptalk: 10, bodyslam: 10 } };
		const outcomes = actionOutcomes(f.state, 'self', action('sleeptalk'));
		assert.deepEqual(outcomes.map(o => [o.action.calledMove, o.weight]), [['rest', 0.5], ['bodyslam', 0.5]]);
		for (const outcome of outcomes) {
			const next = advancePosition(f.state, outcome.action, action('splash'), () => undefined);
			assert.equal(next.self.active[0].sleepTurns, 2);
			assert.equal(next.self.active[0].projection.pp.sleeptalk, 9);
			assert.equal(next.self.active[0].projection.pp.bodyslam, 10);
			assert.equal(next.self.active[0].hp, 100); // Called Rest fails while asleep.
			assert.equal(next.opponent.active[0].hp < f.state.opponent.active[0].hp, outcome.action.calledMove === 'bodyslam');
		}
		assert.equal(searchPosition(f.state, f.evaluator, [action('sleeptalk')], new Map()).choice, 'move sleeptalk');
	});
	it('settles a delayed attack on a replacement and preserves Dark immunity', () => {
		const f = fixture([mon('Mew', ['futuresight'])], [mon('Blissey', ['splash']), mon('Umbreon', ['splash'])]);
		let next = step(f.state, 'futuresight', 'splash');
		next = advancePosition(next, action('splash'), { id: 'switch 2', switchTo: next.opponent.reserve[0], prior: 0 }, () => undefined);
		next = step(next, 'splash', 'splash');
		assert.equal(next.opponent.active[0].hp, next.opponent.active[0].maxHp);
	});
	it('covers every move in the Gen 6 OU preset catalogue', () => {
		const presets = require('../../../data/npc/strategies/gen6ou.json');
		for (const id of new Set(Object.values(presets.species).flatMap(sets => sets.flatMap(set => set.moves.flat())))) {
			assert(supportsMove({ field: { formatId: 'gen6ou' } }, id), id);
		}
	});
	it('projects common non-damaging effects and restores copied properties on switching', () => {
		let f = fixture([mon('Azumarill', ['bellydrum'], { item: 'Sitrus Berry', evs: { hp: 4 } })], [mon('Blissey', ['splash'])]);
		let next = step(f.state, 'bellydrum', 'splash');
		assert.equal(next.self.active[0].boosts.atk, 6);
		assert.equal(next.self.active[0].hp, f.state.self.active[0].hp - Math.floor(f.state.self.active[0].maxHp / 2) +
		Math.floor(f.state.self.active[0].maxHp / 4));
		assert(next.self.active[0].itemLost);
		f = fixture([mon('Mew', ['reflecttype', 'skillswap']), mon('Blissey', ['splash'])],
			[mon('Gengar', ['splash'], { ability: 'Levitate' })]);
		next = step(f.state, 'reflecttype', 'splash');
		assert.deepEqual(next.self.active[0].types, ['Ghost', 'Poison']);
		switchIn(next, 'self', next.self.reserve[0]);
		assert.deepEqual(next.self.reserve[0].types, ['Psychic']);
		next = step(f.state, 'skillswap', 'splash');
		assert.equal(next.self.active[0].ability.toLowerCase(), 'levitate');
		switchIn(next, 'self', next.self.reserve[0]);
		assert.equal(next.self.reserve[0].ability, f.state.self.active[0].ability);
		f = fixture([mon('Ditto', ['transform']), mon('Mew', ['splash'])], [mon('Garchomp', ['earthquake'])]);
		next = step(f.state, 'transform', 'splash');
		assert.equal(next.self.active[0].species, 'Garchomp');
		switchIn(next, 'self', next.self.reserve[0]); assert.equal(next.self.reserve[0].species, 'Ditto');
	});
	it('weights indistinguishable configurations when choosing the second-turn continuation', () => {
		const f = fixture([mon('Mew', ['protect', 'energyball', 'tackle'])], [mon('Mew', ['splash'])]);
		const p = f.state.opponent.active[0]; p.itemKnown = false; p.observedAbility = '';
		const value = weight => {
			const models = [['waterabsorb', weight], ['sapsipper', 1 - weight]].map(([ability, mass]) => ({
				name: ability, pokemon: { ...p, ability, baseStats: { ...p.baseStats, spd: 60, def: 250 } },
				weight: mass, matched: true, moves: [{ id: 'splash', availability: 1 }],
			})).filter(m => m.weight > 0);
			f.evaluator.models = new Map([[p, models]]);
			return searchPosition(f.state, f.evaluator, [action('protect')], new Map(),
				new MatchupEvaluator(), false, { prune: false }).values[0].value;
		};
		// At 1% Sap Sipper, the strong Energy Ball continuation remains worthwhile.
		// A worst-profile minimum instead chooses the weak Tackle in both distributions.
		assert(value(0.99) > value(1) * 0.9);
		assert(value(0.99) > value(0.01) * 3);
	});
	it('handles Bounce charging, Perish Song timing, Magnet Rise and Fairy Lock duration', () => {
		let f = fixture([mon('Mew', ['bounce'])], [mon('Blissey', ['tackle'])]);
		let next = step(f.state, 'bounce', 'tackle');
		assert.equal(next.self.active[0].hp, f.state.self.active[0].hp);
		assert(next.self.active[0].volatiles.has('bounce'));
		next = step(next, 'bounce', 'tackle');
		assert(next.opponent.active[0].hp < f.state.opponent.active[0].hp);
		assert(!next.self.active[0].volatiles.has('bounce'));
		f = fixture([mon('Mew', ['perishsong', 'magnetrise', 'fairylock'])], [mon('Blissey', ['splash'])]);
		next = step(f.state, 'perishsong', 'splash');
		assert(next.self.active[0].volatiles.has('perish2'));
		for (let i = 0; i < 3; i++) next = step(next, 'splash', 'splash');
		assert(next.self.active[0].fainted && next.opponent.active[0].fainted);
		next = step(f.state, 'magnetrise', 'splash'); assert(next.self.active[0].volatiles.has('magnetrise'));
		next = step(f.state, 'fairylock', 'splash'); assert.equal(next.field.fairylockTurns, 1);
		next = step(next, 'splash', 'splash'); assert.equal(next.field.fairylockTurns, 0);
	});
	it('matches PS damage ranges using actual public stats rather than guessing EVs', () => {
		for (const [own, foe, move] of [
			[mon('Metagross-Mega', ['bulletpunch'], { ability: 'Tough Claws', nature: 'Adamant', evs: { atk: 252 } }),
				mon('Medicham-Mega', ['splash']), 'bulletpunch'],
			[mon('Rotom-Wash', ['hydropump'], { item: 'Choice Specs', evs: { spa: 252 } }),
				mon('Heatran', ['splash'], { item: 'Assault Vest', evs: { hp: 252, spd: 252 } }), 'hydropump'],
			[mon('Sylveon', ['hypervoice'], { ability: 'Pixilate' }), mon('Mew', ['splash']), 'hypervoice'],
			[mon('Gengar', ['hex']), mon('Mew', ['splash']), 'hex'],
			[mon('Chansey', ['seismictoss']), mon('Tyranitar', ['splash']), 'seismictoss'],
		]) {
			const f = fixture([own], [foe]); const actual = damage(f.state, move);
			const expected = [];
			for (let roll = 85; roll <= 100; roll++) {
				f.b.randomizer = n => Math.floor(n * roll / 100);
				let m = f.b.dex.getActiveMove(move); m.willCrit = false;
				f.b.setActiveMove(m, f.b.p1.active[0], f.b.p2.active[0]);
				f.b.singleEvent('ModifyType', m, null, f.b.p1.active[0], f.b.p2.active[0], m, m);
				f.b.singleEvent('ModifyMove', m, null, f.b.p1.active[0], f.b.p2.active[0], m, m);
				m = f.b.runEvent('ModifyType', f.b.p1.active[0], f.b.p2.active[0], m, m);
				m = f.b.runEvent('ModifyMove', f.b.p1.active[0], f.b.p2.active[0], m, m);
				expected.push(f.b.actions.getDamage(f.b.p1.active[0], f.b.p2.active[0], m));
			}
			assert.equal(actual.min, Math.min(...expected), move);
			assert.equal(actual.max, Math.max(...expected), move);
		}
	});
	it('uses one explicit damage policy without rolling accuracy or critical hits', () => {
		const f = fixture([mon('Mew', ['hydropump'])], [mon('Blissey', ['splash'])]);
		const result = damage(f.state, 'hydropump');
		assert.equal(selectDamage(result), result.rolls.reduce((a, b) => a + b) / result.rolls.length);
		assert.equal(selectDamage(result, { quantile: 0.6 }), result.rolls[Math.ceil(result.rolls.length * 0.6) - 1]);
		const before = structuredClone(f.state);
		const mean = step(f.state, 'hydropump', 'splash');
		const high = step(f.state, 'hydropump', 'splash', { quantile: 1 });
		assert.equal(mean.opponent.active[0].hp, before.opponent.active[0].hp - Math.floor(result.average));
		assert(high.opponent.active[0].hp < mean.opponent.active[0].hp);
		assert.deepEqual(f.state, before);
	});
	it('preserves immunity, protection and guaranteed status without lucky extra effects', () => {
		let f = fixture([mon('Mew', ['thunderbolt'])], [mon('Garchomp', ['splash'])]);
		assert.equal(step(f.state, 'thunderbolt', 'splash').opponent.active[0].hp, f.state.opponent.active[0].hp);
		f = fixture([mon('Mew', ['scald'])], [mon('Blissey', ['protect'])]);
		assert.equal(step(f.state, 'scald', 'protect').opponent.active[0].hp, f.state.opponent.active[0].hp);
		assert.equal(step(f.state, 'scald', 'splash').opponent.active[0].status, '');
		f = fixture([mon('Mew', ['nuzzle'])], [mon('Blissey', ['splash'])]);
		assert.equal(step(f.state, 'nuzzle', 'splash').opponent.active[0].status, 'par');
	});
	it('applies setup to stats and lets the unified position evaluator see its future benefit', () => {
		const f = fixture([mon('Garchomp', ['swordsdance', 'earthquake'])], [mon('Blissey', ['splash'])]);
		const next = step(f.state, 'swordsdance', 'splash');
		assert.equal(next.self.active[0].boosts.atk, 2);
		assert(damage(next, 'earthquake').average > damage(f.state, 'earthquake').average * 1.8);
	});
	it('applies Toxic to HP and future defensive value instead of a separate move reward', () => {
		const f = fixture([mon('Chansey', ['toxic', 'softboiled'], { item: 'Eviolite' })],
			[mon('Cresselia', ['psychic', 'moonlight'])]);
		const next = step(f.state, 'toxic', 'splash');
		assert.equal(next.opponent.active[0].status, 'tox');
		assert.equal(next.opponent.active[0].toxicCounter, 1);
		assert(next.opponent.active[0].hp < f.state.opponent.active[0].hp);
		const later = step(next, 'splash', 'splash');
		assert(next.opponent.active[0].hp - later.opponent.active[0].hp > f.state.opponent.active[0].hp - next.opponent.active[0].hp);
	});
	it('does not execute the move of a Pokemon knocked out before its action', () => {
		const f = fixture([mon('Metagross-Mega', ['bulletpunch'], { ability: 'Tough Claws', nature: 'Adamant', evs: { atk: 252 } })],
			[mon('Medicham-Mega', ['highjumpkick'], { ability: 'Pure Power' })]);
		hp(f.state.opponent.active[0], 100);
		const next = step(f.state, 'bulletpunch', 'highjumpkick');
		assert(next.opponent.active[0].fainted); assert.equal(next.self.active[0].hp, f.state.self.active[0].hp);
	});
	it('protects an existing Substitute, consumes its HP, and applies no excess damage', () => {
		const f = fixture([mon('Mew', ['substitute'])], [mon('Chansey', ['seismictoss'])]);
		const next = step(f.state, 'substitute', 'seismictoss');
		assert.equal(next.self.active[0].hp, f.state.self.active[0].hp - Math.floor(f.state.self.active[0].maxHp / 4));
		assert(!next.self.active[0].volatiles.has('substitute'));
	});
	it('models Rest as two skipped subsequent actions and ordinary recovery at the correct time', () => {
		const f = fixture([mon('Mew', ['rest', 'psychic'])], [mon('Blissey', ['splash'])]);
		hp(f.state.self.active[0], 100);
		let next = step(f.state, 'rest', 'splash');
		assert.equal(next.self.active[0].hp, next.self.active[0].maxHp);
		for (let i = 0; i < 2; i++) {
			next = step(next, 'psychic', 'splash'); assert.equal(next.opponent.active[0].hp, next.opponent.active[0].maxHp);
		}
		next = step(next, 'psychic', 'splash'); assert(next.opponent.active[0].hp < next.opponent.active[0].maxHp);
	});
	it('handles entry hazards, Regenerator and Intimidate without a simulator', () => {
		const f = fixture([mon('Slowbro', ['splash'], { ability: 'Regenerator' }),
			mon('Landorus-Therian', ['earthquake'], { ability: 'Intimidate' })], [mon('Garchomp', ['splash'])]);
		hp(f.state.self.active[0], 100); f.state.self.conditions.stealthrock = true;
		const next = clonePosition(f.state); switchIn(next, 'self', next.self.reserve[0]);
		assert(next.self.active[0].hp < next.self.active[0].maxHp);
		assert(next.self.reserve[0].hp > 100); assert.equal(next.opponent.active[0].boosts.atk, -1);
	});
	it('applies pivot damage only on a successful hit and charges the entry before the pending attack', () => {
		const f = fixture([mon('Mew', ['voltswitch']), mon('Blissey', ['splash'])], [mon('Garchomp', ['splash'])]);
		assert.equal(step(f.state, 'voltswitch', 'splash').self.active[0].species, 'Mew');
		f.state.opponent.active[0].types = ['Water'];
		assert.equal(step(f.state, 'voltswitch', 'splash').self.active[0].species, 'Blissey');
	});
	it('reflects hazards and Taunt through Magic Bounce, including their next-turn consequences', () => {
		const f = fixture([mon('Mew', ['stealthrock', 'taunt'])], [mon('Espeon', ['splash'], { ability: 'Magic Bounce' })]);
		const hazards = step(f.state, 'stealthrock', 'splash');
		assert(hazards.self.conditions.stealthrock); assert(!hazards.opponent.conditions.stealthrock);
		const taunt = step(f.state, 'taunt', 'splash');
		assert(taunt.self.active[0].volatiles.has('taunt')); assert(!taunt.opponent.active[0].volatiles.has('taunt'));
	});
	it('heals an absorbing ability and uses Mold Breaker when checking Sturdy', () => {
		const f = fixture([mon('Mew', ['surf'])], [mon('Vaporeon', ['splash'], { ability: 'Water Absorb' })]);
		hp(f.state.opponent.active[0], 100);
		assert(step(f.state, 'surf', 'splash').opponent.active[0].hp > 100);
		const g = fixture([mon('Haxorus', ['earthquake'], { ability: 'Mold Breaker', evs: { atk: 252 } })],
			[mon('Magnemite', ['splash'], { ability: 'Sturdy', level: 1 })]);
		assert(step(g.state, 'earthquake', 'splash').opponent.active[0].fainted);
	});
	it('passes Wish using the source HP after switching to a recipient with different HP', () => {
		const f = fixture([mon('Blissey', ['wish']), mon('Mew', ['splash'])], [mon('Magikarp', ['splash'])]);
		hp(f.state.self.reserve[0], 10);
		let next = step(f.state, 'wish', 'splash');
		next = advancePosition(next, { id: 'switch 2', switchTo: next.self.reserve[0], prior: 0 }, action('splash'), () => undefined);
		assert.equal(next.self.active[0].hp, Math.min(next.self.active[0].maxHp, 10 + Math.floor(f.state.self.active[0].maxHp / 2)));
	});
	it('receives Wish before poison but cannot recover after a weather KO or through Heal Block', () => {
		for (const mode of ['poison', 'sand', 'healblock']) {
			const f = fixture([mon('Blissey', ['wish', 'splash'])], [mon('Magikarp', ['splash'])]);
			let next = step(f.state, 'wish', 'splash');
			const actor = next.self.active[0]; hp(actor, 1); actor.status = 'psn';
			if (mode === 'sand') Object.assign(next.field, { weather: 'sand', weatherId: 'sandstorm', weatherTurns: 4 });
			if (mode === 'healblock') actor.volatiles.add('healblock');
			next = step(next, 'splash', 'splash');
			assert.equal(next.self.active[0].hp, mode === 'poison' ?
				1 + Math.floor(actor.maxHp / 2) - Math.floor(actor.maxHp / 8) : 0, mode);
			assert.equal(next.self.conditions.wishes[1], 0);
			assert(!next.self.conditions.wishSources[1]);
		}
	});
	it('keeps Wish on the vacated field slot across a pivot, including a fainted caster', () => {
		const f = fixture([mon('Blissey', ['wish', 'uturn']), mon('Mew', ['splash'])], [mon('Magikarp', ['splash'])]);
		hp(f.state.self.reserve[0], 10);
		const pending = step(f.state, 'wish', 'splash');
		const pivoted = step(pending, 'uturn', 'splash');
		assert.equal(pivoted.self.active[0].species, 'Mew');
		assert.equal(pivoted.self.active[0].slot, 1);
		assert.equal(pivoted.self.active[0].hp, Math.min(pivoted.self.active[0].maxHp,
			10 + Math.floor(f.state.self.active[0].maxHp / 2)));
		assert.equal(pending.self.active[0].species, 'Blissey', 'Branching must not mutate the original position');
		hp(pending.self.active[0], 0);
		switchIn(pending, 'self', pending.self.reserve[0]);
		const healed = step(pending, 'splash', 'splash');
		assert.equal(healed.self.active[0].hp, pivoted.self.active[0].hp);
	});
	it('uses recipient HP for Gen 4 Wish and source HP for Gen 6 Wish', () => {
		for (const gen of [4, 6]) {
			const f = fixture([mon('Magikarp', ['wish']), mon('Blissey', ['splash'])], [mon('Magikarp', ['splash'])]);
			f.state.field.formatId = `gen${gen}customgame`; hp(f.state.self.reserve[0], 10);
			let next = step(f.state, 'wish', 'splash');
			next = advancePosition(next, { id: 'switch 2', switchTo: next.self.reserve[0], prior: 0 }, action('splash'), () => undefined);
			const source = gen === 4 ? next.self.active[0] : f.state.self.active[0];
			assert.equal(next.self.active[0].hp, 10 + Math.floor(source.maxHp / 2));
		}
	});
	it('restores Regenerator once on a projected exit and applies hazards on the later entry', () => {
		const f = fixture([mon('Tornadus-Therian', ['uturn'], { ability: 'Regenerator' }), mon('Mew', ['splash'])],
			[mon('Blissey', ['splash'])]);
		const bird = f.state.self.active[0]; hp(bird, 10); f.state.self.conditions.stealthrock = true;
		const next = step(f.state, 'uturn', 'splash');
		const rested = next.self.reserve.find(p => p.species === bird.species);
		assert.equal(rested.hp, 10 + Math.floor(bird.maxHp / 3));
		switchIn(next, 'self', rested);
		assert.equal(next.self.active[0].hp, 10 + Math.floor(bird.maxHp / 3) - Math.floor(bird.maxHp / 4));
		assert(!next.self.active[0].fainted);
		assert.equal(bird.hp, 10);
	});
	it('keeps stored sacrifice healing per field slot and consumes it according to the generation', () => {
		for (const gen of [6, 9]) for (const move of ['healingwish', 'lunardance']) {
			const f = fixture([mon('Mew', ['psychic'])], [mon('Magikarp', ['splash'])]);
			f.state.field.formatId = `gen${gen}customgame`;
			const p = f.state.self.active[0], c = f.state.self.conditions;
			c.healingWishes = { 1: move, 2: move };
			applyEntryEffects(p, c, f.state.field);
			assert.equal(c.healingWishes[1], gen === 6 ? undefined : move);
			assert.equal(c.healingWishes[2], move);
			c.healingWishes[1] = move; c.stealthrock = true;
			hp(p, 1); p.status = 'tox';
			p.sleepTurns = 2; p.toxicCounter = 8;
			p.projection = { pp: { psychic: 0 } };
			applyEntryEffects(p, c, f.state.field);
			assert.equal(p.hp, p.maxHp - Math.floor(p.maxHp / 8));
			assert.equal(p.status, ''); assert.equal(p.toxicCounter, 0); assert.equal(p.sleepTurns, 0);
			assert.equal(p.projection.pp.psychic, move === 'lunardance' ? 16 : 0);
			assert(!c.healingWishes[1]);
			hp(p, 1); applyEntryEffects(p, c, f.state.field);
			assert(p.fainted, 'A consumed effect cannot heal the next entry');
		}
	});
	it('uses Gen 4 hazard order before sacrifice healing, including Toxic Spikes', () => {
		const f = fixture([mon('Mew', ['psychic'])], [mon('Magikarp', ['splash'])]);
		f.state.field.formatId = 'gen4customgame';
		const p = f.state.self.active[0], c = f.state.self.conditions;
		c.healingWishes = { 1: 'healingwish' }; c.stealthrock = true; c.toxicspikes = 2;
		hp(p, 100); applyEntryEffects(p, c, f.state.field);
		assert.equal(p.hp, p.maxHp); assert.equal(p.status, '');
		c.healingWishes[1] = 'healingwish'; hp(p, 1);
		applyEntryEffects(p, c, f.state.field);
		assert(p.fainted, 'Healing cannot revive a recipient that faints to the earlier hazard');
	});
	it('includes stored sacrifice healing when evaluating a forced replacement', () => {
		const f = fixture([mon('Latias', ['healingwish']), mon('Mew', ['psychic'])], [mon('Magikarp', ['splash'])]);
		hp(f.state.self.active[0], 0); hp(f.state.self.reserve[0], 1);
		f.state.self.conditions.stealthrock = true;
		f.state.self.conditions.healingWishes = { 1: 'healingwish' };
		const result = f.evaluator.scoreSwitch(f.state.self.reserve[0], new Map(), true);
		assert(result.safe, result.reasons.join('; '));
		assert.equal(f.state.self.conditions.healingWishes[1], 'healingwish', 'Evaluation cannot consume the live effect');
	});
	it('includes pending Wish in switch survival using the caster rather than the outgoing Pokemon', () => {
		const f = fixture([mon('Magikarp', ['splash']), mon('Blissey', ['wish']), mon('Mew', ['splash'])],
			[mon('Magikarp', ['splash'])]);
		const recipient = f.state.self.reserve[1]; hp(recipient, 1); recipient.status = 'psn';
		f.state.self.conditions.wishes[1] = 1;
		f.state.self.conditions.wishSources = { 1: f.state.self.reserve[0].ident };
		const result = f.evaluator.scoreSwitch(recipient, new Map(), false, f.state.self.active[0]);
		assert(result.safe, result.reasons.join('; '));
		assert(result.reasons.some(reason => reason.startsWith('Wish recipient')));
	});
	it('does not discard an unsupported opponent response while returning a confident search result', () => {
		const f = fixture([mon('Mew', ['psychic', 'psyshock'])], [mon('Mew', ['batonpass', 'splash']), mon('Magikarp', ['splash'])]);
		const result = searchPosition(f.state, f.evaluator, [action('psychic'), action('psyshock')], new Map());
		assert(!result.choice); assert(result.reason.includes('batonpass'));
	});
	it('keeps reactive damage separate from ordinary damage and fails Counter against special attacks', () => {
		const f = fixture([mon('Mew', ['tackle', 'watergun'])], [mon('Blissey', ['counter'])]);
		const next = step(f.state, 'tackle', 'counter');
		const taken = f.state.opponent.active[0].hp - next.opponent.active[0].hp;
		assert.equal(f.state.self.active[0].hp - next.self.active[0].hp, taken * 2);
		assert.equal(step(f.state, 'watergun', 'counter').self.active[0].hp, f.state.self.active[0].hp);
	});
	it('charges Solar Beam outside sunlight and resolves it directly in sunlight', () => {
		const f = fixture([mon('Mew', ['solarbeam'])], [mon('Blissey', ['splash'])]);
		const next = step(f.state, 'solarbeam', 'splash');
		assert.equal(next.opponent.active[0].hp, f.state.opponent.active[0].hp);
		assert(step(next, 'solarbeam', 'splash').opponent.active[0].hp < next.opponent.active[0].hp);
		Object.assign(f.state.field, { weather: 'sun', weatherId: 'sunnyday', weatherTurns: 4 });
		assert(step(f.state, 'solarbeam', 'splash').opponent.active[0].hp < f.state.opponent.active[0].hp);
	});
	it('applies both versions of Curse and preserves a guaranteed self boost on a KO', () => {
		const f = fixture([mon('Snorlax', ['curse'])], [mon('Mew', ['splash'])]);
		const next = step(f.state, 'curse', 'splash');
		assert.equal(next.self.active[0].boosts.atk, 1); assert.equal(next.self.active[0].boosts.spe, -1);
		f.state.self.active[0].types = ['Ghost'];
		const cursed = step(f.state, 'curse', 'splash');
		assert(cursed.opponent.active[0].volatiles.has('curse'));
		assert(cursed.self.active[0].hp <= f.state.self.active[0].maxHp / 2 + 1);
		const g = fixture([mon('Mew', ['poweruppunch'])], [mon('Blissey', ['splash'])]);
		hp(g.state.opponent.active[0], 1);
		assert.equal(step(g.state, 'poweruppunch', 'splash').self.active[0].boosts.atk, 1);
	});
	it('intercepts the departing Pokemon with Pursuit instead of attacking its replacement', () => {
		const f = fixture([mon('Weavile', ['pursuit'])], [mon('Snorlax', ['splash']), mon('Mew', ['splash'])]);
		const normal = damage(f.state, 'pursuit').average;
		const next = advancePosition(f.state, action('pursuit'),
			{ id: 'switch 2', switchTo: f.state.opponent.reserve[0], prior: 100 }, () => undefined);
		assert.equal(next.opponent.active[0].species, 'Mew');
		assert.equal(next.opponent.active[0].hp, next.opponent.active[0].maxHp);
		const loss = f.state.opponent.active[0].hp - next.opponent.reserve[0].hp;
		assert(loss > normal * 1.9);
	});
	it('does not turn a delayed attack into immediate damage', () => {
		const f = fixture([mon('Mew', ['futuresight'])], [mon('Mew', ['splash'])]);
		const result = searchPosition(f.state, f.evaluator, [action('futuresight')], new Map());
		assert.equal(result.choice, 'move futuresight');
		let next = step(f.state, 'futuresight', 'splash');
		assert.equal(next.opponent.active[0].hp, f.state.opponent.active[0].hp);
		assert.equal(next.opponent.conditions.futureMoves[1], 2);
		next = step(next, 'splash', 'splash');
		assert.equal(next.opponent.active[0].hp, f.state.opponent.active[0].hp);
		next = step(next, 'splash', 'splash');
		assert(next.opponent.active[0].hp < f.state.opponent.active[0].hp);
		assert.equal(next.opponent.conditions.futureMoves[1], 0);
	});
	it('retains every compatible candidate, and excludes conflicting moves only after a hypothetical reveal', () => {
		const f = fixture([mon('Mew', ['splash'])], [mon('Metagross', ['bulletpunch'])]);
		const p = f.state.opponent.active[0]; p.moves = [];
		p.moveKnowledge = { revealedMoves: [], presetCandidates: ['bulletpunch', 'icepunch', 'meteormash', 'zenheadbutt', 'hammerarm'],
			remainingSlots: 4, slots: [['meteormash'], ['zenheadbutt'], ['hammerarm'], ['bulletpunch', 'icepunch']] };
		assert.equal(knownMoves(p).length, 5);
		const next = step(f.state, 'splash', 'bulletpunch');
		assert(knownMoves(next.opponent.active[0]).includes('bulletpunch'));
		assert(!knownMoves(next.opponent.active[0]).includes('icepunch'));
		assert.equal(knownMoves(p).length, 5);
	});
	it('uses profile weights without completing or sampling six four-move sets', () => {
		const f = fixture([mon('Mew', ['splash'])], [mon('Metagross', ['bulletpunch'])]);
		const p = f.state.opponent.active[0];
		p.presetModels = [1, 3].map((weight, i) => ({ name: String(i), weight: weight / 4, matched: true,
			pokemon: { ...p, item: i ? 'leftovers' : 'choiceband' }, moves: [{ id: 'bulletpunch', availability: 1 }] }));
		assert.deepEqual(modelsFor(p).map(m => m.weight), [0.25, 0.75]);
	});
	it('uses scoring to reject capped setup and evaluates recovery in its actual damage context', () => {
		const f = fixture([mon('Mew', ['swordsdance', 'recover', 'thunderbolt'])], [mon('Mew', ['tackle'])]);
		f.state.self.active[0].boosts.atk = 6;
		const actions = ['swordsdance', 'recover', 'thunderbolt'].map(action);
		const kept = new Search(new MatchupEvaluator()).choices(f.state, 'self', actions);
		assert(actions.find(a => a.move === 'swordsdance').prior <= 60);
		assert(!kept.some(a => a.move === 'swordsdance'));
		assert(kept.some(a => a.move === 'thunderbolt'));
	});

	it('finds a two-turn setup win and keeps source state isolated', () => {
		const f = fixture([mon('Garchomp', ['swordsdance', 'earthquake'], { evs: { atk: 252, spe: 252 }, nature: 'Jolly' })],
			[mon('Umbreon', ['moonlight', 'tackle'])]);
		const before = structuredClone(f.state);
		const result = searchPosition(f.state, f.evaluator, [action('swordsdance'), action('earthquake')], new Map());
		assert.equal(result.choice, 'move swordsdance', result.reason); assert(result.nodes > 0);
		assert(result.reason.includes('damage-only')); assert.deepEqual(f.state, before);
	});
	it('does not call PS serialization or turn advancement during search', () => {
		const f = fixture([mon('Mew', ['psychic'])], [mon('Machamp', ['closecombat'])]);
		const original = Battle.fromJSON;
		Battle.fromJSON = () => { throw new Error('Search may not construct simulated Battles'); };
		try {
			assert(searchPosition(f.state, f.evaluator, [action('psychic')], new Map()).choice);
		} finally { Battle.fromJSON = original; }
	});
	it('reports unsupported productive actions instead of silently valuing them as no-ops', () => {
		const f = fixture([mon('Mew', ['batonpass', 'psychic']), mon('Alakazam', ['psychic'])], [mon('Mew', ['splash'])]);
		f.state.self.active[0].boosts.spa = 2;
		const result = searchPosition(f.state, f.evaluator, [action('batonpass'), action('psychic')], new Map());
		assert(!result.choice); assert(result.reason.includes('batonpass'));
	});
	it('values a status transition through the same team value function as direct attacks', () => {
		const f = fixture([mon('Mew', ['willowisp'])], [mon('Garchomp', ['earthquake'])]);
		const evaluator = new MatchupEvaluator(), initial = evaluator.assess(f.state).value;
		const next = step(f.state, 'willowisp', 'splash');
		assert(evaluator.assess(next).value > initial);
	});
});
