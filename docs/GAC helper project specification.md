# SWGOH GAC Helper App Specification

## Overview

SWGOH GAC Helper is a mobile-first web application designed to support Grand Arena Championship (GAC) planning in Star Wars: Galaxy of Heroes.

The app provides a fast, simplified counter lookup experience focused on practical decision-making during a live GAC round.

The design philosophy is:

* Fast to use during a match
* Easy to maintain
* Mobile friendly
* Focused on strategic team identities rather than exact squad compositions
* Incrementally extensible towards future planning and roster-aware functionality

---

### Purpose

The SWGOH GAC Helper is a lightweight mobile-first companion app designed to help players of Star Wars: Galaxy of Heroes make better Grand Arena Championship (GAC) decisions.

The app will evolve from a simple counter lookup tool into a personal GAC planning assistant that:

* Identifies the best available counters to enemy teams.
* Tracks which teams have already been used.
* Considers the user's roster.
* Optimises banner efficiency.
* Recommends the best attack order and counter allocation.
* Ultimately acts as a "GAC co-pilot" during attack phases.

  ---

# Core Objectives

The app should allow a player to:

1. Select the current GAC mode (5v5 or 3v3)
2. Search for an enemy defence team
3. View recommended counters
4. View counter quality and expected banners
5. Track which counters have already been used
6. Determine whether a counter can be fielded from the player's roster
7. Support future GAC planning functionality

---

### Target User

* Intermediate to advanced SWGOH players.
* Players who participate regularly in GAC.
* Players who want to maximise banners and efficiency.
* Players who maintain their own counter knowledge and roster data.

---


# Design Principles

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

# MVP Functional Requirements

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

---

## FR-004 Version Display

App version displayed.

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

---

# Current Architecture

## Front End

### index.html

Responsible for:

* App shell
* Loading scripts
* Loading styles
* Registering service worker

### styles.css

Responsible for:

* Theme
* Layout
* Responsive design
* Counter card styling

### app.js

Responsible for:

* Data loading
* State management
* Rendering
* Counter lookup
* Used team tracking
* Availability calculation

---

## Back End

### Google Sheets

Primary data store.

### Google Apps Script

Provides JSON API consumed by the web app.

---

# Data Model

## Character_Definitions

Master list of all playable characters.

### Columns

| Column         | Description                 |
| -------------- | --------------------------- |
| Character_ID   | Stable internal identifier  |
| Character_Name | Human-readable display name |

### Example

| Character_ID   | Character_Name |
| -------------- | -------------- |
| DARTH_BANE     | Darth Bane     |
| LEIA_ORGANA    | Leia Organa    |
| CAPTAIN_DROGAN | Captain Drogan |

---

## Counter_Definitions

Master list of strategic counter teams.

A Counter_ID represents a team identity rather than a specific squad composition.

### Columns

| Column          | Description                    |
| --------------- | ------------------------------ |
| Counter_ID      | Stable internal identifier     |
| Counter Team    | Display name                   |
| Required 5v5    | Required characters for 5v5    |
| Recommended 5v5 | Recommended characters for 5v5 |
| Required 3v3    | Required characters for 3v3    |
| Recommended 3v3 | Recommended characters for 3v3 |

### Example

| Counter_ID | Counter Team |
| ---------- | ------------ |
| LEIA       | Leia         |
| BANE       | Bane         |
| STARKILLER | Starkiller   |

### Design Principles

Counter definitions describe:

> Can the player reasonably field this counter?

They do not attempt to model every matchup-specific squad variation.

Example:

### Counter_ID

LEIA

### Required 5v5

* LEIA_ORGANA
* CAPTAIN_DROGAN

### Recommended 5v5

* HAN_SOLO
* CHEWBACCA
* R2_D2

---

## Counters

Relationship table between defence teams and counter teams.

### Columns

| Column       | Description             |
| ------------ | ----------------------- |
| Mode         | 5v5 or 3v3              |
| Defence Team | Enemy team              |
| Counter_ID   | Counter team identifier |
| Counter Team | Display name            |
| Tier         | S/A/B/C                 |
| Banner Score | Expected banner score   |
| Undersize    | Yes/No                  |
| Notes        | Optional notes          |

