import assert from "node:assert/strict";
import {
  fieldsToUpdate,
  handleFrom,
  mergeHandles,
  readWelcomeReply,
  WELCOME_FIELDS,
} from "./welcome";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * Two properties. An answer wins, because the client is the authority on their
 * own details and the whole point of sending the link to an existing brand is
 * that they correct what is wrong. And a blank changes nothing, because no
 * field is required, so a half finished reply is the normal case and a skipped
 * phone box must not wipe the number already on file.
 */

/* ---- handles, however they were typed ---- */

assert.equal(handleFrom("cacvmotors"), "cacvmotors");
assert.equal(handleFrom("@cacvmotors"), "cacvmotors", "the @ is not part of it");
assert.equal(handleFrom("  @cacvmotors  "), "cacvmotors");
assert.equal(handleFrom("@@cacvmotors"), "cacvmotors");
// People paste the profile link, every time.
assert.equal(handleFrom("https://instagram.com/cacvmotors"), "cacvmotors");
assert.equal(handleFrom("https://www.tiktok.com/@cacvmotors"), "cacvmotors");
assert.equal(handleFrom("instagram.com/cacvmotors?hl=en"), "cacvmotors");
assert.equal(handleFrom("https://youtube.com/@realcaleb/videos"), "realcaleb");

/* Nothing usable stays nothing, rather than becoming a broken handle. */
for (const bad of ["", "   ", "not a handle", "https://instagram.com/", null, undefined, 42]) {
  assert.equal(handleFrom(bad), null, `${String(bad)} is not a handle`);
}

/* The same account typed three ways is stored one way. */
assert.equal(
  handleFrom("https://instagram.com/cacvmotors"),
  handleFrom("@cacvmotors"),
);

/* ---- reading a reply ---- */

{
  const reply = readWelcomeReply({
    id: "sub_1",
    createdAt: "2026-07-30T12:00:00Z",
    data: {
      [WELCOME_FIELDS.token]: "tok_abc",
      [WELCOME_FIELDS.businessName]: "  Reyes Auto Group ",
      [WELCOME_FIELDS.contactName]: "  Caleb Concepcion ",
      [WELCOME_FIELDS.contactEmail]: "caleb@example.com",
      [WELCOME_FIELDS.contactPhone]: "   ",
      [WELCOME_FIELDS.instagram]: "@cacvmotors",
      [WELCOME_FIELDS.tiktok]: "https://tiktok.com/@cacvmotors",
      [WELCOME_FIELDS.youtube]: "",
      [WELCOME_FIELDS.notes]: " I post mostly trucks. ",
    },
  });

  assert.equal(reply.token, "tok_abc");
  assert.equal(reply.patch.name, "Reyes Auto Group", "the brand renames itself");
  assert.equal(reply.patch.contactName, "Caleb Concepcion", "trimmed");
  assert.equal(reply.patch.contactEmail, "caleb@example.com");
  assert.equal("contactPhone" in reply.patch, false, "a blank box is not an answer");
  assert.equal(reply.notes, "I post mostly trucks.");

  assert.deepEqual(reply.handles, [
    { platform: "instagram", handle: "cacvmotors" },
    { platform: "tiktok", handle: "cacvmotors" },
  ]);
  assert.equal(
    reply.handles.some((h) => h.platform === "youtube"),
    false,
    "an empty box adds no account",
  );
}

/* A reply with nothing in it changes nothing and still parses. */
{
  const empty = readWelcomeReply({ id: "s", createdAt: "", data: {} });
  assert.equal(empty.token, null);
  assert.deepEqual(empty.patch, {});
  assert.deepEqual(empty.handles, []);
  assert.equal(empty.notes, null);
}

/* Missing data entirely is not a crash: Netlify decides that shape, not us. */
{
  const odd = readWelcomeReply({ id: "s", createdAt: "", data: undefined as never });
  assert.deepEqual(odd.patch, {});
}

/* ---- what actually gets written ---- */

{
  // Everything they answered, whatever was there before. An earlier version of
  // this only filled blanks, which meant a client correcting their own phone
  // number changed nothing at all.
  const update = fieldsToUpdate({
    name: "Reyes Auto Group",
    contactName: "Dana Reyes",
    contactEmail: "dana@example.com",
  });
  assert.deepEqual(update, {
    name: "Reyes Auto Group",
    contactName: "Dana Reyes",
    contactEmail: "dana@example.com",
  });
}

{
  // A blank is not an answer and clears nothing: readWelcomeReply has already
  // dropped empty boxes, and anything whitespace-only is dropped here too.
  assert.deepEqual(fieldsToUpdate({}), {});
  assert.deepEqual(fieldsToUpdate({ contactPhone: "   " }), {});
  assert.deepEqual(fieldsToUpdate({ contactName: "  Dana  " }), { contactName: "Dana" });
}

/* Nothing here can ever produce an empty string to write over something real. */
for (const patch of [
  { name: "x" },
  { contactName: " y " },
  { contactEmail: "z" },
  { contactPhone: "" },
  {},
]) {
  for (const value of Object.values(fieldsToUpdate(patch))) {
    assert.equal(value.length > 0, true, "a written value is never empty");
  }
}

/* ---- handles ---- */

{
  // Filling in only the missing YouTube box must not erase the rest.
  const merged = mergeHandles({ instagram: "cacvmotors", tiktok: "cacvmotors" }, [
    { platform: "youtube", handle: "realcaleb" },
  ]);
  assert.deepEqual(merged, {
    instagram: "cacvmotors",
    tiktok: "cacvmotors",
    youtube: "realcaleb",
  });
}
{
  // A handle they corrected replaces the old one.
  const merged = mergeHandles({ instagram: "old_handle" }, [
    { platform: "instagram", handle: "new_handle" },
  ]);
  assert.deepEqual(merged, { instagram: "new_handle" });
}
{
  // Nothing stored yet, and nothing given, are both fine.
  assert.deepEqual(mergeHandles(null, [{ platform: "tiktok", handle: "a" }]), { tiktok: "a" });
  assert.deepEqual(mergeHandles({ tiktok: "a" }, []), { tiktok: "a" });
  assert.deepEqual(mergeHandles(null, []), {});
}

console.log("welcome: all checks passed");
