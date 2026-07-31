# GAC Scoring Reference

An authoring aid for the `Banner Score` and `Undersize` columns in the **Counters**
tab. It captures how many banners a battle is worth, so a hand-authored expected
score can be placed consistently against a shared meaning.

From v2.8, the two columns own **non-overlapping** parts of a counter's value:

- **`Banner Score`** — the **full-squad, first-attempt, clean-clear** expected value.
  No undersizing baked in.
- **`Undersize`** — the maximum units the counter can drop from a full squad and
  still win cleanly (`0` = full squad). Each unit dropped is worth **+1 banner** over
  the full-squad clean clear, so the app reconstructs the undersize total as
  `Banner Score + Undersize`.

Author the `Banner Score` using the full-squad tables below; let the `Undersize`
count carry the undersize upside separately.

---

## How a battle is scored

A single clean **first-attempt** win banks:

```
  15   Victory
+ 30   First attempt
+  1   per enemy unit defeated
+  1   per own unit surviving
+  1   per own unit at 100% health
+  1   per own unit at 100% protection
+  4   per unused (deliberately empty) squad slot
```

Two levers change the total between modes: the **number of enemy units** (defeated
bonus) and the **number of own units** (survive / health / protection bonuses). A
flawless full squad therefore has a fixed ceiling per mode:

| Mode  | Units | Ceiling | Working |
|-------|-------|---------|---------|
| 5v5   | 5     | **65**  | 45 + 5 defeated + 5×3 survive/health/prot |
| 3v3   | 3     | **57**  | 45 + 3 defeated + 3×3 |
| Fleet | 7     | **73**  | 45 + 7 defeated + 7×3 |

**Attempt adjustment.** These tables are all first-attempt values. A **second-attempt**
win is **−20** (the +30 first-attempt bonus drops to +10); a **third-or-later** win is
**−30** (no attempt bonus). Subtract accordingly when scoring a counter you expect to
need more than one go.

**Undersize adjustment.** Dropping a unit trades its 3 per-unit banners (survive,
health, protection) for a +4 unused-slot bonus — a net **+1 per unit dropped**, in a
flawless win. This is why fewer units can score higher, and it is what the `Undersize`
count encodes. The theoretical single-battle maxima are **69** (5v5, solo), **61** (3v3,
solo), and **79** (fleet, solo).

---

## 5v5 — full squad (ceiling 65)

| Score | Meaning |
|-------|---------|
| 65 | Flawless — no losses, full health & protection |
| 64 | Very efficient — trivial chip damage |
| 63 | Efficient — light damage, no losses |
| 62 | Standard clean win — some damage, no losses |
| 61 | Occasionally lose a unit |
| 60 | Reliable but inefficient — usually lose a unit |
| 58 | Risky — often lose two |
| 55 | Cleanup likely — messy, multiple losses |

## 3v3 — full squad (ceiling 57)

| Score | Meaning |
|-------|---------|
| 57 | Flawless — no losses, full health & protection |
| 56 | Very efficient — trivial chip damage |
| 55 | Efficient — light damage, no losses |
| 54 | Standard clean win — some damage, no losses |
| 53 | Occasionally lose a unit |
| 52 | Reliable but inefficient — usually lose a unit |
| 50 | Risky — often lose two |
| 48 | Cleanup likely — messy, multiple losses |

## Fleet — full squad (ceiling 73)

Fleet is a **7-unit** format (capital ship + 6). All 7 count toward the survive,
health, and protection bonuses in a flawless win; survival bonuses are a flat +1
per ship (not scaled). Ceiling verified against the SWGOH Wiki "Fleet Max Banners"
table: a flawless first-attempt 7-ship win banks 73, rising to 79 for a solo ship.

| Score | Meaning |
|-------|---------|
| 73 | Flawless — all 7 ships survive, full health & protection |
| 71 | Very efficient — trivial chip damage |
| 69 | Efficient — light damage, no losses |
| 67 | Standard clean win — some damage, no losses |
| 64 | Occasionally lose a ship |
| 61 | Reliable but inefficient — usually lose a ship |
| 57 | Risky — often lose two |
| 52 | Cleanup likely — messy, multiple losses |

### Fleet undersize ladder (from the wiki table, first attempt)

Confirms the +1-per-drop rule end to end:

| Ships fielded | 7 | 6 | 5 | 4 | 3 | 2 | 1 |
|---------------|---|---|---|---|---|---|---|
| First-attempt total | 73 | 74 | 75 | 76 | 77 | 78 | 79 |
| Second-attempt total | 53 | 54 | 55 | 56 | 57 | 58 | 59 |
| Third+ attempt total | 43 | 44 | 45 | 46 | 47 | 48 | 49 |

---

## Whole-board theoretical maximum (worked example)

The **can-I-win** verdict and the **points-to-win** remaining figure both use the
*theoretical maximum* the board can still yield — every uncleared team across every
territory, locked or not, cleared perfectly, plus each territory's clear bonus. This
is the ceiling for "is the round still mathematically winnable". Per-territory it is:

```
squad territory  = teams × 57  + 120 + 28 × teams      (3v3)
squad territory  = teams × 65  + 120 + 30 × teams      (5v5)
fleet territory  = teams × 73  + 120 + 33 × teams
```

**Worked example — Kyber 3v3** (board config: three 5-team squad territories +
one 3-team fleet territory = 18 teams):

| Territory | Teams | Battles | Clear bonus | Subtotal |
|-----------|-------|---------|-------------|----------|
| Squad ×3  | 5 each | 3 × (5×57) = 855 | 3 × (120 + 28×5) = 780 | 1635 |
| Fleet ×1  | 3 | 3×73 = 219 | 120 + 33×3 = 219 | 438 |
| **Board** | **18** | | | **2073** |

(2083 with the one-off first-attack bonus.) This matches the community "soft max"
of ~2079–2080 for Kyber 3v3 to within a couple of banners — a useful sanity check
that the config team counts and scoring values are right. The small residual
(2073 vs ~2080) is within noise for a winnability ceiling; a single clean full-board
run would pin it exactly if ever needed.

The figure is only as correct as the **`GAC_Board_Config`** team counts: the walker
multiplies out whatever the sheet specifies, so wrong counts there (not a code bug)
would mis-state the ceiling.

---

## Note: GAC_Scoring sheet — fleet unit count (resolved in v2.8)

The points-to-win two-count model was originally specced with fleet as **8** own /
**8** enemy units. The wiki "Fleet Max Banners" table proved fleet is a **7**-unit
format (capital + 6), and the app's fallbacks were corrected to 7 in v2.8. If the
`GAC_Scoring` sheet carries explicit rows, they should read 7 for fleet:

```
OWN_UNITS    FLEET  ANY  7
ENEMY_UNITS  FLEET  ANY  7
```

(and, for completeness under the "sheet owns the values" principle:)

```
OWN_UNITS    SQUAD  5v5  5     ENEMY_UNITS  SQUAD  5v5  5
OWN_UNITS    SQUAD  3v3  3     ENEMY_UNITS  SQUAD  3v3  3
```

These rows are optional — the app falls back to the correct counts (7 for fleet,
5/3 for squads) without them. If added, fleet rows must read 7, not 8, or they would
override the correct fallback with the wrong value. This affects the points-to-win
*fleet* best-case only — the `Banner Score` column and undersize display do not
depend on it.
