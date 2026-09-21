# ARCH-103 canonical baseline capture report

## Capture identity

- Capture timestamp: `2026-09-21T08:59:37Z`
- Source repository SHA: `d113f512b02d950ede320a26075fe52d3f6e9c97`
- Workbook: `SWGOH_GAC_Assistant_Data`
- Apps Script response: 77,553 bytes
- Apps Script response SHA-256: `342e3e4bf095cb7ae25011682f81b17da2b8470b445e046db5f541d5bc0cc4a3`
- HTTP result: `200`, `application/json; charset=utf-8`
- Redaction: none
- Semantic transformation: none. The canonical JSON changes only whitespace and object-key order and parses to the same value as the exact response bytes.

The workbook was read through bounded Google Sheets API ranges. No cell was edited. The `Counters` CSV contains the current displayed values so the open-ended formula results are retained. A full formula scan found exactly two authored formulas, documented below. The other seven exported tabs contained no formulas. Grid-capacity-only trailing empty rows are not CSV records.

## Source inventory

| Tab | Columns in exact order | Role | Data rows | Stable identifiers | Formula or derived columns |
|---|---|---:|---:|---|---|
| `Counters` | `Mode`, `Defence Team`, `Counter_ID`, `Counter Team`, `Tier`, `Banner Score`, `Score Meaning`, `Undersize`, `Notes` | App-facing, authored plus derived | 366 | `Mode` + `Defence Team` + `Counter_ID` identifies a matchup entry; row order remains significant where duplicates exist | `Counter Team` is derived by the `D2` ARRAYFORMULA; `Score Meaning` is derived by the `G2` ARRAYFORMULA |
| `Defence_Teams` | `Defence_Team`, `Mode`, `Threat`, `Notes` | App-facing authored data | 9 | `Mode` + `Defence_Team` | None |
| `Score_Meanings` | `Mode`, `Score`, `Meaning` | Authoring-only lookup guidance | 26 | `Mode` + `Score` | Feeds the `Counters.Score Meaning` formula; not read by Apps Script |
| `Counter_Definitions` | `Counter_ID`, `Counter Team` | App-facing authored data | 56 | `Counter_ID` | None |
| `Counter_Composition` | `Counter_ID`, `Character_ID`, `Role` | App-facing authored data | 70 | `Counter_ID` + `Character_ID`; `Role` is the membership classification | None |
| `Character_Definitions` | `Character_ID`, `Character_Name`, `Unit_Type`, `External_ID` | App-facing authored data | 312 | `Character_ID`; `External_ID` is the external game/swgoh.gg identifier | None |
| `GAC_Board_Config` | `League`, `Mode`, `Territory`, `Territory_Type`, `Team_Count` | App-facing authored configuration | 40 | `League` + `Mode` + `Territory`; row order determines territory order | None |
| `GAC_Scoring` | `Rule_ID`, `Battle_Type`, `Mode`, `Value`, `Notes` | App-facing authored rules | 16 | `Rule_ID` + `Battle_Type` + `Mode` | None |
| `Defence_Composition` | Expected by `Code.gs`: `Defence_Team`, `Mode`, `Character_ID` | Optional app-facing authored data | 0; tab absent | `Mode` + `Defence_Team` + `Character_ID` | Absent source yields `{}` by design |

The two exact formulas are:

- `Counters!D2`: `=ARRAYFORMULA(IF(C2:C="","",IFERROR(VLOOKUP(C2:C,Counter_Definitions!A:B,2,FALSE),"")))`
- `Counters!G2`: `=ARRAYFORMULA(IF(A2:A="","",IFERROR(VLOOKUP(A2:A&"|"&F2:F,{Score_Meanings!$A$2:$A&"|"&Score_Meanings!$B$2:$B,Score_Meanings!$C$2:$C},2,FALSE),"")))`

`Roster` and `GAC History` were deliberately neither read nor exported. They do not feed the catalogue payload and are outside the authorized data scope. The implementation plan does not require the binary workbook, so no redundant `.xlsx` was retained.

## Payload contract and counts

Top-level keys, in response order:

1. `counters`
2. `counterDefinitions`
3. `characterDefinitions`
4. `boardConfig`
5. `scoring`
6. `defenceTeams`
7. `defenceCompositions`

| Payload domain | Count |
|---|---:|
| Counter matchup rows | 366 |
| Counter defence groups | 111 |
| 5v5 matchup rows / defence groups | 154 / 49 |
| 3v3 matchup rows / defence groups | 181 / 54 |
| FLEET matchup rows / defence groups | 31 / 8 |
| Counter definitions | 57 |
| Character definitions | 312 |
| Board configuration rows | 40 |
| Scoring rows | 16 |
| Defence-team attribute rows | 9 |
| Defence composition teams / members | 0 / 0 |