### Example

| Defence Team | Counter_ID |
| ------------ | ---------- |
| Darth Malgus | LEIA       |
| Darth Malgus | BANE       |
| Darth Malgus | STARKILLER |

---

# Identifier Standards

## Counter_ID

Rules:

* Uppercase
* Underscores
* No spaces
* Stable once created

Examples:

```text
LEIA
BANE
STARKILLER
GREAT_MOTHERS
BO_MANDALOR
REX_PHOENIX
```

---

## Character_ID

Rules:

* Uppercase
* Underscores
* Based on official character names
* Stable once created

Examples:

```text
LEIA_ORGANA
CAPTAIN_DROGAN
DARTH_BANE
EMPEROR_PALPATINE
GREAT_MOTHERS
```

---

# Current Features

## Counter Lookup

User selects:

* Mode
* Defence Team

App displays:

* Counter Team
* Tier
* Expected Banners
* Undersize
* Notes

---

## Used Team Tracking

User can mark a counter as used.

Used teams are stored locally.

Used counters display with reduced opacity.

---

## Counter Availability

Availability is based on ownership of all required characters.

### Available

All required characters owned.

```text
🟢 Available
```

### Unavailable

One or more required characters missing.

```text
🔴 Unavailable
```

Missing characters are listed.

Example:

```text
🔴 Unavailable

Missing:
Mara Jade
Starkiller
```

---

# Roster Model

## Ownership

Character-level ownership only.

Example:

```text
Owned:
- Darth Bane
- Leia Organa
- Captain Drogan

Not Owned:
- Mara Jade
- Starkiller
```

No relics, gear levels, zetas, omicrons, mods or GP are considered at this stage.

---

## Availability Rules

A counter is available if:

```text
All required characters are owned
```

Recommended characters are ignored for availability calculations.

---

# API Contract

Google Apps Script returns:

```json
{
  "counters": {},
  "counterDefinitions": {},
  "characterDefinitions": {}
}
```

## counters

Contains:

```json
{
  "5v5": {},
  "3v3": {}
}
```

---

## counterDefinitions

Contains:

```json
{
  "LEIA": {
    "name": "Leia",
    "required5v5": [],
    "recommended5v5": [],
    "required3v3": [],
    "recommended3v3": []
  }
}
```

---

## characterDefinitions

Contains:

```json
{
  "LEIA_ORGANA": "Leia Organa"
}
```

---

# Roadmap

## Version 1.5 - Roster Foundations

Completed

### Delivered

* Counter_ID architecture
* Character_Definitions sheet
* Counter_Definitions sheet
* Apps Script support
* Availability engine
* Availability indicators
* Missing character display

---

## Version 1.6 - Manual Roster

Planned

### Objectives

* Roster screen
* Character search
* Character ownership toggles
* Local storage persistence
* Availability updates automatically

---

## Version 1.7 - Available Counters Filter

Planned

### Objectives

* Show Available Only toggle
* Hide unavailable counters
* Improve decision speed during live GAC

---

## Version 1.8 - Used Team Awareness

Planned

### Objectives

Combine:

* Availability
* Used team tracking

Example:

```text
🟢 Available
🟡 Already Used
🔴 Unavailable
```

---

## Version 2.0 - Roster Import

Planned

### Objectives

Import roster data from external sources.

Potential sources:

* SWGOH.gg
* HotUtils
* Other publicly available roster APIs

Manual roster functionality should remain available as a fallback.

---

## Future Vision

Long-term direction is a roster-aware GAC planning assistant.

Potential future features:

* Automatic roster imports
* Team allocation planning
* Counter conflict detection
* Banner optimisation
* Defence strategy support
* GAC round planning
* Opponent roster analysis
* Statistical counter recommendations

The application should continue prioritising simplicity and speed over attempting to replicate the full functionality of SWGOH.gg.

# Success Criteria

A user should be able to:

1. Open the app from their Home Screen.
2. Select an enemy team.
3. Instantly view recommended counters.
4. Track which counters have already been used.
5. Complete an entire GAC attack phase without needing external notes, spreadsheets, or websites.

The long-term vision is for the app to become a personal SWGOH Grand Arena strategist rather than merely a counter lookup tool.
