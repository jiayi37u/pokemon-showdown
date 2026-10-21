'use strict';

// Offline comparison against observed choices. No battle RNG is replayed and no scoring rules are copied.
const fs = require('fs');
const path = require('path');
const { Battle, Dex, Teams, toID } = require('../../dist/sim');
const { NormalAI } = require('../../dist/server/npc/ai/normal');
const { HardAI } = require('../../dist/server/npc/ai/hard');
const { HardEvaluation } = require('../../dist/server/npc/ai/hard/evaluation');
const { hardMove } = require('../../dist/server/npc/ai/hard/opponent-model');
const { buildPokemonFromRequest, buildBattleStateWithTracker } = require('../../dist/server/npc/ai/cfru/state-builder');
const { DEFAULT_AI_CONFIG } = require('../../dist/server/npc/ai/cfru/types');
const { moveTargets } = require('../../dist/server/npc/ai/cfru/util/move-effects');
const { createBattleTracker } = require('../../dist/server/npc/ai/cfru/util/battle-tracker');
const FORMAT = 'gen9randombattle';

function readProtocol(html) {
	const embedded = html.match(/<script\b[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/);
	if (!embedded) throw new Error('Missing embedded battle protocol');
	const lines = embedded[1].replace(/\\\//g, '/').split(/\r?\n/).filter(line => line.startsWith('|'));
	if (!lines.includes('|gen|9') || !lines.includes('|gametype|singles') || !lines.includes('|tier|[Gen 9] Random Battle')) {
		throw new Error('This importer supports Gen 9 Random Battle singles only');
	}
	return lines;
}

// These exports contain exact opposing HP. Give the AI only the usual public percentage.
function publicLine(line) {
	const p = line.split('|');
	const index = ['switch', 'drag', 'replace'].includes(p[1]) ? 4 : ['-damage', '-heal'].includes(p[1]) ? 3 : -1;
	if (index > 0 && p[2]?.startsWith('p1')) {
		p[index] = p[index].replace(/^(\d+)\/(\d+)/, (_, hp, max) => `${Math.ceil(Number(hp) * 100 / Number(max))}/100`);
	}
	return p.join('|');
}

/** Reconstruct only the controlled team's request, using its exported set and events already seen. */
class OwnRequest {
	constructor(teamText) {
		const team = Teams.import(teamText);
		if (!team || team.length !== 6) throw new Error('Expected the controlled player\'s complete six-Pokemon team');
		// The simulator supplies initial stats and PP; this dummy foe is never passed to the AI.
		this.template = new Battle({ formatid: 'gen9customgame', seed: [1, 2, 3, 4],
			p1: { name: 'Unused', team: [{ species: 'Mew', moves: ['splash'] }] },
			p2: { name: 'Controlled', team } });
		this.party = this.template.p2.pokemon.map(p => ({
			request: { ...p.getSwitchRequestData(), active: false }, set: p.set,
			maxHp: p.maxhp, hp: p.hp, status: '', moveSlots: p.moveSlots.map(m => ({ ...m })),
			hpRange: [p.hp, p.hp],
			choiceLock: '', lastMove: '', encore: '', disabledMove: '',
		}));
		this.active = null;
		this.teraUsed = false;
		this.issues = [];
	}

	find(ident) {
		const name = ident.split(': ').slice(1).join(': ');
		return this.party.find(p => p.request.ident === `p2: ${name}`);
	}

	consume(line, tracker) {
		const p = line.split('|'), event = p[1];
		if (event === '-transform' || event === 'replace' || event === '-sethp') {
			this.issues.push(`${event} needs an additional request reconstruction adapter`);
		}
		if (event === '-start' && ['imprison', 'torment', 'healblock', 'gastroacid', 'embargo', 'powersplit', 'guardsplit', 'powertrick']
			.includes(toID(p[3].replace(/^move: /, ''))) || event === '-endability' ||
			event === '-ability' && ['arenatrap', 'shadowtag', 'magnetpull', 'neutralizinggas'].includes(toID(p[3])) ||
			event === '-activate' && /Spite|Eerie Spell|Grudge|Leppa Berry|Lunar Dance/.test(p.slice(3).join('|'))) {
			this.issues.push(`Request-affecting event needs an adapter: ${event} ${p[3]}`);
		}
		if (event === '-cureteam' && p[2]?.startsWith('p2')) {
			for (const member of this.party) if (member.hp) member.status = '';
		}
		if (!p[2]?.startsWith('p2')) return;
		const mon = this.find(p[2]);
		if (!mon) {
			if (['switch', 'drag'].includes(event)) throw new Error(`Exported team does not contain ${p[2]}`);
			return;
		}
		if (['switch', 'drag'].includes(event)) {
			if (this.active) {
				const old = this.active;
				if (old.hp > 0 && toID(old.request.ability) === 'regenerator') {
					old.hpRange = old.hpRange.map(hp => Math.min(old.maxHp, hp + Math.floor(old.maxHp / 3)));
					old.hp = Math.floor((old.hpRange[0] + old.hpRange[1]) / 2);
				}
				if (toID(old.request.ability) === 'naturalcure') old.status = '';
				old.request.active = false;
				old.choiceLock = ''; old.lastMove = '';
				old.encore = ''; old.disabledMove = '';
			}
			const slot = this.party.indexOf(mon);
			[this.party[0], this.party[slot]] = [mon, this.party[0]];
			this.active = mon;
			mon.request.active = true;
			mon.request.details = p[3];
			if (Dex.species.get(p[3].split(',')[0]).baseSpecies !== Dex.species.get(mon.set.species).baseSpecies) {
				throw new Error(`Exported team species does not match ${p[2]}: ${p[3]}`);
			}
			this.health(mon, p[4], true);
		} else if (['-damage', '-heal'].includes(event)) {
			this.health(mon, p[3]);
		} else if (event === 'faint') {
			mon.hp = 0; mon.hpRange = [0, 0]; mon.status = 'fnt';
		} else if (event === '-status') {
			mon.status = p[3];
		} else if (event === '-curestatus') {
			mon.status = '';
		} else if (event === '-item' || event === '-enditem') {
			mon.request.item = event === '-item' ? toID(p[3]) : '';
			if (!['choiceband', 'choicespecs', 'choicescarf'].includes(mon.request.item)) mon.choiceLock = '';
		} else if (event === '-ability') {
			mon.request.ability = toID(p[3]);
		} else if (event === '-terastallize') {
			mon.request.terastallized = p[3]; this.teraUsed = true;
		} else if (event === 'detailschange' || event === '-formechange') {
			const species = Dex.species.get(p[3].split(',')[0]);
			mon.request.details = `${species.name}, L${mon.set.level}${mon.set.gender ? `, ${mon.set.gender}` : ''}`;
			const stats = this.template.spreadModify(species.baseStats, mon.set);
			mon.request.stats = Object.fromEntries(Object.entries(stats).filter(([id]) => id !== 'hp'));
		} else if (event === '-start' || event === '-end') {
			const id = toID(p[3].replace(/^move: /, ''));
			if (id === 'encore') mon.encore = event === '-start' ? mon.lastMove : '';
			if (id === 'disable') mon.disabledMove = event === '-start' ? toID(p[4]) : '';
		} else if (event === 'move' && !p.some(v => v.startsWith('[from]'))) {
			const id = toID(p[3]), move = mon.moveSlots.find(m => m.id === id);
			if (!move) {
				this.issues.push(`Own move ${id} is absent from the exported set`);
				return;
			}
			const target = tracker.getActiveOpponent();
			const pressure = p[4]?.startsWith('p1') && toID(target?.ability) === 'pressure';
			move.pp = Math.max(0, move.pp - (pressure ? 2 : 1));
			mon.lastMove = id;
			if (['choiceband', 'choicespecs', 'choicescarf'].includes(mon.request.item)) mon.choiceLock ||= id;
		}
	}

	health(mon, text, entry = false) {
		const [fraction, status = ''] = text.split(' ');
		const [hp, max] = fraction.split('/').map(Number);
		if (max === 100 && max !== mon.maxHp) {
			let range = hp ? [Math.floor((hp - 1) * mon.maxHp / 100) + 1, Math.floor(hp * mon.maxHp / 100)] : [0, 0];
			if (entry) {
				const intersection = [Math.max(range[0], mon.hpRange[0]), Math.min(range[1], mon.hpRange[1])];
				if (intersection[0] <= intersection[1]) range = intersection;
			}
			mon.hpRange = range;
			mon.hp = Math.floor((range[0] + range[1]) / 2);
		} else {
			if (max && max !== mon.maxHp) this.issues.push(`HP denominator differs from exported set: ${mon.request.ident} (${max}/${mon.maxHp})`);
			mon.hp = hp; mon.hpRange = [hp, hp];
		}
		mon.status = status;
	}

	request(tracker, forced = false) {
		const request = { side: { id: 'p2', pokemon: this.party.map(p => ({
			...structuredClone(p.request), condition: `${p.hp}/${p.maxHp}${p.status ? ` ${p.status}` : ''}`,
		})) } };
		if (forced) return { ...request, forceSwitch: [true] };
		if (!this.active || !this.active.hp) throw new Error('No active Pokemon for turn request');
		const effects = tracker.getVolatiles('p2a'), mon = this.active;
		let moves = mon.moveSlots.map(m => {
			const data = Dex.moves.get(m.id);
			return { ...m, disabled: m.pp === 0 ||
				(data.category === 'Status' && (effects.has('taunt') || mon.request.item === 'assaultvest')) ||
				(effects.has('throatchop') && !!data.flags.sound) ||
				(!!mon.choiceLock && m.id !== mon.choiceLock) ||
				(!!mon.encore && m.id !== mon.encore) || m.id === mon.disabledMove };
		});
		if (effects.has('mustrecharge')) moves = [{ id: 'recharge', move: 'Recharge', pp: 1, maxpp: 1, disabled: false }];
		if (moves.every(m => m.disabled)) moves = [{ id: 'struggle', move: 'Struggle', pp: 1, maxpp: 1, disabled: false }];
		return { ...request, active: [{ moves,
			trapped: effects.has('partiallytrapped') || effects.has('trapped'),
			canTerastallize: this.teraUsed ? undefined : mon.request.teraType,
		}] };
	}

	destroy() { this.template.destroy(); }
}

function observedTurn(lines, start) {
	let tera;
	for (let i = start + 1; i < lines.length; i++) {
		const p = lines[i].split('|');
		if (['turn', 'upkeep', 'win', 'tie'].includes(p[1])) break;
		if (!p[2]?.startsWith('p2')) continue;
		if (p[1] === '-terastallize') tera = p[3];
		if (p[1] === 'switch' && !p.some(v => v.startsWith('[from]'))) return { type: 'switch', name: p[2].split(': ')[1] };
		if (p[1] === 'move' && !p.some(v => v.startsWith('[from]'))) return { type: 'move', id: toID(p[3]), name: p[3], tera };
		if (p[1] === 'cant') return { type: 'unknown', reason: `cant: ${p[3]}` };
		if (p[1] === 'faint') return { type: 'unknown', reason: 'Fainted before its chosen move was revealed' };
	}
	return { type: 'unknown', reason: 'No choice revealed before the turn or battle ended' };
}

function collectFrames(html, teamText) {
	const lines = readProtocol(html), tracker = createBattleTracker('p2'), own = new OwnRequest(teamText);
	tracker.setFormat(FORMAT);
	const frames = [], prefix = [];
	let turn = 0, upkeep = true, ownActed = false, lastSwitchTurn;
	const uncertainty = () => own.party.map(mon => ({ ident: mon.request.ident, min: mon.hpRange[0], max: mon.hpRange[1] }));
	try {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i], p = line.split('|'), event = p[1];
			if (event === 'switch' && p[2].startsWith('p2') && turn && !upkeep && !ownActed && own.active?.hp &&
				!p.some(v => v.startsWith('[from]'))) lastSwitchTurn = turn;
			if (event === 'switch' && p[2].startsWith('p2') && turn &&
				(upkeep || ownActed || !own.active?.hp || p.some(v => v.startsWith('[from]')))) {
				frames.push({ turn, phase: p.some(v => v.startsWith('[from]')) ? 'pivot' : 'replacement',
					line: i + 1, protocol: [...prefix], request: own.request(tracker, true),
					observed: { type: 'switch', name: p[2].split(': ')[1] }, issues: [...new Set(own.issues)], hpRanges: uncertainty(), lastSwitchTurn,
					evidence: structuredClone(tracker.evidence.getHistory()) });
			}
			own.consume(line, tracker);
			const visible = publicLine(line);
			prefix.push(visible); tracker.parseMessage(visible);
			if (event === 'upkeep') upkeep = true;
			if (p[2]?.startsWith('p2') && ['move', 'cant'].includes(event)) ownActed = true;
			if (event === 'turn') {
				turn = Number(p[2]); upkeep = false; ownActed = false;
				const request = own.request(tracker);
				buildBattleStateWithTracker(request, { turn }, tracker, { ...DEFAULT_AI_CONFIG, formatId: FORMAT });
				frames.push({ turn, phase: 'turn', line: i + 1, protocol: [...prefix],
					request, observed: observedTurn(lines, i), issues: [...new Set(own.issues)], hpRanges: uncertainty(), lastSwitchTurn,
					evidence: structuredClone(tracker.evidence.getHistory()) });
			}
		}
		return frames;
	} finally { own.destroy(); }
}

