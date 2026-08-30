# GAC Scoring Reference

**Scope.** This document is the specialist reference for scoring maths and for authoring the `Banner Score` and `Undersize` fields used by the app. It owns scoring rules, ceilings, score-meaning tables, worked examples, and scoring-data guidance. It must not document general application behaviour, release history, or future product work. Current system behaviour belongs in `SPEC.md`; release history belongs in `../changelog.md`; future work belongs in `../ROADMAP.md`.

**Update this document when** GAC scoring rules or constants, score-meaning tables, worked examples, or `Banner Score` / `Undersize` authoring guidance changes. Application behaviour that merely consumes those values belongs in `SPEC.md` instead.

It captures how many banners a battle is worth, so a hand-authored expected score can be placed consistently against a shared meaning.

The two counter fields own **non-overlapping** parts of a counter's value:

- **`Banner Score`** — the **full-squad, first-attempt, clean-clear** expected value. No undersizing or later-attempt adjustment is baked in.
- **`Undersize`** — the maximum units the counter can drop from a full squad and still win cleanly (`0` = full squad). Each unit dropped is worth **+1 banner** over the full-squad clean clear, so the undersize total is `Banner Score + Undersize`.

Author `Banner Score` using the full-squad, first-attempt tables below; let `Undersize` carry the undersize upside separately. Attempt state is dynamic match state and must not be encoded into a counter's authored `Banner Score`.

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

Two levers change the total between modes: the **number of enemy units** (defeated bonus) and the **number of own units** (survive / health / protection bonuses). A flawless full squad therefore has a fixed ceiling per mode:

| Mode  | Units | Ceiling | Working |
|-------|-------|---------|---------|
| 5v5   | 5     | **65**  | 45 + 5 defeated + 5×3 survive/health/prot |
| 3v3   | 3     | **57**  | 45 + 3 defeated + 3×3 |
| Fleet | 7     | **73**  | 45 + 7 defeated + 7×3 |

**Attempt adjustment.** A **second-attempt** win is **−20** relative to the first-attempt value (the +30 first-attempt bonus drops to +10); a **third-or-later** win is **−30** (no attempt bonus). These adjustments describe live battle scoring only. Do **not** subtract them when authoring `Banner Score`, which always represents a first-attempt expectation; the app applies attempt state separately from the opponent board's Battles count.

**Undersize adjustment.** Dropping a unit trades its 3 per-unit banners (survive, health, protection) for a +4 unused-slot bonus — a net **+1 per unit dropped**, in a flawless win. This is why fewer units can score higher, and it is what the `Undersize` count encodes. The theoretical single-battle maxima are **69** (5v5, solo), **61** (3v3, solo), and **79** (fleet, solo).

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

Fleet is a **7-unit** format (capital ship + 6). All 7 count toward the survive, health, and protection bonuses in a flawless win; survival bonuses are a flat +1 per ship (not scaled). The SWGOH Wiki "Fleet Max Banners" table gives a flawless first-attempt 7-ship win as 73, rising to 79 for a solo ship.

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

### Fleet undersize ladder

The fleet scoring table confirms the +1-per-drop rule end to end:

| Ships fielded | 7 | 6 | 5 | 4 | 3 | 2 | 1 |
|---------------|---|---|---|---|---|---|---|
| First-attempt total | 73 | 74 | 75 | 76 | 77 | 78 | 79 |
| Second-attempt total | 53 | 54 | 55 | 56 | 57 | 58 | 59 |
| Third+ attempt total | 43 | 44 | 45 | 46 | 47 | 48 | 49 |

---

## Whole-board theoretical maximum

A theoretical board ceiling sums the perfect-clear value of every uncleared team plus the clear bonus for every territory that still contains an uncleared team. Locked territories are included because the ceiling represents the banners available from clearing the whole remaining board. The application behaviour that consumes this ceiling is specified in `SPEC.md`.

Per-territory, for a fresh board, the calculation is:

```
squad territory  = teams × 57  + 120 + 28 × teams      (3v3)
squad territory  = teams × 65  + 120 + 30 × teams      (5v5)
fleet territory  = teams × 73  + 120 + 33 × teams
```

### Worked example — Kyber 3v3

Board config: three 5-team squad territories + one 3-team fleet territory = 18 teams.

| Territory | Teams | Battles | Clear bonus | Subtotal |
|-----------|-------|---------|-------------|----------|
| Squad ×3  | 5 each | 3 × (5×57) = 855 | 3 × (120 + 28×5) = 780 | 1635 |
| Fleet ×1  | 3 | 3×73 = 219 | 120 + 33×3 = 219 | 438 |
| **Board** | **18** | | | **2073** |

With the one-off first-attack bonus, the theoretical opening ceiling is **2083**. This is close to the community "soft max" of roughly 2079–2080 for Kyber 3v3 and provides a useful sanity check on the configured team counts and scoring values.

The figure is only as correct as the **`GAC_Board_Config`** team counts: the scoring calculation multiplies out whatever the sheet specifies, so incorrect counts there would mis-state the ceiling.

---

## GAC_Scoring unit-count authoring

`OWN_UNITS` and `ENEMY_UNITS` represent separate scoring inputs: the number of the player's own units eligible for per-unit survival bonuses and the number of enemy units defeated in a perfect clear. For the current battle formats they are equal.

If the `GAC_Scoring` sheet carries explicit unit-count rows, use:

```
OWN_UNITS    FLEET  ANY  7
ENEMY_UNITS  FLEET  ANY  7

OWN_UNITS    SQUAD  5v5  5
ENEMY_UNITS  SQUAD  5v5  5

OWN_UNITS    SQUAD  3v3  3
ENEMY_UNITS  SQUAD  3v3  3
```

These rows are optional because the app has matching fallbacks. If explicit rows are present, they override the fallbacks, so their values must match the format's actual unit counts. In particular, fleet is **7** units (capital ship + 6).
