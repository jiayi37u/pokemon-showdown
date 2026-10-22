'use strict';
const assert = require('assert').strict;
const { Battle } = require('../../../dist/sim');
const { buildPokemonFromRequest, buildBattleStateWithTracker } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { completeMoves, projectBattle, projectionUnsupported } = require('../../../dist/server/npc/ai/hard/projection');
const { searchPosition, searchDamage, searchChoices, searchResponses, replacementChoices } = require('../../../dist/server/npc/ai/hard/search');
const { MatchupEvaluator } = require('../../../dist/server/npc/ai/hard/matchups');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');

const empty = () => ({ stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false,
	reflect: 0, lightscreen: 0, auroraveil: 0, tailwind: 0, wishes: {}, futureMoves: {} });
const field = () => ({ formatId: 'gen6customgame', weather: '', weatherTurns: -1, terrain: '', terrainTurns: 0,
	trickroom: false, trickroomTurns: 0, gravity: false, magicroom: false, wonderroom: false });
let battles = [];
function fixture(team, foe) {
	const b = new Battle({ formatid: 'gen6customgame', seed: '1,2,3,4',
		p1: { name: 'Self', team }, p2: { name: 'Foe', team: foe } });
	battles.push(b); b.makeChoices();
	const pokemon = side => side.activeRequest.side.pokemon.map((p, i) => ({
		...buildPokemonFromRequest(p, i + 1, i === 0, 'gen6customgame'), ident: p.ident,
		ownerSide: side.id, ability: side.pokemon[i].ability,
	}));
	const own = pokemon(b.p1), opposing = pokemon(b.p2);
	const state = { turn: 1, isDoubles: false, field: field(),
		self: { active: own.slice(0, 1), reserve: own.slice(1), team: own, conditions: empty() },
		opponent: { active: opposing.slice(0, 1), reserve: opposing.slice(1), team: opposing,
			remaining: opposing.length, conditions: empty() } };
	// These fixtures deliberately expose complete sets; production uses evidence-refined hypotheses.
	const models = new Map(opposing.map(p => [p, [{ name: 'observed', pokemon: p, weight: 1, matched: true,
		moves: p.moves.map(id => ({ id, availability: 1 })) }]]));
	const evaluator = new HardEvaluation(state, 'gen6customgame');
	evaluator.models = models;
	return { b, state, evaluator };
}

