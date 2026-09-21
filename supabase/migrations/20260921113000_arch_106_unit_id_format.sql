-- ARCH-106 follow-up to the ARCH-105 core schema: widen units_unit_id_format.
--
-- The ARCH-105 constraint was:
--
--   check (unit_id ~ '^[A-Z0-9]+(?:_[A-Z0-9]+)*$')
--
-- It rejected a valid, stable, public identifier. The committed ARCH-103
-- baseline carries Character_ID 'TIE_ADVANCED_x1' (Character_Definitions row
-- 287, display name 'TIE Advanced x1', external ID 'TIEADVANCED'), which is
-- also a published characterDefinitions key in the current catalogue payload.
-- Its lowercase 'x1' segment fails the uppercase-only rule, so preserving every
-- Character_ID and satisfying the constraint were not both possible. The owner
-- accepted AMEND_ARCH_105_UNIT_ID_FORMAT: keep the public identifier exactly as
-- authored and correct the constraint.
--
-- The replacement relaxes exactly one axis, letter case, and keeps every other
-- structural rule: ASCII alphanumerics and underscores only, at least one
-- character per segment, no leading or trailing underscore, and no consecutive
-- underscores.
--
-- 'TIE_ADVANCED_x1' is the only one of the 312 captured Character_ID values
-- that relies on the newly allowed form; the other 311 also satisfy the
-- original expression. gac.team_archetypes and gac.gac_scoring_rules keep their
-- uppercase-only identifier formats, which no captured value violates.

begin;

set role gac_migration_admin;

alter table gac.units drop constraint units_unit_id_format;
alter table gac.units add constraint units_unit_id_format
  check (unit_id ~ '^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$');

reset role;
commit;