function evaluateFrame(frame, difficulty = 'normal') {
	const ai = new (difficulty === 'hard' ? HardAI : NormalAI)({ write() {} }, { seed: [1, 2, 3, 4] });
	ai.setBattle({ format: FORMAT, turn: frame.turn });
	ai.getTracker().parseMessage(frame.protocol.join('\n'));
	ai.getTracker().evidence.restore(frame.evidence || []);
	let choice = '', switching;
	ai.choose = value => { choice = value; };
	if (difficulty === 'normal') {
		const original = ai.evaluateSwitching.bind(ai);
		ai.evaluateSwitching = (...args) => { switching = original(...args); return switching; };
	} else if (frame.lastSwitchTurn !== undefined) {
		ai.lastSwitchTurn.set(1, frame.lastSwitchTurn);
	}
	ai.receiveRequest(structuredClone(frame.request));
	const state = ai.battleState || ai.state, request = frame.request;
	const pokemon = request.side.pokemon;
	const chosen = choice.split(' '), slot = Number(chosen[1]) - 1;
	const selected = chosen[0] === 'switch' ?
		{ type: 'switch', name: pokemon[slot]?.ident.split(': ')[1] } :
		{ type: 'move', id: request.active?.[0].moves[slot]?.id, name: request.active?.[0].moves[slot]?.move };
	let rawScores = [], switchScores = [];
	const switches = ai.getAvailableSwitches(pokemon, 0, [], 1, false);
	const actor = state.self.active[0];
	if (difficulty === 'hard') {
		const evaluator = new HardEvaluation(state, FORMAT);
		const predictions = actor ? evaluator.predictions(actor) : undefined;
		if (frame.phase === 'turn' && actor) {
			for (const [i, data] of request.active[0].moves.entries()) {
				if (data.disabled) continue;
				const move = hardMove(data.id, i + 1, FORMAT);
				for (const target of moveTargets(state, actor, move)) rawScores.push(...evaluator.scoreMoves(actor, [move], target, predictions));
			}
		}
		switchScores = switches.map(sw => {
			const mon = buildPokemonFromRequest(sw.pokemon, sw.slot, false, FORMAT);
			const result = evaluator.scoreSwitch(mon, frame.phase === 'turn' && predictions ||
				evaluator.predictions(mon), frame.phase !== 'turn', actor);
			return { pokemon: mon.species, name: sw.pokemon.ident.split(': ')[1], score: result.score, safe: result.safe, reasons: result.reasons };
		});
	} else if (frame.phase === 'turn' && state.opponent.active.length) {
		// Also expose the stay-in alternatives when the production decision chose to switch.
		const active = request.active[0];
		const choices = ai.getAvailableMoves(active.moves, active, false, 0, pokemon);
		if (!ai.lastMoveScores.length && choices.length) ai.chooseBestMoveWithScores(active, choices, 0);
	}
	if (difficulty === 'normal') {
		rawScores = ai.lastMoveScores;
		switchScores = switches.map(sw => {
			const mon = buildPokemonFromRequest(sw.pokemon, sw.slot, false, FORMAT);
			const incoming = ai.getIncomingThreat(mon, state.opponent.active, actor);
			return { pokemon: mon.species, name: sw.pokemon.ident.split(': ')[1],
				...ai.scoreSwitchMatchups(sw.pokemon, state.opponent.active), incoming,
				safe: frame.phase !== 'turn' || incoming <= NormalAI.SWITCH_THREAT_LIMIT };
		});
	}
	const scores = rawScores.map(s => ({
		id: s.move.id, name: s.move.name, score: s.score,
		flags: s.flags, details: s.breakdown.details,
	}));
	const expected = frame.observed;
	const exact = expected.type === selected.type &&
		(expected.type === 'move' ? expected.id === selected.id : expected.name === selected.name);
	const score = scores.find(s => s.id === expected.id);
	const best = Math.max(...scores.map(s => s.score));
	const sameTop = expected.type === 'move' && selected.type === 'move' && score?.score === best;
	const disabledObserved = expected.type === 'move' && request.active?.[0].moves.find(m => m.id === expected.id)?.disabled;
	const issues = [...frame.issues];
	if (disabledObserved) issues.push('Observed move is disabled in reconstructed request; exclude until reconstruction is checked');
	if (expected.type === 'move' && !request.active?.[0].moves.some(m => m.id === expected.id)) {
		issues.push('Observed move is absent from reconstructed request');
	}
	return {
		difficulty, turn: frame.turn, phase: frame.phase, line: frame.line,
		actor: state.self.active[0]?.species || pokemon[0].details.split(',')[0],
		hp: state.self.active[0]?.hpPercent,
		foe: state.opponent.active[0]?.species, foeHp: state.opponent.active[0]?.hpPercent,
		observed: expected, selected, exact, sameTop, fullChoiceExact: exact && !expected.tera,
		comparable: expected.type !== 'unknown' && !issues.length && !!state.opponent.active.length,
		moveGap: score ? best - score.score : undefined,
		scores, switchScores, switchReason: switching?.reason || ai.getLogger().getEntries().at(-1)?.reasoning?.join('; '), issues,
		hpRanges: frame.hpRanges,
		// Include reconstructed inputs so disagreements can be independently inspected and rerun.
		request, state,
	};
}

