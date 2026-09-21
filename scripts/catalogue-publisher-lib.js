"use strict";

const { checksumFor, generatePayload, validateAssessedProvenance, validatePayload } = require("./catalogue-lib.js");

const PUBLICATION_LOCK_KEY = 108108;

class PublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationError";
    this.code = code;
  }
}

function asId(value) {
  return value === null || value === undefined ? null : String(value);
}

function asJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function query(database, sql, params = []) {
  return database.query(sql, params);
}

async function withPublicationTransaction(database, operation) {
  await database.exec("begin");
  try {
    await query(database, "set local role gac_publisher");
    await query(database, "select pg_advisory_xact_lock($1::bigint)", [PUBLICATION_LOCK_KEY]);
    const result = await operation();
    await database.exec("commit");
    return result;
  } catch (error) {
    try { await database.exec("rollback"); } catch {}
    throw error;
  }
}

async function readState(database, { forUpdate = false } = {}) {
  const result = await query(database, `
    select s.current_release_id, s.publication_generation,
           r.version as current_version, r.checksum as current_checksum
    from gac.catalogue_state s
    left join gac.catalogue_releases r on r.release_id = s.current_release_id
    where s.singleton_id = true
    ${forUpdate ? "for update of s" : ""}
  `);
  return result.rows[0];
}

async function readRelease(database, releaseId) {
  const result = await query(database, `
    select release_id, version, payload_schema_version, base_release_id,
           previous_release_id, release_reason, status, payload, checksum,
           source_commit_sha, deployed_commit_sha, cloudflare_deployment_id,
           published_at
    from gac.catalogue_releases
    where release_id = $1
  `, [releaseId]);
  if (result.rows.length !== 1) throw new PublicationError("RELEASE_NOT_FOUND", `Release ${releaseId} does not exist`);
  return { ...result.rows[0], payload: asJson(result.rows[0].payload) };
}

async function assertAuthoringChanges(database, changeIds) {
  if (changeIds.length === 0) throw new PublicationError("AUTHORING_PROVENANCE", "AUTHORING releases require at least one applied authoring change");
  const placeholders = changeIds.map((_, index) => `$${index + 1}`).join(", ");
  const rows = (await query(database, `
    select change_id, status from gac.authoring_changes
    where change_id in (${placeholders})
  `, changeIds)).rows;
  const byId = new Map(rows.map((row) => [row.change_id, row.status]));
  for (const changeId of changeIds) {
    if (byId.get(changeId) !== "APPLIED") {
      throw new PublicationError("AUTHORING_PROVENANCE", `Authoring change ${changeId} is missing or not APPLIED`);
    }
  }
}

async function prepareRelease(database, options) {
  const {
    expectedBaseReleaseId = null,
    releaseReason,
    sourceCommitSha,
    generatedAt = new Date().toISOString(),
    authoringChangeIds = [],
    provenanceReference = releaseReason === "MIGRATION" ? "ARCH-106" : "ARCH-108",
    scope = {},
    provenanceKind = ({ MIGRATION: "MIGRATION", AUTHORING: "AUTHORING_CHANGE", MAINTENANCE: "MAINTENANCE_RUN", APPROVED_OVERRIDE: "AUTHORING_CHANGE" })[releaseReason],
    validation = {}
  } = options;

  return withPublicationTransaction(database, async () => {
    const state = await readState(database, { forUpdate: true });
    if (asId(state.current_release_id) !== asId(expectedBaseReleaseId)) {
      throw new PublicationError(
        "STALE_BASE",
        `Expected base release ${asId(expectedBaseReleaseId) ?? "none"}, current release is ${asId(state.current_release_id) ?? "none"}`
      );
    }
    if (releaseReason === "AUTHORING") await assertAuthoringChanges(database, [...new Set(authoringChangeIds)]);
    await validateAssessedProvenance(database);

    const versionRow = (await query(database, "select coalesce(max(version), 0)::bigint + 1 as version from gac.catalogue_releases")).rows[0];
    const version = Number(versionRow.version);
    const payload = await generatePayload(database, {
      version,
      baseReleaseId: asId(state.current_release_id),
      releaseReason,
      generatedAt,
      sourceCommitSha,
      authoringChangeIds: [...new Set(authoringChangeIds)]
    });
    validatePayload(payload, validation);

    const inserted = (await query(database, `
      insert into gac.catalogue_releases (
        version, payload_schema_version, base_release_id, previous_release_id,
        release_reason, scope, status, payload, checksum, source_commit_sha
      ) values ($1, $2, $3, $3, $4, $5::jsonb, 'READY', $6::jsonb, $7, $8)
      returning release_id, version, status, checksum
    `, [
      version, payload.payloadSchemaVersion, state.current_release_id, releaseReason,
      JSON.stringify(scope), JSON.stringify(payload), payload.checksum, sourceCommitSha
    ])).rows[0];

    const releaseId = inserted.release_id;
    if (releaseReason === "AUTHORING") {
      for (const changeId of [...new Set(authoringChangeIds)].sort()) {
        await query(database, "insert into gac.catalogue_release_authoring_changes (release_id, change_id) values ($1, $2)", [releaseId, changeId]);
      }
    }
    if (!provenanceKind) throw new PublicationError("PROVENANCE_KIND", `No provenance kind is defined for ${releaseReason}`);
    await query(database, `
      insert into gac.catalogue_release_provenance (release_id, kind, reference_code, details)
      values ($1, $2, $3, $4::jsonb)
    `, [releaseId, provenanceKind, provenanceReference, JSON.stringify({ sourceCommitSha, authoringChangeIds: [...new Set(authoringChangeIds)].sort() })]);

    return { ...inserted, payload, baseReleaseId: state.current_release_id };
  });
}

