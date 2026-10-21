/** Observations anchored to an authorized decision snapshot, independent of AI difficulty. */
import { Dex } from '../../../../../sim/dex';
import type { AIPokemon, BattleState, FieldConditions, SideConditions } from '../types';

export interface EvidenceContext {
	self: AIPokemon[];
	opponents: AIPokemon[];
	field: FieldConditions;
	selfConditions: SideConditions;
	opponentConditions: SideConditions;
	isDoubles: boolean;
}
export interface BattleEvidence {
	kind: 'speed' | 'damage';
	turn: number;
	opponent: string;
	context: EvidenceContext;
	first: string;
	second: string;
	move: string;
	response?: string;
	/** Public HP percentages, before and after a single direct hit. */
	before?: number;
	after?: number;
}
interface Attack {
	context: EvidenceContext;
	source: AIPokemon;
	move: string;
	invalid: boolean;
	hits: BattleEvidence[];
}

export class BattleEvidenceTracker {
	private history: BattleEvidence[] = [];
	private context?: EvidenceContext;
	private positions = new Map<string, AIPokemon>();
	private attack?: Attack;
	private order: { ident: string, move: string }[] = [];
	private turn = 0;

	getHistory(): readonly BattleEvidence[] { return [...this.history]; }

	/** Historical requests can be reconstructed by the offline audit, without future observations. */
	restore(history: readonly BattleEvidence[]): void { this.history = structuredClone([...history]); }

	begin(state: BattleState): void {
		this.flush();
		this.turn = state.turn;
		// Public opponents carry no guessed stats, items, abilities or move pools in evidence.
		const opponents = state.opponent.active.map(p => ({ ...p, presetModels: undefined, moveKnowledge: undefined,
			baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, maxHp: 0, hp: 0,
			item: p.itemKnown ? p.item : '', ability: p.observedAbility || p.abilityChanged ? p.ability : '',
		}));
		this.context = structuredClone({ self: state.self.active, opponents, field: state.field,
			selfConditions: state.self.conditions, opponentConditions: state.opponent.conditions, isDoubles: state.isDoubles });
		this.positions.clear();
		for (const p of [...this.context.self, ...this.context.opponents]) {
			if (!p.ident || !p.ownerSide) continue;
			// PS emits global letters in Multi (p3b/p4b); adapters can also use the player's local 'a'.
			const multi = Number(p.ownerSide.slice(1)) > 2 ||
				[...state.self.active, ...state.opponent.active].some(mon => Number(mon.ownerSide?.slice(1)) > 2);
			this.positions.set(`${p.ownerSide}${String.fromCharCode(96 + p.slot)}`, p);
			if (multi) this.positions.set(`${p.ownerSide}a`, p);
		}
		this.order = [];
	}

	private add(evidence: BattleEvidence): void {
		this.history.push(evidence);
		// Bound memory and repeated calculations while keeping observations across switches.
		const same = this.history.filter(e => e.opponent === evidence.opponent && e.kind === evidence.kind);
		if (same.length > 16) this.history.splice(this.history.indexOf(same[0]), 1);
		if (this.history.length > 192) this.history.shift();
	}

	private flush(): void {
		if (this.attack && !this.attack.invalid) {
			for (const hit of this.attack.hits) {
				if (this.attack.hits.filter(other => other.second === hit.second).length === 1) this.add(hit);
			}
		}
		this.attack = undefined;
	}

	observe(parts: string[]): void {
		const [event, ident = '', effect = ''] = parts;
		if (['turn', 'upkeep', 'win', 'tie', 'move', 'switch', 'drag'].includes(event)) this.flush();
		if (['replace', '-transform', 'detailschange', '-formechange'].includes(event)) {
			// Disguises and changed base stats cannot be attributed to the previous apparent configuration.
			this.history = this.history.filter(e => !e.opponent.startsWith(ident.slice(0, 2)));
		}
		if (['turn', 'upkeep', 'switch', 'drag', 'replace', 'swap', 'faint', '-transform', 'detailschange', '-formechange',
			'-boost', '-unboost', '-setboost', '-clearboost', '-clearallboost', '-clearpositiveboost', '-clearnegativeboost',
			'-swapboost', '-copyboost', '-invertboost', '-singleturn', '-singlemove', '-swapsideconditions',
			'-status', '-curestatus', '-cureteam', '-item', '-enditem', '-ability', '-endability', '-terastallize',
			'-weather', '-fieldstart', '-fieldend', '-sidestart', '-sideend', '-start', '-end', '-activate', '-sethp',
		].includes(event)) {
			// A fresh request rearms recording. Do not reconstruct mid-turn mechanics a second time here.
			this.context = undefined;
			this.order = [];
		}
		if (['-crit', '-hitcount', '-immune', '-miss', '-fail', '-block'].includes(event) && this.attack) {
			this.attack.invalid = true;
		}
		const pokemon = this.positions.get(ident.split(':')[0]);
		if (event === 'move' && this.context && pokemon) {
			const data = Dex.forFormat(this.context.field.formatId || 'gen9customgame').moves.get(effect);
			if (['round', 'firepledge', 'waterpledge', 'grasspledge'].includes(data.id)) {
				this.context = undefined;
				this.order = [];
				return;
			}
			if (parts.some(p => p.startsWith('[from]')) || data.category === 'Status') {
				this.order = [];
				return;
			}
			for (const earlier of this.order) {
				const first = [...this.context.self, ...this.context.opponents].find(p => p.ident === earlier.ident)!;
				if (this.context.self.includes(first) === this.context.self.includes(pokemon)) continue;
				this.add({ kind: 'speed', turn: this.turn,
					opponent: (this.context.opponents.includes(first) ? first : pokemon).ident!,
					context: structuredClone(this.context), first: first.ident!, second: pokemon.ident!,
					move: earlier.move, response: data.id });
			}
			this.order.push({ ident: pokemon.ident!, move: data.id });
			this.attack = { context: structuredClone(this.context), source: pokemon, move: data.id,
				invalid: !!data.multihit || !data.basePower || !!data.damage || !!data.damageCallback || !!data.basePowerCallback,
				hits: [] };
		}
		if (['-damage', '-heal'].includes(event) && pokemon) {
			const [hp, max] = effect.split(' ')[0].split('/').map(Number);
			const percent = max ? Math.ceil(hp / max * 100) : 0;
			const attack = this.attack;
			if (event === '-damage' && attack && this.context && !parts.some(p => p.startsWith('[from]')) &&
				this.context.self.includes(pokemon) !== this.context.self.includes(attack.source) &&
				!pokemon.volatiles.has('substitute') && percent > 0 && percent < pokemon.hpPercent) {
				attack.hits.push({ kind: 'damage', turn: this.turn,
					opponent: (this.context.opponents.includes(pokemon) ? pokemon : attack.source).ident!,
					context: attack.context, first: attack.source.ident!, second: pokemon.ident!, move: attack.move,
					before: Math.ceil(pokemon.hpPercent), after: percent });
			}
			pokemon.hpPercent = percent;
			if (pokemon.maxHp) pokemon.hp = Math.floor(pokemon.maxHp * percent / 100);
		}
	}

	reset(): void {
		this.history = []; this.context = undefined; this.attack = undefined;
		this.order = []; this.positions.clear();
	}
}