function summarize(rows) {
	const known = rows.filter(r => r.comparable);
	return { total: rows.length, comparable: known.length, unknownOrExcluded: rows.length - known.length,
		exact: known.filter(r => r.exact).length, topEquivalent: known.filter(r => r.exact || r.sameTop).length,
		fullChoiceExact: known.filter(r => r.fullChoiceExact).length,
		teraChoices: known.filter(r => r.observed.tera).length,
		staySwitch: {
			bothStay: known.filter(r => r.observed.type === 'move' && r.selected.type === 'move').length,
			bothSwitch: known.filter(r => r.observed.type === 'switch' && r.selected.type === 'switch').length,
			aiStaysExpertSwitches: known.filter(r => r.observed.type === 'switch' && r.selected.type === 'move').length,
			aiSwitchesExpertStays: known.filter(r => r.observed.type === 'move' && r.selected.type === 'switch').length,
			sameSwitchTarget: known.filter(r => r.observed.type === 'switch' && r.exact).length,
		},
	};
}

/** Diagnostic only: hold the expert's Tera choice fixed, without feeding it into the baseline. */
function conditionOnObservedTera(frame, difficulty = 'normal') {
	if (!frame.observed.tera) return undefined;
	const clone = structuredClone(frame), mon = clone.request.side.pokemon[0];
	mon.terastallized = frame.observed.tera;
	clone.request.active[0].canTerastallize = undefined;
	clone.protocol.push(`|-terastallize|${mon.ident.replace('p2:', 'p2a:')}|${frame.observed.tera}`);
	const result = evaluateFrame(clone, difficulty);
	return { selected: result.selected, scores: result.scores, switchReason: result.switchReason };
}

