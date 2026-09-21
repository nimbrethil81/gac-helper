-- ARCH-106 follow-up to the ARCH-105 core schema: allow mirror matchups.
--
-- The ARCH-105 constraint was:
--
--   constraint matchups_distinct_archetypes check (defence_archetype_id <> counter_archetype_id)
--
-- It assumed a matchup always relates two different identities. Under the
-- single team registry in TARGET_ARCHITECTURE.md section 2.2, a defence and its
-- counter can legitimately be the same archetype: the catalogue advises
-- countering a team with the same team. The committed ARCH-103 baseline carries
-- three such rows:
--
--   Counters row  60: FLEET | Executor     | EXECUTOR
--   Counters row 152: FLEET | Leviathan    | LEVIATHAN
--   Counters row 305: 5v5   | The Stranger | THE_STRANGER
--
-- The owner accepted AMEND_ARCH_105_ALLOW_MIRROR_MATCHUPS: keep one archetype
-- in both roles rather than fabricating defence-only identities for three names
-- that match exactly.
--
-- Uniqueness is unchanged. matchups_unique_relationship on
-- (mode, defence_archetype_id, counter_archetype_id) still holds, so a single
-- self-reference is valid while a duplicate self-reference is rejected.
-- gac.validate_matchup_mode() continues to require both roles to share a battle
-- type and to match the matchup mode.

begin;

set role gac_migration_admin;

alter table gac.matchups drop constraint matchups_distinct_archetypes;

reset role;
commit;
