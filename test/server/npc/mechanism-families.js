'use strict';

const assert = require('assert').strict;
const { Battle, Dex } = require('../../../dist/sim');
const { buildAIMove, buildPokemonFromRequest, buildBattleStateFromRequests } = require('../../../dist/server/npc/ai/cfru/state-builder');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { DEFAULT_AI_CONFIG, createAICache } = require('../../../dist/server/npc/ai/cfru/types');
const { ScoringEngine } = require('../../../dist/server/npc/ai/cfru/scoring');
const { resolveMove } = require('../../../dist/server/npc/ai/cfru/util/type-calc');
const { calculateDamage, getSecondaryEffectDamage, willFaintFromSecondaryDamage, getEffectiveHpAfterSecondary, canKnockOutWithSecondary } = require('../../../dist/server/npc/ai/cfru/util/damage-calc');
const { NormalAI } = require('../../../dist/server/npc/ai/normal');

let games = [];
const passive = { species: 'Mew', ability: 'Synchronize', moves: ['splash'] };
function game({ format = 'gen9customgame', mode = 'singles', actor = passive, foe = passive, ally = passive, reserve = [], allyReserve = [] } = {}) {
	const multi = mode === 'multi';
	const b = new Battle({ format: { ...Dex.formats.get(format), gameType: mode, playerCount: multi ? 4 : 2 }, seed: [1, 2, 3, 4],
		p1: { name: 'Foe', team: mode === 'doubles' ? [foe, passive] : [foe] }, p2: { name: 'Actor', team: [actor, ...(mode === 'doubles' ? [ally] : []), ...reserve] },
		...(multi ? { p3: { name: 'Foe2', team: [passive] }, p4: { name: 'Ally', team: [ally, ...allyReserve] } } : {}) });
	if (b.requestState === 'teampreview')b.makeChoices();
	games.push(b);
	const config = { ...DEFAULT_AI_CONFIG, formatId: format, isDoubles: mode !== 'singles' };
	const state = () => {
		const t = createBattleTracker('p2', multi); t.setFormat(format); t.parseMessage(b.log.join('\n'));
		return buildBattleStateFromRequests((multi ? ['p2', 'p4'] : ['p2']).map(side => ({ side, request: JSON.parse(JSON.stringify(b[side].activeRequest)) })), t, config, b.turn);
	};
	const score = (id, s = state(), target = s.opponent.active[0]) => new ScoringEngine(config, createAICache(b.turn)).scoreMove(s, s.self.active[0], buildAIMove({ id }, 1, format), target);
	const play = (choice = 'move 1') => b.makeChoices(...(multi ? ['move 1', choice, 'move 1', 'move 1'] : mode === 'doubles' ? ['move 1, move 1', choice + ', move 1'] : ['move 1', choice]));
	return { b, format, state, score, play };
}

function engineMove(g, id) {
	const move = g.b.dex.getActiveMove(id);
	move.willCrit = false;
	if (move.onModifyType) move.onModifyType.call(g.b, move, g.b.p2.active[0], g.b.p1.active[0]);
	if (move.onModifyMove) move.onModifyMove.call(g.b, move, g.b.p2.active[0], g.b.p1.active[0]);
	return move;
}
function oracle(g, id, tolerance = 0) {
	g.b.makeRequest('move');
	const s = g.state();
	// Test oracle uses authorized snapshots for both sides to isolate mechanisms from preset estimation.
	const target = buildPokemonFromRequest(g.b.p1.activeRequest.side.pokemon[0], 1, true, g.format);
	target.boosts = { ...g.b.p1.active[0].boosts };
	const ai = calculateDamage(s.self.active[0], target, buildAIMove({ id }, 1, g.format), s.field).max;
	g.b.randomizer = x => x;
	const engine = g.b.actions.getDamage(g.b.p2.active[0], g.b.p1.active[0], engineMove(g, id));
	assert(Math.abs(ai - engine) <= tolerance, `${id}: estimated ${ai}, engine ${engine}`);
	return ai;
}

