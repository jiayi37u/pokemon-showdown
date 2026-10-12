# PokeMMO

`mmo` is a Gen 5 species/type dex with PokeMMO battle overrides. The rated singles formats are `gen5pokemmoou`, `gen5pokemmouu`, and `gen5pokemmonu`; all adjust teams to level 50. The existing PokeMMO, Test, and Doubles formats also use the shared dex, but retain their own format rules.

## Sources

- The battle implementation starts from [CTCC1/Pokemon-Showdown](https://github.com/CTCC1/Pokemon-Showdown/tree/9466904df894ae04a9568523e64ba3c40b5e1193/data/mods/mmo), commit `9466904df894ae04a9568523e64ba3c40b5e1193` (MIT).
- Tiers, ability slots, base stats, and move pools are a **2026-10-12 snapshot** of the `pokemmo` table in [MMO Showdown's public teambuilder data](https://mmoshowdown.cc/data/teambuilder-tables.js), cross-checked against the [tier directory](https://www.mmoshowdown.com/dex/tiers/). The asset SHA-256 is `3c0c2e7f47633994334492035a4cb7c2aef2d8c0e277934dd18694dc7396ca30`.
- Move metadata comes from the [MMO client data](https://github.com/sah-leem/pokemon-showdown-client/tree/e3f8bdaaa848ac5ac620e752ce302cabdccf0281/play.pokemonshowdown.com/pokemmo-data), commit `e3f8bdaaa848ac5ac620e752ce302cabdccf0281`. This is the MMO-specific `moves.js`, not the generic Gen 5 display overrides in the teambuilder. Its SHA-256 is `aca4af079b23131b6040602e00aeef8f88f3a75d2cc890aa69de26a4dc5b9a60`.
- Format bans and clause descriptions were queried on 2026-10-12 from `wss://api.mmoshowdown.cc/showdown/websocket` using `/formathelp gen5pokemmoou`, `gen5pokemmouu`, `gen5pokemmonu`, `Sleep Clause MMO`, `Hidden Power Clause`, and `No Event Abilities`.
- [Mechanics reference](https://www.mmoshowdown.com/resources/mechanics-reference) documents the intended hybrid mechanics. An [offline archive and reading guide](references/README.md) preserves the page as retrieved on 2026-10-12. The live server's banlist takes precedence where the prose differs: **Garchomp + Swords Dance is allowed; Blaziken + Speed Boost is banned**. The public client's older `formats-data.ts` is not used for tier assignments.

## Tier and legality data

`formats-data.ts` contains 691 tier entries, including forms: OU 43, UU 53, NU 46, UT 487, LC 2, and Uber 60. The LC entries are Nidoran-F and Nidoran-M; they are available in all three singles tiers. OU permits UU/NU/UT; UU excludes OU; NU excludes OU and UU. All three exclude Ubers and the explicitly banned species, moves, items, and ability combinations in `rulesets.ts` and `config/formats.ts`.

`pokedex.ts` supplies MMO ability slots and the 55 stat changes relative to Gen 5. Event-exclusive `S` abilities are rejected in the tier formats; an ability also present in a normal or hidden slot remains usable. Cosmetic forms retain their normal abilities and inherit their base form's move pool where the client only contains unrelated generation data.

`learnsets-data.ts` contains MMO move pools, including special tutors such as Golem's Rapid Spin and Blissey's Wish. `PokeMMO Standard.checkCanLearn` checks these pools and pre-evolutions, so Magmar and Electabuzz retain Follow Me from Magby and Elekid: cartridge transfer, breeding, and event-source compatibility are not MMO acquisition rules. Smeargle uses Sketch eligibility. Only Gen 1–5 moves and the explicitly backported Snowscape are available.

`move-data.ts` supplies static differences from the CTCC battle implementation without replacing its callbacks. This includes Outrage at 90 power and Recover/Rest/Roost/Slack Off/Soft-Boiled/Milk Drink at 5 base PP (8 with PP Ups). Abilities and items added in later generations are explicitly backported; unrelated future content remains unavailable.

The singles rules also enforce species uniqueness, duplicate-move rejection, OHKO/evasion bans, 510 total EVs, and no Dynamax. Hidden Power is fixed at 60 power and permits any of its 16 types without changing IVs; the validator exception is scoped to `PokeMMO Hidden Power`. Sleep Clause MMO records successful opponent-induced sleep for the entire battle; waking, switching, and fainting do not reset it. Self-induced Rest neither consumes nor is blocked by that allowance.

## Maintenance and validation

The snapshot is checked into the repository and is not fetched at server startup. For tier changes, update `PokeMMOTiers` from the live table and re-query all three live format banlists. Keep the shared bans in `PokeMMO Standard` and format-specific tier/combo bans in `config/formats.ts`. Do not substitute Smogon tiers or import the client's inherited CAP/future-generation entries. Preserve the two legitimate LC entries.

Run `node build`, then the `PokeMMO` suites under `test/sim/misc/pokemmo*.js`. These cover tier boundaries, the full tier catalogue, combo bans and their legal alternatives, move pools, ability/item availability, Hidden Power, sleep, weather, trapping, and complete level-50 battles. This mod incorporates the documented changes and tested behavior; it is not a claim of exhaustive parity with every PokeMMO engine interaction.

## Mechanics-reference audit (2026-10-12)

`test/sim/misc/pokemmo-reference.js` covers the reference's applicable singles and shared battle mechanics, alongside `pokemmo.js` and `pokemmo-tiers.js`:

| Reference section | Executable coverage |
| --- | --- |
| Types and level cap | 17 available types, no Fairy, Steel resists Dark/Ghost, level 50 in OU/UU/NU |
| Weather and status | All four weather abilities at 5/8 turns, snow defense/no chip, Slush Rush, sleep countdown/switching, paralysis and critical damage |
| Moves | All 37 listed power values, Dark Void at 50% accuracy, six recovery moves at 8 max PP, Rapid Spin, Teleport, Toxic, Facade, flat-power Knock Off |
| Immunities and doubles | Dark Prankster immunity, Ghost trapping immunity, powder immunity for Grass/Overcoat/Safety Goggles, Rage Powder redirection, 1/2 singles and 2/3 doubles screen damage |
| Abilities | Four Intimidate blockers, Oblivious's three immunities, Mold Breaker versus Iron Barbs/Rough Skin, six Sharpness moves, Competitive, Wind Rider, Neutralizing Gas reactivation |
| Items | All 13 backported items, type-restricted Soul Dew power without stat boosts, one-use 1.5x Gems |
| Pokemon and acquisition | 55 base-stat updates, all listed special-tutor families, pre-evolution inheritance, a legal set for all 631 non-Uber catalogue entries |
| Singles clauses | Tier/combo bans, unavailable abilities/items/species, species/move uniqueness, OHKO/evasion/EV limits, all 16 independent Hidden Power types, once-per-battle opposing sleep |

Reference-specific corrections include the Mold Breaker exceptions, Knock Off's lack of held-item bonus, Dark Void accuracy, modern Soul Dew and powder immunity, and the Nidoran/Happiny tutor moves required by the documented evolution-line availability. Mainline Gen 9 does **not** make Iron Barbs/Rough Skin breakable; these are explicit MMO overrides, not inherited Gen 9 behavior. The reference lists 54 names while saying 55 stat updates; the public data additionally includes Illumise. Exploud uses its cartridge stats, independently of this fork's custom Gen 9 stats.

The live-server combo-ban policy above remains authoritative where the page differs. VGC-only clauses (item uniqueness, open team sheets, bring six/pick four, and Politoed + Lovely Kiss) are outside the OU/UU/NU formats and are not applied to singles. The existing Doubles format is used to verify shared doubles mechanics; it is not a VGC format.
