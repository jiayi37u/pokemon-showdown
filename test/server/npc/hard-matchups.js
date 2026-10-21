'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { projectedState } = require('../../../dist/server/npc/ai/hard/projection');
const { positionValue } = require('../../../dist/server/npc/ai/hard/search');

const mon = (species, moves, rest = {}) => ({ species, moves, ...rest });
const battles = [];
function fixture(own, foe) {
	const battle = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Self', team: own }, p2: { name: 'Foe', team: foe } });
	battles.push(battle); battle.makeChoices();
	return { battle, state: projectedState(battle), evaluator: new MatchupEvaluator() };
}

describe('Hard singles matchup value', () => {
	afterEach(() => { battles.splice(0).forEach(b => b.destroy()); });
	it('distinguishes a free-entry check from a manual switch-in', () => {
		const f = fixture([mon('Mamoswine', ['earthquake', 'iceshard'], { ability: 'Thick Fat', item: 'Life Orb',
			nature: 'Jolly', evs: { atk: 252, spe: 252 } })],
		[mon('Bisharp', ['suckerpunch', 'ironhead', 'swordsdance'], { item: 'Dread Plate', nature: 'Adamant',
			evs: { hp: 124, atk: 252, spe: 132 } })]);
		const matchup = f.evaluator.assess(f.state).matrix[0][0].self;
		assert(matchup.check > 0.9);
		assert.equal(matchup.counter, 0);
	});
	it('changes the same team members roles against physical and special opposition', () => {
		const team = [mon('Skarmory', ['bravebird', 'roost']), mon('Chansey', ['seismictoss', 'softboiled'], { item: 'Eviolite' })];
		const physical = fixture(team, [mon('Garchomp', ['earthquake', 'dragonclaw'])]);
		const special = fixture(team, [mon('Alakazam', ['psychic', 'focusblast'])]);
		const a = physical.evaluator.roles(physical.state), b = special.evaluator.roles(special.state);
		assert(a[0].value > a[1].value + 50);
		assert(b[1].value > b[0].value + 50);
	});
	it('values the last answer more than a replaceable answer', () => {
		const f = fixture([mon('Skarmory', ['bravebird', 'roost']), mon('Chansey', ['seismictoss', 'softboiled'])],
			[mon('Garchomp', ['earthquake', 'dragonclaw'])]);
		const unique = f.evaluator.roles(f.state)[0].value;
		f.state.self.team.push({ ...f.state.self.team[0], ident: 'backup', slot: 3 });
		const replaceable = f.evaluator.roles(f.state)[0].value;
		assert(unique > replaceable + 50, `${unique} <= ${replaceable}`);
	});
	it('reduces a wall role when its assigned threat faints, and never rewards keeping a defeated threat alive', () => {
		const f = fixture([mon('Skarmory', ['bravebird', 'roost']), mon('Chansey', ['seismictoss', 'softboiled'])],
			[mon('Garchomp', ['earthquake', 'dragonclaw']), mon('Magikarp', ['splash'])]);
		const initial = f.evaluator.assess(f.state).value, role = f.evaluator.roles(f.state)[0].value;
		Object.assign(f.state.opponent.team[0], { hp: 0, hpPercent: 0, fainted: true });
		assert(f.evaluator.assess(f.state).value > initial);
		assert(f.evaluator.roles(f.state)[0].value < role);
	});
	it('charges lethal entry hazards to a reserve, but not again to an active Pokemon', () => {
		const f = fixture([mon('Mew', ['splash']), mon('Talonflame', ['bravebird'])], [mon('Breloom', ['machpunch'])]);
		const p = f.state.self.team[1]; p.hp = p.maxHp / 4; p.hpPercent = 25;
		const before = f.evaluator.roles(f.state)[1].value;
		f.state.self.conditions.stealthrock = true;
		assert(before > 0);
		assert.equal(f.evaluator.roles(f.state)[1].value, 0);
		assert.equal(f.evaluator.assess(f.state).matrix[1][0].self.check, 0);
		p.active = true;
		assert(f.evaluator.assess(f.state).matrix[1][0].self.check > 0);
	});
	it('recognizes recovery as repeatable defensive capacity and loses it below the survival threshold', () => {
		const f = fixture([mon('Skarmory', ['bravebird', 'roost'])], [mon('Garchomp', ['earthquake', 'dragonclaw'])]);
		const full = f.evaluator.assess(f.state).matrix[0][0].self;
		assert(full.counter > 0.8 && full.sustain > 0.8);
		Object.assign(f.state.self.team[0], { hp: 1, hpPercent: 100 / f.state.self.team[0].maxHp });
		assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.counter, 0);
	});
	it('accounts for setup on the entry turn, not just the current strongest attack', () => {
		const f = fixture([mon('Mew', ['icebeam', 'softboiled'], { nature: 'Bold', evs: { hp: 252, def: 252 } })],
			[mon('Garchomp', ['dragonclaw'])]);
		const before = f.evaluator.assess(f.state).matrix[0][0].self.counter;
		f.state.opponent.team[0].moves.push('swordsdance');
		const after = f.evaluator.assess(f.state).matrix[0][0].self.counter;
		assert(after < before, `${after} >= ${before}`);
	});
	it('does not count an immune attack as pressure or a check', () => {
		const f = fixture([mon('Mew', ['surf'])], [mon('Gastrodon', ['earthpower'], { ability: 'Storm Drain' })]);
		const matchup = f.evaluator.assess(f.state).matrix[0][0].self;
		assert.equal(matchup.check, 0); assert.equal(matchup.pressure, 0);
	});
	it('invalidates only a changed row/column; field changes invalidate the whole table', () => {
		const species = ['Mew', 'Garchomp', 'Skarmory', 'Chansey', 'Heatran', 'Slowbro'];
		const f = fixture(species.map(p => mon(p, ['tackle'])), species.map(p => mon(p, ['tackle'])));
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 36);
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 36);
		f.state.opponent.team[2].item = 'Choice Band';
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 42);
		f.state.self.team[3].hp--; f.state.self.team[3].hpPercent = 100 * f.state.self.team[3].hp / f.state.self.team[3].maxHp;
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 48);
		f.state.opponent.team[1].baseStats.def += 20;
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 54);
		f.state.field.trickroom = true;
		f.evaluator.assess(f.state); assert.equal(f.evaluator.stats.misses, 90);
	});
	it('does not let a speculative branch pollute the real table and never mutates the source battle', () => {
		const f = fixture([mon('Mew', ['psychic'])], [mon('Garchomp', ['dragonclaw'])]);
		const serialized = JSON.stringify(f.battle.toJSON());
		const original = positionValue(f.battle, f.evaluator);
		const branch = Battle.fromJSON(serialized); battles.push(branch);
		branch.p1.active[0].hp = 1;
		assert(positionValue(branch, f.evaluator) < original);
		assert.equal(positionValue(f.battle, f.evaluator), original);
		assert.equal(JSON.stringify(f.battle.toJSON()), serialized);
	});
	it('invalidates other pairs when an ally sleep source changes clause eligibility', () => {
		const f = fixture([mon('Mew', ['tackle']), mon('Slowbro', ['rest'])],
			[mon('Breloom', ['spore', 'machpunch'])]);
		const sleeper = f.state.self.team[1]; sleeper.status = 'slp'; sleeper.sleepSelfInflicted = true;
		f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 2);
		sleeper.sleepSelfInflicted = false;
		f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 4);
	});
	it('is symmetric between perspectives and bounded below a terminal win', () => {
		const f = fixture([mon('Skarmory', ['bravebird', 'roost']), mon('Chansey', ['seismictoss', 'softboiled'])],
			[mon('Garchomp', ['earthquake', 'dragonclaw'])]);
		const a = f.evaluator.assess(f.state).value;
		const b = f.evaluator.assess({ ...f.state, self: f.state.opponent, opponent: f.state.self }).value;
		assert.equal(a, -b);
		f.battle.win(f.battle.p1);
		assert(positionValue(f.battle, f.evaluator) > Math.abs(a));
	});
	it('does not value losing the last member as an improvement when opposing offensive routes disappear', () => {
		const f = fixture([mon('Magikarp', ['splash'])],
			['Garchomp', 'Mew', 'Dragonite', 'Skarmory', 'Bisharp', 'Snorlax'].map(p => mon(p, ['tackle'])));
		Object.assign(f.state.self.team[0], { hp: 1, hpPercent: 100 / f.state.self.team[0].maxHp });
		assert(f.evaluator.roles(f.state)[0].value > 0);
	});
});
