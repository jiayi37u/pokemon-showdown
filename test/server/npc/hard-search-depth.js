'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { Search, searchPosition } = require('../../../dist/server/npc/ai/hard/search');
const { observationKey } = require('../../../dist/server/npc/ai/hard/candidates');
const battles = [];
const action = move => ({ id: `move ${move}`, move, prior: 100 });
function fixture(ownMoves = ['splash', 'tackle'], foeMoves = ['splash'], reserves = []) {
	const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Own', team: [{ species: 'Mew', moves: ownMoves }, ...reserves] },
		p2: { name: 'Foe', team: [{ species: 'Mew', moves: foeMoves }] } });
	battles.push(battle); battle.makeChoices();
	const state = projectedState(battle), evaluator = new HardEvaluation(state, 'gen6customgame');
	const foe = state.opponent.active[0];
	evaluator.models = new Map([[foe, [{ name: 'observed', pokemon: foe, weight: 1, matched: true,
		moves: foe.moves.map(id => ({ id, availability: 1 })) }]]]);
	return { state, evaluator };
}
function run(f, actions = [action('splash')], replacing = false, prune = false, pp = new Map()) {
	const continuations = [], original = Search.prototype.continuation;
	Search.prototype.continuation = function (state, ...args) {
		continuations.push({ observation: observationKey(state), atk: state.opponent.active[0].baseStats.atk,
			pendingWish: Object.values(state.self.conditions.wishes).some(n => n > 0) });
		return original.call(this, state, ...args);
	};
	try {
		const result = searchPosition(f.state, f.evaluator, actions, pp, new MatchupEvaluator(), replacing, { prune });
		return { result, continuations };
	} finally {
		Search.prototype.continuation = original;
	}
}

describe('Hard selective search depth', () => {
	afterEach(() => battles.splice(0).forEach(battle => battle.destroy()));
	it('stops quiet observations at their first-turn value', () => {
		const f = fixture();
		const quiet = run(f, [action('splash'), action('tackle')]);
		assert.equal(quiet.continuations.length, 0);
		assert(quiet.result.values.every(v => !v.upperBound && !v.lowerBound));
		assert.equal(run(f, [action('splash'), action('tackle')], false, true).result.choice, quiet.result.choice);
	});
	it('extends a positive boost even without an immediate knockout', () => {
		const f = fixture(['swordsdance', 'tackle']);
		assert(run(f, [action('swordsdance')]).continuations.length > 0);
	});
	it('preserves a root Wish commitment after the first turn consumes it', () => {
		const f = fixture();
		f.state.self.active[0].hp = 100;
		f.state.self.conditions.wishes[1] = 1;
		f.state.self.conditions.wishAmounts = { 1: 100 };
		const observed = run(f).continuations;
		assert(observed.length > 0);
		assert(observed.every(c => !c.pendingWish), 'The root commitment survives its endpoint timer');
	});
	it('extends an endpoint immediately before a screen expires', () => {
		const f = fixture(); f.state.self.conditions.reflect = 2;
		assert(run(f).continuations.length > 0);
	});
	it('extends an endpoint whose next residual damage is lethal', () => {
		const f = fixture(); f.state.self.active[0].status = 'psn'; f.state.self.active[0].hp = 70;
		assert(run(f).continuations.length > 0);
	});
	it('recognizes a legal priority knockout but excludes exhausted moves', () => {
		const f = fixture(['splash', 'quickattack']); f.state.opponent.active[0].hp = 5;
		assert(run(f).continuations.length > 0);
		assert.equal(run(f, [action('splash')], false, false, new Map([['quickattack', 0]]))
			.continuations.length, 0);
	});
	it('does not treat a charging attack as an immediate knockout', () => {
		const f = fixture(['splash', 'solarbeam']); f.state.opponent.active[0].hp = 5;
		assert.equal(run(f).continuations.length, 0);
		assert(run(f, [action('solarbeam')]).continuations.length > 0,
			'An attack already charging must complete before static evaluation');
	});
	it('retains an actual exchange after a quiet forced replacement', () => {
		const f = fixture(['splash'], ['splash'], [{ species: 'Pikachu', moves: ['splash', 'tackle'] }]);
		f.state.self.active[0].hp = 0; f.state.self.active[0].fainted = true;
		const replacement = { id: 'switch 2', switchTo: f.state.self.reserve[0], prior: 100 };
		assert(run(f, [replacement], true).continuations.length > 0);
	});
	it('shares continuation depth across indistinguishable hidden configurations', () => {
		const f = fixture(['protect', 'splash'], ['splash', 'tackle']);
		f.state.self.active[0].hp = 100;
		const foe = f.state.opponent.active[0]; foe.itemKnown = false;
		const models = [30, 1000].map(atk => ({ name: `attack ${atk}`, weight: 0.5, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, atk } },
			moves: foe.moves.map(id => ({ id, availability: 1 })) }));
		const check = ordered => {
			f.evaluator.models = new Map([[foe, ordered]]);
			const result = run(f, [action('protect')]);
			const groups = new Map();
			for (const c of result.continuations) {
				if (!groups.has(c.observation)) groups.set(c.observation, new Set());
				groups.get(c.observation).add(c.atk);
			}
			assert(groups.size > 0);
			assert([...groups.values()].every(values => values.has(30) && values.has(1000)));
			return result.result;
		};
		assert.equal(check(models).choice, check([...models].reverse()).choice);
		f.evaluator.models = new Map([[foe, [{ ...models[0], weight: 1 }]]]);
		assert.equal(run(f, [action('protect')]).continuations.length, 0,
			'The safe profile alone is quiet; its continuation above comes from the shared observation');
	});
});
