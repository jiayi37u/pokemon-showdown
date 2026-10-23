'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { projectedState } = require('./helpers/hard-state');
const { advancePosition, beginTurn, continueTurn, clonePosition, switchIn, modelsFor, knownMoves, hp, usableMove, actionOutcomes, supportsMove } = require('../../../dist/server/npc/ai/hard/projection');
const { searchPosition, certainlyUseless, Search } = require('../../../dist/server/npc/ai/hard/search');
const { calculateDamage, selectDamage } = require('../../../dist/server/npc/ai/hard/damage');
const { hardMove, hardMoveId } = require('../../../dist/server/npc/ai/hard/opponent-model');
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

describe('Hard damage-based state search', () => {
	afterEach(() => battles.splice(0).forEach(b => b.destroy()));
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
	it('selects attack coverage and keeps useful effects without blanket priority or spin exemptions', () => {
		const moves = ['thunderbolt', 'icebeam', 'watergun', 'quickattack', 'uturn', 'gigadrain', 'knockoff', 'rapidspin'];
		const f = fixture([mon('Mew', moves), mon('Magikarp', ['splash'])],
			[mon('Gyarados', ['splash'], { item: 'Leftovers' }), mon('Garchomp', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		const kept = search.choices(f.state, 'self', moves.map(move => ({ ...action(move), prior: 1 })))
			.map(a => a.move);
		for (const id of ['watergun', 'quickattack', 'rapidspin']) assert(!kept.includes(id), kept.join(', '));
		for (const id of moves.filter(id => !['watergun', 'quickattack', 'rapidspin'].includes(id))) assert(kept.includes(id), id);
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
	it('retains weaker priority only for a finishing race or damage before an otherwise lethal hit', () => {
		const f = fixture([mon('Mew', ['bodyslam', 'quickattack'])], [mon('Mew', ['tackle'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		const search = new Search(new MatchupEvaluator());
		const kept = () => search.choices(f.state, 'self').map(a => a.move);
		actor.baseStats.spe = 100; foe.baseStats.spe = 200; foe.baseStats.atk = 10;
		assert(!kept().includes('quickattack'), 'Slower, but survives and cannot finish: use stronger damage');
		hp(foe, 1);
		assert(kept().includes('quickattack'), 'Priority finishes before the faster response');
		actor.baseStats.spe = 300;
		assert(!kept().includes('quickattack'), 'Already first: the stronger attack also finishes');
		hp(foe, foe.maxHp); actor.baseStats.spe = 100; foe.baseStats.atk = 10000;
		assert(kept().includes('quickattack'), 'Otherwise dies before dealing any damage');
		foe.moves = ['extremespeed'];
		assert(!kept().includes('quickattack'), 'Cannot salvage damage before an even earlier lethal response');
	});
	it('compares actual attack order including opposing priority and Trick Room', () => {
		const f = fixture([mon('Mew', ['bodyslam', 'extremespeed'])], [mon('Mew', ['quickattack'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 300; foe.baseStats.spe = 100; foe.baseStats.atk = 10000;
		const search = new Search(new MatchupEvaluator());
		assert(search.choices(f.state, 'self').some(a => a.move === 'extremespeed'));
		foe.moves = ['tackle']; foe.baseStats.atk = 10; hp(foe, 1);
		assert(!search.choices(f.state, 'self').some(a => a.move === 'extremespeed'));
		f.state.field.trickroom = true;
		assert(search.choices(f.state, 'self').some(a => a.move === 'extremespeed'));
	});
	it('unions priority benefits over speed presets instead of trusting the representative speed', () => {
		const f = fixture([mon('Mew', ['bodyslam', 'quickattack'])], [mon('Mew', ['tackle'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 200; hp(foe, 1);
		foe.presetModels = [100, 300].map(spe => ({ name: `speed ${spe}`, weight: 0.5, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, spe } }, moves: [{ id: 'tackle', availability: 1 }] }));
		const search = new Search(new MatchupEvaluator());
		assert(search.choices(f.state, 'self').some(a => a.move === 'quickattack'));
		foe.presetModels = [foe.presetModels[0]];
		assert(!search.choices(f.state, 'self').some(a => a.move === 'quickattack'));
	});
	it('retains spin for hazards and item removal for unknown items, but not empty effects', () => {
		const f = fixture([mon('Mew', ['bodyslam', 'rapidspin', 'knockoff'])], [mon('Mew', ['splash'])]);
		const search = new Search(new MatchupEvaluator()), foe = f.state.opponent.active[0];
		foe.types = ['Normal']; foe.item = '';
		foe.itemKnown = true; foe.itemAssumed = false;
		let moves = search.choices(f.state, 'self').map(a => a.move);
		assert(!moves.includes('rapidspin')); assert(!moves.includes('knockoff'));
		f.state.self.conditions.stealthrock = true; foe.itemKnown = false;
		moves = search.choices(f.state, 'self').map(a => a.move);
		assert(moves.includes('rapidspin')); assert(moves.includes('knockoff'));
		f.state.self.conditions.stealthrock = false; foe.moves = ['stealthrock'];
		assert(search.choices(f.state, 'self').some(a => a.move === 'rapidspin'), 'Can clear hazards placed this turn');
	});
	it('does not reserve an attack only to cover a reserve with no switching purpose', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'magicalleaf'])],
			[mon('Mew', ['tackle']), mon('Mew', ['splash'])]);
		f.state.opponent.active[0].types = ['Normal'];
		f.state.opponent.reserve[0].types = ['Rock'];
		const search = new Search(new MatchupEvaluator());
		assert.equal(search.destinations(f.state, 'opponent').length, 1);
		assert(!search.choices(f.state, 'self').some(a => a.move === 'magicalleaf'));
		f.state.opponent.active[0].moves.push('uturn');
		assert.equal(search.destinations(f.state, 'opponent').length, 2);
		assert(search.choices(f.state, 'self').some(a => a.move === 'magicalleaf'));
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
	it('reuses real-position move choices across decisions but invalidates changed participants', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam'])], [mon('Gyarados', ['splash'])]);
		const matchups = new MatchupEvaluator(), actions = ['thunderbolt', 'icebeam'].map(action);
		const first = new Search(matchups, f.state);
		first.coverage(f.state, 'self', actions);
		// A same-turn hypothetical replacement/damage branch must not overwrite real knowledge.
		const future = clonePosition(f.state); hp(future.self.active[0], 100);
		first.coverage(future, 'self', actions);
		f.state.turn++;
		const again = new Search(matchups);
		assert.deepEqual([...again.coverage(f.state, 'self', actions)].map(a => a.move), ['thunderbolt']);
		assert.equal(again.reused.coverage, 1);
		f.state.turn++; f.state.opponent.active[0].types = ['Ground', 'Dragon'];
		const changed = new Search(matchups);
		assert.deepEqual([...changed.coverage(f.state, 'self', actions)].map(a => a.move), ['icebeam']);
		assert.equal(changed.reused.coverage, 0);
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
		assert.deepEqual([...search.coverage(f.state, 'self', actions)].map(a => a.move).sort(), ['earthquake', 'psychic']);
		target.presetModels = [target.presetModels[0]];
		assert.deepEqual([...search.coverage(f.state, 'self', actions)].map(a => a.move), ['psychic']);
	});
	it('does not let a stronger pivot erase the option to attack without leaving', () => {
		const f = fixture([mon('Mew', ['thundershock', 'voltswitch']), mon('Magikarp', ['splash'])],
			[mon('Gyarados', ['splash'])]);
		const choices = new Search(new MatchupEvaluator()).choices(f.state, 'self');
		assert(choices.some(a => a.move === 'thundershock'));
		assert(choices.some(a => a.move === 'voltswitch'));
	});
	it('caches representative move identities independently of unrelated teammates', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam']), mon('Blissey', ['splash'])],
			[mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator()), actions = ['thunderbolt', 'icebeam'].map(action);
		assert.deepEqual([...search.coverage(f.state, 'self', actions)].map(a => a.move), ['thunderbolt']);
		hp(f.state.self.reserve[0], 100);
		const renamed = actions.map(a => ({ ...a, id: a.id + ' renamed' }));
		assert.deepEqual([...search.coverage(f.state, 'self', renamed)].map(a => a.move), ['thunderbolt']);
		assert.equal(search.reused.coverage, 1);
	});
	it('expands every eligible root without count caps and discards low-scoring empty protection', () => {
		const moves = ['reflect', 'lightscreen', 'safeguard', 'mist', 'tailwind', 'protect'];
		const f = fixture([mon('Mew', moves)], [mon('Mew', ['tackle'])]);
		const result = searchPosition(f.state, f.evaluator, moves.map((move, i) =>
			({ ...action(move), prior: i })), new Map());
		assert.deepEqual(result.values.map(v => v.id).sort(), moves.filter(id => id !== 'protect')
			.map(id => `move ${id}`).sort(), result.reason);
	});
	it('does not cap favorable switches or free replacements', () => {
		const f = fixture(['Mew', 'Garchomp', 'Dragonite', 'Gengar', 'Machamp', 'Alakazam']
			.map(species => mon(species, ['tackle'])), [mon('Magikarp', ['splash'])]);
		f.state.self.active[0].volatiles.add('yawn'); // Every counter is a meaningful exit from Yawn.
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
		assert(!search.choices(f.state, 'opponent').some(a => a.move === 'flamethrower'));
		assert(search.choices(f.state, 'opponent').some(a => a.switchTo));
		f.state.self.active[0].volatiles.add('perish1');
		assert(!search.favorableStay(f.state, 'self'));
		assert(search.choices(f.state, 'self').some(a => a.switchTo));
		assert([...search.coverage(f.state, 'opponent', ['icebeam', 'flamethrower'].map(action))]
			.some(a => a.move === 'flamethrower'), 'Coverage includes the possible replacement; score eligibility is separate');
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
	it('reuses choices for identical snapshots and recomputes coverage after a public change', () => {
		const f = fixture([mon('Mew', ['thunderbolt', 'icebeam'])], [mon('Gyarados', ['splash'])]);
		const search = new Search(new MatchupEvaluator());
		let computations = 0;
		const coverage = search.coverage.bind(search);
		search.coverage = (...args) => { computations++; return coverage(...args); };
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
	it('expands both pivot selections and all free replacements', () => {
		const team = [mon('Mew', ['uturn']), mon('Blissey', ['splash']), mon('Garchomp', ['splash'])];
		const f = fixture(team, team), search = new Search(new MatchupEvaluator());
		const pivots = search.transitions(f.state, action('uturn'), action('uturn'), false);
		assert.equal(pivots.length, 4);
		assert.equal(new Set(pivots.map(b => `${b.state.self.active[0].slot}/${b.state.opponent.active[0].slot}`)).size, 4);
		hp(f.state.self.active[0], 1);
		const entries = search.transitions(f.state, action('splash'), action('seismictoss'), false);
		assert.deepEqual(entries.map(b => b.state.self.active[0].species).sort(), ['Blissey', 'Garchomp']);
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
			assert.equal(next.self.conditions.healingWish, move);
			switchIn(next, 'self', next.self.reserve[0]);
			assert.equal(next.self.active[0].hp, recipient.maxHp - Math.floor(recipient.maxHp / 8));
			assert.equal(next.self.active[0].status, '');
			assert(!next.self.conditions.healingWish);
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
			return searchPosition(f.state, f.evaluator, [action('protect')], new Map()).values[0].value;
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
	it('does not discard an unsupported opponent response while returning a confident search result', () => {
		const f = fixture([mon('Mew', ['psychic'])], [mon('Mew', ['batonpass', 'splash']), mon('Magikarp', ['splash'])]);
		const result = searchPosition(f.state, f.evaluator, [action('psychic')], new Map());
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
	it('prunes capped setup but keeps recovery before incoming damage and coverage into switches', () => {
		const f = fixture([mon('Mew', ['swordsdance', 'recover', 'thunderbolt'])], [mon('Garchomp', ['splash'])]);
		f.state.self.active[0].boosts.atk = 6;
		assert(certainlyUseless(f.state, 'self', action('swordsdance')));
		assert(!certainlyUseless(f.state, 'self', action('recover')));
		assert(!certainlyUseless(f.state, 'self', action('thunderbolt')));
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
