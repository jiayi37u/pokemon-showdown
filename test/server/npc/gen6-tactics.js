'use strict';
const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');
const { HardAI } = require('../../../dist/server/npc/ai/hard');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');
const { inferOpponent, hardMove } = require('../../../dist/server/npc/ai/hard/opponent-model');
const { buildBattleStateWithTracker, buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { DEFAULT_AI_CONFIG } = require('../../../dist/server/npc/ai/cfru/types');
const { megaEvolutionState } = require('../../../dist/server/npc/ai/cfru/util/forms');
const { getEffectiveSpeed, compareSpeedOrder, compareActionOrder } = require('../../../dist/server/npc/ai/cfru/util/speed');
const fish = { species: 'Magikarp', ability: 'Swift Swim', moves: ['splash'] };
let battles = [];
function game(team, foes = [fish], AI = HardAI, mode = 'singles') {
	const b = new Battle({ format: { ...Dex.formats.get('gen6customgame'), gameType: mode }, seed: [1, 2, 3, 4],
		p1: { name: 'Foe', team: foes }, p2: { name: 'Own', team } });
	battles.push(b); b.makeChoices();
	const ai = new AI({ write() {} }, { seed: [1, 2, 3, 4] });
	const room = { format: 'gen6customgame' };
	Object.defineProperty(room, 'sides', { get() { throw new Error('Hidden simulator state accessed'); } });
	ai.setBattle(room);
	let choice, cursor = 0;
	ai.choose = x => { choice = x; };
	const sync = () => { ai.getTracker().parseMessage(b.log.slice(cursor).join('\n')); cursor = b.log.length; };
	sync();
	return { b, ai, sync, state() { return buildBattleStateWithTracker(b.p2.activeRequest, room, ai.getTracker(), { ...DEFAULT_AI_CONFIG, formatId: 'gen6customgame' }); },
		decide() { sync(); ai.receiveRequest(b.p2.activeRequest); return choice; } };
}
describe('Gen6 preset and tactical integration', () => {
	afterEach(() => { battles.forEach(b => b.destroy()); battles = []; });
	it('loads local Gen6 variants and keeps base and Mega stats distinct', () => {
		const g = game([fish], [{ species: 'Charizard', moves: ['flamethrower'] }]);
		let foe = g.state().opponent.active[0], models = inferOpponent(foe, 'gen6ou');
		assert(models.length > 1 && models.every(m => m.matched));
		assert(models.every(m => m.pokemon.species === 'Charizard'));
		const speed = models.map(m => m.pokemon.baseStats.spe);
		assert(speed.every(s => s <= 328));
		g.ai.getTracker().parseMessage('|detailschange|p1a: Charizard|Charizard-Mega-X');
		foe = g.state().opponent.active[0]; models = inferOpponent(foe, 'gen6ou');
		assert(models.length && models.every(m => m.matched && m.pokemon.item === 'charizarditex'));
		assert(models.every(m => m.pokemon.species === 'Charizard-Mega-X'));
	});
	it('shares priors for cosmetic forms without merging Mega or battle-changing forms', () => {
		const { getOpponentPreset, presetSpeciesId } = require('../../../dist/server/npc/ai/cfru/util/opponent-presets');
		for (const [form, base] of [['Keldeo-Resolute', 'Keldeo'], ['Gastrodon-East', 'Gastrodon']]) {
			assert.deepEqual(getOpponentPreset(form, 'gen6ou'), getOpponentPreset(base, 'gen6ou'));
			const g = game([fish], [{ species: form, moves: ['surf'] }]);
			const models = inferOpponent(g.state().opponent.active[0], 'gen6ou');
			assert(models.length && models.every(m => m.matched));
			assert(models.every(m => m.pokemon.species === form));
		}
		assert.equal(presetSpeciesId('Venusaur-Mega', 'gen6ou'), 'venusaurmega');
		assert.equal(presetSpeciesId('Rotom-Wash', 'gen6ou'), 'rotomwash');
		assert.equal(presetSpeciesId('Genesect-Douse', 'gen6ou'), 'genesectdouse');
	});

	it('falls back to the common preset for a species absent from Gen6 OU data', () => {
		const g = game([fish]);
		const models = inferOpponent(g.state().opponent.active[0], 'gen6ou');
		assert.equal(models.length, 1); assert.equal(models[0].matched, false);
	});
	for (const AI of [NormalAI, HardAI]) {
		it(`${AI.name} issues Mega in singles and does not give Gen6 immediate Mega speed`, () => {
			const g = game([{ species: 'Diancie', item: 'Diancite', nature: 'Naive', evs: { spe: 252, spa: 252 }, moves: ['moonblast'] }], [fish], AI);
			const state = g.state(), actor = state.self.active[0], projected = megaEvolutionState(state, actor);
			assert(projected); const mega = projected.self.active[0];
			assert(mega.baseStats.spe > actor.baseStats.spe);
			assert(getEffectiveSpeed(mega, projected.field) > getEffectiveSpeed(actor, state.field));
			assert.equal(compareSpeedOrder(mega, actor, projected.field), 0);
			assert.equal(state.self.active[0].species, 'Diancie');
			assert(g.decide().endsWith(' mega'));
		});
		it(`${AI.name} can Mega in the second doubles slot after a non-Mega first slot`, () => {
			const g = game([fish, { species: 'Diancie', item: 'Diancite', moves: ['moonblast'] }], [fish, fish], AI, 'doubles');
			const choice = g.decide(); assert(/, move .* mega$/.test(choice), choice);
		});
	}
	it('keeps a free Mega Fake Out turn instead of fleeing the attack it prevents', () => {
		const g = game([{ species: 'Lopunny', item: 'Lopunnite', ability: 'Limber',
			moves: ['fakeout'], evs: { atk: 252, spe: 252 }, nature: 'Jolly' },
		{ species: 'Blissey', ability: 'Natural Cure', moves: ['seismictoss'] }],
		[{ species: 'Alakazam', ability: 'Magic Guard', moves: ['psychic'] }]);
		g.b.p2.active[0].hp = 40; g.b.makeRequest('move');
		const choice = g.decide();
		assert.equal(choice, 'move 1 mega');
		g.b.makeChoices('move 1', choice);
		assert.equal(g.b.p2.active[0].hp, 40);
		assert(g.b.log.some(line => line.includes('|cant|p1a: Alakazam|flinch')));
	});

	it('does not mistake Inner Focus for a free Fake Out turn', () => {
		const g = game([{ species: 'Lopunny', item: 'Lopunnite', ability: 'Limber', moves: ['fakeout'] },
			{ species: 'Blissey', ability: 'Natural Cure', moves: ['seismictoss'] }],
		[{ species: 'Alakazam', ability: 'Inner Focus', moves: ['psychic'] }]);
		// Exercise the tactical fallback. Team search can deliberately sacrifice a spent
		// Fake Out-only member for chip and a free entry; that is not a flinch prediction.
		g.ai.useSearch = false;
		g.ai.getTracker().parseMessage('|-ability|p1a: Alakazam|Inner Focus');
		g.b.p2.active[0].hp = 40; g.b.makeRequest('move');
		assert.equal(g.decide(), 'switch 2');
	});

	it('rejects entry into a revealed lethal attack even when its predicted probability is low', () => {
		const g = game([{ species: 'Mew', moves: ['psychic'] }, { species: 'Tyranitar', moves: ['crunch'] }],
			[{ species: 'Machamp', ability: 'Guts', moves: ['tackle', 'closecombat'] }]);
		g.ai.getTracker().parseMessage('|move|p1a: Machamp|Tackle|p2a: Mew\n|move|p1a: Machamp|Close Combat|p2a: Mew');
		const state = g.state(), actor = state.self.active[0], foe = state.opponent.active[0], reserve = state.self.reserve[0];
		const e = new HardEvaluation(state, 'gen6ou');
		const prediction = new Map([[foe, [
			{ move: hardMove('tackle', 1, 'gen6ou'), weight: 0.99, switching: false, user: foe },
			{ move: hardMove('closecombat', 2, 'gen6ou'), weight: 0.01, switching: false, user: foe },
		]]]);
		assert(e.incomingRisk(reserve, prediction) < reserve.hp);
		assert.equal(e.scoreSwitch(reserve, prediction, false, actor).safe, false);
	});

	it('ranks a usable priority finish above a slower replacement that cannot attack before fainting', () => {
		const g = game([fish, { species: 'Slowpoke', moves: ['psychic'] }, { species: 'Weavile', moves: ['iceshard'] }],
			[{ species: 'Mewtwo', moves: ['psychic'] }]);
		g.ai.getTracker().parseMessage('|move|p1a: Mewtwo|Psychic|p2a: Magikarp\n|-damage|p1a: Mewtwo|1/100');
		const state = g.state(), e = new HardEvaluation(state, 'gen6ou');
		const [slow, fast] = state.self.reserve;
		slow.hp = fast.hp = 1; slow.hpPercent = fast.hpPercent = 1;
		const slowResult = e.scoreSwitch(slow, e.predictions(slow), true);
		const fastResult = e.scoreSwitch(fast, e.predictions(fast), true);
		assert.equal(slowResult.hasFollowUp, false);
		assert(fastResult.hasFollowUp && fastResult.score > slowResult.score);
	});

	it('attempts a useful support action over an impossible status when every forecast score is zero', () => {
		const g = game([{ species: 'Smeargle', moves: ['spore', 'stealthrock'] }],
			[{ species: 'Raikou', moves: ['thunderbolt'] }, fish]);
		g.ai.getTracker().parseMessage('|-status|p1a: Raikou|slp');
		g.b.p2.active[0].hp = 1; g.b.makeRequest('move');
		assert.equal(g.decide(), 'move 2');
	});

	it('Gen7 projections use the new speed immediately', () => {
		const g = game([{ species: 'Diancie', item: 'Diancite', moves: ['moonblast'] }]);
		const state = g.state(); state.field.formatId = 'gen7customgame';
		const actor = state.self.active[0], projected = megaEvolutionState(state, actor);
		assert(getEffectiveSpeed(projected.self.active[0], projected.field) > getEffectiveSpeed(actor, state.field));
	});
	it('matches Gen6 Mega Banette retaining its pre-Mega priority for the current turn', () => {
		const g = game([{ species: 'Banette', item: 'Banettite', ability: 'Insomnia', moves: ['thunderwave'] }],
			[{ ...fish, nature: 'Jolly', evs: { spe: 252 } }]);
		const state = g.state(), projected = megaEvolutionState(state, state.self.active[0]);
		const actor = projected.self.active[0], foe = state.opponent.active[0];
		assert.equal(compareActionOrder(actor, foe, hardMove('thunderwave', 1, 'gen6ou'),
			[hardMove('splash', 1, 'gen6ou')], projected.field), -1);
		g.b.makeChoices('move 1', 'move 1 mega');
		const moves = g.b.log.filter(line => line.startsWith('|move|'));
		assert(moves[0].includes('Magikarp|Splash'));
		assert(moves[1].includes('Banette|Thunder Wave'));
	});
	it('keeps preview separate from observed members and never resurrects a fainted preview member', () => {
		const g = game([fish], [fish, { species: 'Cresselia', moves: ['icebeam'] }, { species: 'Dragonite', moves: ['earthquake'] }]);
		let state = g.state();
		assert.deepEqual(state.opponent.preview.map(p => p.species).sort(), ['Cresselia', 'Dragonite']);
		assert.equal(state.opponent.team.length, 1);
		assert(state.opponent.preview.every(p => p.moves.length === 0 && !p.itemKnown && !p.observedAbility));
		g.ai.getTracker().parseMessage('|switch|p1a: Cresselia|Cresselia, F|100/100\n|faint|p1a: Cresselia');
		state = g.state(); assert.deepEqual(state.opponent.preview.map(p => p.species), ['Dragonite']);
		g.ai.getTracker().reset(); assert.equal(g.ai.getTracker().getUnseenOpponentPreview().length, 0);
	});
	it('devalues a predicted Earthquake into public ground-immune replacements', () => {
		const g = game([{ species: 'Landorus-Therian', moves: ['earthquake', 'uturn', 'stealthrock'] }],
			[{ species: 'Excadrill', moves: ['earthquake'] }, { species: 'Cresselia', ability: 'Levitate', moves: ['icebeam'] }]);
		const state = g.state(), actor = state.self.active[0], foe = state.opponent.active[0];
		const e = new HardEvaluation(state, 'gen6ou'), move = hardMove('earthquake', 1, 'gen6ou');
		const stay = new Map([[foe, [{ move: null, weight: 1, switching: false }]]]);
		const swap = new Map([[foe, [{ move: null, weight: 1, switching: true }]]]);
		const before = e.scoreMoves(actor, [move], foe, stay)[0];
		const after = e.scoreMoves(actor, [move], foe, swap)[0];
		assert(after.score < before.score - 30, `${before.score} -> ${after.score}`);
		assert(after.breakdown.details.some(d => d.reason.includes('public replacement')));
	});
	it('does not turn an unseen replacement into zero damage in no-preview formats', () => {
		const g = game([{ species: 'Mew', moves: ['tackle'] }], [{ species: 'Mew', moves: ['splash'] }]);
		const state = g.state(), actor = state.self.active[0], foe = state.opponent.active[0];
		state.opponent.preview = []; state.opponent.reserve = []; state.opponent.remaining = 6;
		const e = new HardEvaluation(state, 'gen6ou'), move = hardMove('tackle', 1, 'gen6ou');
		const staying = new Map([[foe, [{ move: null, switching: false, weight: 1 }]]]);
		const unknown = new Map([[foe, [{ move: null, switching: false, weight: 0.4 },
			{ move: null, switching: true, weight: 0.6 }]]]);
		assert.equal(e.scoreMoves(actor, [move], foe, unknown)[0].score,
			e.scoreMoves(actor, [move], foe, staying)[0].score);
	});

	it('requires a plausible public destination before assigning high retreat weight', () => {
		const forecast = reserve => {
			const g = game([{ species: 'Kyogre', ability: 'Drizzle', moves: ['surf'] }],
				[{ species: 'Torkoal', moves: ['flamethrower'] }, reserve]);
			const state = g.state(), actor = state.self.active[0], foe = state.opponent.active[0];
			const weight = () => new HardEvaluation(state, 'gen6ou').predictions(actor).get(foe)
				.filter(a => a.switching).reduce((sum, a) => sum + a.weight, 0);
			const known = weight();
			state.opponent.preview = []; state.opponent.reserve = [];
			assert(weight() <= 0.2 + 1e-9, 'Unknown bench information is not a safe switch destination');
			return known;
		};
		assert(forecast({ species: 'Gastrodon', ability: 'Storm Drain', moves: ['earthpower'] }) > 0.5);
		assert(forecast({ species: 'Charizard', moves: ['flamethrower'] }) <= 0.2 + 1e-9);
	});

	it('does not spend a healthy Cresselia to restore a healthy teammate', () => {
		const g = game([{ species: 'Cresselia', moves: ['lunardance', 'icebeam'] }, { species: 'Dragonite', moves: ['earthquake'] }]);
		assert.notEqual(g.decide(), 'move 1');
	});
	it('values hitting a replacement despite current immunity, but never bypasses own confirmed sleep', () => {
		const g = game([{ species: 'Landorus-Therian', moves: ['earthquake'] }],
			[{ species: 'Cresselia', ability: 'Levitate', moves: ['icebeam'] }, { species: 'Excadrill', moves: ['earthquake'] }]);
		const state = g.state(), actor = state.self.active[0], foe = state.opponent.active[0];
		const e = new HardEvaluation(state, 'gen6ou'), move = hardMove('earthquake', 1, 'gen6ou');
		const swap = new Map([[foe, [{ move: null, weight: 1, switching: true }]]]);
		const attacking = e.scoreMoves(actor, [move], foe, swap)[0];
		assert(attacking.score > 0 && !attacking.flags.isImmune, JSON.stringify(attacking));
		actor.status = 'slp'; actor.sleepTurns = 3;
		assert.equal(e.scoreMoves(actor, [move], foe, swap)[0].score, 0);
	});
	it('uses Lunar Dance for a wounded recipient and follows that plan at forced replacement', () => {
		const g = game([{ species: 'Cresselia', moves: ['lunardance', 'icebeam'] },
			{ species: 'Dragonite', moves: ['earthquake'] }, { species: 'Volcanion', moves: ['flamethrower'] }]);
		g.b.p2.active[0].hp = 15; g.b.p2.pokemon[2].hp = 30; g.b.makeRequest('move');
		const choice = g.decide(); assert.equal(choice, 'move 1');
		g.b.makeChoices('move 1', choice);
		assert(g.b.p2.activeRequest.forceSwitch); assert.equal(g.decide(), 'switch 3');
		g.b.makeChoices('', 'switch 3');
		assert.equal(g.b.p2.active[0].species.name, 'Volcanion');
		assert.equal(g.b.p2.active[0].hp, g.b.p2.active[0].maxhp);
	});
	it('Gen6 Lunar Dance heals a 1 HP recipient before entry hazards', () => {
		const g = game([{ species: 'Cresselia', moves: ['lunardance', 'icebeam'] },
			{ species: 'Volcarona', moves: ['flamethrower'] }]);
		g.b.p2.active[0].hp = 15; g.b.p2.pokemon[1].hp = 1;
		g.b.p2.addSideCondition('stealthrock', g.b.p1.active[0]);
		g.b.makeRequest('move');
		assert.equal(g.decide(), 'move 1');
		g.b.makeChoices('move 1', 'move 1');
		assert.equal(g.decide(), 'switch 2');
		g.b.makeChoices('', 'switch 2');
		const recipient = g.b.p2.active[0];
		assert.equal(recipient.hp, recipient.maxhp - Math.floor(recipient.maxhp / 2));
	});
	for (const AI of [NormalAI, HardAI]) it(`${AI.name} supports the p4 Mega slot in Multi`, () => {
		const b = new Battle({ format: { ...Dex.formats.get('gen6customgame'), gameType: 'multi', playerCount: 4 }, seed: [1, 2, 3, 4],
			p1: { name: 'A', team: [fish] }, p2: { name: 'B', team: [fish] }, p3: { name: 'C', team: [fish] },
			p4: { name: 'D', team: [{ species: 'Diancie', item: 'Diancite', moves: ['moonblast'] }] } });
		battles.push(b); b.makeChoices();
		const tracker = createBattleTracker('p2', true); tracker.setFormat('gen6customgame'); tracker.parseMessage(b.log.join('\n'));
		const state = buildBattleStateFromRequests(['p2', 'p4'].map(side => ({ side, request: b[side].activeRequest })), tracker,
			{ ...DEFAULT_AI_CONFIG, formatId: 'gen6customgame', isDoubles: true });
		const ai = new AI({ write() {} }, { seed: [1, 2, 3, 4] }); ai.setBattle({ format: 'gen6customgame' }); ai.tracker = tracker;
		let choice;
		ai.choose = x => { choice = x; };
		ai.receiveRequestWithState(b.p4.activeRequest, state, 2);
		assert(choice.endsWith(' mega'), choice);
	});
});
