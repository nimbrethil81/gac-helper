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

## Note: GAC_Scoring sheet correction (fleet unit count)

The points-to-win engine's two-count model was originally specced with fleet as
**8** own / **8** enemy units. The wiki table proves fleet is a **7**-unit format.
The `GAC_Scoring` sheet should therefore carry:

```
OWN_UNITS    FLEET  ANY  7
ENEMY_UNITS  FLEET  ANY  7
```

(and, for completeness under the "sheet owns the values" principle:)

```
OWN_UNITS    SQUAD  5v5  5     ENEMY_UNITS  SQUAD  5v5  5
OWN_UNITS    SQUAD  3v3  3     ENEMY_UNITS  SQUAD  3v3  3
```

Until these rows exist the app uses built-in fallbacks; the fleet fallback is
currently **8** and should be corrected to **7** (in `ownUnitCount` /
`enemyUnitCount`). This affects the points-to-win *fleet* best-case only — the
`Banner Score` column and undersize display do not depend on it.