describe('NPC shared mechanism families', () => {
	afterEach(() => { for (const b of games) b.destroy(); games = []; });
	for (const mode of ['singles', 'doubles', 'multi']) {
		it(`${mode}: only rewards Focus Punch behind a substitute or against a sleeping target`, () => {
			const g = game({ mode, actor: { species: 'Breloom', ability: 'Poison Heal', moves: ['focuspunch', 'spore', 'substitute'] },
				foe: { species: 'Tauros', ability: 'Intimidate', moves: ['earthquake'] } });
			let s = g.state();
			s.opponent.active[0].hp = 1;
			s.opponent.active[0].hpPercent = 1;
			s.opponent.active[0].lastMove = 'Earthquake';
			const result = g.score('focuspunch', s);
			assert(result.flags.canKO, 'The test must cover a tempting KO reward');
			assert.equal(result.score, 60);
			assert.equal(result.breakdown.positives, 0);
			if (mode !== 'singles') {
				s.opponent.active[1].status = 'slp';
				assert.equal(g.score('focuspunch', s).score, 60, 'An unrelated sleeping foe does not protect this attack');
			}
			g.b.p1.active[0].setStatus('slp');
			g.b.makeRequest('move');
			s = g.state();
			assert(g.score('focuspunch', s).score > 60, 'Public sleep permits normal scoring');
			g.b.p1.active[0].cureStatus();
			g.b.p2.active[0].addVolatile('substitute');
			g.b.makeRequest('move');
			assert(g.score('focuspunch').score > 60, 'Our substitute permits normal scoring');
		});
		for (const format of ['gen5customgame', 'gen5pokemmorandombattle', 'gen9customgame']) {
			it(`${mode}, ${format}: validates Psycho Shift using the user's actual status`, () => {
				const g = game({ mode, format, actor: { species: 'Sigilyph', ability: 'Magic Guard', moves: ['psychoshift'] },
					foe: { species: 'Scizor', ability: 'Technician', moves: ['splash'] } });
				assert.equal(g.score('psychoshift').score, 0, 'No status to transfer');
				g.b.p2.active[0].setStatus('brn');
				g.b.p1.active[0].setStatus('frz');
				g.b.makeRequest('move');
				const blocked = g.score('psychoshift');
				assert.equal(blocked.score, 0, 'An existing target status blocks transfer');
				assert(blocked.flags.hasNoEffect);
				const useShift = () => {
					const move = g.b.dex.getActiveMove('psychoshift');
					move.accuracy = true; // Isolate status rules from the Gen 5 accuracy roll.
					g.b.actions.useMove(move, g.b.p2.active[0], { target: g.b.p1.active[0] });
				};
				useShift();
				assert(g.b.log.some(line => line.startsWith('|-fail|p2')));
				assert.equal(g.b.p2.active[0].status, 'brn');
				g.b.p1.active[0].cureStatus();
				g.b.makeRequest('move');
				assert(g.score('psychoshift').score > 60, 'A valid transfer remains usable');
				useShift();
				assert.equal(g.b.p1.active[0].status, 'brn');
				assert.equal(g.b.p2.active[0].status, '');
				g.b.p1.active[0].cureStatus();
				g.b.p2.active[0].setStatus('tox');
				g.b.makeRequest('move');
				assert.equal(g.score('psychoshift').score, 0, 'Steel immunity blocks transferred poison');
				useShift();
				assert.equal(g.b.p1.active[0].status, '');
				assert.equal(g.b.p2.active[0].status, 'tox');
			});
		}
		it(`${mode}: discourages Coil when Unaware ignores every useful boost`, () => {
			const g = game({ mode, actor: { species: 'Dunsparce', ability: 'Serene Grace', moves: ['coil', 'bodyslam', 'earthquake', 'roost'] } });
			const s = g.state();
			for (const foe of s.opponent.active) foe.ability = 'Unaware';
			for (const id of ['coil', 'honeclaws', 'doubleteam']) {
				const result = g.score(id, s);
				assert.equal(result.score, 60, id);
				assert.equal(result.breakdown.positives, 0, id);
			}
			assert(g.score('dragondance', s).score > 60, 'Speed still has value against Unaware');
			s.self.active[0].ability = 'Mold Breaker';
			assert(g.score('coil', s).score > 60, 'Mold Breaker bypasses Unaware');
			s.self.active[0].ability = 'Serene Grace';
			s.self.active[0].moves.push('storedpower');
			assert(g.score('coil', s).score > 60, 'Stored Power still benefits from the boost count');
			s.self.active[0].moves.pop();
			if (mode !== 'singles') {
				s.opponent.active[1].ability = 'Synchronize';
				assert(g.score('coil', s).score > 60, 'Boosts can still help against the other foe');
			}
		});
		it(`${mode}: records Magic Bounce from a reflected move and suppresses its tactical rewards`, () => {
			const g = game({ mode, actor: { species: 'Whimsicott', ability: 'Prankster', moves: ['leechseed', 'encore', 'taunt', 'hurricane'] },
				foe: { species: 'Xatu', ability: 'Magic Bounce', moves: ['toxic', 'splash'] } });
			const choice = mode === 'singles' ? 'move 1' : 'move 1 1';
			g.b.makeChoices(...(mode === 'multi' ? [choice, choice, 'move 1', 'move 1'] :
				mode === 'doubles' ? [choice + ', move 1', choice + ', move 1'] : [choice, choice]));
			assert(g.b.log.some(line => line.startsWith('|move|p1a: Xatu|Leech Seed|') && line.includes('[from] ability: Magic Bounce')));
			const s = g.state(), target = s.opponent.active[0];
			assert.equal(target.ability, 'Magic Bounce');
			assert.equal(target.lastMove.toLowerCase(), 'toxic');
			assert(!target.moves.includes('leechseed'), 'Reflected moves are not revealed moveset slots');
			for (const id of ['encore', 'leechseed', 'taunt']) {
				const result = g.score(id, s);
				assert(result.score <= 60, `${id}: ${result.score}`);
				assert.equal(result.breakdown.positives, 0, id);
				assert(result.breakdown.details.some(detail => detail.reason.includes('Magic Bounce')));
			}
			assert(g.score('hurricane', s).score > 60, 'Ordinary attacks are unaffected');
			s.self.active[0].ability = 'Mold Breaker';
			assert(g.score('encore', s).score > 60, 'Mold Breaker allows Encore through');
		});
		it(`${mode}: resolves Shell Side Arm against the target's defenses`, () => {
			const g = game({ mode, actor: { species: 'Slowbro-Galar', ability: 'Quick Draw', nature: 'Adamant', evs: { atk: 252 }, moves: ['shellsidearm'] }, foe: { species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] } });
			const s = g.state();
			const target = buildPokemonFromRequest(g.b.p1.activeRequest.side.pokemon[0], 1, true, g.format);
			const ai = resolveMove(s.self.active[0], buildAIMove({ id: 'shellsidearm' }, 1), s.field, target);
			const engine = engineMove(g, 'shellsidearm');
			assert.equal(ai.category, engine.category);
			assert.equal(ai.flags.contact, engine.flags.contact);
			assert.equal(g.score('shellsidearm', s, target).move.category, 'Physical');
		});
		it(`${mode}: records public Tera types without revealing an unused Tera type`, () => {
			const g = game({ mode, actor: { ...passive, teraType: 'Fire', moves: ['terablast'] } });
			assert.equal(g.state().self.active[0].terastallized, undefined);
			g.b.actions.terastallize(g.b.p2.active[0]);
			const s = g.state(), actor = s.self.active[0];
			assert.deepEqual(actor.types, g.b.p2.active[0].getTypes());
			assert.equal(resolveMove(actor, buildAIMove({ id: 'terablast' }, 1), s.field).type, engineMove(g, 'terablast').type);
		});
		for (const id of ['steelroller', 'lastresort', 'swallow', 'gearup', 'magneticflux']) {
			it(`${mode}: rejects ${id} when its prerequisite is absent`, () => {
				const g = game({ mode, actor: { ...passive, moves: [id, 'tackle'] } });
				assert.equal(g.score(id).score, 0);
				g.play(['steelroller', 'lastresort'].includes(id) && mode !== 'singles' ? 'move 1 1' : 'move 1');
				assert(g.b.log.some(line => line.startsWith('|-fail|p2')));
			});
		}
		it(`${mode}: tracks trapping damage and its public end`, () => {
			const g = game({ mode, foe: { ...passive, moves: ['wrap'] } });
			const p = g.b.p2.active[0];
			p.addVolatile('partiallytrapped', g.b.p1.active[0], g.b.dex.moves.get('wrap'));
			let s = g.state();
			assert(s.self.active[0].volatiles.has('partiallytrapped'));
			assert(getSecondaryEffectDamage(s.self.active[0], '', '', s.field) > 0);
			p.removeVolatile('partiallytrapped');
			s = g.state();
			assert(!s.self.active[0].volatiles.has('partiallytrapped'));
		});
	}
	for (const mode of ['doubles', 'multi']) {
		it(`${mode}: Damp on a known ally blocks damage and scoring`, () => {
			const g = game({ mode, actor: { ...passive, moves: ['explosion'] }, ally: { species: 'Golduck', ability: 'Damp', moves: ['splash'] } });
			const s = g.state();
			assert.equal(g.score('explosion', s).score, 0);
			assert.equal(calculateDamage(s.self.active[0], s.opponent.active[0], buildAIMove({ id: 'explosion' }, 1), s.field, undefined, { activePokemon: [...s.self.active, ...s.opponent.active] }).max, 0);
			g.play();
			assert(g.b.log.some(line => line.includes('ability: Damp')));
		});
		it(`${mode}: Coaching cannot boost a capped partner`, () => {
			const g = game({ mode, actor: { ...passive, moves: ['coaching'] } });
			const ally = mode === 'multi' ? g.b.p4.active[0] : g.b.p2.active[1];
			assert(g.score('coaching').score > 0);
			g.b.boost({ atk: 6, def: 6 }, ally);
			assert.equal(g.score('coaching').score, 0);
		});
	}
	for (const id of ['batonpass', 'shedtail']) {
		it(`Multi ${id} requires this owner's reserve`, () => {
			const g = game({ mode: 'multi', actor: { ...passive, moves: [id] }, allyReserve: [passive] });
			assert.equal(g.score(id).score, 0);
			const own = game({ mode: 'multi', actor: { ...passive, moves: [id] }, reserve: [passive] });
			assert(own.score(id).score > 0);
		});
	}
	for (const id of ['roar', 'whirlwind']) {
		it(`${id} cannot phaze a party with no reserve`, () => {
			const g = game({ mode: 'multi', actor: { ...passive, moves: [id] } });
			assert.equal(g.score(id).score, 0);
			g.play('move 1 1');
			assert(g.b.log.some(line => line.startsWith('|-fail|p2')));
		});
	}
	for (const id of ['healpulse', 'floralhealing', 'decorate', 'acupressure']) {
		it(`Normal chooses an allied recipient for ${id}`, () => {
			const g = game({ mode: 'doubles', actor: { ...passive, moves: [id] }, foe: { species: 'Umbreon', ability: 'Synchronize', moves: ['splash'] } });
			const ally = g.b.p2.active[1];
			ally.hp = Math.floor(ally.maxhp / 4);
			g.b.add('-damage', ally, ally.getHealth);
			g.b.makeRequest('move');
			const stream = { push() {}, write() {} };
			const ai = new NormalAI(stream, { seed: [1, 2, 3, 4] });
			ai.setBattle({ stream, format: 'gen9doublescustomgame' });
			let choice;
			ai.choose = c => { choice = c; };
			stream.push(g.b.log.join('\n'));
			ai.receiveRequest(JSON.parse(JSON.stringify(g.b.p2.activeRequest)));
			assert(/^move 1 -[12],/.test(choice), choice);
			g.b.makeChoices('move 1, move 1', choice);
			const boosts = g.b.log.filter(line => line.startsWith('|-boost|p1'));
			assert.equal(boosts.length, 0);
		});
	}
	for (const id of ['lifedew', 'junglehealing', 'lunarblessing']) {
		it(`${id} values the actual injured or statused recipients`, () => {
			const g = game({ mode: 'doubles', actor: { ...passive, moves: [id] } });
			assert.equal(g.score(id).score, 60);
			const ally = g.b.p2.active[1];
			ally.hp = Math.floor(ally.maxhp / 4);
			g.b.makeRequest('move');
			assert(g.score(id).score > 100);
			if (id !== 'lifedew') {
				ally.hp = ally.maxhp;
				ally.setStatus('brn');
				g.b.makeRequest('move');
				assert(g.score(id).score > 100);
			}
		});
	}
	for (const [id, terrain] of [['terrainpulse', 'electricterrain'], ['risingvoltage', 'electricterrain'], ['expandingforce', 'psychicterrain'], ['psyblade', 'electricterrain']]) {
		it(`${id} matches PS before and after its terrain condition`, () => {
			const g = game({ actor: { ...passive, moves: [id] } });
			const before = oracle(g, id);
			g.b.field.setTerrain(terrain, g.b.p2.active[0]);
			assert(oracle(g, id) > before);
			const s = g.state();
			assert.equal(resolveMove(s.self.active[0], buildAIMove({ id }, 1), s.field).target, engineMove(g, id).target);
		});
	}
	for (const format of ['gen5customgame', 'gen5pokemmorandombattle', 'gen9customgame']) {
		for (const id of ['hex', 'facade']) {
			it(`${format}: ${id} matches the format's status damage rule`, () => {
				const g = game({ format, actor: { ...passive, moves: [id] } });
				oracle(g, id);
				(id === 'hex' ? g.b.p1.active[0] : g.b.p2.active[0]).setStatus('brn');
				oracle(g, id);
			});
		}
		it(`${format}: trapping uses the format's damage fraction`, () => {
			const g = game({ format, actor: { species: 'Blissey', ability: 'Natural Cure', moves: ['protect'] } });
			const p = g.b.p2.active[0];
			p.addVolatile('partiallytrapped', g.b.p1.active[0], g.b.dex.moves.get('wrap'));
			const s = g.state(), hp = p.hp;
			const predicted = getSecondaryEffectDamage(s.self.active[0], '', '', s.field);
			g.play();
			assert.equal(predicted, hp - p.hp);
		});
	}
	it('tracks Stockpile layers, caps, Spit Up damage and consumption', () => {
		const g = game({ actor: { ...passive, moves: ['stockpile', 'spitup', 'swallow'] } });
		g.play();
		assert(oracle(g, 'spitup') > 0);
		g.play(); g.play();
		assert.deepEqual([...g.state().self.active[0].volatiles], ['stockpile3']);
		assert.equal(g.score('stockpile').score, 0);
		g.play('move 2');
		assert(!g.state().self.active[0].volatiles.has('stockpile3'));
		assert.equal(g.score('spitup').score, 0);
	});
	it('records Last Resort move use for this stay and resets on switching', () => {
		const g = game({ actor: { ...passive, moves: ['lastresort', 'splash'] }, reserve: [{ species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] }] });
		assert.equal(g.score('lastresort').score, 0);
		g.play('move 2');
		assert(g.score('lastresort').score > 0);
		g.play('switch 2'); g.play('switch 2');
		assert.equal(g.score('lastresort').score, 0);
	});
	it('Last Respects uses public faint events for the owner, not its Multi partner', () => {
		const g = game({ mode: 'multi', actor: { ...passive, moves: ['lastrespects'] }, reserve: [{ species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] }] });
		const victim = g.b.p2.pokemon[1];
		victim.faint(); g.b.faintMessages();
		assert.equal(g.state().self.active[0].faintedAllies, 1);
		assert.equal(g.state().self.active[1].faintedAllies, 0);
		oracle(g, 'lastrespects');
	});
	for (const item of ['Black Sludge', 'Sticky Barb', 'Leftovers']) {
		it(`residual survival includes ${item}`, () => {
			const g = game({ actor: { ...passive, item, moves: ['protect'] } });
			const p = g.b.p2.active[0]; p.hp = 1; g.b.makeRequest('move');
			const s = g.state();
			const lethal = willFaintFromSecondaryDamage(s.self.active[0], '', '', s.field);
			g.play();
			assert.equal(lethal, p.fainted);
			assert.equal(lethal, item !== 'Leftovers');
		});
	}
	it('weather can KO before Leftovers, but Leftovers can precede poison', () => {
		const g = game({ actor: { ...passive, item: 'Leftovers', moves: ['protect'] } });
		const p = g.b.p2.active[0]; p.hp = Math.floor(p.maxhp / 16) + 1;
		p.setStatus('psn'); g.b.makeRequest('move');
		let s = g.state();
		assert.equal(willFaintFromSecondaryDamage(s.self.active[0], '', '', s.field), false);
		g.play(); assert(!p.fainted);
		p.cureStatus(); p.hp = 1;
		g.b.field.setWeather('sandstorm', g.b.p1.active[0]); g.b.makeRequest('move');
		s = g.state();
		assert(willFaintFromSecondaryDamage(s.self.active[0], s.field.weather, '', s.field));
		assert.equal(g.score('protect', s).score, 60);
		g.play(); assert(p.fainted);
	});
	it('preserves original STAB, public Tera types and Stellar consumption across switches', () => {
		const g = game({ actor: { ...passive, teraType: 'Stellar', moves: ['psychic'] },
			reserve: [{ species: 'Chansey', ability: 'Natural Cure', moves: ['splash'] }] });
		g.b.actions.terastallize(g.b.p2.active[0]);
		let s = g.state();
		assert.deepEqual(s.self.active[0].stellarBoostedTypes, []);
		g.play();
		s = g.state();
		assert.deepEqual(s.self.active[0].stellarBoostedTypes, g.b.p2.active[0].stellarBoostedTypes);
		assert.deepEqual(s.self.active[0].stellarBoostedTypes, ['Psychic']);
		g.play('switch 2'); g.play('switch 2');
		s = g.state();
		assert.equal(s.self.active[0].terastallized, 'Stellar');
		assert.deepEqual(s.self.active[0].stellarBoostedTypes, ['Psychic']);
		oracle(g, 'psychic');
	});
	for (const tera of ['Psychic', 'Fire']) {
		it(`matches both original and new STAB after Tera ${tera}`, () => {
			const g = game({ actor: { ...passive, teraType: tera, moves: ['psychic', 'terablast'] } });
			g.b.actions.terastallize(g.b.p2.active[0]);
			oracle(g, 'psychic'); oracle(g, 'terablast');
		});
	}
	it('resolves Terapagos Stellar move type, category and spread target', () => {
		const g = game({ actor: { species: 'Terapagos', ability: 'Tera Shift', teraType: 'Stellar', moves: ['terastarstorm'] } });
		g.b.actions.terastallize(g.b.p2.active[0]);
		const s = g.state(), ai = resolveMove(s.self.active[0], buildAIMove({ id: 'terastarstorm' }, 1), s.field);
		const engine = engineMove(g, 'terastarstorm');
		assert.equal(ai.type, engine.type);
		assert.equal(ai.category, engine.category);
		assert.equal(ai.target, engine.target);
		oracle(g, 'terastarstorm', 1); // Fixed-point Stellar rounding may differ by one HP.
	});
	it('shares ordered residual HP between survival and damage-plus-residual KO estimates', () => {
		const g = game({ actor: { ...passive, moves: ['seismictoss'] },
			foe: { ...passive, item: 'Leftovers' } });
		const p = g.b.p1.active[0];
		p.hp = 101; p.setStatus('brn'); g.b.makeRequest('move');
		const s = g.state();
		const target = buildPokemonFromRequest(g.b.p1.activeRequest.side.pokemon[0], 1, true, g.format);
		assert.equal(canKnockOutWithSecondary(s.self.active[0], target,
			buildAIMove({ id: 'seismictoss' }, 1), s.field), false);
		p.hp = 1; g.b.makeRequest('move');
		const low = buildPokemonFromRequest(g.b.p1.activeRequest.side.pokemon[0], 1, true, g.format);
		const expected = getEffectiveHpAfterSecondary(low, '', '', s.field);
		assert.equal(expected, 1, 'Leftovers precedes burn, with equal 1/16 amounts');
		g.play('move 1');
		assert.equal(getEffectiveHpAfterSecondary({ ...low, hp: 0 }, '', '', s.field), 0,
			'An immediate KO cannot be healed by later residual recovery');
	});
});