async function finaliseRelease(database, {
  releaseId,
  deployedCommitSha,
  deploymentId,
  publishedAt = new Date().toISOString(),
  beforePointerUpdate = null
}) {
  return withPublicationTransaction(database, async () => {
    const state = await readState(database, { forUpdate: true });
    const release = await readRelease(database, releaseId);
    if (release.status === "DEPLOYED" && asId(state.current_release_id) === asId(releaseId)) {
      return { action: "already-finalised", releaseId: asId(releaseId) };
    }
    if (release.status !== "READY") throw new PublicationError("RELEASE_NOT_READY", `Release ${releaseId} is ${release.status}, not READY`);
    if (asId(state.current_release_id) !== asId(release.base_release_id)) {
      throw new PublicationError("STALE_BASE", "The current release changed after this release was prepared");
    }
    if (checksumFor(release.payload) !== release.checksum) throw new PublicationError("CHECKSUM_MISMATCH", "Stored release payload checksum is invalid");

    await query(database, `
      update gac.catalogue_releases
      set status = 'DEPLOYED', deployed_commit_sha = $2,
          cloudflare_deployment_id = $3, published_at = $4
      where release_id = $1
    `, [releaseId, deployedCommitSha, deploymentId, publishedAt]);
    if (beforePointerUpdate) await beforePointerUpdate();
    await query(database, `
      update gac.catalogue_state
      set current_release_id = $1,
          publication_generation = publication_generation + 1,
          updated_at = statement_timestamp()
      where singleton_id = true
    `, [releaseId]);
    if (state.current_release_id !== null) {
      await query(database, "update gac.catalogue_releases set status = 'SUPERSEDED' where release_id = $1", [state.current_release_id]);
    }
    return { action: "finalised", releaseId: asId(releaseId) };
  });
}

async function rollbackRelease(database, {
  targetReleaseId,
  deploymentId,
  deployedCommitSha,
  verifiedChecksum,
  currentPayloadSchemaVersion = 1,
  rolledBackAt = new Date().toISOString()
}) {
  return withPublicationTransaction(database, async () => {
    const state = await readState(database, { forUpdate: true });
    if (asId(state.current_release_id) === asId(targetReleaseId)) return { action: "already-current", releaseId: asId(targetReleaseId) };
    const target = await readRelease(database, targetReleaseId);
    if (target.status !== "SUPERSEDED") throw new PublicationError("ROLLBACK_TARGET", `Release ${targetReleaseId} is not a retained SUPERSEDED release`);
    if (Number(target.payload_schema_version) !== currentPayloadSchemaVersion) {
      throw new PublicationError("INCOMPATIBLE_SCHEMA", `Release ${targetReleaseId} uses payload schema ${target.payload_schema_version}; expected ${currentPayloadSchemaVersion}`);
    }
    if (target.checksum !== verifiedChecksum || checksumFor(target.payload) !== target.checksum) {
      throw new PublicationError("CHECKSUM_MISMATCH", "Rollback artifact is absent, changed, or unverified");
    }
    const current = await readRelease(database, state.current_release_id);

    await query(database, "update gac.catalogue_releases set status = 'DEPLOYED' where release_id = $1", [targetReleaseId]);
    await query(database, `
      insert into gac.catalogue_release_provenance (release_id, kind, reference_code, details)
      values ($1, 'ROLLBACK', $2, $3::jsonb)
      on conflict (release_id, kind, reference_code) do nothing
    `, [targetReleaseId, `from-release-${current.release_id}`, JSON.stringify({ deploymentId, deployedCommitSha, rolledBackAt })]);
    await query(database, `
      update gac.catalogue_state
      set current_release_id = $1,
          publication_generation = publication_generation + 1,
          updated_at = statement_timestamp()
      where singleton_id = true
    `, [targetReleaseId]);
    await query(database, "update gac.catalogue_releases set status = 'SUPERSEDED' where release_id = $1", [current.release_id]);
    return { action: "rolled-back", releaseId: asId(targetReleaseId), version: Number(target.version) };
  });
}

async function reconcilePublication(database, { deployment, verify, deployedCommitSha }) {
  const state = await readState(database);
  const readyRows = (await query(database, `
    select release_id from gac.catalogue_releases
    where status = 'READY'
    order by version desc
  `)).rows;
  const live = await deployment.readPointer();

  for (const row of readyRows) {
    const ready = await readRelease(database, row.release_id);
    if (live && Number(live.catalogueVersion) === Number(ready.version) && live.checksum === ready.checksum) {
      await verify(ready);
      return finaliseRelease(database, {
        releaseId: ready.release_id,
        deployedCommitSha,
        deploymentId: live.deploymentId ?? "reconciled-external-deployment"
      });
    }
  }

  if (state.current_release_id !== null) {
    const current = await readRelease(database, state.current_release_id);
    if (live && Number(live.catalogueVersion) === Number(current.version) && live.checksum === current.checksum) {
      return { action: "already-consistent", releaseId: asId(current.release_id) };
    }
    const deployed = await deployment.deploy(current);
    await verify(current);
    return { action: "restored-current", releaseId: asId(current.release_id), deploymentId: deployed.deploymentId };
  }
  if (live !== null) throw new PublicationError("UNKNOWN_LIVE_RELEASE", "A live catalogue exists while the database has no current release");
  return { action: "empty-consistent" };
}

module.exports = {
  PUBLICATION_LOCK_KEY,
  PublicationError,
  finaliseRelease,
  prepareRelease,
  readRelease,
  readState,
  reconcilePublication,
  rollbackRelease,
  withPublicationTransaction
};
