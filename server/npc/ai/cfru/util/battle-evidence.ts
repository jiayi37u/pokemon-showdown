/** Observations anchored to an authorized decision snapshot, independent of AI difficulty. */
import { Dex } from '../../../../../sim/dex';
import { effectiveAbility, effectiveItem, fieldWithActivePokemon } from './mechanics';
import type { AbilityData } from '../../../../../sim/dex-abilities';
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
	kind: 'speed' | 'damage' | 'selection';
	/** Entry effects compare Speed directly, without move priority. */
	speedSource?: 'entry';
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
	/** Public actions or missing guaranteed effects rule out these active items. */
	excludedItems?: string[];
}
interface Attack {
	context: EvidenceContext;
	source: AIPokemon;
	move: string;
	invalid: boolean;
	hits: BattleEvidence[];
	itemEffects: Set<string>;
}
interface EntryOrder {
	positions: Set<string>;
	abilities: { position: string, ability: string }[];
	closed: boolean;
}

/** These effects invalidate damage snapshots, but cannot change the order of queued actions. */
function preservesActionOrder(event: string, effect: string): boolean {
	if (['-boost', '-unboost', '-setboost'].includes(event)) return effect !== 'spe';
	if (['-sidestart', '-sideend'].includes(event)) {
		return ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb',
			'reflect', 'lightscreen', 'auroraveil', 'safeguard', 'mist']
			.includes(Dex.toID(effect.replace(/^move: /, '')));
	}
	if (event === '-singleturn') {
		return ['protect', 'endure', 'roost'].includes(Dex.toID(effect.replace(/^move: /, '')));
	}
	return false;
}