The payload contains one more counter definition than `Counter_Definitions.csv`: `MAZ_KANATA` is synthesized by `Code.gs` because it appears in `Counter_Composition` but has no definition row.

## Identifier coverage

- Authored counter IDs: 56 unique, 56 rows, 0 blank, 0 duplicate.
- Payload counter IDs: 57 because of the synthesized `MAZ_KANATA` definition.
- Counter-composition membership: 70 rows across 57 counter IDs and 64 character IDs; 68 `REQUIRED`, 2 `RECOMMENDED`.
- Character IDs: 312 unique, 312 rows, 0 blank, 0 duplicate.
- External IDs: 312 present, 312 unique, 0 blank, 0 duplicate.
- Character unit types: 260 `CHARACTER`, 41 `SHIP`, 11 `CAPITAL_SHIP`.
- Required composition members without an external ID: 0.
- Composition character IDs without a character definition: 0.
- Blank required identifiers across all eight exported tabs: 0.

Authored `Counter_ID` values:

`50R_T`, `ADMIRAL_RADDUS`, `BAD_BATCH`, `BANE`, `BAYLAN`, `BOBA_FETT_SCION_OF_JANGO`, `BOSSK`, `BO_KATAN_MANDALORE`, `CERE`, `CERE_SK`, `CHIMAERA`, `CLS`, `DARTH_NIHILUS`, `DARTH_REVAN`, `DASH`, `ENDURANCE`, `ENOCH`, `EXECUTOR`, `EXECUTRIX`, `FINALIZER`, `GAS`, `GI`, `GREAT_MOTHERS`, `GUNGANS`, `HOME_ONE`, `JABBA`, `JAWAS`, `JKCK`, `JKL`, `JKR`, `JMK`, `JML`, `LEIA`, `LEVIATHAN`, `LORD_VADER`, `MALAK`, `MALEVOLENCE`, `MALGUS`, `MAUL`, `MOTHER_TALZIN`, `NEGOTIATOR`, `PHOENIX`, `PROFUNDITY`, `QUEEN_AMIDALA`, `RADDUS`, `REVA`, `SATELE_SHAN`, `SAW_GERRERA`, `SEE`, `SEE_BANE`, `SLKR`, `STARKILLER`, `THE_STRANGER`, `TRAYA`, `VEERS`, `WAMPA`.

The payload-only synthesized counter ID is `MAZ_KANATA`.

## Defence identity observations

There are 69 distinct defence display names across `Counters` and `Defence_Teams`. All are enumerated here:

`Admiral Raddus`, `Admiral Trench`, `Ahsoka Tano`, `Baylan Skoll`, `Bo-Katan Mandalore`, `CLS`, `Carth Onasi`, `Cassian Andor (Undercover)`, `Cere UFU`, `Chimaera`, `Dark Trooper Moff Gideon`, `Darth Malgus`, `Darth Revan with Zaalbar`, `Dash Rendar`, `Dr Aphra`, `Emperor Palp with Vader Dual's End`, `Enoch`, `Executor`, `Finn`, `GAS`, `General Grievous`, `Geonosian`, `Geonosians`, `Grand Inquisitor`, `Grand Moff Tarkin`, `Great Mothers`, `Gungan`, `Gungans`, `Home One`, `Hondo`, `Iden Versio`, `Inquisitor Barriss`, `Jabba`, `Jedi Knight Revan`, `Jedi Master Kenobi`, `Jedi Master Luke`, `Jedi Master Mace Windu`, `Jedi Training Rey`, `Kelleran Beq`, `Leia Organa`, `Leviathan`, `Lord Vader`, `Malevolence`, `Maul`, `Mauldalorians`, `Maz Kanata`, `Mon Mothma`, `Mother Talzin`, `Negotiator`, `Omega (Fugitive)`, `Padme Amidala`, `Profundity`, `Queen Amidala`, `Qui-Gon Jinn`, `Raddus`, `Reva`, `Rex`, `Rey`, `SLKR`, `Satele Shan`, `Saw Gerrera`, `Sith Eternal Emperor`, `Starkiller`, `Stormtrooper Luke`, `Tarfful`, `The Stranger`, `Traya`, `Tusken`, `Veers`.

Thirty-six names have one exact `Counter_Definitions.Counter Team` match. Thirty-three have no exact counter identity and therefore cannot use the current exact-name fallback for defence composition:

