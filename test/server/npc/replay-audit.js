'use strict';

const assert = require('assert').strict;
const { Battle, Teams } = require('../../../dist/sim');
const { createBattleTracker } = require('../../../dist/server/npc/ai/cfru/util/battle-tracker');
const { collectFrames, evaluateFrame, publicLine, observedTurn, OwnRequest, conditionOnObservedTera, summarize } = require('../../npc/replay-audit');

const team = [
	{ species: 'Mew', ability: 'Synchronize', item: 'Choice Specs', moves: ['psychic', 'uturn', 'protect', 'recover'], teraType: 'Water' },
	{ species: 'Ho-Oh', ability: 'Regenerator', moves: ['sacredfire', 'recover'] },
	{ species: 'Snorlax', ability: 'Immunity', moves: ['bodyslam'] },
	{ species: 'Blissey', ability: 'Natural Cure', moves: ['softboiled'] },
	{ species: 'Pikachu', ability: 'Static', moves: ['thunderbolt'] },
	{ species: 'Vaporeon', ability: 'Water Absorb', moves: ['surf'] },
];
const text = Teams.export(team);
function html(lines) {
	return `<script type="text/plain" class="battle-log-data">${[
		'|gen|9', '|gametype|singles', '|tier|[Gen 9] Random Battle', ...lines,
	].join('\n')}</script>`;
}
const opening = ['|switch|p1a: Foe|Snorlax, L100|461/461', '|switch|p2a: Mew|Mew, L100|341/341', '|turn|1'];

