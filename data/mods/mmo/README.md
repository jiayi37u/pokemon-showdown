# PokeMMO

`mmo` is a Gen 5 species/type dex with PokeMMO battle overrides. The rated singles formats are `gen5pokemmoou`, `gen5pokemmouu`, and `gen5pokemmonu`; all adjust teams to level 50. The existing PokeMMO, Test, and Doubles formats also use the shared dex, but retain their own format rules.

## Sources

- The battle implementation starts from [CTCC1/Pokemon-Showdown](https://github.com/CTCC1/Pokemon-Showdown/tree/9466904df894ae04a9568523e64ba3c40b5e1193/data/mods/mmo), commit `9466904df894ae04a9568523e64ba3c40b5e1193` (MIT).
- Tiers, ability slots, base stats, and move pools are a **2026-10-12 snapshot** of the `pokemmo` table in [MMO Showdown's public teambuilder data](https://mmoshowdown.cc/data/teambuilder-tables.js), cross-checked against the [tier directory](https://www.mmoshowdown.com/dex/tiers/). The asset SHA-256 is `3c0c2e7f47633994334492035a4cb7c2aef2d8c0e277934dd18694dc7396ca30`.
- Move metadata comes from the [MMO client data](https://github.com/sah-leem/pokemon-showdown-client/tree/e3f8bdaaa848ac5ac620e752ce302cabdccf0281/play.pokemonshowdown.com/pokemmo-data), commit `e3f8bdaaa848ac5ac620e752ce302cabdccf0281`. This is the MMO-specific `moves.js`, not the generic Gen 5 display overrides in the teambuilder. Its SHA-256 is `aca4af079b23131b6040602e00aeef8f88f3a75d2cc890aa69de26a4dc5b9a60`.
- Format bans and clause descriptions were queried on 2026-10-12 from `wss://api.mmoshowdown.cc/showdown/websocket` using `/formathelp gen5pokemmoou`, `gen5pokemmouu`, `gen5pokemmonu`, `Sleep Clause MMO`, `Hidden Power Clause`, and `No Event Abilities`.
- [Mechanics reference](https://www.mmoshowdown.com/resources/mechanics-reference) documents the intended hybrid mechanics. The live server's banlist takes precedence where the prose differs: **Garchomp + Swords Dance is allowed; Blaziken + Speed Boost is banned**. The public client's older `formats-data.ts` is not used for tier assignments.

## Tier and legality data

`formats-data.ts` contains 689 tier entries, including forms: OU 43, UU 53, NU 46, UT 487, and Uber 60. OU permits UU/NU/UT; UU excludes OU; NU excludes OU and UU. All three exclude Ubers and the explicitly banned species, moves, items, and ability combinations in `rulesets.ts` and `config/formats.ts`.

`pokedex.ts` supplies MMO ability slots and the 55 stat changes relative to Gen 5. Event-exclusive `S` abilities are rejected in the tier formats; an ability also present in a normal or hidden slot remains usable. Cosmetic forms retain their normal abilities and inherit their base form's move pool where the client only contains unrelated generation data.

`learnsets-data.ts` contains complete MMO move pools, including special tutors such as Golem's Rapid Spin and Blissey's Wish. `PokeMMO Standard.checkCanLearn` uses these pools directly: cartridge transfer, breeding, and event-source compatibility are not MMO acquisition rules. Smeargle uses Sketch eligibility. Only Gen 1–5 moves and the explicitly backported Snowscape are available.

`move-data.ts` supplies static differences from the CTCC battle implementation without replacing its callbacks. This includes Outrage at 90 power and Recover/Rest/Roost/Slack Off/Soft-Boiled/Milk Drink at 5 base PP (8 with PP Ups). Abilities and items added in later generations are explicitly backported; unrelated future content remains unavailable.

The singles rules also enforce species uniqueness, duplicate-move rejection, OHKO/evasion bans, 510 total EVs, and no Dynamax. Hidden Power is fixed at 60 power and permits any of its 16 types without changing IVs; the validator exception is scoped to `PokeMMO Hidden Power`. Sleep Clause MMO records successful opponent-induced sleep for the entire battle; waking, switching, and fainting do not reset it. Self-induced Rest neither consumes nor is blocked by that allowance.

## Maintenance and validation

The snapshot is checked into the repository and is not fetched at server startup. For tier changes, update `PokeMMOTiers` from the live table and re-query all three live format banlists. Keep the shared bans in `PokeMMO Standard` and format-specific tier/combo bans in `config/formats.ts`. Do not substitute Smogon tiers or import the client's inherited CAP/future-generation entries.

Run `node build`, then the `PokeMMO` suites under `test/sim/misc/pokemmo*.js`. These cover tier boundaries, the full tier catalogue, combo bans and their legal alternatives, move pools, ability/item availability, Hidden Power, sleep, weather, trapping, and complete level-50 battles. This mod incorporates the documented changes and tested behavior; it is not a claim of exhaustive parity with every PokeMMO engine interaction.
