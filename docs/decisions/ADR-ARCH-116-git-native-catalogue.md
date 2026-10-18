# ADR ARCH-116 — Git-native static catalogue

**Status:** Accepted — implemented. The owner approved this ADR on 2026-10-10, and the live cutover was deployed the same day (app v3.6, deployed commit `a52fbfc`). It is implemented by #41 (source and compiler), #42 (static release on Pages, §11) and #43 (app loader and cache migration, §12). [`SPEC.md`](../SPEC.md) describes the resulting runtime.  
**Decision date:** 2026-10-10.  
**Supersedes:** the Google Sheets/Apps Script catalogue-authority decisions in ADR-ARCH-113 and ADR-ARCH-115, and the database-backed catalogue-publication path of the parked architecture programme.  
**Does not supersede:** one-repository GitHub Pages delivery, the manual `Deploy Pages Live` gate, the allow-listed Pages artifact, cache-first loading, `action=roster`, or GATE-150/GATE-200 for any future evidence/automation work.  
**Downstream work:** #34 (read-only integrity/parity gate), #41 (import and compiler), #42 (static release build and Pages publication), #43 (app cutover).

## 1. Context

The shared counter/game catalogue is authored in a Google Sheet and served live by Apps Script on every app refresh. Authoring changes are not reviewable as diffs, cannot be validated before they reach users, and have no release or rollback boundary. The parked database programme solved this with Postgres + a publisher, but at a hosting/credential cost not justified for a single-user hobby PWA.

The repository is already public, CI-validated and the production gate is a manual workflow. A version-controlled catalogue compiled to static JSON and shipped through that same gate gives review, validation, release and rollback with no new service.

## 2. Decision

1. The canonical shared catalogue moves from Google Sheets to version-controlled JSON source files under `catalogue/source/` in `nimbrethil81/gac-helper`.
2. A pure, dependency-free Node compiler deterministically validates the source and generates a static catalogue release, served from the existing GitHub Pages site at the same URL.
3. Publication stays manual: only `Deploy Pages Live` publishes a catalogue. Merging to `main` publishes nothing. No scheduled, autonomous or bot writer exists.
4. The app keeps the exact seven-key `action=data` payload shape (§5), so consumer logic is unchanged; only the loader, cache envelope and service worker change.
5. Roster, board, used-team, banner and template state stay in the browser. No personal roster, ally code, account data or secret is ever committed or published.
6. Apps Script is retained **only** for `action=roster` (Comlink stays on Render). Moving the roster proxy is a separate optional issue and is not a dependency of catalogue cutover or fortnightly reviews.
7. Postgres/Supabase schema, migration/authoring/publisher scripts, Cloudflare publisher and evidence/automation assets stay parked. Pure helpers (canonical JSON, checksum, validators, immutable-write/pointer ideas) may be reused selectively; the database implementation is not activated.
8. No new hosting provider, Worker, database, scheduled task or credential is introduced.
9. Live cutover requires separate explicit owner approval (§10).

## 3. Shipped versus target

| Concern | Shipped now | Target after cutover |
|---|---|---|
| Catalogue authority | Google Sheet `SWGOH_GAC_Assistant_Data` | `catalogue/source/*.json` on `main` |
| Authoring | Direct Sheet edits, live immediately | PR → CI validation → owner merge |
| Catalogue delivery | Apps Script `action=data`, built per request | Static `catalogue/current.json` + immutable release file on Pages |
| Publication | Implicit on Sheet save | Manual `Deploy Pages Live` only |
| App cache | `catalogueCache:v1`, contract `apps-script-action-data:v1` | `catalogueCache:v2`, contract `gac-catalogue-release:v1` (§8) |
| Service worker | Ignores cross-origin Apps Script | Explicitly bypasses same-origin `catalogue/` (§8) |
| Roster | Apps Script `action=roster` → Comlink | Unchanged |
| Rollback | None (edit Sheet back) | Revert source on `main` + redeploy (§9) |

Until cutover ships, `SPEC.md` continues to describe the Sheet runtime and must not be edited to claim otherwise.

## 4. Canonical authoring schema (`catalogue/source/`, schema 1)

