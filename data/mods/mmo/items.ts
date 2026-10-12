// MMO Showdown public teambuilder snapshot, 2026-10-12. See README.md for sources.
import { Items as ModernItems } from '../../items';

export const Items: import('../../../sim/dex-items').ModdedItemDataTable = {
	// Replace the full entry to remove Gen 6's inherited SpA/SpD callbacks.
	souldew: { ...ModernItems.souldew },
	assaultvest: { inherit: true, gen: 5, isNonstandard: null },
	clearamulet: { inherit: true, gen: 5, isNonstandard: null },
	covertcloak: { inherit: true, gen: 5, isNonstandard: null },
	ejectpack: { inherit: true, gen: 5, isNonstandard: null },
	heavydutyboots: { inherit: true, gen: 5, isNonstandard: null },
	loadeddice: { inherit: true, gen: 5, isNonstandard: null },
	luminousmoss: { inherit: true, gen: 5, isNonstandard: null },
	punchingglove: { inherit: true, gen: 5, isNonstandard: null },
	roomservice: { inherit: true, gen: 5, isNonstandard: null },
	safetygoggles: { inherit: true, gen: 5, isNonstandard: null },
	snowball: { inherit: true, gen: 5, isNonstandard: null },
	throatspray: { inherit: true, gen: 5, isNonstandard: null },
	weaknesspolicy: { inherit: true, gen: 5, isNonstandard: null },
};
