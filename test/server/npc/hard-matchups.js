'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { projectedState } = require('./helpers/hard-state');
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
	it('does not carry stranded boosts into bench matchups, while keeping the real active pair', () => {
		const { hp, clonePosition } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Manaphy', ['psychic', 'scald'], { nature: 'Modest',
			evs: { hp: 252, spa: 240, spe: 16 } }), mon('Volcarona', ['flamethrower'])],
		[mon('Serperior', ['leafstorm'], { ability: 'Contrary', nature: 'Timid',
			evs: { hp: 120, spa: 136, spe: 252 } }), mon('Volcanion', ['steameruption'], { ability: 'Water Absorb' })]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		hp(actor, 146); actor.boosts.spa = 3;
		hp(foe, 160); foe.boosts.spa = 2;
		const before = clonePosition(f.state), boosted = f.evaluator.assess(f.state);
		const neutral = clonePosition(f.state); neutral.self.active[0].boosts.spa = 0;
		const without = f.evaluator.assess(neutral);
		assert.equal(boosted.matrix[0][0].self.check, 0);
		assert.equal(boosted.matrix[0][0].self.pressure, 0);
		assert.equal(boosted.matrix[0][0].opponent.check, 1);
		assert.deepEqual(boosted.matrix[0][1], without.matrix[0][1], 'Unusable boosts cannot cover a different foe');
		assert(boosted.matrix[0][0].self.switchPressure.psychic > without.matrix[0][0].self.switchPressure.psychic,
			'The actual attack into the active target retains its real damage');
		assert.deepEqual(clonePosition(f.state), before, 'Valuation must not change the search state');
		const misses = f.evaluator.stats.misses;
		assert.equal(f.evaluator.assess(f.state), boosted);
		assert.equal(f.evaluator.stats.misses, misses, 'Repeated values reuse the pair and position caches');
		const reversed = { ...f.state, self: f.state.opponent, opponent: f.state.self };
		assert(Math.abs(f.evaluator.assess(reversed).value + boosted.value) < 1e-9);
		actor.baseStats.spe = 1000;
		const faster = f.evaluator.assess(f.state);
		assert(faster.matrix[0][0].self.pressure > 0);
		const fasterNeutral = clonePosition(f.state); fasterNeutral.self.active[0].boosts.spa = 0;
		assert(faster.matrix[0][1].self.switchPressure.psychic >
			f.evaluator.assess(fasterNeutral).matrix[0][1].self.switchPressure.psychic,
		'A changed speed that enables attacking restores the boost contribution');
	});
	it('retains boost potential when compatible active profiles do not all prevent progress', () => {
		const { hp } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Manaphy', ['psychic'])],
			[mon('Serperior', ['leafstorm']), mon('Volcanion', ['steameruption'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		hp(actor, 80); actor.boosts.spa = 3;
		foe.presetModels = [1, 1000].map(spe => ({ name: String(spe), weight: 0.5, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, spe } }, moves: [{ id: 'leafstorm', availability: 1 }],
		}));
		const uncertain = f.evaluator.assess(f.state);
		foe.presetModels = [foe.presetModels[1]];
		const blocked = f.evaluator.assess(f.state);
		assert(uncertain.matrix[0][1].self.switchPressure.psychic > blocked.matrix[0][1].self.switchPressure.psychic);
	});
	it('keeps the stationary check but cannot enforce it against a faster successful pivot', () => {
		const { hp, clonePosition } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Volcanion', ['flamethrower', 'steameruption'], { ability: 'Water Absorb' }),
			mon('Excadrill', ['earthquake'], { ability: 'Mold Breaker' })],
		[mon('Rotom-Wash', ['voltswitch'], { ability: 'Levitate', item: 'Choice Scarf' }), mon('Mew', ['tackle'])]);
		hp(f.state.self.active[0], f.state.self.active[0].maxHp * 0.65);
		hp(f.state.opponent.active[0], f.state.opponent.active[0].maxHp * 0.1);
		const before = clonePosition(f.state), assessment = f.evaluator.assess(f.state);
		assert.equal(assessment.matrix[0][0].self.check, 1);
		assert.equal(assessment.matrix[0][0].opponent.check, 0);
		assert(!f.evaluator.holdsAdvantage(f.state, 'self', assessment));
		assert.deepEqual(clonePosition(f.state), before);
		assert.equal(f.evaluator.assess(f.state).value, assessment.value);
		const { Search } = require('../../../dist/server/npc/ai/hard/search');
		assert(new Search(f.evaluator).choices(f.state, 'self').some(a => a.switchTo?.species === 'Excadrill'));
		f.state.self.active[0].baseStats.spe = 1000;
		assert(f.evaluator.holdsAdvantage(f.state, 'self'), 'A first-strike KO prevents the pivot');
	});
	it('only treats a usable pivot with a living recipient as an escape', () => {
		const { hp } = require('../../../dist/server/npc/ai/hard/projection');
		for (const [species, ability, attack, pivot, blocked] of [
			['Excadrill', 'Mold Breaker', 'earthquake', 'voltswitch', true],
			['Excadrill', 'Mold Breaker', 'earthquake', 'uturn', false],
			['Volcanion', 'Water Absorb', 'flamethrower', 'partingshot', false],
			['Jolteon', 'Volt Absorb', 'thunderbolt', 'voltswitch', true],
		]) {
			const f = fixture([mon(species, [attack], { ability })],
				[mon('Rotom-Wash', [pivot], { ability: 'Levitate' }), mon('Mew', ['tackle'])]);
			hp(f.state.opponent.active[0], 1); f.state.opponent.active[0].baseStats.spe = 1000;
			assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.check, 1);
			assert.equal(f.evaluator.holdsAdvantage(f.state, 'self'), blocked, pivot);
			hp(f.state.opponent.reserve[0], 0);
			assert(f.evaluator.holdsAdvantage(f.state, 'self'), 'A pivot needs a living recipient');
		}
	});
	it('invalidates the cached hold proof when pivot PP, sleep or a hidden move pool changes', () => {
		const { hp } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Volcanion', ['flamethrower'], { ability: 'Water Absorb' })],
			[mon('Rotom-Wash', ['voltswitch'], { ability: 'Levitate' }), mon('Mew', ['tackle'])]);
		const foe = f.state.opponent.active[0]; hp(foe, 1); foe.baseStats.spe = 1000;
		assert(!f.evaluator.holdsAdvantage(f.state, 'self'));
		foe.projection = { pp: { voltswitch: 0 } };
		assert(f.evaluator.holdsAdvantage(f.state, 'self'));
		delete foe.projection;
		foe.status = 'slp'; foe.sleepTurns = 3;
		assert(f.evaluator.holdsAdvantage(f.state, 'self'));
		foe.status = ''; foe.sleepTurns = 0; foe.moves = [];
		foe.presetModels = [['splash', 0.99], ['voltswitch', 0.01]].map(([id, weight]) => ({
			name: id, weight, matched: true, pokemon: { ...foe }, moves: [{ id, availability: 1 }],
		}));
		assert(!f.evaluator.holdsAdvantage(f.state, 'self'), 'A low-weight pivot still invalidates the proof');
	});
	it('does not use a weak priority attack to justify a slower winning attack against a pivot', () => {
		const f = fixture([mon('Mew', ['quickattack', 'icebeam'])],
			[mon('Gliscor', ['uturn']), mon('Mew', ['tackle'])]);
		f.state.opponent.active[0].baseStats.spe = 1000;
		assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.check, 1);
		assert(!f.evaluator.holdsAdvantage(f.state, 'self'));
	});
	it('uses speed alone to enforce a winning matchup without projecting an exchange', () => {
		const f = fixture([mon('Rotom-Wash', ['hydropump'], { ability: 'Levitate', item: 'Leftovers',
			nature: 'Bold', evs: { hp: 252, def: 252 } }), mon('Tornadus-Therian', ['hurricane'])],
		[mon('Landorus-Therian', ['uturn'], { nature: 'Impish', evs: { hp: 252, def: 252 } }),
			mon('Serperior', ['leafstorm'])]);
		const actor = f.state.self.active[0], foe = f.state.opponent.active[0];
		actor.baseStats.spe = 266;
		const assessment = f.evaluator.assess(f.state), stats = { ...f.evaluator.stats };
		assert.equal(assessment.matrix[0][0].self.check, 1);
		assert(f.evaluator.attack(f.state, actor, foe,
			require('../../../dist/server/npc/ai/hard/opponent-model').hardMove('hydropump', 1, 'gen6customgame')).damage < foe.hp);
		assert(f.evaluator.holdsAdvantage(f.state, 'self', assessment), 'The faster attacker need not KO before the pivot');
		assert.deepEqual(f.evaluator.stats, stats, 'The speed gate does not reevaluate any projected position');
		actor.baseStats.spe = foe.baseStats.spe;
		assert(!f.evaluator.holdsAdvantage(f.state, 'self'), 'A tie does not establish a speed advantage');
		actor.baseStats.spe = 210;
		assert(!f.evaluator.holdsAdvantage(f.state, 'self'));
		f.state.self.conditions.tailwind = 2;
		assert(f.evaluator.holdsAdvantage(f.state, 'self'));
		f.state.self.conditions.tailwind = 0; actor.item = 'choicescarf';
		assert(f.evaluator.holdsAdvantage(f.state, 'self'));
		actor.item = 'leftovers'; f.state.field.trickroom = true;
		assert(f.evaluator.holdsAdvantage(f.state, 'self'));
	});
	it('keeps both sides profile weights and switch candidates when reversing perspective', () => {
		const { Search } = require('../../../dist/server/npc/ai/hard/search');
		const f = fixture([mon('Mew', ['psychic']), mon('Skarmory', ['bravebird'])],
			[mon('Machamp', ['closecombat']), mon('Rotom-Wash', ['hydropump'], { ability: 'Levitate' })]);
		for (const party of [f.state.self, f.state.opponent]) {
			for (const p of party.team) p.presetModels = [0, 1].map(i => ({ name: String(i), weight: i ? 0.75 : 0.25,
				matched: true, pokemon: { ...p, baseStats: { ...p.baseStats, def: i ? 350 : 100, spd: i ? 100 : 350 } },
				moves: p.moves.map(id => ({ id, availability: 1 })),
			}));
		}
		f.state.self.conditions.reflect = 3;
		const reversed = { ...f.state, self: f.state.opponent, opponent: f.state.self };
		const forward = f.evaluator.assess(f.state), backward = f.evaluator.assess(reversed);
		assert(Math.abs(forward.value + backward.value) < 1e-9);
		for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
			for (const side of ['self', 'opponent']) {
				const a = forward.matrix[i][j][side], b = backward.matrix[j][i][side === 'self' ? 'opponent' : 'self'];
				for (const key of ['check', 'counter', 'pressure', 'sustain', 'entryPressure', 'entrySustain']) {
					assert(Math.abs(a[key] - b[key]) < 1e-9, `${side} ${i}/${j} ${key}`);
				}
			}
		}
		const search = new Search(f.evaluator);
		for (const context of ['free', 'exposed', 'switch']) {
			assert.deepEqual(search.entryChoices(f.state, 'opponent', context).map(p => p.ident),
				search.entryChoices(reversed, 'self', context).map(p => p.ident), context);
		}
		const p = f.state.self.active[0];
		p.presetModels = p.presetModels.map((model, i) => ({ ...model, weight: i ? 0.25 : 0.75 }));
		const changed = f.evaluator.assess(f.state);
		assert.notDeepEqual(changed.matrix, forward.matrix, 'Own profile weights participate in the cache key and evaluation');
		assert(Math.abs(changed.value + f.evaluator.assess(reversed).value) < 1e-9);
	});
	it('reuses an evaluation across search histories without merging their action states', () => {
		const { clonePosition, positionKey } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Mew', ['psychic'])], [mon('Machamp', ['closecombat'])]);
		f.state = clonePosition(f.state);
		const initial = f.evaluator.assess(f.state), next = clonePosition(f.state);
		next.self.active[0].projection = { pp: { psychic: 1 } };
		assert.notEqual(positionKey(next), positionKey(f.state));
		assert.equal(f.evaluator.assess(next), initial);
		assert.equal(f.evaluator.stats.positions, 1);
	});
	it('invalidates cached values for state changes and hidden-profile weights', () => {
		const f = fixture([mon('Mew', ['psychic', 'recover']), mon('Skarmory', ['bravebird'])],
			[mon('Machamp', ['closecombat']), mon('Garchomp', ['earthquake'])]);
		const foe = f.state.opponent.active[0];
		foe.presetModels = [0.2, 0.8].map((weight, i) => ({ name: String(i), weight, matched: true,
			pokemon: { ...foe, baseStats: { ...foe.baseStats, atk: i ? 150 : 350 } },
			moves: [{ id: 'closecombat', availability: 1 }] }));
		let previous = f.evaluator.assess(f.state);
		for (const change of [
			() => { foe.presetModels[0].weight = 0.8; foe.presetModels[1].weight = 0.2; },
			() => { f.state.self.team[0].hp--; },
			() => { f.state.self.team[1].status = 'brn'; },
			() => { f.state.self.team[0].boosts.spa = 2; },
			() => { f.state.self.conditions.stealthrock = true; },
			() => { f.state.field.weather = 'rain'; },
			() => { f.state.self.team[1].fainted = true; },
			() => { foe.presetModels[0].moves.push({ id: 'knockoff', availability: 1 }); },
		]) {
			change();
			const value = f.evaluator.assess(f.state);
			assert.notEqual(value, previous);
			assert.deepEqual(value, new MatchupEvaluator().assess(f.state));
			previous = value;
		}
	});
	it('values an unresisted wallbreaking move even against faster revenge killers', () => {
		const f = fixture([mon('Medicham-Mega', ['highjumpkick', 'zenheadbutt'],
			{ ability: 'Pure Power', nature: 'Adamant', evs: { atk: 252, spe: 252 } })],
		[mon('Metagross-Mega', ['bulletpunch'], { ability: 'Tough Claws', nature: 'Adamant', evs: { atk: 252, spe: 252 } }),
			mon('Serperior', ['leafstorm'], { ability: 'Contrary', nature: 'Timid', evs: { spa: 252, spe: 252 } }),
			mon('Tornadus-Therian', ['hurricane'], { nature: 'Timid', evs: { hp: 168, def: 132, spe: 208 } })]);
		const actor = f.state.self.active[0]; actor.hp = 116; actor.hpPercent = 44;
		const row = f.evaluator.assess(f.state).matrix[0].map(p => p.self);
		assert.equal(row[0].pressure, 0, 'Bullet Punch stops Medicham in a direct attack race');
		assert(row[0].switchPressure.highjumpkick > 0.8, 'A free High Jump Kick still threatens a huge hit');
		const resisted = Math.min(...row.map(p => p.switchPressure.highjumpkick));
		const unresisted = Math.min(...row.slice(0, 2).map(p => p.switchPressure.highjumpkick));
		assert(unresisted > resisted + 0.2, 'Removing the Fighting resist opens the same move across the defense');
	});
	it('retains a Toxic stall route after poison lands, but does not invent one through Rest or Poison Heal', () => {
		const f = fixture([mon('Chansey', ['toxic', 'softboiled'], { item: 'Eviolite', nature: 'Bold', evs: { hp: 252, def: 252 } })],
			[mon('Cresselia', ['psychic', 'moonlight'], { evs: { hp: 252 } })]);
		const before = f.evaluator.assess(f.state).matrix[0][0].self;
		Object.assign(f.state.opponent.team[0], { status: 'tox', toxicCounter: 1 });
		const after = f.evaluator.assess(f.state).matrix[0][0].self;
		assert(before.check > 0.6); assert(after.check >= before.check);
		f.state.opponent.team[0].hp = 20; f.state.opponent.team[0].hpPercent = 5;
		assert(f.evaluator.assess(f.state).matrix[0][0].self.check >= before.check);
		f.state.opponent.team[0].moves.push('rest');
		assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.check, 0);
		f.state.opponent.team[0].moves.pop(); f.state.opponent.team[0].ability = 'poisonheal';
		assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.check, 0);
	});
	it('uses opposing missed actions and consumes the entry turn of that window', () => {
		const f = fixture([mon('Garchomp', ['earthquake'], { nature: 'Jolly', evs: { atk: 252, spe: 252 } })],
			[mon('Weavile', ['iciclecrash'], { nature: 'Jolly', evs: { atk: 252, spe: 252 } })]);
		const target = f.state.opponent.team[0];
		const awake = f.evaluator.assess(f.state).matrix[0][0].self;
		Object.assign(target, { status: 'slp', sleepTurns: 3 });
		const asleep = f.evaluator.assess(f.state).matrix[0][0].self;
		assert(asleep.check > awake.check + 0.5);
		assert(asleep.check > asleep.counter);
		target.ability = 'earlybird';
		assert(f.evaluator.assess(f.state).matrix[0][0].self.check < asleep.check);
		target.status = ''; target.volatiles.add('mustrecharge');
		assert(f.evaluator.assess(f.state).matrix[0][0].self.pressure > awake.pressure);
	});
	it('does not delay a sleeping attacker with a sleep-usable move', () => {
		const f = fixture([mon('Magikarp', ['tackle'])], [mon('Snorlax', ['snore'])]);
		const target = f.state.opponent.team[0];
		Object.assign(target, { status: 'slp', sleepTurns: 3 });
		const usable = f.evaluator.assess(f.state).matrix[0][0].self;
		target.sleepTurns = 1;
		assert.equal(f.evaluator.assess(f.state).matrix[0][0].self.pressure, usable.pressure);
	});
	it('distinguishes a free-entry check from a manual switch-in', () => {
		const f = fixture([mon('Mamoswine', ['earthquake', 'iceshard'], { ability: 'Thick Fat', item: 'Life Orb',
			nature: 'Jolly', evs: { atk: 252, spe: 252 } })],
		[mon('Bisharp', ['suckerpunch', 'ironhead', 'swordsdance'], { item: 'Dread Plate', nature: 'Adamant',
			evs: { hp: 124, atk: 252, spe: 132 } })]);
		const matchup = f.evaluator.assess(f.state).matrix[0][0].self;
		assert(matchup.check > 0.9);
		assert.equal(matchup.counter, 0);
	});
	it('values an active answer above the same check stranded on the bench', () => {
		const f = fixture([mon('Magikarp', ['splash']), mon('Mamoswine', ['earthquake', 'iceshard'],
			{ ability: 'Thick Fat', item: 'Life Orb', nature: 'Jolly', evs: { atk: 252, spe: 252 } })],
		[mon('Bisharp', ['suckerpunch', 'ironhead', 'swordsdance'], { item: 'Dread Plate', nature: 'Adamant',
			evs: { hp: 124, atk: 252, spe: 132 } })]);
		const waiting = f.evaluator.assess(f.state);
		assert(waiting.matrix[1][0].self.check > 0.9);
		assert.equal(waiting.matrix[1][0].self.counter, 0);
		const [idle, answer] = f.state.self.team;
		idle.active = false; answer.active = true;
		f.state.self.active = [answer]; f.state.self.reserve = [idle];
		const ready = f.evaluator.assess(f.state);
		assert(ready.self > waiting.self + 25, `${ready.self} <= ${waiting.self}`);
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
			[mon('Garchomp', ['dragonclaw'], { nature: 'Adamant', evs: { atk: 252 } })]);
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
		const original = positionValue(projectedState(f.battle), f.evaluator);
		const branch = Battle.fromJSON(serialized); battles.push(branch);
		branch.p1.active[0].hp = 1;
		assert(positionValue(projectedState(branch), f.evaluator) < original);
		assert.equal(positionValue(projectedState(f.battle), f.evaluator), original);
		assert.equal(JSON.stringify(f.battle.toJSON()), serialized);
	});
	it('reuses static pairs across field clocks and delayed healing, while retaining complete search state', () => {
		const { clonePosition, positionKey } = require('../../../dist/server/npc/ai/hard/projection');
		const f = fixture([mon('Mew', ['surf', 'recover']), mon('Garchomp', ['earthquake'])],
			[mon('Machamp', ['closecombat']), mon('Skarmory', ['bravebird'])]);
		Object.assign(f.state.field, { weather: 'rain', weatherId: 'raindance', weatherTurns: 5,
			terrain: 'grassy', terrainTurns: 5, trickroom: true, trickroomTurns: 5 });
		Object.assign(f.state.self.conditions, { reflect: 5, tailwind: 4, safeguard: 5 });
		const initial = f.evaluator.assess(f.state), before = positionKey(clonePosition(f.state));
		Object.assign(f.state.field, { weatherTurns: 4, terrainTurns: 4, trickroomTurns: 4 });
		Object.assign(f.state.self.conditions, { reflect: 4, tailwind: 3, safeguard: 4,
			wishes: { 1: 1 }, wishAmounts: { 1: 150 } });
		const next = f.evaluator.assess(f.state);
		assert.notEqual(positionKey(clonePosition(f.state)), before);
		assert.deepEqual(next, initial);
		assert.equal(f.evaluator.stats.misses, 4, 'No pair depends on these clocks or pending Wish');
		assert.deepEqual(next, new MatchupEvaluator().assess(f.state));
		f.state.self.conditions.reflect = 0;
		const expired = f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 8, 'A screen expiring still invalidates the combat context');
		assert.deepEqual(expired, new MatchupEvaluator().assess(f.state));
		assert.notDeepEqual(expired.matrix, next.matrix);
	});
	it('keys hazards and sacrifice healing by their actual effects on each entrant', () => {
		const f = fixture([mon('Mew', ['psychic']), mon('Clefable', ['moonblast'], { ability: 'Magic Guard' }),
			mon('Talonflame', ['bravebird'])], [mon('Machamp', ['closecombat']), mon('Garchomp', ['earthquake'])]);
		f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 6);
		f.state.self.conditions.stealthrock = true;
		const hazards = f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 8, 'Only Talonflame takes entry damage; the other two rows remain valid');
		assert.deepEqual(hazards, new MatchupEvaluator().assess(f.state));
		const recipient = f.state.self.team[2]; recipient.hp = 1; recipient.hpPercent = 100 / recipient.maxHp;
		f.state.self.conditions.healingWishes = { 1: 'healingwish' };
		const restored = f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 8, 'Healing before hazards reaches the same already-cached entrant state');
		assert.deepEqual(restored, new MatchupEvaluator().assess(f.state));
		assert(restored.matrix[2][0].self.pressure > 0);
		delete f.state.self.conditions.healingWishes;
		const fainted = f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 10);
		assert.deepEqual(fainted, new MatchupEvaluator().assess(f.state));
		assert.equal(fainted.matrix[2][0].self.pressure, 0);
	});
	it('shares attack estimates across irrelevant field records but refreshes expired defenses', () => {
		const { hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
		const f = fixture([mon('Mew', ['psychic'])], [mon('Machamp', ['closecombat'])]);
		const [actor, target] = [f.state.self.active[0], f.state.opponent.active[0]];
		const move = hardMove('psychic', 1, f.state.field.formatId);
		f.state.opponent.conditions.lightscreen = 5;
		const before = f.evaluator.attack(f.state, actor, target, move);
		Object.assign(f.state.opponent.conditions, { lightscreen: 4, stealthrock: true,
			wishes: { 1: 1 }, wishAmounts: { 1: 150 } });
		f.state.field.weatherTurns--;
		assert.equal(f.evaluator.attack(f.state, actor, target, move), before);
		f.state.opponent.conditions.lightscreen = 0;
		const after = f.evaluator.attack(f.state, actor, target, move);
		assert(after.damage > before.damage);
		assert.deepEqual(after, new MatchupEvaluator().attack(f.state, actor, target, move));
	});
	it('derives suppression from each pair rather than the unrelated current active lineup', () => {
		const f = fixture([mon('Golduck', ['surf'], { ability: 'Cloud Nine' }), mon('Mew', ['surf'])],
			[mon('Machamp', ['closecombat']), mon('Garchomp', ['earthquake'])]);
		Object.assign(f.state.field, { weather: '', weatherId: 'raindance', neutralizingGas: false });
		const initial = f.evaluator.assess(f.state);
		Object.assign(f.state.field, { weather: 'rain', neutralizingGas: true });
		const next = f.evaluator.assess(f.state);
		assert.deepEqual(next, initial);
		assert.equal(f.evaluator.stats.misses, 4);
		assert.deepEqual(next, new MatchupEvaluator().assess(f.state));
		f.state.field.weatherId = '';
		const cleared = f.evaluator.assess(f.state);
		assert.deepEqual(cleared, new MatchupEvaluator().assess(f.state));
		assert.notDeepEqual(cleared.matrix[1], next.matrix[1]);
	});
	it('invalidates other pairs when an ally sleep source changes clause eligibility', () => {
		const f = fixture([mon('Mew', ['tackle']), mon('Slowbro', ['rest'])],
			[mon('Breloom', ['spore', 'machpunch']), mon('Machamp', ['closecombat'])]);
		f.state.field.formatId = 'gen6ou';
		const sleeper = f.state.self.team[1]; sleeper.status = 'slp'; sleeper.sleepSelfInflicted = true;
		f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 4);
		sleeper.sleepSelfInflicted = false;
		const next = f.evaluator.assess(f.state);
		assert.equal(f.evaluator.stats.misses, 7, 'The changed sleeper row and sleep-capable foe column are affected');
		assert.deepEqual(next, new MatchupEvaluator().assess(f.state));
	});
	it('is symmetric between perspectives and bounded below a terminal win', () => {
		const f = fixture([mon('Skarmory', ['bravebird', 'roost']), mon('Chansey', ['seismictoss', 'softboiled'])],
			[mon('Garchomp', ['earthquake', 'dragonclaw'])]);
		const a = f.evaluator.assess(f.state).value;
		const b = f.evaluator.assess({ ...f.state, self: f.state.opponent, opponent: f.state.self }).value;
		assert.equal(a, -b);
		f.battle.p2.pokemon.forEach(p => { p.hp = 0; p.fainted = true; });
		assert(positionValue(projectedState(f.battle), f.evaluator) > Math.abs(a));
	});
	it('does not value losing the last member as an improvement when opposing offensive routes disappear', () => {
		const f = fixture([mon('Magikarp', ['splash'])],
			['Garchomp', 'Mew', 'Dragonite', 'Skarmory', 'Bisharp', 'Snorlax'].map(p => mon(p, ['tackle'])));
		Object.assign(f.state.self.team[0], { hp: 1, hpPercent: 100 / f.state.self.team[0].maxHp });
		assert(f.evaluator.roles(f.state)[0].value > 0);
	});
});
