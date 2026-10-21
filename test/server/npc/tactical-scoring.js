'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { buildAIMove, buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { HardEvaluation } = require('../../../dist/server/npc/ai/hard/evaluation');

const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
let battles = [];
function fixture(mode = 'singles', actor = passive, foe = passive, reserve = [], format = 'gen6customgame') {
	const multi = mode === 'multi';
	const battle = new Battle({ format: { ...Dex.formats.get(format), gameType: mode, playerCount: multi ? 4 : 2 }, seed: [1, 2, 3, 4],
		p1: { name: 'Foe', team: mode === 'doubles' ? [foe, passive] : [foe] },
		p2: { name: 'Actor', team: [actor, ...(mode === 'doubles' ? [passive] : []), ...reserve] },
		...(multi ? { p3: { name: 'Foe2', team: [passive] }, p4: { name: 'Ally', team: [passive] } } : {}) });
	battles.push(battle);
	if (battle.requestState === 'teampreview') battle.makeChoices();
	const config = { ...DEFAULT_AI_CONFIG, formatId: format, isDoubles: mode !== 'singles' };
	const tracker = createBattleTracker('p2', multi); tracker.setFormat(format); tracker.parseMessage(battle.log.join('\n'));
	const state = buildBattleStateFromRequests((multi ? ['p2', 'p4'] : ['p2']).map(side =>
		({ side, request: JSON.parse(JSON.stringify(battle[side].activeRequest)) })), tracker, config, battle.turn);
	// Explicit public move fixtures isolate tactical rules from preset coverage.
	for (const mon of state.opponent.active) { mon.moves = ['splash']; mon.moveKnowledge = undefined; }
	const score = id => new ScoringEngine(config, createAICache(1)).scoreMove(state, state.self.active[0],
		buildAIMove({ id }, 1, format), state.opponent.active[0]);
	return { battle, state, score, format };
}
const has = (result, text) => result.breakdown.details.some(d => d.reason.includes(text));

