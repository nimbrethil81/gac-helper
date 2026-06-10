# SWGOH GAC Helper App Specification

## 1. Vision

### Purpose

The SWGOH GAC Helper is a lightweight mobile-first companion app designed to help players of Star Wars: Galaxy of Heroes make better Grand Arena Championship (GAC) decisions.

The app will evolve from a simple counter lookup tool into a personal GAC planning assistant that:

* Identifies the best available counters to enemy teams.
* Tracks which teams have already been used.
* Considers the user's roster.
* Optimises banner efficiency.
* Recommends the best attack order and counter allocation.
* Ultimately acts as a "GAC co-pilot" during attack phases.

### Target User

* Intermediate to advanced SWGOH players.
* Players who participate regularly in GAC.
* Players who want to maximise banners and efficiency.
* Players who maintain their own counter knowledge and roster data.

---

# 2. Design Principles

### Mobile First

The app must be optimised for:

* iPhone
* Android
* Home Screen PWA installation

### Fast

Users should be able to find a counter within seconds.

### Maintainable

Counter information should be editable via Google Sheets without modifying application code.

### Incremental

Features should be built in stages, ensuring the app remains functional throughout development.

---

# 3. Architecture

## Front End

Technology:

* HTML
* CSS
* JavaScript
* Progressive Web App (PWA)

Hosted via:

* GitHub Pages

Repositories:

* gac-helper-dev
* gac-helper

---

## Data Layer

Counter data maintained in:

Google Sheets

Structure:

```text
Mode | Defence Team | Counter Team | Tier | Banner Score | Undersize | Notes
```

Example:

```text
5v5 | Darth Malgus | Bane | S | 64 | Yes | Preferred counter
```

---

## API Layer

Google Apps Script

Responsibilities:

* Read Google Sheet
* Convert rows to JSON
* Serve JSON to app

Example endpoint:

```text
https://script.google.com/macros/s/.../exec
```

---

## Storage

### Current

Browser Local Storage

Stores:

* Used teams
* User preferences
* Future settings

### Future

Potential cloud storage:

* Google account
* Firebase
* SWGOH.gg integration

---

# 4. Functional Requirements

## FR-001 Counter Lookup

User can:

* Select 5v5 or 3v3
* Select enemy defence team
* View available counters

Display:

* Counter Team
* Tier
* Banner Score
* Undersize viability
* Notes

---

## FR-002 Mode Selection

User can switch between:

```text
5v5
3v3
```

Selected mode must be visually highlighted.

---

## FR-003 Tier Display

Counter tiers displayed using colour coding.

| Tier | Colour |
| ---- | ------ |
| S    | Green  |
| A    | Blue   |
| B    | Orange |
| C    | Red    |

---

## FR-004 Version Display

App version displayed prominently.

Example:

```text
SWGOH Counters v1.3
```

---

## FR-005 Used Team Tracking

User can mark a counter as used.

Example:

```text
Bane
✓ USED
```

Used status persists between app launches.

Stored locally.

---

## FR-006 Round Reset

User can reset all used teams.

Button:

```text
Reset GAC Round
```

---

# 5. Use Cases

## UC-001 Find Counter

Player sees:

```text
Darth Malgus
```

Player selects:

```text
Darth Malgus
```

App displays:

```text
Bane
JKCK
Leia
```

ranked by tier.

---

## UC-002 Mark Team Used

Player defeats:

```text
Darth Malgus
```

using:

```text
Bane
```

Player taps:

```text
Mark Used
```

App records usage.

---

## UC-003 Reset Between GAC Rounds

New GAC attack phase starts.

Player taps:

```text
Reset GAC Round
```

All teams become available.

---

# 6. Future Requirements

## FR-101 Search

Search defence teams.

Example:

```text
Search:
mal
```

Results:

```text
Darth Malgus
```

---

## FR-102 Tier Sorting

Automatically display:

```text
S
A
B
C
```

order.

---

## FR-103 Hide Used Teams

Toggle:

```text
Hide Used Teams
```

Used counters removed from results.

---

## FR-104 Favourite Counters

User can star preferred counters.

Example:

```text
⭐ Bane
```

---

## FR-105 Counter Notes

Expanded notes system.

Example:

```text
Requires Datacron
Watch for Reva
```

---

# 7. Roster Integration

## Goal

Filter recommendations based on owned characters.

### Phase 1

Manual roster ownership.

Example:

```text
Own Bane: Yes
Own Bo-Katan Mand'alor: No
```

---

### Phase 2

Roster import from:

```text
swgoh.gg
```

---

### Phase 3

Automatic roster synchronisation.

---

# 8. GAC Planning Engine

## Objective

Move beyond counter lookup.

The app should recommend:

```text
Best Available Counter
```

based on:

* Remaining enemy teams
* Remaining player teams
* Banner efficiency

---

## Example

Enemy teams remaining:

```text
Lord Vader
Leia
Jabba
```

Available teams:

```text
JMK
Bane
Bo-Katan
```

App determines:

```text
Use Bane on Leia
Use JMK on Jabba
Use Bo-Katan on Lord Vader
```

to maximise success probability.

---

# 9. Banner Optimisation

Future system to estimate:

* Expected banners
* Undersize opportunities
* Solo opportunities

Example:

```text
Bane Solo
Expected banners: 65
```

---

# 10. Advanced Features

## SWGOH.gg Integration

Potential integrations:

* Player roster
* Omicrons
* Datacrons
* GAC history
* Matchup data

---

## Opponent Analysis

Import opponent roster.

Determine:

* Likely remaining teams
* Relative GP strength
* Threat assessment

---

## Battle Planner

Display:

```text
North Wall
South Wall
Fleet Wall
```

Track progress during attack phase.

---

# 11. Long-Term Roadmap

## Version 1.x

Core Counter App

* Counter lookup
* Google Sheets backend
* Tier colours
* Used team tracking
* Search

---

## Version 2.x

Personalisation

* Roster filtering
* Favourite counters
* Better planning tools

---

## Version 3.x

Roster Integration

* SWGOH.gg import
* Automatic ownership filtering

---

## Version 4.x

GAC Assistant

* Team allocation engine
* Banner optimisation
* Attack recommendations

---

## Version 5.x

Full GAC Co-Pilot

* Opponent analysis
* Match planning
* Dynamic recommendations
* End-to-end GAC guidance

---

# Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Select an enemy team.
3. Instantly view recommended counters.
4. Track which counters have already been used.
5. Complete an entire GAC attack phase without needing external notes, spreadsheets, or websites.

The long-term vision is for the app to become a personal SWGOH Grand Arena strategist rather than merely a counter lookup tool.
