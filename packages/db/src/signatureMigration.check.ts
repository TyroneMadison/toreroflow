import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * The signatures migration was written by hand, because Prisma needs a database
 * to diff against and this project's Postgres only exists inside the server's
 * Docker network. That trade is fine for an additive migration, but it moves
 * the risk to a typo nobody sees until `migrate deploy` fails mid-release.
 *
 * So: every field in the four new models must appear as a column, with a type
 * that matches. This is the check that would have caught it.
 */

const read = (url: URL): string => fs.readFileSync(url, "utf8").replace(/\r/g, "");

const schema = read(new URL("../prisma/schema.prisma", import.meta.url));
const sql = read(new URL("../prisma/migrations/20261118120000_signatures/migration.sql", import.meta.url));

const MODELS = ["SignatureRequest", "SignatureSigner", "SignatureField", "SignatureAuditEvent"];
const ENUMS = ["SignatureRequestStatus", "SignerStatus", "SignatureFieldType"];

/** Prisma scalar -> the Postgres type Prisma emits for it. */
const SQL_TYPE: Record<string, string> = {
  String: "TEXT",
  Int: "INTEGER",
  Float: "DOUBLE PRECISION",
  Boolean: "BOOLEAN",
  DateTime: "TIMESTAMP(3)",
  Json: "JSONB",
};

function modelBlock(name: string): string {
  const m = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(m, `model ${name} is in the schema`);
  return m[1];
}

function tableBlock(name: string): string {
  const m = sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `migration creates table ${name}`);
  return m[1];
}

for (const e of ENUMS) {
  assert.ok(sql.includes(`CREATE TYPE "${e}" AS ENUM`), `migration creates enum ${e}`);
  const vals = schema.match(new RegExp(`^enum ${e} \\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(vals, `enum ${e} is in the schema`);
  for (const v of vals[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("/"))) {
    assert.ok(sql.includes(`'${v}'`), `enum ${e} value ${v} is in the migration`);
  }
}

let checked = 0;
for (const model of MODELS) {
  const body = modelBlock(model);
  const table = tableBlock(model);

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("/") || line.startsWith("@@")) continue;
    const m = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!m) continue;
    const [, field, type, isList] = m;
    // Relation fields are not columns; they are the FK constraints below.
    if (isList || (!SQL_TYPE[type] && !ENUMS.includes(type))) continue;

    assert.ok(table.includes(`"${field}"`), `${model}.${field} has a column`);
    const expected = ENUMS.includes(type) ? `"${type}"` : SQL_TYPE[type];
    const col = table.split("\n").find((l) => l.trim().startsWith(`"${field}"`));
    assert.ok(col, `${model}.${field} column line found`);
    assert.ok(col.includes(expected), `${model}.${field} is ${expected} (got: ${col.trim()})`);
    checked += 1;
  }
}

// Foreign keys and their delete behaviour, which is what stops orphaned
// signatures outliving the request they belong to.
for (const [table, column, target, onDelete] of [
  ["SignatureRequest", "agencyId", "Agency", "CASCADE"],
  ["SignatureRequest", "clientId", "Client", "SET NULL"],
  ["SignatureSigner", "requestId", "SignatureRequest", "CASCADE"],
  ["SignatureField", "requestId", "SignatureRequest", "CASCADE"],
  ["SignatureField", "signerId", "SignatureSigner", "CASCADE"],
  ["SignatureAuditEvent", "requestId", "SignatureRequest", "CASCADE"],
] as const) {
  const fk = sql.match(new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_fkey"[^;]*;`));
  assert.ok(fk, `${table}.${column} has a foreign key`);
  assert.ok(fk[0].includes(`REFERENCES "${target}"`), `${table}.${column} points at ${target}`);
  assert.ok(fk[0].includes(`ON DELETE ${onDelete}`), `${table}.${column} deletes with ${onDelete}`);
}

// Every @@index in the schema exists in the migration.
for (const model of MODELS) {
  for (const idx of modelBlock(model).matchAll(/@@index\(\[(\w+)\]\)/g)) {
    assert.ok(sql.includes(`CREATE INDEX "${model}_${idx[1]}_idx"`), `${model} is indexed on ${idx[1]}`);
  }
}

// The migration must sort after everything that existed when it was written,
// so `migrate deploy` applies it last and its foreign keys find their tables.
// Deliberately not "it is the newest on disk": that would turn the next
// migration anyone adds into a failure of this check.
const applied = fs
  .readdirSync(new URL("../prisma/migrations", import.meta.url))
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
const self = applied.indexOf("20261118120000_signatures");
assert.ok(self >= 0, "the signatures migration is on disk");
for (const earlier of applied.slice(0, self)) {
  assert.ok(earlier < "20261118120000_signatures", `${earlier} sorts before signatures`);
}

console.log(`signatureMigration ok (${checked} columns, ${MODELS.length} tables, ${ENUMS.length} enums)`);
