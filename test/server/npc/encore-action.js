'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { buildBattleStateWithTracker } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { advancePosition, beginTurn } = require('../../../dist/server/npc/ai/hard/projection');
const action = move => ({ id: `move ${move}`, move, prior: 100 });

describe('Encore overrides hypothetical queued actions', () => {
	const battles = [];
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
	function fixture(gen = 6, last = 'tackle', selected = 'splash', prankster = false, casterPrankster = false) {
		const formatId = `gen${gen}customgame`;
		const b = new Battle({ formatid: formatId, seed: '1,2,3,4',
			p1: { name: 'Caster', team: [{ species: prankster ? 'Umbreon' : 'Mew', ability: casterPrankster ? 'Prankster' : 'Synchronize', moves: ['encore', 'splash'],
				nature: 'Timid', evs: { spe: 252 } }] },
			p2: { name: 'Target', team: [{ species: 'Mew', ability: prankster ? 'Prankster' : 'Synchronize',
				moves: [last, selected], nature: 'Brave', ivs: { spe: 0 } }] } });
		battles.push(b); b.makeChoices(); b.makeChoices('move splash', `move ${last}`);
		const state = () => {
			const tracker = createBattleTracker('p2'); tracker.setFormat(formatId); tracker.parseMessage(b.log.join('\n'));
			const result = buildBattleStateWithTracker(b.p2.activeRequest, null, tracker, { ...DEFAULT_AI_CONFIG, formatId });
			// The branch models a faster caster; no opponent configuration is read from Battle.
			result.opponent.active[0].moveKnowledge.presetCandidates.push('encore');
			result.opponent.active[0].item = ''; result.opponent.active[0].itemKnown = true;
			if (casterPrankster) result.opponent.active[0].ability = 'Prankster';
			result.opponent.active[0].baseStats.spe = result.self.active[0].baseStats.spe + 1;
			result.self.active[0].projection = { pp: Object.fromEntries(b.p2.activeRequest.active[0].moves.map(m => [m.id, m.pp])) };
			return result;
		};
		return { b, state };
	}
	for (const gen of [5, 6, 7]) it(`executes and spends PP on the replacement in gen ${gen}`, () => {
		const f = fixture(gen), state = f.state(), before = state.self.active[0].projection.pp;
		const projected = advancePosition(state, action('splash'), action('encore'), () => undefined);
		const start = f.b.log.length; f.b.makeChoices('move encore', 'move splash');
		assert.deepEqual(f.b.log.slice(start).filter(l => l.startsWith('|move|')).map(l => l.split('|')[3]), ['Encore', 'Tackle']);
		assert.equal(projected.self.active[0].lastMove, 'tackle');
		assert.equal(projected.self.active[0].projection.pp.tackle, before.tackle - 1);
		assert.equal(projected.self.active[0].projection.pp.splash, before.splash);
		assert.equal(projected.self.active[0].projection.pp.tackle, f.b.p2.activeRequest.active[0].moves[0].pp);
	});
	it('retains the selected negative priority and queue position after replacing Roar', () => {
		const f = fixture(6, 'tackle', 'roar'), state = f.state();
		const turn = beginTurn(state, action('roar'), action('encore'));
		assert.deepEqual(turn.remaining.map(q => q.side), ['opponent', 'self']);
		assert.equal(turn.remaining[1].queuedMove.priority, -6);
		const projected = advancePosition(state, action('roar'), action('encore'), () => undefined);
		f.b.makeChoices('move encore', 'move roar');
		assert.equal(projected.self.active[0].lastMove, 'tackle');
		assert.equal(projected.self.active[0].projection.pp.tackle, f.b.p2.activeRequest.active[0].moves[0].pp);
	});
	it('uses retained negative priority in the damage calculator under Psychic Terrain', () => {
		const f = fixture(7, 'quickattack', 'roar');
		f.b.field.setTerrain('psychicterrain', f.b.p1.active[0], f.b.dex.moves.get('psychicterrain')); f.b.makeRequest('move');
		const state = f.state();
		const projected = advancePosition(state, action('roar'), action('encore'), () => undefined);
		const start = f.b.log.length; f.b.makeChoices('move encore', 'move roar');
		assert(f.b.log.slice(start).some(l => l.startsWith('|-damage|p1a: Mew|')));
		assert(projected.opponent.active[0].hp < state.opponent.active[0].hp);
	});
	it('does not add Prankster immunity when an attack is replaced by status', () => {
		const f = fixture(7, 'thunderwave', 'tackle', true), state = f.state();
		const projected = advancePosition(state, action('tackle'), action('encore'), () => undefined);
		f.b.makeChoices('move encore', 'move tackle');
		assert(f.b.log.some(l => l === '|-status|p1a: Umbreon|par'));
		assert.equal(projected.opponent.active[0].status, 'par');
	});
	for (const gen of [5, 6, 7]) it(`preserves the queued Prankster flag and gen ${gen} priority semantics`, () => {
		const f = fixture(gen, 'tackle', 'splash', true, true), state = f.state();
		const turn = beginTurn(state, action('splash'), action('encore'));
		assert.equal(turn.remaining[1].queuedMove.priority, gen === 5 ? 0 : 1);
		assert.equal(turn.remaining[1].queuedMove.pranksterBoosted, true);
		const projected = advancePosition(state, action('splash'), action('encore'), () => undefined);
		const start = f.b.log.length; f.b.makeChoices('move encore', 'move splash');
		assert.equal(projected.self.active[0].lastMove, 'tackle');
		assert.equal(projected.self.active[0].projection.pp.tackle, f.b.p2.activeRequest.active[0].moves[0].pp);
		if (gen === 7) {
			assert(f.b.log.slice(start).some(l => l.startsWith('|-immune|p1a: Umbreon')));
			assert.equal(projected.opponent.active[0].hp, state.opponent.active[0].hp);
		}
	});
	it('discards the pre-expanded Sleep Talk call when Encore replaces Sleep Talk', () => {
		const f = fixture(6, 'tackle', 'sleeptalk'), state = f.state();
		const projected = advancePosition(state, { ...action('sleeptalk'), calledMove: 'splash' }, action('encore'), () => undefined);
		f.b.makeChoices('move encore', 'move sleeptalk');
		assert.equal(projected.self.active[0].lastMove, 'tackle');
		assert.equal(projected.self.active[0].projection.pp.tackle, f.b.p2.activeRequest.active[0].moves[0].pp);
	});
	it('does not override Struggle or infer Encore can lock an exhausted known move', () => {
		const f = fixture();
		for (const slot of f.b.p2.active[0].moveSlots) slot.pp = 0;
		f.b.makeRequest('move');
		const state = f.state();
		// The authorized request exposes Struggle instead of exhausted slots.
		state.self.active[0].projection.pp = { tackle: 0, splash: 0 };
		const projected = advancePosition(state, action('struggle'), action('encore'), () => undefined);
		f.b.makeChoices('move encore', 'move struggle');
		assert(f.b.log.some(l => l.startsWith('|move|p2a: Mew|Struggle|')));
		assert.equal(projected.self.active[0].lastMove, 'struggle');
		assert(!projected.self.active[0].volatiles.has('encore'));
	});
});