`Admiral Trench`, `Ahsoka Tano`, `Carth Onasi`, `Cassian Andor (Undercover)`, `Dark Trooper Moff Gideon`, `Darth Revan with Zaalbar`, `Dr Aphra`, `Emperor Palp with Vader Dual's End`, `Finn`, `General Grievous`, `Geonosian`, `Geonosians`, `Grand Moff Tarkin`, `Gungan`, `Hondo`, `Iden Versio`, `Inquisitor Barriss`, `Jedi Master Mace Windu`, `Jedi Training Rey`, `Kelleran Beq`, `Mauldalorians`, `Maz Kanata`, `Mon Mothma`, `Omega (Fugitive)`, `Padme Amidala`, `Qui-Gon Jinn`, `Rex`, `Rey`, `Stormtrooper Luke`, `Tarfful`, `Traya`, `Tusken`, `Veers`.

- Exact counter-team-name collisions: 0.
- Ambiguous exact defence matches: 0.
- Explicit defence compositions: 0 because the optional tab is absent.
- Even the 36 unique exact-name fallbacks remain partial by current client design because attacking counter cores do not prove a complete defensive lineup.

## Duplicate and blank identifier findings

- Duplicate entity identifiers: 0 for `Counter_ID`, `Character_ID`, `External_ID`, board keys, scoring keys, defence-team keys, score-meaning keys, and counter-composition membership keys.
- Duplicate matchup composite: 1. `3v3 | Grand Inquisitor | TRAYA` appears in `Counters` rows 80 and 82. Both have tier `S`, banner score `54`, and undersize `0`; row 80 has note `Strong`, while row 82 has a blank note. The current payload preserves both entries and their order.
- Blank required identifiers: 0 across every exported source tab.

## Notes and authoring guidance

- `Counters.Notes`: 97 non-blank values.
- `Defence_Teams.Notes`: 0 non-blank values.
- `GAC_Scoring.Notes`: 14 non-blank values.
- `Score_Meanings`: 26 authoring-only guidance rows.

A privacy scan of these fields found no email address, ally-code-shaped value, cookie, authorization header, OAuth value, connection string, credential, or unrelated personal identifier.

## Persisted client keys affected by identity migration

| Local-storage key | Identity dependency |
|---|---|
| `rosterData` | Stores owned external unit IDs; migration must preserve the `External_ID` to canonical unit mapping. No roster value is included in this baseline. |
| `ownedCharacters` | Legacy roster array with the same external-unit-ID dependency; no value is included. |
| `usedTeams` | Stores counter identities and therefore depends on stable `Counter_ID` values. |
| `boardData` | Stores opponent defence display names and the frozen round layout. |
| `myBoardData` | Stores the player's defence display names and the paired round layout. |
| `defenceTemplate:5v5`, `defenceTemplate:3v3` | Store defence display names; exact-name identity changes require a deterministic client migration. |
| `bannerData` | No catalogue identity dependency. |
| `counterFilter` | No catalogue identity dependency. |
| `gacLeague` | No catalogue identity dependency. |
| `gacLastSquadMode` | No catalogue identity dependency. |

## Classified anomalies

| Classification | Count | Observation and required follow-up |
|---|---:|---|
| Migration blocker | 0 | No captured condition prevents preserving the current payload exactly. |
| Requires deterministic mapping | 4 | (1) The 33 defence names without an exact counter identity need explicit identities/compositions or a reviewed mapping. (2) The duplicate `3v3 | Grand Inquisitor | TRAYA` matchup needs an explicit preservation/deduplication rule. (3) `MAZ_KANATA` lacks a `Counter_Definitions` row and is synthesized by payload construction. (4) Eight `Defence_Teams` rows use mode `Any`, while the client wildcard lookup expects uppercase `ANY`; migration must preserve current behavior intentionally or normalize it as a separately reviewed change. |
| Safe known legacy condition | 1 | The optional `Defence_Composition` tab is absent, so the seven-key payload correctly carries an empty `defenceCompositions` object and saved-defence resolution remains partial/unresolved. |
| Informational | 2 | The `Counters` tab has two ARRAYFORMULA-derived columns. `Score_Meanings` is authoring-only and is not returned as a payload domain. |

ARCH-105 provides the canonical schema and constraints. ARCH-106 owns migration reconciliation and deterministic resolution of these captured mapping anomalies: it must not silently collapse the duplicate matchup, invent the missing `MAZ_KANATA` display definition, normalize `Any` to `ANY`, or infer any of the 33 unmatched defence identities without an explicit deterministic mapping decision.