describe('NPC tactical scoring from public threats', () => {
	afterEach(() => { for (const battle of battles) battle.destroy(); battles = []; });
	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: pure phazing requires a concrete benefit`, () => {
			const g = fixture(mode, { ...passive, moves: ['roar', 'dragontail'] });
			g.state.opponent.remaining = 3;
			g.state.opponent.remainingByOwner = { p1: 3 };
			assert.equal(g.score('roar').score, 60);
			assert(g.score('dragontail').score > 60, 'Damaging phazing still deals damage');
			g.state.opponent.active[0].boosts.spe = 2;
			assert(g.score('roar').score > 60);
			g.state.opponent.active[0].boosts.spe = 0;
			g.state.opponent.conditions.stealthrock = true;
			assert(g.score('roar').score > 60);
		});

		it(`${mode}: a resisted finishing hit keeps its KO value`, () => {
			const g = fixture(mode, { ...passive, moves: ['tackle', 'swordsdance'] },
				{ species: 'Aggron', ability: 'Sturdy', moves: ['splash'] });
			const foe = g.state.opponent.active[0]; foe.hp = 1; foe.hpPercent = 100 / foe.maxHp;
			const result = g.score('tackle');
			assert(result.flags.canKO);
			assert(!has(result, 'resisted') && !has(result, 'low damage'));
			assert(result.score > g.score('swordsdance').score);
		});

		it(`${mode}: rejects Weavile setting up into a revealed boosted Iron Head`, () => {
			const g = fixture(mode, { species: 'Weavile', ability: 'Pressure', moves: ['swordsdance', 'iciclecrash'] },
				{ species: 'Bisharp', ability: 'Defiant', moves: ['ironhead'] });
			const foe = g.state.opponent.active[0]; foe.moves = ['ironhead']; foe.boosts.atk = 2;
			const actor = g.state.self.active[0]; actor.hp = Math.floor(actor.maxHp * 0.75); actor.hpPercent = 75;
			assert.equal(g.score('swordsdance').score, 60);
			assert(has(g.score('swordsdance'), 'cannot survive'));
			const evaluation = new HardEvaluation(g.state, g.format);
			const result = evaluation.scoreMoves(actor, [buildAIMove({ id: 'swordsdance' }, 1, g.format)], foe,
				evaluation.predictions(actor))[0];
			assert(result.score <= 60, 'Hard must retain the shared survival gate');
			foe.volatiles.add('mustrecharge');
			assert(g.score('swordsdance').score > 100, 'A public recharge turn gives a setup window');
		});

		it(`${mode}: recognizes meaningful Rapid Spin clearing without treating it as an ineffective attack`, () => {
			const g = fixture(mode, { species: 'Excadrill', ability: 'Mold Breaker', moves: ['rapidspin'] },
				{ species: 'Aggron', ability: 'Sturdy', moves: ['splash'] }, [{ species: 'Volcarona', moves: ['splash'] }]);
			const without = g.score('rapidspin');
			g.state.self.conditions.stealthrock = true;
			const clearing = g.score('rapidspin');
			assert(clearing.score > without.score + 20);
			assert(has(clearing, 'Spin removes') && !has(clearing, 'low damage'));
			g.state.opponent.active[0].types = ['Ghost'];
			assert.equal(g.score('rapidspin').score, 0, 'An immune target blocks clearing');
			g.state.opponent.active[0].types = ['Rock', 'Steel'];
			g.state.self.reserve[0].fainted = true;
			assert(!has(g.score('rapidspin'), 'Spin removes'), 'No reserve remains to benefit from hazards');
		});
	}

	it('Hard does not revive a discouraged conditional attack through damage bonuses', () => {
		const g = fixture('singles', { species: 'Bisharp', ability: 'Defiant', moves: ['suckerpunch', 'knockoff'] },
			{ species: 'Alakazam', ability: 'Magic Guard', moves: ['calmmind'] });
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		foe.hp = 1; foe.hpPercent = 100 / foe.maxHp; foe.lastMove = 'calmmind';
		const e = new HardEvaluation(g.state, g.format);
		const result = e.scoreMoves(actor, [buildAIMove({ id: 'suckerpunch' }, 1, g.format)], foe, e.predictions(actor))[0];
		assert.equal(result.score, 60);
		assert(result.flags.discouraged);
	});

	it('both difficulties discourage sacrificing a healthy user for nonlethal damage', () => {
		const g = fixture('singles', { species: 'Landorus-Therian', moves: ['explosion'] },
			{ species: 'Aggron', ability: 'Rock Head', moves: ['splash'] });
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		assert.equal(g.score('explosion').score, 60);
		const e = new HardEvaluation(g.state, g.format);
		assert.equal(e.scoreMoves(actor, [buildAIMove({ id: 'explosion' }, 1, g.format)], foe,
			e.predictions(actor))[0].score, 60);
		foe.hp = 1; foe.hpPercent = 100 / foe.maxHp;
		assert(g.score('explosion').score > 100, 'A useful trade remains available');
	});

	it('applies a fast defensive boost before incoming damage, but not after a slower action', () => {
		const g = fixture('singles', { ...passive, moves: ['irondefense'] }, { ...passive, moves: ['tackle'] });
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		foe.moves = ['tackle']; foe.baseStats.atk = 400; actor.baseStats.def = 200;
		actor.hp = 60; actor.maxHp = 100; actor.hpPercent = 60;
		actor.baseStats.spe = 400; foe.baseStats.spe = 100;
		assert(!has(g.score('irondefense'), 'cannot survive'));
		actor.baseStats.spe = 50;
		assert(has(g.score('irondefense'), 'cannot survive'));
	});

	it('does not mistake conditional priority for a threat to a non-attacking setup turn', () => {
		const g = fixture('singles', { ...passive, moves: ['swordsdance', 'tackle'] });
		g.state.opponent.active[0].moves = ['suckerpunch'];
		g.state.opponent.active[0].baseStats.atk = 999;
		assert(!has(g.score('swordsdance'), 'cannot survive'));
	});

	it('preserves known single-hit setup protection without treating it as immunity to multiple hits', () => {
		const g = fixture('singles', { ...passive, item: 'Focus Sash', moves: ['shellsmash'] });
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		foe.moves = ['tackle']; foe.baseStats.atk = 9999;
		assert(!has(g.score('shellsmash'), 'cannot survive'));
		g.state.field.weather = 'sand';
		assert(has(g.score('shellsmash'), 'cannot survive'), 'Residual damage consumes the surviving HP');
		g.state.field.weather = '';
		actor.hp -= 1;
		assert(has(g.score('shellsmash'), 'cannot survive'), 'Damaged Focus Sash offers no protection');
		actor.volatiles.add('substitute');
		assert(!has(g.score('shellsmash'), 'cannot survive'));
		foe.moves = ['doublehit'];
		assert(has(g.score('shellsmash'), 'cannot survive'));
	});

	it('sacrificial healing requires a useful reserve and does not casually sacrifice a healthy supporter', () => {
		const g = fixture('singles', { ...passive, moves: ['lunardance', 'healingwish'] }, passive, [passive]);
		for (const move of ['lunardance', 'healingwish']) {
			assert.equal(g.score(move).score, 60, 'Full-health reserves offer no healing benefit');
			g.state.self.reserve[0].hpPercent = 20;
			assert.equal(g.score(move).score, 60, 'Healthy supporter still has value');
			g.state.self.active[0].hpPercent = 30;
			assert.equal(g.score(move).score, 100, 'An injured supporter can pass recovery');
			g.state.self.reserve[0].fainted = true;
			assert.equal(g.score(move).score, 0);
			g.state.self.reserve[0].fainted = false;
			g.state.self.reserve[0].hpPercent = 100;
			g.state.self.active[0].hpPercent = 100;
		}
	});

	it('matches engine Rapid Spin clearing, including Ghost immunity', () => {
		for (const species of ['Mew', 'Gengar']) {
			const g = fixture('singles', { species: 'Excadrill', ability: 'Mold Breaker', moves: ['rapidspin'] },
				{ species, moves: ['splash'] }, [passive]);
			g.battle.p2.addSideCondition('stealthrock', g.battle.p1.active[0]);
			g.battle.actions.useMove('rapidspin', g.battle.p2.active[0], { target: g.battle.p1.active[0] });
			assert.equal(!!g.battle.p2.sideConditions.stealthrock, species === 'Gengar');
		}
	});

	it('removes no hazard utility for boots-only reserves, Sheer Force suppression, or fatal contact', () => {
		const g = fixture('singles', { ...passive, moves: ['rapidspin', 'mortalspin'] }, passive,
			[{ ...passive, item: 'Heavy-Duty Boots' }], 'gen9customgame');
		g.state.self.conditions.stealthrock = true;
		assert(!has(g.score('rapidspin'), 'Spin removes'));
		g.state.self.reserve[0].item = '';
		g.state.self.active[0].ability = 'Sheer Force';
		assert(!has(g.score('rapidspin'), 'Spin removes'));
		assert(!has(g.score('mortalspin'), 'Spin removes'));
		g.state.self.active[0].ability = 'Synchronize';
		g.state.self.active[0].hp = 1;
		g.state.opponent.active[0].item = 'Rocky Helmet';
		assert(!has(g.score('rapidspin'), 'Spin removes'));
		g.state.self.active[0].ability = 'Magic Guard';
		assert(has(g.score('rapidspin'), 'Spin removes'));
	});
	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: records contact item ownership and retains it after switching`, () => {
			const tracker = createBattleTracker('p2', mode === 'multi');
			const holder = mode === 'singles' ? 'p1a' : mode === 'doubles' ? 'p1b' : 'p3b';
			tracker.parseMessage(`|switch|${holder}: Mew|Mew|100/100\n` +
				`|-damage|p2a: Victim|50/100|[from] item: Rocky Helmet|[of] ${holder}: Mew`);
			const known = tracker.getOpponentTeam().find(p => p.species === 'Mew');
			assert.equal(known.item, 'Rocky Helmet');
			assert.equal(known.originalItem, 'Rocky Helmet');
			tracker.parseMessage(`|switch|${holder}: Ditto|Ditto|100/100\n|switch|${holder}: Mew|Mew|100/100`);
			assert.equal(tracker.getOpponentTeam().find(p => p.species === 'Mew').item, 'Rocky Helmet');
		});

		it(`${mode}: discourages HP-cost support before a lethal revealed attack`, () => {
			const g = fixture(mode, { ...passive, moves: ['substitute'] }, passive);
			const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
			actor.hp = Math.floor(actor.maxHp * 0.31); actor.hpPercent = 31; actor.status = 'par';
			foe.moves = ['psychic']; foe.moveKnowledge = { revealedMoves: ['psychic'], presetCandidates: [], remainingSlots: 3 };
			foe.boosts.spa = 6;
			assert.equal(g.score('substitute').score, 60);
			foe.volatiles.add('mustrecharge');
			assert(g.score('substitute').score > 60, 'Recharge permits paying the cost');
		});
	}

	it('does not average lethal priority branches into safe recovery', () => {
		const g = fixture('singles', { species: 'Serperior', ability: 'Contrary', moves: ['synthesis'] },
			{ species: 'Metagross-Mega', ability: 'Tough Claws', moves: ['bulletpunch', 'splash'] });
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		actor.hp = 1; actor.hpPercent = 100 / actor.maxHp;
		const move = buildAIMove({ id: 'synthesis' }, 1, g.format);
		const predictions = new Map([[foe, [
			{ move: buildAIMove({ id: 'bulletpunch' }, 1, g.format), weight: 0.46 },
			{ move: null, weight: 0.54, switching: true },
		]]]);
		const e = new HardEvaluation(g.state, g.format);
		const score = e.scoreMoves(actor, [move], foe, predictions)[0];
		assert(score.score <= 60);
		assert(!has(score, 'Healing prevents KO'));
		const safe = e.scoreMoves(actor, [move], foe, new Map([[foe, [{ move: null, weight: 1 }]]]))[0];
		assert(safe.score > 100, 'A genuine free turn still rewards recovery');
	});

	it('caps zero-benefit recovery and protection, then leaves for a useful safe replacement', () => {
		const g = fixture('singles', { species: 'Slowbro', moves: ['slackoff', 'protect'] }, passive, [passive]);
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		const e = new HardEvaluation(g.state, g.format);
		const predictions = new Map([[foe, [{ move: null, weight: 1 }]]]);
		const scores = e.scoreMoves(actor, ['slackoff', 'protect'].map(id => buildAIMove({ id }, 1, g.format)), foe, predictions);
		assert(scores.every(s => s.score <= 60));
		assert(e.switchReason(actor, scores[0], { pokemon: g.state.self.reserve[0], score: 1, safe: true }, predictions, true));
		assert(e.switchReason(actor, scores[0], { pokemon: g.state.self.reserve[0], score: -50, safe: true,
			hasFollowUp: true }, predictions, true), 'A costly entry can be justified by a productive next action');
		assert.equal(e.switchReason(actor, scores[0], { pokemon: g.state.self.reserve[0], score: -50, safe: true,
			hasFollowUp: false }, predictions, true), null, 'Do not trade one dead end for another');
		assert.equal(e.switchReason(actor, scores[0], { pokemon: g.state.self.reserve[0], score: 10, safe: false,
			hasFollowUp: true }, predictions, true), null, 'Entry must survive');
	});

	it('includes Toxic in recovery survival and resets attrition before the high recovery score exemption', () => {
		const g = fixture('singles', { ...passive, moves: ['recover', 'rest'] }, passive, [passive]);
		const actor = g.state.self.active[0], foe = g.state.opponent.active[0];
		actor.hp = Math.floor(actor.maxHp * 0.2); actor.hpPercent = 20;
		actor.status = 'tox'; actor.toxicCounter = 14;
		assert.equal(g.score('recover').score, 60);
		const { selfActionOutcome } = require('../../../dist/server/npc/ai/cfru/util/turn-outcome');
		assert(selfActionOutcome(actor, buildAIMove({ id: 'rest' }, 1, g.format), g.state.field, 0, 0).endHp > 0);
		actor.toxicCounter = 7;
		const e = new HardEvaluation(g.state, g.format), predictions = new Map([[foe, [{ move: null, weight: 1 }]]]);
		const score = e.scoreMoves(actor, [buildAIMove({ id: 'recover' }, 1, g.format)], foe, predictions)[0];
		assert(score.score >= 115);
		assert(e.switchReason(actor, score, { pokemon: g.state.self.reserve[0], score: 1, safe: true }, predictions, true)
			.includes('residual'));
	});

	for (const mode of ['doubles', 'multi']) {
		it(`${mode}: recovery survival includes both opponents, without averaging away their joint hit`, () => {
			const g = fixture(mode, { ...passive, moves: ['recover'] });
			const actor = g.state.self.active[0];
			actor.hp = Math.floor(actor.maxHp * 0.4); actor.hpPercent = 40;
			actor.baseStats.spe = 1;
			const e = new HardEvaluation(g.state, g.format);
			const attack = buildAIMove({ id: 'tackle' }, 1, g.format);
			// Isolate branch composition from damage estimation: each hit is individually survivable.
			e.damage = () => ({ average: actor.hp * 0.6, min: actor.hp * 0.6, max: actor.hp * 0.6 });
			const predictions = new Map(g.state.opponent.active.map(foe => [foe, [{ move: attack, weight: 1 }]]));
			const score = e.scoreMoves(actor, [buildAIMove({ id: 'recover' }, 1, g.format)],
				g.state.opponent.active[0], predictions)[0];
			assert(score.score <= 60);
			assert(!has(score, 'Healing prevents KO'));
		});
	}
});