export class BattleEvidenceTracker {
	private history: BattleEvidence[] = [];
	private context?: EvidenceContext;
	private speedContext?: EvidenceContext;
	private positions = new Map<string, AIPokemon>();
	private attack?: Attack;
	private entry?: EntryOrder;
	private order: { ident: string, move: string }[] = [];
	private turn = 0;
	private selections = new Map<string, string>();

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
		// Keep the order snapshot immutable as damage/healing updates the damage snapshot's HP.
		this.speedContext = structuredClone(this.context);
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
		this.recordEntryOrder();
	}

	private recordEntryOrder(): void {
		const entry = this.entry, context = this.speedContext;
		this.entry = undefined;
		if (!entry || !context) return;
		const dex = Dex.forFormat(context.field.formatId || 'gen9customgame');
		// Gen 5+ resolves simultaneous entrants in one speed-sorted SwitchIn event.
		if (dex.gen < 5) return;
		const triggers = entry.abilities.flatMap(({ position, ability }) => {
			const current = this.positions.get(position);
			const pokemon = [...context.self, ...context.opponents].find(p => p.ident === current?.ident);
			const id = dex.abilities.get(ability).id;
			const data: AbilityData & { onSwitchInOrder?: number } = dex.data.Abilities[id];
			// Only direct entry callbacks qualify. Skip speed-changing abilities rather than
			// reconstructing their pre-entry state from the request received after activation.
			return pokemon && data && Dex.toID(pokemon.ability) === id &&
				(data.onStart || data.onSwitchIn) && !data.onModifySpe ? [{ pokemon, data }] : [];
		});
		for (let i = 0; i < triggers.length; i++) {
			const first = triggers[i];
			for (const second of triggers.slice(i + 1)) {
				if (context.self.includes(first.pokemon) === context.self.includes(second.pokemon) ||
					(first.data.onSwitchInPriority || 0) !== (second.data.onSwitchInPriority || 0) ||
					(first.data.onSwitchInOrder || 0) !== (second.data.onSwitchInOrder || 0)) continue;
				this.add({ kind: 'speed', speedSource: 'entry', turn: this.turn,
					opponent: (context.opponents.includes(first.pokemon) ? first : second).pokemon.ident!,
					context: structuredClone(context), first: first.pokemon.ident!, second: second.pokemon.ident!, move: '' });
			}
		}
	}

	/** Buffer public entry events until the ensuing request supplies our authorized stats. */
	private observeEntry(parts: string[]): void {
		const [event, ident = '', effect = ''] = parts;
		if (event === 'switch') {
			// A switch after an ability starts a different batch (e.g. two voluntary switches).
			if (!this.entry || this.entry.closed || this.entry.abilities.length) {
				this.entry = { positions: new Set(), abilities: [], closed: false };
			}
			this.entry.positions.add(ident.split(':')[0]);
			return;
		}
		const entry = this.entry;
		if (!entry) return;
		if (['turn', 'upkeep'].includes(event)) { entry.closed = true; return; }
		if (['move', 'drag', 'replace', 'swap', 'faint', '-transform', 'detailschange', '-formechange',
			'-status', '-curestatus', '-cureteam', '-item', '-enditem', '-endability', '-activate',
			'-start', '-end', '-fieldstart', '-fieldend', '-swapsideconditions',
			'-clearboost', '-clearallboost', '-clearpositiveboost', '-clearnegativeboost',
			'-swapboost', '-copyboost', '-invertboost',
		].includes(event) || (['-boost', '-unboost', '-setboost', '-sidestart', '-sideend'].includes(event) &&
			!preservesActionOrder(event, effect))) {
			this.entry = undefined;
			return;
		}
		if (entry.closed) return;
		let source = '', ability = '';
		if (event === '-ability') {
			if (parts.some(p => p.startsWith('[from]')) || (parts[3] && Dex.abilities.get(parts[3]).exists)) {
				this.entry = undefined; // Trace, Skill Swap, etc. do not reveal natural entry order.
				return;
			}
			source = ident; ability = effect;
		} else if (event === '-weather') {
			source = parts.find(p => p.startsWith('[of] '))?.slice(5) || '';
			ability = parts.find(p => p.startsWith('[from] ability: '))?.slice(16) || '';
		}
		const position = source.split(':')[0];
		if (ability && entry.positions.has(position) && !entry.abilities.some(a => a.position === position)) {
			entry.abilities.push({ position, ability });
		}
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
				if (this.attack.hits.filter(other => other.second === hit.second).length !== 1) continue;
				this.recordMissingItemEffects(this.attack, hit);
				this.add(hit);
			}
		}
		this.attack = undefined;
	}

	private recordMissingItemEffects(attack: Attack, hit: BattleEvidence): void {
		const all = [...hit.context.self, ...hit.context.opponents];
		const source = all.find(p => p.ident === hit.first), target = all.find(p => p.ident === hit.second);
		if (!source || !target || attack.source.hpPercent <= 0) return;
		const field = fieldWithActivePokemon(hit.context.field, all);
		const dex = Dex.forFormat(field.formatId || 'gen9customgame');
		if (dex.gen < 5) return;
		const move = dex.moves.get(hit.move);
		// Only our known attack can establish contact; unknown opponent abilities remain uncertain.
		if (hit.second === hit.opponent && move.flags.contact &&
			!['magicguard', 'longreach'].includes(effectiveAbility(source, field)) &&
			!['protectivepads', 'punchingglove'].includes(effectiveItem(source, field)) &&
			!target.itemKnown && !target.itemLost &&
			effectiveItem({ ...target, item: 'rockyhelmet' }, field) === 'rockyhelmet' &&
			(target.observedAbility || !Object.values(dex.species.get(target.species).abilities)
				.some(ability => Dex.toID(ability) === 'klutz')) &&
				!attack.itemEffects.has('rockyhelmet')) hit.excludedItems = ['rockyhelmet'];
	}

	private recordSelection(context: EvidenceContext, pokemon: AIPokemon, move: string): void {
		if (!context.opponents.some(p => p.ident === pokemon.ident)) return;
		const dex = Dex.forFormat(context.field.formatId || 'gen9customgame');
		const field = fieldWithActivePokemon(context.field, [...context.self, ...context.opponents]);
		const previous = this.selections.get(pokemon.ident!);
		this.selections.delete(pokemon.ident!);
		// An unknown Klutz ability or a temporarily inactive item cannot establish exclusion.
		if (pokemon.itemChanged || pokemon.itemLost || pokemon.volatiles.has('transform') ||
			!pokemon.observedAbility && Object.values(dex.species.get(pokemon.species).abilities)
				.some(a => Dex.toID(a) === 'klutz') ||
				effectiveItem({ ...pokemon, item: 'choiceband' }, field) !== 'choiceband') return;
		this.selections.set(pokemon.ident!, move);
		const excludedItems = [];
		if (dex.gen >= 6 && dex.moves.get(move).category === 'Status') excludedItems.push('assaultvest');
		if (previous && previous !== move) excludedItems.push('choiceband', 'choicespecs', 'choicescarf');
		if (excludedItems.length) this.add({ kind: 'selection', turn: this.turn, opponent: pokemon.ident!,
			context: structuredClone(context), first: pokemon.ident!, second: '', move, excludedItems });
	}

	observe(parts: string[]): void {
		const [event, ident = '', effect = ''] = parts;
		this.observeEntry(parts);
		if (['switch', 'drag', 'replace', '-transform', 'detailschange', '-formechange', '-item', '-enditem',
			'-ability', '-endability', '-fieldstart', '-fieldend', '-start', '-end'].includes(event)) {
			// Changing item eligibility breaks the continuity needed to infer a Choice lock.
			this.selections.clear();
		}
		const itemEffect = parts.find(p => p.startsWith('[from] item: '));
		if (itemEffect && this.attack) this.attack.itemEffects.add(Dex.toID(itemEffect.slice(13)));
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
			if (!preservesActionOrder(event, effect)) {
				this.speedContext = undefined;
				this.order = [];
			}
		}
		if (['-crit', '-hitcount', '-immune', '-miss', '-fail', '-block'].includes(event) && this.attack) {
			this.attack.invalid = true;
		}
		const pokemon = this.positions.get(ident.split(':')[0]);
		const context = this.speedContext || this.context;
		if (event === 'move' && context && pokemon) {
			const data = Dex.forFormat(context.field.formatId || 'gen9customgame').moves.get(effect);
			if (['round', 'firepledge', 'waterpledge', 'grasspledge'].includes(data.id)) {
				this.context = undefined;
				this.speedContext = undefined;
				this.order = [];
				return;
			}
			if (parts.some(p => p.startsWith('[from]'))) {
				this.order = [];
				return;
			}
			this.recordSelection(context, pokemon, data.id);
			const speed = this.speedContext;
			if (speed) {
				const second = [...speed.self, ...speed.opponents].find(p => p.ident === pokemon.ident)!;
				for (const earlier of this.order) {
					const first = [...speed.self, ...speed.opponents].find(p => p.ident === earlier.ident)!;
					if (speed.self.includes(first) === speed.self.includes(second)) continue;
					this.add({ kind: 'speed', turn: this.turn,
						opponent: (speed.opponents.includes(first) ? first : second).ident!,
						context: structuredClone(speed), first: first.ident!, second: second.ident!,
						move: earlier.move, response: data.id });
				}
				this.order.push({ ident: pokemon.ident!, move: data.id });
			}
			if (!this.context || data.category === 'Status') return;
			this.attack = { context: structuredClone(this.context), source: pokemon, move: data.id,
				invalid: !!data.multihit || !data.basePower || !!data.damage || !!data.damageCallback || !!data.basePowerCallback,
				hits: [], itemEffects: new Set() };
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
		this.history = []; this.context = undefined; this.speedContext = undefined;
		this.attack = undefined;
		this.entry = undefined;
		this.order = []; this.positions.clear(); this.selections.clear();
	}
}
