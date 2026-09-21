"use strict";

function connectPostgres(connectionString) {
  if (!connectionString) throw new Error("SUPABASE_PUBLISHER_DATABASE_URL is required");
  const postgres = require("postgres");
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    ssl: "require",
    connect_timeout: 15,
    idle_timeout: 20
  });
  return {
    async query(statement, params = []) {
      const rows = await sql.unsafe(statement, params);
      return { rows, rowCount: rows.count ?? rows.length };
    },
    async exec(statement) { await sql.unsafe(statement); },
    async close() { await sql.end({ timeout: 5 }); }
  };
}

module.exports = { connectPostgres };