describe('NPC offline expert replay comparison', () => {
	it('masks opposing exact HP while retaining controlled-team HP', () => {
		assert.equal(publicLine('|-damage|p1a: Foe|128/268 par'), '|-damage|p1a: Foe|48/100 par');
		assert.equal(publicLine('|switch|p1a: Foe|Snorlax|460/461'), '|switch|p1a: Foe|Snorlax|100/100');
		assert.equal(publicLine('|-heal|p2a: Mew|230/341'), '|-heal|p2a: Mew|230/341');
	});

	it('freezes decisions before either player acts, without leaking switches, revealed moves or future Tera', () => {
		const first = collectFrames(html([...opening,
			'|switch|p1a: Next|Gengar, L100|261/261', '|move|p2a: Mew|Psychic|p1a: Next', '|upkeep',
		]), text)[0];
		const changed = collectFrames(html([...opening,
			'|-terastallize|p1a: Foe|Dark', '|move|p2a: Mew|Psychic|p1a: Foe',
			'|move|p1a: Foe|Earthquake|p2a: Mew', '|upkeep',
		]), text)[0];
		assert.deepEqual(first.request, changed.request);
		assert.deepEqual(first.protocol, changed.protocol);
		for (const difficulty of ['normal', 'hard']) {
			const a = evaluateFrame(first, difficulty), b = evaluateFrame(changed, difficulty);
			assert.deepEqual(a.scores, b.scores);
			assert.deepEqual(a.selected, b.selected);
			assert.equal(a.foe, 'Snorlax');
			assert.deepEqual(a.state.opponent.active[0].moveKnowledge.revealedMoves, []);
			assert.equal(a.state.opponent.reserve.length, 0);
			assert(!a.state.opponent.active[0].terastallized);
		}
	});

	it('reconstructs percent-only own HP as an interval without replacing simulator maximum HP', () => {
		const frames = collectFrames(html([
			'|switch|p1a: Foe|Snorlax, L100|100/100', '|switch|p2a: Mew|Mew, L100|100/100', '|turn|1',
			'|-damage|p2a: Mew|54/100', '|upkeep', '|turn|2',
			'|move|p2a: Mew|Psychic|p1a: Foe', '|upkeep',
		]), text);
		assert.equal(frames[0].request.side.pokemon[0].condition, '341/341');
		assert.deepEqual(frames[1].hpRanges[0], { ident: 'p2: Mew', min: 181, max: 184 });
		assert.equal(frames[1].request.side.pokemon[0].condition, '182/341');
		for (let hp = 181; hp <= 184; hp++) assert.equal(Math.ceil(hp / 341 * 100), 54);
		assert.deepEqual(frames[1].issues, []);
	});

	it('separates stay/switch agreement from replacement identity and excludes unknown choices', () => {
		const rows = [
			{ comparable: true, observed: { type: 'move' }, selected: { type: 'move' }, exact: false },
			{ comparable: true, observed: { type: 'switch' }, selected: { type: 'switch' }, exact: false },
			{ comparable: true, observed: { type: 'switch' }, selected: { type: 'switch' }, exact: true },
			{ comparable: true, observed: { type: 'switch' }, selected: { type: 'move' }, exact: false },
			{ comparable: true, observed: { type: 'move' }, selected: { type: 'switch' }, exact: false },
			{ comparable: false, observed: { type: 'unknown' }, selected: { type: 'move' }, exact: false },
		];
		assert.deepEqual(summarize(rows).staySwitch, {
			bothStay: 1, bothSwitch: 2, aiStaysExpertSwitches: 1, aiSwitchesExpertStays: 1, sameSwitchTarget: 1,
		});
	});

	it('restores hard switching cooldown from past voluntary switches only', () => {
		const frames = collectFrames(html([...opening,
			'|switch|p2a: Ho-Oh|Ho-Oh, L100|353/353', '|upkeep', '|turn|2',
			'|move|p2a: Ho-Oh|Sacred Fire|p1a: Foe', '|upkeep',
		]), text);
		assert.equal(frames[0].lastSwitchTurn, undefined);
		assert.equal(frames[1].lastSwitchTurn, 1);
		const result = evaluateFrame(frames[1], 'hard');
		assert.equal(result.difficulty, 'hard');
		assert(result.scores.length);
		assert(result.switchScores.length);
	});

	it('keeps hidden selections unknown when paralysis, fainting or forfeiting prevents a move event', () => {
		for (const [event, reason] of [
			['|cant|p2a: Mew|par', 'cant: par'],
			['|faint|p2a: Mew', 'Fainted before its chosen move was revealed'],
			['|win|Opponent', 'No choice revealed before the turn or battle ended'],
		]) {
			assert.deepEqual(observedTurn(['|turn|1', event], 0), { type: 'unknown', reason });
		}
	});

	it('restores historical evidence for Hard without leaking the current turn outcome', () => {
		const past = [...opening, '|move|p1a: Foe|Body Slam|p2a: Mew', '|-damage|p2a: Mew|270/341',
			'|move|p2a: Mew|Psychic|p1a: Foe', '|-damage|p1a: Foe|390/461', '|upkeep', '|turn|2'];
		const a = collectFrames(html([...past, '|move|p2a: Mew|Psychic|p1a: Foe', '|upkeep']), text)[1];
		const b = collectFrames(html([...past, '|switch|p1a: Next|Gengar, L100|261/261',
			'|move|p2a: Mew|Psychic|p1a: Next', '|upkeep']), text)[1];
		assert(a.evidence.some(e => e.kind === 'damage'));
		assert.deepEqual(a.evidence, b.evidence);
		const result = evaluateFrame(a, 'hard');
		assert.deepEqual(result.state.opponentEvidence, a.evidence);
		assert.deepEqual(result.scores, evaluateFrame(b, 'hard').scores);
	});

	it('uses simulator stats, PP and Choice lock for requests, including bench Regenerator healing', () => {
		const own = new OwnRequest(text), tracker = createBattleTracker('p2');
		tracker.setFormat('gen9randombattle');
		const battle = new Battle({ formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Foe', team: [{ species: 'Snorlax', ability: 'Immunity', moves: ['splash'] }] },
			p2: { name: 'Controlled', team } });
		let cursor = 0;
		const sync = () => {
			for (const line of battle.log.slice(cursor)) { own.consume(line, tracker); tracker.parseMessage(publicLine(line)); }
			cursor = battle.log.length;
		};
		try {
			if (battle.requestState === 'teampreview') battle.makeChoices();
			sync();
			assert.deepEqual(own.request(tracker).side.pokemon[0].stats, battle.p2.activeRequest.side.pokemon[0].stats);
			battle.makeChoices('move 1', 'move 1'); sync();
			const actual = battle.p2.activeRequest.active[0].moves;
			assert.deepEqual(own.request(tracker).active[0].moves.map(m => [m.id, m.pp, !!m.disabled]),
				actual.map(m => [m.id, m.pp, !!m.disabled]));
			battle.makeChoices('move 1', 'switch 2'); sync();
			battle.damage(100, battle.p2.active[0]); sync();
			battle.makeChoices('move 1', 'switch 2'); sync();
			const request = own.request(tracker);
			assert.equal(request.side.pokemon[1].condition, battle.p2.activeRequest.side.pokemon[1].condition);
			assert(request.active[0].moves.filter(m => !m.disabled).length > 1, 'Choice lock resets on switching');
		} finally { own.destroy(); battle.destroy(); }
	});

	it('separates pivot and forced replacement requests from turn choices', () => {
		const frames = collectFrames(html([...opening,
			'|move|p2a: Mew|U-turn|p1a: Foe', '|switch|p2a: Ho-Oh|Ho-Oh, L100|353/353|[from] U-turn',
			'|-damage|p2a: Ho-Oh|0 fnt', '|faint|p2a: Ho-Oh', '|upkeep',
			'|switch|p2a: Snorlax|Snorlax, L100|461/461', '|turn|2', '|win|Controlled',
		]), text);
		assert.deepEqual(frames.map(f => f.phase), ['turn', 'pivot', 'replacement', 'turn']);
		assert.equal(frames[0].observed.id, 'uturn');
		assert.equal(frames[1].request.side.pokemon[0].ident, 'p2: Mew');
		assert.equal(frames[2].request.side.pokemon[0].ident, 'p2: Ho-Oh');
		assert(frames[1].request.forceSwitch[0]);
		assert(!frames[1].protocol.some(line => line.includes('|switch|p2a: Ho-Oh')));
	});

	it('keeps the baseline pre-Tera and exposes a separately labelled conditioned diagnostic', () => {
		const frame = collectFrames(html([...opening,
			'|-terastallize|p2a: Mew|Water', '|move|p2a: Mew|Psychic|p1a: Foe', '|upkeep',
		]), text)[0];
		assert.equal(frame.observed.tera, 'Water');
		assert(!frame.protocol.some(line => line.includes('-terastallize')));
		assert.equal(frame.request.side.pokemon[0].terastallized, '');
		const before = evaluateFrame(frame);
		assert.equal(before.fullChoiceExact, false, 'Normal does not choose Tera');
		assert(conditionOnObservedTera(frame));
		assert.deepEqual(before.scores, evaluateFrame(frame).scores, 'Diagnostic must not mutate baseline');
	});

	it('excludes decisions after unsupported request-changing events instead of silently fabricating requests', () => {
		const frames = collectFrames(html([...opening,
			'|-start|p2a: Mew|Torment', '|upkeep', '|turn|2', '|move|p2a: Mew|Psychic|p1a: Foe', '|upkeep',
		]), text);
		const result = evaluateFrame(frames[1]);
		assert.equal(result.comparable, false);
		assert(result.issues.some(issue => issue.includes('Torment')));
	});
});