describe('Hard public-state simulator search', () => {
	afterEach(() => { battles.forEach(b => b.destroy()); battles = []; });
	it('ignores expired delayed effects on either side but keeps pending effects explicit', () => {
		const f = fixture([{ species: 'Mew', moves: ['psychic'] }], [{ species: 'Mew', moves: ['psychic'] }]);
		for (const side of [f.state.self, f.state.opponent]) for (const effect of ['wishes', 'futureMoves']) {
			side.conditions[effect] = { 1: 0 };
			assert.equal(projectionUnsupported(f.state), undefined);
			side.conditions[effect][1] = 1;
			assert.equal(projectionUnsupported(f.state), 'delayed effect source unavailable');
			side.conditions[effect][1] = 0;
		}
	});
	it('samples distinct optional slots even when three mandatory moves have higher availability', () => {
		const mandatory = ['rapidspin', 'earthquake', 'ironhead'];
		const optional = ['swordsdance', 'rockslide', 'substitute', 'stealthrock'];
		const knowledge = { revealedMoves: [], presetCandidates: [...optional, ...mandatory], remainingSlots: 4,
			slots: [optional, ...mandatory.map(m => [m])] };
		const model = { pokemon: { moves: [], moveKnowledge: knowledge },
			moves: [...optional.map(id => ({ id, availability: 0.25 })), ...mandatory.map(id => ({ id, availability: 1 }))] };
		const samples = [0, 1, 2].map(i => completeMoves(model, i));
		assert.equal(new Set(samples.map(m => m.slice().sort().join())).size, 3);
		assert(samples.some(m => m.includes('rockslide')));
		assert(completeMoves(model, 2, 'stealthrock').includes('stealthrock'));
		assert.equal(completeMoves(model, 2, 'stealthrock').length, 4);
		for (const moves of samples) { assert.equal(moves.length, 4); assert(mandatory.every(m => moves.includes(m))); }
	});
	it('projects free replacements with real entry hazards and abilities, without an extra opposing attack', () => {
		const f = fixture([{ species: 'Mew', moves: ['splash'] },
			{ species: 'Landorus-Therian', ability: 'Intimidate', moves: ['earthquake'] }],
		[{ species: 'Garchomp', moves: ['dragonclaw'] }]);
		Object.assign(f.state.self.active[0], { hp: 0, maxHp: 100, fainted: true });
		f.state.self.conditions.stealthrock = true;
		const p = projectBattle(f.state, f.state.opponent.team, 0, new Map(), true);
		assert(p); battles.push(p.battle);
		assert.equal(p.battle.requestState, 'switch');
		assert.equal(p.battle.p1.pokemonLeft, 1);
		assert.deepEqual(replacementChoices(p.battle, p.battle.p1, {
			assess() { throw new Error('A sole legal replacement needs no position search'); },
		}), ['switch 2']);
		const entrant = p.battle.p1.pokemon[1], full = entrant.hp;
		p.battle.makeChoices('switch 2', 'pass');
		assert.equal(p.battle.requestState, 'move');
		assert.equal(entrant.hp, full - Math.floor(entrant.maxhp / 8));
		assert.equal(p.battle.p2.active[0].boosts.atk, -1);
	});
	it('selects a free entry using its next action rather than sacrificing a faster KO to damage-only ranking', () => {
		const f = fixture([{ species: 'Mew', moves: ['splash'] },
			{ species: 'Alakazam', moves: ['psychic'], nature: 'Timid', evs: { spa: 252, spe: 252 } },
			{ species: 'Snorlax', moves: ['tackle'] }],
		[{ species: 'Gengar', moves: ['shadowball'], nature: 'Timid', evs: { spa: 252, spe: 252 } }]);
		Object.assign(f.state.self.active[0], { hp: 0, fainted: true });
		const actions = f.state.self.reserve.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 100 }));
		const before = JSON.stringify(f.state);
		const result = searchPosition(f.state, f.evaluator, actions, new Map(), new MatchupEvaluator(), true);
		assert.equal(result.choice, 'switch 2', result.reason);
		assert(result.reason.startsWith('Replacement search'));
		const p = projectBattle(f.state, f.state.opponent.team, 0, new Map(), true); battles.push(p.battle);
		assert.equal(replacementChoices(p.battle, p.battle.p1, new MatchupEvaluator())[0], 'switch 2');
		assert.equal(JSON.stringify(f.state), before);
	});
	it('prepares Beat Up participants and sums their hits without changing the searched position', () => {
		const f = fixture([{ species: 'Weavile', moves: ['beatup'] }, { species: 'Garchomp', moves: ['earthquake'] }],
			[{ species: 'Mew', moves: ['splash'] }]);
		const before = JSON.stringify(f.b.toJSON());
		const full = searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], 'beatup');
		assert(full > 0);
		assert.equal(JSON.stringify(f.b.toJSON()), before);
		f.b.p1.pokemon[1].status = 'brn';
		const reduced = searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], 'beatup');
		assert(reduced > 0 && reduced < full);
	});
	it('isolates preparation hooks that lock the user into a multi-turn move', () => {
		const f = fixture([{ species: 'Mew', moves: ['rollout', 'iceball'] }], [{ species: 'Mew', moves: ['splash'] }]);
		const before = JSON.stringify(f.b.toJSON());
		for (const move of ['rollout', 'iceball']) assert(searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], move) > 0);
		assert.equal(JSON.stringify(f.b.toJSON()), before);
	});
	it('does not rank absorbed attacks as the strongest continuation or activate the immunity while ranking', () => {
		const f = fixture([{ species: 'Talonflame', moves: ['flareblitz', 'bravebird'] }],
			[{ species: 'Heatran', ability: 'Flash Fire', moves: ['magmastorm'] }]);
		const before = JSON.stringify(f.b.toJSON());
		assert.equal(searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], 'flareblitz'), 0);
		assert(searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], 'bravebird') > 0);
		assert.equal(JSON.stringify(f.b.toJSON()), before);
	});
	it('runs attacking ability preparation before testing an absorption ability', () => {
		const f = fixture([{ species: 'Haxorus', ability: 'Mold Breaker', moves: ['surf'] }],
			[{ species: 'Gastrodon', ability: 'Storm Drain', moves: ['splash'] }]);
		const before = JSON.stringify(f.b.toJSON());
		assert(searchDamage(f.b, f.b.p1.active[0], f.b.p2.active[0], 'surf') > 0);
		assert.equal(JSON.stringify(f.b.toJSON()), before);
	});
	it('ranks a reserve with its active ability and item without switching the real projected board', () => {
		const f = fixture([{ species: 'Mew', moves: ['splash'] },
			{ species: 'Azumarill', ability: 'Huge Power', item: 'Choice Band', moves: ['waterfall'] }],
		[{ species: 'Mew', moves: ['surf'] }, { species: 'Gastrodon', ability: 'Storm Drain', moves: ['splash'] }]);
		const reserve = f.b.p1.pokemon[1], foe = f.b.p2.active[0];
		const before = JSON.stringify(f.b.toJSON());
		const strong = searchDamage(f.b, reserve, foe, 'waterfall');
		assert.equal(searchDamage(f.b, f.b.p1.active[0], f.b.p2.pokemon[1], 'surf'), 0);
		assert.equal(JSON.stringify(f.b.toJSON()), before);
		reserve.ability = 'thickfat'; reserve.item = '';
		const weak = searchDamage(f.b, reserve, foe, 'waterfall');
		assert(strong > 2.5 * weak);
	});
	it('retains a switch after attacking even when two damaging continuations outrank it', () => {
		const f = fixture([{ species: 'Mew', moves: ['flamethrower', 'icebeam', 'thunderbolt'] },
			{ species: 'Magikarp', moves: ['splash'] }], [{ species: 'Ferrothorn', moves: ['powerwhip'] }]);
		f.b.p2.active[0].hp = 1;
		const choices = searchChoices(f.b, f.b.p1, 2);
		assert.equal(choices.filter(c => c.startsWith('move')).length, 2);
		assert(choices.includes('switch 2'));
		f.b.p1.active[0].trapped = true;
		assert(searchChoices(f.b, f.b.p1, 2).every(c => c.startsWith('move')));
	});
	it('retains setup against passive actions even when attack-only predictions give it zero weight', () => {
		const f = fixture([{ species: 'Diancie', moves: ['protect', 'moonblast'] }],
			[{ species: 'Gallade', moves: ['closecombat', 'psychocut', 'swordsdance'] },
				{ species: 'Mew', moves: ['psychic'] }]);
		const before = JSON.stringify(f.b.toJSON());
		const predictions = ['closecombat', 'psychocut'].map(id => ({ move: { id }, switching: false, weight: 0.5 }));
		const replies = searchResponses(f.b, predictions);
		assert(replies.length <= 3);
		assert(replies.find(r => r.choice === 'move 3').weight > 0.1);
		assert(replies.some(r => r.choice === 'move 1' && r.weight > 0));
		const continuation = searchChoices(f.b, f.b.p2, 2);
		assert(continuation.includes('move 1')); assert(continuation.includes('move 3'));
		assert(continuation.includes('switch 2'));
		assert.equal(JSON.stringify(f.b.toJSON()), before);
		f.b.p2.active[0].boosts.atk = 6;
		assert(!searchResponses(f.b, predictions).some(r => r.choice === 'move 3' && r.weight > 0));
		assert(!searchChoices(f.b, f.b.p2, 2).includes('move 3'));
		f.b.p2.active[0].boosts.atk = 0; f.b.p2.active[0].ability = 'contrary';
		assert(!searchResponses(f.b, predictions).some(r => r.choice === 'move 3' && r.weight > 0));
		f.b.p2.active[0].ability = 'steadfast'; f.b.p2.active[0].addVolatile('taunt');
		f.b.makeRequest('move');
		assert(!searchResponses(f.b, predictions).some(r => r.choice === 'move 3' && r.weight > 0));
	});
	it('restores stats, HP, status, boosts and weather without replaying lead abilities', () => {
		const f = fixture([{ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
			evs: { atk: 252, spe: 252, hp: 4 }, moves: ['earthquake', 'swordsdance'] }],
		[{ species: 'Landorus-Therian', ability: 'Intimidate', moves: ['earthquake'] }]);
		const own = f.state.self.active[0];
		own.hp = 200; own.status = 'tox'; own.toxicCounter = 3;
		own.boosts.atk = 2;
		f.state.field.weatherId = 'sandstorm'; f.state.field.weatherTurns = 3;
		const before = JSON.stringify(f.state);
		const projection = projectBattle(f.state, f.state.opponent.team, 0, new Map([['earthquake', 2]]));
		assert(projection); battles.push(projection.battle);
		const p = projection.battle.p1.active[0];
		for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) assert.equal(p.storedStats[stat], own.baseStats[stat]);
		assert.equal(p.hp, 200); assert.equal(p.status, 'tox'); assert.equal(p.statusState.stage, 3);
		assert.equal(p.boosts.atk, 2); assert.equal(p.getMoveData('earthquake').pp, 2);
		assert.equal(projection.battle.field.weather, 'sandstorm');
		assert.equal(projection.battle.field.weatherState.duration, 3);
		assert.equal(JSON.stringify(f.state), before);
	});
	it('keeps simulated branches isolated through serialization', () => {
		const f = fixture([{ species: 'Mew', moves: ['swordsdance'] }], [{ species: 'Magikarp', moves: ['splash'] }]);
		const p = projectBattle(f.state, f.state.opponent.team, 0); assert(p); battles.push(p.battle);
		const snapshot = JSON.stringify(p.battle.toJSON());
		const a = Battle.fromJSON(snapshot), b = Battle.fromJSON(snapshot); battles.push(a, b);
		a.makeChoices('move 1', 'move 1');
		assert.equal(a.p1.active[0].boosts.atk, 2); assert.equal(b.p1.active[0].boosts.atk, 0);
		assert.equal(JSON.stringify(p.battle.toJSON()), snapshot);
	});
	it('restores Leech Seed and the Perish Song countdown with engine effect payloads', () => {
		const f = fixture([{ species: 'Mew', moves: ['splash'] }, { species: 'Magikarp', moves: ['splash'] }],
			[{ species: 'Celebi', moves: ['splash'] }]);
		f.state.self.active[0].volatiles.add('leechseed');
		f.state.opponent.active[0].hp -= 100;
		const projection = projectBattle(f.state, f.state.opponent.team, 0); assert(projection); battles.push(projection.battle);
		const hp = projection.battle.p1.active[0].hp, foeHP = projection.battle.p2.active[0].hp;
		projection.battle.makeChoices('move 1', 'move 1');
		assert(projection.battle.p1.active[0].hp < hp); assert(projection.battle.p2.active[0].hp > foeHP);
		f.state.self.active[0].volatiles.clear(); f.state.self.active[0].volatiles.add('perish1');
		const perish = projectBattle(f.state, f.state.opponent.team, 0); assert(perish); battles.push(perish.battle);
		perish.battle.makeChoices('move 1', 'move 1');
		assert.equal(perish.battle.p1.active[0].hp, 0);
	});
	it('does not grant a second Mega after the first has fainted', () => {
		const f = fixture([{ species: 'Lopunny', item: 'Lopunnite', moves: ['return'] }],
			[{ species: 'Magikarp', moves: ['splash'] }]);
		f.state.self.megaUsedByOwner = { p1: true };
		const p = projectBattle(f.state, f.state.opponent.team, 0); assert(p); battles.push(p.battle);
		assert(!p.battle.p1.activeRequest.active[0].canMegaEvo);
	});
	it('retains public Mega usage after the observed Pokemon faints', () => {
		const f = fixture([{ species: 'Charizard', item: 'Charizardite X', moves: ['splash'] }],
			[{ species: 'Magikarp', moves: ['splash'] }]);
		f.b.makeChoices('move 1 mega', 'move 1');
		const tracker = createBattleTracker('p2'); tracker.setFormat('gen6customgame');
		tracker.parseMessage(f.b.log.join('\n'));
		tracker.parseMessage('|faint|p1a: Charizard');
		const state = buildBattleStateWithTracker(f.b.p2.activeRequest, null, tracker, { formatId: 'gen6customgame' });
		assert.equal(state.opponent.megaUsedByOwner.p1, true);
		assert(!state.opponent.megaUsedByOwner.p3);
	});
	it('constructs coherent four-move alternatives including every revealed move', () => {
		const knowledge = { revealedMoves: ['roost'], presetCandidates: ['swordsdance', 'defog', 'bulletpunch', 'uturn', 'knockoff'],
			remainingSlots: 3, slots: [['roost'], ['swordsdance', 'defog'], ['bulletpunch'], ['uturn', 'knockoff']] };
		const model = { pokemon: { moves: ['roost'], moveKnowledge: knowledge },
			moves: [...knowledge.revealedMoves, ...knowledge.presetCandidates].map(id => ({ id, availability: 1 })) };
		for (let variant = 0; variant < 6; variant++) {
			const moves = completeMoves(model, variant);
			assert.equal(moves.length, 4); assert(moves.includes('roost')); assert(moves.includes('bulletpunch'));
			assert(!(moves.includes('swordsdance') && moves.includes('defog')));
		}
	});
	it('varies unknown moves even when public moves occupy the first entries of the candidate list', () => {
		const knowledge = { revealedMoves: ['smackdown', 'earthquake'],
			presetCandidates: ['stealthrock', 'swordsdance', 'uturn'], remainingSlots: 2,
			slots: [['smackdown'], ['earthquake'], ['stealthrock'], ['swordsdance', 'uturn']] };
		const model = { pokemon: { moves: knowledge.revealedMoves, moveKnowledge: knowledge },
			moves: [...knowledge.revealedMoves, ...knowledge.presetCandidates].map(id => ({ id, availability: 1 })) };
		const samples = [0, 1, 2].map(i => completeMoves(model, i));
		assert(samples.some(moves => moves.includes('uturn')));
		assert(samples.some(moves => moves.includes('swordsdance')));
		for (const moves of samples) {
			assert.equal(moves.length, 4);
			assert(knowledge.revealedMoves.every(move => moves.includes(move)));
			assert(!(moves.includes('uturn') && moves.includes('swordsdance')));
		}
	});
	it('uses one typed Hidden Power slot for a generic public reveal and a compatible preset', () => {
		const knowledge = { revealedMoves: ['hiddenpower', 'flamethrower'],
			presetCandidates: ['steameruption', 'sludgebomb', 'hiddenpowergrass'], remainingSlots: 2,
			slots: [['steameruption'], ['flamethrower'], ['sludgebomb'], ['hiddenpowergrass']] };
		const model = { pokemon: { moves: knowledge.revealedMoves, moveKnowledge: knowledge },
			moves: ['steameruption', 'flamethrower', 'sludgebomb', 'hiddenpowergrass'].map(id => ({ id, availability: 1 })) };
		for (let variant = 0; variant < 3; variant++) {
			const moves = completeMoves(model, variant);
			assert.equal(moves.length, 4);
			assert(moves.includes('hiddenpowergrass')); assert(!moves.includes('hiddenpower'));
			const f = fixture([{ species: 'Mew', moves: ['splash'] }], [{ species: 'Volcanion', moves }]);
			f.state.opponent.active[0].moves = moves;
			const p = projectBattle(f.state, f.state.opponent.team, 0); assert(p); battles.push(p.battle);
			assert.equal(p.battle.p2.active[0].hpType, 'Grass');
			assert.equal(p.battle.p2.active[0].moveSlots.filter(m => m.id === 'hiddenpower').length, 1);
		}
	});
	it('compares two attacks with boosting into a next-turn KO on the same scale', () => {
		const f = fixture([{ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
			evs: { atk: 252, spe: 252 }, moves: ['earthquake', 'swordsdance'] }],
		[{ species: 'Machamp', ability: 'No Guard', moves: ['icepunch'] }]);
		const foe = f.state.opponent.active[0]; foe.hp = Math.floor(foe.maxHp * 0.6); foe.hpPercent = 60;
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'attack', move: 'earthquake', prior: 100 }, { id: 'boost', move: 'swordsdance', prior: 130 },
		], new Map());
		assert.equal(result.choice, 'attack', result.reason); assert(result.nodes > 0);
	});
	it('preserves public happiness-based power, move slots and PP in projected sets', () => {
		for (const happiness of [0, 100, 255]) {
			const f = fixture([{ species: 'Mew', happiness, moves: ['return', 'frustration', 'psychic'] }],
				[{ species: 'Mew', moves: ['splash'] }]);
			const power = Math.max(1, Math.floor(happiness / 2.5));
			const opposite = Math.max(1, Math.floor((255 - happiness) / 2.5));
			assert(f.state.self.active[0].moves.includes(`return${power}`));
			const projected = projectBattle(f.state, f.state.opponent.team, 0,
				new Map([[`return${power}`, 2], [`frustration${opposite}`, 3]]));
			assert(projected); battles.push(projected.battle);
			const actor = projected.battle.p1.active[0];
			assert.deepEqual(actor.moveSlots.map(m => m.id), ['return', 'frustration', 'psychic']);
			assert.equal(actor.moveSlots[0].pp, 2); assert.equal(actor.moveSlots[1].pp, 3);
			assert.equal(Math.max(1, Math.floor(actor.happiness / 2.5)), power);
			assert.equal(Math.max(1, Math.floor((255 - actor.happiness) / 2.5)), opposite);
		}
	});
	it('keeps a lethal Return in search instead of endlessly boosting or attacking an immunity', () => {
		const f = fixture([{ species: 'Altaria-Mega', ability: 'Pixilate', happiness: 255,
			moves: ['dragondance', 'return', 'earthquake', 'roost'] }],
		[{ species: 'Zapdos', ability: 'Pressure', moves: ['discharge', 'roost'] }]);
		f.state.self.active[0].boosts.atk = 6;
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'return', move: 'return', prior: 170 }, { id: 'earthquake', move: 'earthquake', prior: 0 },
			{ id: 'heal', move: 'roost', prior: 60 },
		], new Map([['return102', 16]]));
		assert.equal(result.choice, 'return', result.reason);
	});
	it('values a safe setup whose following attack wins instead of reflexively dealing damage', () => {
		const f = fixture([{ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
			evs: { atk: 252, spe: 252 }, moves: ['earthquake', 'swordsdance'] }],
		[{ species: 'Umbreon', ability: 'Synchronize', moves: ['moonlight', 'tackle'] }]);
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'attack', move: 'earthquake', prior: 100 }, { id: 'boost', move: 'swordsdance', prior: 130 },
		], new Map());
		assert.equal(result.choice, 'boost', result.reason);
	});
	it('compares switching and attacking, with entry hazards and the incoming hit resolved by PS', () => {
		const f = fixture([{ species: 'Tyranitar', ability: 'Sand Stream', moves: ['crunch'] },
			{ species: 'Slowbro', ability: 'Regenerator', moves: ['psychic', 'slackoff'] }],
		[{ species: 'Machamp', ability: 'No Guard', moves: ['closecombat'] }, { species: 'Magikarp', moves: ['splash'] }]);
		f.state.self.conditions.stealthrock = true;
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'attack', move: 'crunch', prior: 140 },
			{ id: 'switch', switchTo: f.state.self.reserve[0], prior: 100 },
		], new Map());
		assert.equal(result.choice, 'switch', result.reason);
	});
	it('stops a setup attacker in place instead of cycling between apparent resistances', () => {
		const f = fixture([{ species: 'Rotom-Wash', ability: 'Levitate', item: 'Leftovers', nature: 'Bold',
			evs: { hp: 252, def: 252 }, moves: ['hydropump', 'willowisp', 'voltswitch', 'painsplit'] },
		{ species: 'Ferrothorn', ability: 'Iron Barbs', moves: ['powerwhip', 'leechseed'] },
		{ species: 'Clefable', ability: 'Magic Guard', moves: ['moonblast', 'softboiled'] },
		{ species: 'Heatran', ability: 'Flash Fire', moves: ['lavaplume', 'roar'] }],
		[{ species: 'Garchomp', ability: 'Rough Skin', item: 'Rocky Helmet', nature: 'Jolly',
			evs: { hp: 240, def: 68, spe: 200 }, moves: ['earthquake', 'stoneedge', 'swordsdance', 'stealthrock'] }]);
		f.state.opponent.active[0].boosts.atk = 2;
		f.state.self.conditions.stealthrock = true;
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'burn', move: 'willowisp', prior: 0 }, { id: 'attack', move: 'hydropump', prior: 45 },
			...f.state.self.reserve.map(p => ({ id: `switch ${p.slot}`, switchTo: p, prior: 100 })),
		], new Map());
		assert.equal(result.choice, 'burn', result.reason);
	});
	it('explicitly declines incomplete effect payloads and unseen parties', () => {
		const f = fixture([{ species: 'Mew', moves: ['psychic'] }], [{ species: 'Mew', moves: ['psychic'] }]);
		f.state.self.active[0].volatiles.add('substitute');
		assert(projectionUnsupported(f.state).includes('substitute'));
		f.state.self.active[0].volatiles.clear(); f.state.opponent.remaining = 2;
		assert(projectionUnsupported(f.state).includes('unseen party'));
	});
	it('does not predict a switch that Magnet Pull prevents in the projected world', () => {
		const f = fixture([{ species: 'Magnezone', ability: 'Magnet Pull', moves: ['hiddenpowerfire', 'thunderbolt'] }],
			[{ species: 'Ferrothorn', ability: 'Iron Barbs', moves: ['powerwhip'] }, { species: 'Dragonite', moves: ['earthquake'] }]);
		const result = searchPosition(f.state, f.evaluator, [
			{ id: 'fire', move: 'hiddenpowerfire', prior: 140 }, { id: 'electric', move: 'thunderbolt', prior: 80 },
		], new Map());
		assert.equal(result.choice, 'fire', result.reason);
	});
});
