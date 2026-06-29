# Changelog

## v1.0
- Initial PWA
- Google Sheets integration
## v1.1
- Active 5v5 / 3v3 mode highlighting
## v1.2
- Tier colour coding
## v1.3
- Sorting
## v1.4
- Reset round
- Search bar
- More colour coding
## v1.5
- Roster import foundations
## v1.6
- Manual roster
## v1.65
- Banner tracking (manual score, opponent score, remaining, projected final)
## v1.7
- Slimmed header (subtitle removed, single-line)
- Available counters filter — "Show available only" toggle above results
- Unavailable counters collapse to a tappable count line when filter is on
- Toggle state persists across sessions (localStorage)
- Toggle disabled with hint when roster is empty
- Empty-result state when no available counters exist for selected team
## v1.8
- Tri-state counter status: Available / Used / Not owned
- Three-segment filter: [All] [Owned] [Available]
- Counters sorted by status group (Available → Used → Not owned), then tier and banner score
- Ownership vocabulary: "Owned / Not owned" replaces "Available / Unavailable"
- CURRENT ROUND card: Reset Round moved inline
## v1.9
- Roster persistence hardening: versioned storage schema `{schema, savedAt, source, owned}`,
  single `loadRoster()` / `saveRoster()` path, one-time migration from pre-v1.9 bare array
- Defensive roster re-read on every entry to the Roster screen
- "Last saved" indicator on Roster screen (date, time, source)
- Export roster to clipboard (with select-to-copy fallback)
- Import roster: paste JSON, validate before mutating, replace semantics,
  lenient-reported (imported / skipped counts), Undo import for session rollback
- `applyRoster(owned, source)` shared entry point — v2.0 API import reuses this
- Best-effort `navigator.storage.persist()` request to reduce OS eviction
- Collapsible "Manage roster data" panel (Export / Import / Undo / Clear roster)
- Clear Roster moved from header into panel — destructive action, rare in SWGOH
- Root cause confirmed: iOS WebKit purges localStorage on swipe-away from app
  switcher; persist() mitigates on Chrome/Android; v2.0 remote import is the
  durable fix