Each file is UTF-8 JSON, 2-space indented, with a top-level `"schema": 1` and one array. Arrays are the authoring unit so a change is a small, local diff. Files mirror the existing Sheet concepts one-to-one; no new concept or identifier is introduced. #41 may split a file only if the split is mechanical and documented (e.g. matchups per mode, already below).

| File | Array | Row fields (required **bold**) | Notes |
|---|---|---|---|
| `units.json` | `units` | **`id`** (`Character_ID`), **`name`**, **`unitType`** (`CHARACTER`/`SHIP`/`CAPITAL_SHIP`), `externalId` | Sorted by `id`. `externalId` omitted or `""` = unmapped. |
| `counters.json` | `counters` | **`id`** (`Counter_ID`), **`name`**, `strategicReserve` (`true` only), **`required`** [`Character_ID`], **`recommended`** [`Character_ID`] | Sorted by `id`. Array order is preserved into the payload. Empty arrays are legal (partial/flexible compositions). |
| `matchups/5v5.json`, `matchups/3v3.json`, `matchups/FLEET.json` | `defences` | **`defence`** (exact display name), **`counters`**: [{ **`counterId`**, **`tier`**, **`bannerScore`**, **`undersize`**, `notes` }], or for a tactical step (#112/#115) { **`counterId`**, **`role`**, **`notes`** } with no `tier`, `bannerScore` or `undersize` | One file per mode; the mode is the filename, never a field. Defences sorted by name; counter order within a defence is authored order and is preserved. |
| `defence-teams.json` | `defenceTeams` | **`defence`**, **`mode`**, **`threat`**, `notes` | Sparse by design. |
| `defence-compositions.json` | `defenceCompositions` | **`defence`**, **`mode`**, **`units`** [`Character_ID`] | Sparse by design; partial membership is legal. |
| `board-config.json` | `territories` | **`league`**, **`mode`**, **`territory`**, **`type`**, **`teamCount`** | Row order within league+mode is preserved. |
| `scoring.json` | `rules` | **`ruleId`**, **`battleType`**, **`mode`**, **`value`**, `notes` | Row order preserved. |
| `score-meanings.json` | `meanings` | **`mode`**, **`bannerScore`**, **`meaning`** | Authoring reference only; **not** compiled into the payload. |

Rules:

- **Never authored:** the legacy formula outputs `Counters.Counter Team` and `Score Meaning`. The compiler resolves a counter's display name from `counters.json`.
- **Identifiers** keep SPEC §4.2 rules: `Counter_ID`, `Character_ID`, `External_ID` are preserved exactly; no ID is renamed, generated or inferred during import.
- **Display names** (counter `name`, unit `name`, `defence`) are preserved byte-for-byte, including informal user-facing names (e.g. `GAS`, `CLS`, `Gungans` for `GUNGANS`, whose required lead is `BOSS_NASS`; `REVA` uses `THIRD_SISTER`). No leader-name convention is enforced.
- **Enumerations:** matchup mode ∈ {`5v5`,`3v3`,`FLEET`}; `defence-teams`/`defence-compositions` `mode` ∈ {`5v5`,`3v3`,`FLEET`,`ANY`}; `tier` ∈ {`S`,`A`,`B`,`C`}; matchup `role` ∈ {`SETUP`,`CLEANUP`}; `threat` ∈ {`EXTREME`,`HIGH`,`NORMAL`,`LOW`}; plus the League, Territory, Territory_Type, Battle_Type, Unit_Type enumerations in SPEC §4.2. Values are authored in their canonical case; the compiler does not case-fold.
- **Numbers:** `bannerScore` and `teamCount` are integers; `undersize` is an integer ≥ 0; `value` is a finite number. Ceilings follow from `scoring.json` and are pinned by `tests/scoring-rules.test.js`; meaning ladders live in `score-meanings.json` ([`CATALOGUE_SOURCE.md`](../CATALOGUE_SOURCE.md#scoring-data-authoring)). Validator constants must match them and are not restated here.
- **Uniqueness:** unit `id`; counter `id`; (`mode`, `defence`) per matchup file; (`mode`, `defence`, `counterId`) matchup key; (`defence`, `mode`) in each defence file; (`league`, `mode`, `territory`); (`ruleId`, `battleType`, `mode`); a `Character_ID` appears at most once per counter across `required`+`recommended`.
- **References (release mode):** every `counterId` exists in `counters.json`; every `Character_ID` exists in `units.json`; FLEET matchups reference counters whose members are `SHIP`/`CAPITAL_SHIP`, and squad matchups reference counters whose members are `CHARACTER`. Apps Script's synthesised placeholder definition for an unknown `Counter_ID` (name = ID) is not reproduced: it is an error.
- **Exactly one** positive `SETTING_DEFENCE`/`ANY`/`ANY` scoring rule (SPEC §4.1).
- **Secret scan** of all source and generated files (reuse `scanSensitive` from `scripts/catalogue-lib.js`).

The validator has two modes over the same rule set (shared with #34, not a second rule authority): **parity mode** reports every finding and is used to import and reconcile a Sheet snapshot; **release mode** fails on any blocking finding and is the only mode used to build a publishable release. Findings are classified **blocking structural error**, **editorial warning** (non-blocking) or **owner-approval-required correction** (blocking in release mode until resolved by an approved correction list, §6).

## 5. Generated `action=data` compatibility contract

The compiler emits exactly these seven keys, with the semantics SPEC §5 documents for the Sheet runtime:

| Key | Generated from | Contract |
|---|---|---|
| `counters` | `matchups/*.json` + `counters.json` names | `{mode: {defence: [{counterId, counter, tier, bannerScore, undersize, notes}]}}`; a tactical step is `{counterId, counter, role, notes}` (#112/#115). `5v5` and `3v3` always present (possibly `{}`); `FLEET` present iff it has ≥ 1 matchup. `counter` = `counters.json` `name`. `notes` = `""` when absent. |
| `counterDefinitions` | `counters.json` | `{Counter_ID: {name, required[], recommended[]}}`; `strategicReserve: true` present only when set, otherwise omitted. |
| `characterDefinitions` | `units.json` | `{Character_ID: {name, unitType, externalId}}`; `externalId` is `""` when unmapped. |
| `boardConfig` | `board-config.json` | `{LEAGUE: {mode: [{territory, type, teamCount}]}}`, source row order. |
| `scoring` | `scoring.json` | `[{ruleId, battleType, mode, value, notes}]`, source row order; `notes` `""` when absent. |
| `defenceTeams` | `defence-teams.json` | `{mode: {defence: {threat, notes}}}`; `notes` `""` when absent. |
| `defenceCompositions` | `defence-compositions.json` | `{mode: {defence: [Character_ID]}}`, authored order, de-duplicated. |

Equivalence: two payloads are equal when their **canonical JSON** is identical — object keys sorted recursively, array order significant, `JSON.stringify(sorted, null, 2) + "\n"` (existing `canonicalJson` in `scripts/baseline-lib.js`). Object key order carries no meaning (the app sorts defence names for display); array order does (stable sorts use it to break ties, and scoring/territory order is consumed positionally).

**Additive release metadata.** A release file is the seven keys plus exactly one extra top-level key, `release`. Consumers that predate it ignore it (the current `isValidCataloguePayload` already does). No metadata is placed inside any legacy key.

```json
{
  "release": {
    "contract": "gac-catalogue-release:v1",
    "sourceSchema": 1,
    "catalogueVersion": 1,
    "checksum": "sha256:<64 hex>"
  },
  "counters": {}, "counterDefinitions": {}, "characterDefinitions": {},
  "boardConfig": {}, "scoring": [], "defenceTeams": {}, "defenceCompositions": {}
}
```

The `checksum` is SHA-256 of the canonical JSON of the **seven legacy keys only** (excluding `release`), so a release can be compared directly with a canonicalised Apps Script `action=data` capture. No timestamp, commit SHA or other non-deterministic value appears in a release file; provenance lives in Git and the workflow run.

Any breaking change to the seven-key shape requires a new `contract` value and a coordinated app release; additive keys inside `release` do not.

## 6. Defence identity and known discrepancies

For the first cutover a defence's identity is **exact display name + mode**, exactly as today. No defence ID is introduced or inferred, no name variants are fuzzy-merged, and `ANY` is a consumer-side wildcard for `defenceTeams`/`defenceCompositions` lookups only (mode-specific beats `ANY`). Cross-file near-matches are reported as **candidate aliases** only. Different spellings in different modes (e.g. `Geonosian`/`Geonosians`) and defence-only composition entries (e.g. 3v3 Chief Chirpa, Iden Versio) are not assumed to be errors.

Known findings (observed 2026-10-10; #34 rechecks them against a fresh snapshot):

| Finding | Current runtime effect | Class | Resolution |
|---|---|---|---|
| Eight `Defence_Teams` rows with `Mode = Any` | App looks up `"ANY"`; these threats are never applied (read as `NORMAL`) | Owner-approval-required | Owner chooses per row: change to `ANY` (Battle Order will change) or remove. `Any` is not a legal release-mode value. |
| 5v5 `Defence_Teams.Gungan` vs `Counters` defence `Gungans` | HIGH threat never applied to `Gungans` | Owner-approval-required (candidate alias) | Owner chooses: rename row to `Gungans`, or keep/remove. Never auto-renamed. |
| 3v3 `Defence_Composition` references `KELLERAN_BEQ`, `JOCASTA_NU`, absent from `Character_Definitions` | Unknown IDs enter the defence snapshot but match no unit | Blocking reference error (release mode) | Owner chooses: add unit definitions with game-sourced `External_ID`s, or remove/replace the references. No ID or External_ID is guessed. |

Procedure: the import commit (#41) reproduces the fresh snapshot exactly, discrepancies included, and parity is proven in parity mode. Each correction then lands as a separate reviewed commit listed in an owner-approved correction list (in the PR description or issue) naming the row, the before/after and the expected runtime effect. No silent edit is permitted in the importer, compiler or validator.

## 7. Release, pointer and versioning

**Version.** `catalogue/release.json` (committed, small) holds `{ "schema": 1, "catalogueVersion": N, "checksum": "sha256:…" }`. `N` is a positive integer. `npm run catalogue:release` recompiles and rewrites it; it increments `N` iff the checksum changed. CI fails if the compiled checksum differs from `release.json`, or if the checksum changed relative to the PR base without `N` increasing. `N` never decreases or repeats, including on rollback. Clients compare **checksums** for identity and never refuse a release because of its version number.

**Generated files.** Built only into `_site` at deploy time, never committed and never read as authoring input:

- `catalogue/releases/{N}-{first 12 hex of checksum}.json` — the release file (§5); immutable by name.
- `catalogue/current.json` — the pointer:

```json
{
  "pointerSchema": 1,
  "contract": "gac-catalogue-release:v1",
  "catalogueVersion": 1,
  "checksum": "sha256:<64 hex>",
  "path": "releases/1-<12 hex>.json",
  "bytes": 0
}
```

`path` is relative to `catalogue/`; `bytes` is the release file's exact byte length. The pointer is a few hundred bytes so the routine "is there anything new?" check is cheap.

**Migration baseline.** Release 1 is the #41 import. Its checksum must equal the canonical checksum of a fresh, timestamped, read-only `action=data` capture taken immediately after the Sheet is frozen (the committed 2026-09-21 export is historical, not authoritative). Owner-approved corrections then produce release 2+. From the freeze until cutover or abandonment, catalogue edits are made only in Git; the Sheet is not edited, so there is never dual authority.

## 8. App loading, cache migration and service worker

**Load order (cache-first, unchanged in principle):**

1. Read `catalogueCache:v2`; if valid, render from it immediately.
2. Otherwise read the legacy `catalogueCache:v1`; if valid, render from it (one-time migration: its payload is the same seven-key shape). Keep v1 until a v2 entry has been written successfully, then remove v1.
3. Fetch `catalogue/current.json` with `cache: "no-cache"` and a timeout. If its `checksum` equals the cached entry's, stop (same-version launch: one small request, no payload download).
4. Otherwise fetch the release file at `path`, then accept it only if: HTTP OK, parses as JSON, `release.contract` and pointer `contract` are both `gac-catalogue-release:v1`, the SHA-256 of its canonical seven-key JSON (computed with `crypto.subtle`) equals both the pointer and `release.checksum`, and `isValidCataloguePayload` passes.
5. On acceptance, write `{ schema: 2, sourceContract: "gac-catalogue-release:v1", acceptedAt, catalogueVersion, checksum, payload }` to `catalogueCache:v2`, then apply and re-render. On any failure — offline, timeout, 404 during a deploy, truncated/corrupt body, checksum mismatch, unknown contract, storage quota — keep and keep using the existing cache, show the existing quiet status line, and retry on the next launch.
6. With no valid cache and no acceptable release, show the existing "Catalogue unavailable" screen; roster, round and other local state are untouched.

The app does not fall back to Apps Script `action=data` after cutover; that route's only remaining role is rollback (§9). Active rounds are preserved: a catalogue change never mutates saved boards, used teams, banners or the immutable `defenceSnapshot`; saved identities absent from a new catalogue continue to render as "saved; not in current catalogue".

**Service worker.** Same-origin requests under `catalogue/` are returned from the fetch handler without `respondWith`, so the browser handles them and the service worker neither caches nor serves stale catalogue data; `app.js` remains the only catalogue cache owner, as today for Apps Script. The shell cache name is bumped in the cutover release so old workers are replaced.

**Pages allow-list.** `Deploy Pages Live` gains one step before upload: run the compiler in release mode, fail the deployment on any blocking finding or on mismatch with `release.json`, and write only `catalogue/current.json` and the single current release file into `_site`. `catalogue/source/`, `release.json`, scripts, tests and docs remain outside the artifact. The compiler needs no `npm ci` and no credentials.

## 9. Release and rollback guarantees

- **Gate:** a catalogue reaches users only through a manual `Deploy Pages Live` run from `main`. CI on PRs runs the release-mode validator and the `release.json` consistency check.
- **Atomicity:** the pointer and its release file ship in the same Pages artifact, so a deployed pointer never names a missing file. A client that read the previous pointer just before a deploy may 404 on the old release path; that is handled as an ordinary refresh failure (§8, step 5).
- **Determinism:** the same source always yields byte-identical release and pointer files; `catalogue:release` run twice is a no-op.
- **Catalogue rollback:** revert the offending source commit(s) on `main` via PR, run `catalogue:release` (new higher `N`, earlier checksum), merge, run `Deploy Pages Live`. Clients pick it up by checksum difference.
- **Cutover rollback:** ship an app release that restores the Apps Script `action=data` loader. To keep this available, the Apps Script `action=data` deployment and the frozen Sheet stay intact and unedited until the owner explicitly decommissions them after a stability period. If any Git-only catalogue changes were released meanwhile, they are lost on that path unless re-entered in the Sheet; the owner accepts this explicitly before invoking it.

## 10. Performance and parity checks (measured at implementation; no results are claimed here)

Before cutover approval the implementing PR records, against a fresh baseline:

1. **Parity:** canonical checksum of release 1 = fresh `action=data` capture; per-key domain counts equal; every approved correction listed with its diff.
2. **Payload size:** current `action=data` response bytes (raw and transferred) vs release file and pointer bytes (raw and transferred with Pages compression).
3. **Cold first launch** (no cache, no service worker): time to first usable Counters render, Apps Script path vs static path.
4. **Cached repeat launch:** time to first render from cache (must not regress) and time to background refresh completion.
5. **Same-version launch:** confirm only the pointer is requested and the release file is not downloaded.
6. **Offline launch** with a v1 cache and with a v2 cache: renders from cache, no data loss.
7. **Corrupt catalogue:** truncated release, checksum mismatch, unknown contract, pointer to a missing file, invalid JSON — each leaves the existing cache in use and the app usable.
8. **Slow network:** throttled profile; the cached catalogue stays usable while the refresh is pending or times out.
9. **iPhone Safari and installed PWA:** first launch after the shell-cache bump, repeat launch, offline launch.
10. **Active-round preservation:** a round in progress before deploying a changed catalogue keeps its boards, used teams, banners and defence snapshot after refresh.

Owner approval of these results is the cutover gate. After cutover, `SPEC.md` is updated to describe the Git-native runtime, ROADMAP drops the item, and this ADR's status becomes "Accepted — implemented".

## 11. Implementation amendments (#42, 2026-10-10)

The static release build follows §5, §7 and §9 with these deliberate refinements. Procedure, behaviour and budget are in [`CATALOGUE_SOURCE.md`](../CATALOGUE_SOURCE.md#static-release-on-pages).

1. **Retained releases.** §8's "only `catalogue/current.json` and the single current release file" is widened. A Pages deployment replaces the whole site, so each deployment rebuilds from Git the current release and up to four earlier releases that still reproduce their checksum and pass the release gate. Release files are immutable by name, and their rebuilt bytes are identical across deployments. A client that read the previous pointer just before a deploy therefore usually finds its file instead of a 404 (§9's 404 handling still applies).
2. **Release ledger.** "Versions never decrease or repeat" (§7) is enforced over every `release.json` state on `main`'s first-parent history, in CI and before deployment. Rollback stays §9's source revert under a new, higher version.
3. **Deployment manifest.** One extra generated file, `catalogue/manifest.json`, records the deployed commit and each served release's bytes, file SHA-256 and recording commit. Release files and the pointer stay free of timestamps and commit SHAs (§5, §9 determinism). The app does not need the manifest. It exists for the pre-deployment guard and the post-deployment HTTPS verification.
4. **Serialisation.** Release files are compact JSON with keys sorted recursively, about the size of today's `action=data` response. Pointer and manifest are 2-space canonical JSON. Identity remains the §5 canonical seven-key checksum.
5. **Live checks.** `Deploy Pages Live` refuses to deploy over a newer or contradicting live release, and fails after deployment unless the live catalogue files become byte-identical to the artifact within 15 minutes.

## 12. Implementation amendments (#43, 2026-10-10)

The app loader and service worker follow §8 with these deliberate refinements. Operator procedure, the cutover gate and rollback steps are in [`CATALOGUE_SOURCE.md`](../CATALOGUE_SOURCE.md#cutover).

1. **v1 is kept for rollback.** §8 step 2 said to remove `catalogueCache:v1` once v2 is written. The app instead never writes or removes v1. The one exception is when storing v2 would exceed the storage quota: then v1 is removed and the write retried once. A §9 cutover rollback can therefore render offline straight away. v1 is read only when no valid v2 entry exists.
2. **Identity is recomputed.** The same-version check compares the pointer checksum with a fresh SHA-256 of the cached payload, not with the stored `checksum` field. A damaged cache cannot hide a new release. A v1 cache whose payload already matches the pointer is recorded as v2 without downloading the release.
3. **The pointer is constrained.** A pointer is accepted only with `pointerSchema` 1, a known contract, a positive integer version and `bytes`, and `path` exactly `releases/{N}-{12 hex}.json` for its own version and checksum. Nothing else is ever fetched from it. A release must be exactly `bytes` long before it is parsed.
4. **Timeouts cover the body.** The pointer request has 10 s and the release 30 s, each including the response body, so a stalled transfer fails rather than hangs.
5. **Quota failures don't block a verified release.** If a verified release cannot be stored, it is still applied for the session. The previous cache stays as it was, and the next launch downloads the release again. A cold start therefore does not show "Catalogue unavailable" only because storage is full.
6. **No duplicate render.** A cached launch renders once. It renders again only if a new release was applied or the refresh failed. The interim "checking for updates" line is gone, so a same-version launch is one render and one pointer request.

## 13. Implementation amendments (#36, 2026-10-10)

Routine approved counter maintenance continues to use `catalogue/corrections/*.json` and the compiler/release/Pages path above, with these safeguards. The operator contract and recovery procedure are in [`CATALOGUE_SOURCE.md`](../CATALOGUE_SOURCE.md#applying-an-approved-counter-change-set).

1. **Versioned correction contract.** Historical schema-1 C1–C5 lists remain reproducible. New work uses schema 2, binding an exact `main` commit and release version/checksum to explicit Add/Amend/Retire endpoints, stable source-row keys, provenance, affected references, expected runtime impact and exact compiled-payload paths. It creates no parallel catalogue or approval store; decision history remains linked to GitHub.
2. **Exact approval.** An approved proposal carries the owner's exact GitHub issue-comment or PR-review link and a checksum of its proposal ID, source/release baseline and ordered source changes. Editing the baseline or diff invalidates approval. Other decision states are preview-only.
3. **Fail-closed apply.** Preview and apply run the unchanged shared release gate over the whole coherent result. They reject stale or overlapping rows, ambiguous aliases, source/release/base-ref drift and undeclared compiled impact. Apply writes one approved proposal atomically on a dedicated branch and does not version, commit, merge or deploy it.
4. **Publication and rollback unchanged.** `catalogue:release`, owner-reviewed PR/merge and manual `Deploy Pages Live` remain separate gates. A live rollback still restores only a release on `main`'s first-parent ledger and records its checksum under a new higher version; failed deploy verification is not an automatic undo.