function run(inputs, output, difficulty = 'normal') {
	fs.mkdirSync(output, { recursive: true });
	const summary = [];
	const report = [
		`${difficulty} AI expert-replay comparison (Gen 9 Random Battle singles, controlled side p2)`,
		'Each turn uses only its protocol prefix plus the exported controlled team. Opposing exact HP is masked to public percentages.',
		'Exact/topEquivalent compare move or switch only; fullChoiceExact also requires matching Tera usage. These are agreement counts, not win rates.',
		'Unknown choices and unsupported request events are excluded. Same-turn opponent switches and Tera are not supplied to the baseline.',
		'Public replays lack original requests. Own stats/HP/PP/Choice lock/Taunt and observed items are reconstructed; complex unsupported requests need adapters.',
		'Opposing configurations use this checkout\'s public random presets, which may differ from the replay server\'s data version.',
		'',
	];
	const table = [`battle\tturn\tphase\tactor\tfoe\tobserved\t${difficulty}\tmoveGap\tcomparable\texact\ttopEquivalent`];
	for (const file of inputs) {
		const id = path.basename(file, '.html');
		const frames = collectFrames(fs.readFileSync(file, 'utf8'), fs.readFileSync(file.replace(/\.html$/, '.txt'), 'utf8'));
		const rows = frames.map(frame => {
			const result = evaluateFrame(frame, difficulty);
			const uncertain = frame.hpRanges.filter(r => r.min !== r.max);
			const choices = [];
			// Check each uncertain Pokemon's HP endpoints independently and the joint extremes.
			for (const ranges of [...uncertain.map(r => [r]), ...(uncertain.length > 1 ? [uncertain] : [])]) {
				for (const bound of ['min', 'max']) {
					const clone = structuredClone(frame);
					for (const range of ranges) {
						const mon = clone.request.side.pokemon.find(p => p.ident === range.ident);
						mon.condition = mon.condition.replace(/^\d+\//, `${range[bound]}/`);
					}
					choices.push(evaluateFrame(clone, difficulty).selected);
				}
			}
			const sensitive = choices.some(choice => JSON.stringify(choice) !== JSON.stringify(result.selected));
			if (sensitive) {
				result.comparable = false;
				result.issues.push('Choice changes across reconstructed HP endpoints');
			}
			return { ...result, hpSensitive: sensitive, hpEndpointChoices: choices,
				conditionedOnObservedTera: conditionOnObservedTera(frame, difficulty) };
		});
		fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(rows, (_, value) => value instanceof Set ? [...value] : value instanceof Map ? Object.fromEntries(value) : value, 2));
		const entry = { id, turns: summarize(rows.filter(r => r.phase === 'turn')), replacements: summarize(rows.filter(r => r.phase !== 'turn')) };
		summary.push(entry);
		report.push(JSON.stringify(entry));
		for (const r of rows) {
			const label = a => `${a.type}: ${a.name || a.reason}${a.tera ? ` + Tera ${a.tera}` : ''}`;
			table.push([id, r.turn, r.phase, r.actor, r.foe, label(r.observed), label(r.selected), r.moveGap ?? '', r.comparable, r.exact, r.exact || r.sameTop].join('\t'));
			report.push(`T${r.turn} ${r.phase} ${r.actor} (${r.hp?.toFixed(1) ?? '?'}%) vs ${r.foe} (${r.foeHp ?? '?'}%): ${label(r.observed)} / ${difficulty} ${label(r.selected)}${r.comparable ? '' : ' [not comparable]'}`);
			report.push(`  ${r.scores.map(s => `${s.name}=${s.score}`).join(', ')}${r.switchReason ? `; ${r.switchReason}` : ''}`);
			if (r.issues.length) report.push(`  Issues: ${r.issues.join('; ')}`);
			if (r.conditionedOnObservedTera) report.push(`  Diagnostic with expert Tera held fixed: ${label(r.conditionedOnObservedTera.selected)}; ${r.conditionedOnObservedTera.scores.map(s => `${s.name}=${s.score}`).join(', ')}`);
		}
	}
	fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
	fs.writeFileSync(path.join(output, 'comparison.tsv'), table.join('\n') + '\n');
	fs.writeFileSync(path.join(output, 'report.txt'), report.join('\n') + '\n');
	return summary;
}

module.exports = { readProtocol, publicLine, OwnRequest, observedTurn, collectFrames, evaluateFrame, conditionOnObservedTera, summarize, run };

if (require.main === module) {
	const [output, ...inputs] = process.argv.slice(2);
	const flag = inputs.indexOf('--difficulty');
	const difficulty = flag >= 0 ? inputs.splice(flag, 2)[1] : 'normal';
	if (!['normal', 'hard'].includes(difficulty)) throw new Error('Difficulty must be normal or hard');
	if (!output || !inputs.length) throw new Error('Usage: node test/npc/replay-audit.js OUTPUT_DIR REPLAY.html [...] (matching .txt team exports required)');
	console.log(JSON.stringify(run(inputs, output, difficulty), null, 2));
}
