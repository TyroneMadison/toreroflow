import assert from "node:assert/strict";
import { fieldsToFill, handleFrom, readWelcomeReply, WELCOME_FIELDS } from "./welcome";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The property being defended is that a client's own reply can fill a blank
 * and can never empty something. A half finished form is the normal case, and
 * a client who skips the phone box must not wipe the number already on file.
 */

/* ---- handles, however they were typed ---- */

assert.equal(handleFrom("examplemotors"), "examplemotors");
assert.equal(handleFrom("@examplemotors"), "examplemotors", "the @ is not part of it");
assert.equal(handleFrom("  @examplemotors  "), "examplemotors");
assert.equal(handleFrom("@@examplemotors"), "examplemotors");
// People paste the profile link, every time.
assert.equal(handleFrom("https://instagram.com/examplemotors"), "examplemotors");
assert.equal(handleFrom("https://www.tiktok.com/@examplemotors"), "examplemotors");
assert.equal(handleFrom("instagram.com/examplemotors?hl=en"), "examplemotors");
assert.equal(handleFrom("https://youtube.com/@realnorthstar/videos"), "realnorthstar");

/* Nothing usable stays nothing, rather than becoming a broken handle. */
for (const bad of ["", "   ", "not a handle", "https://instagram.com/", null, undefined, 42]) {
  assert.equal(handleFrom(bad), null, `${String(bad)} is not a handle`);
}

/* The same account typed three ways is stored one way. */
assert.equal(
  handleFrom("https://instagram.com/examplemotors"),
  handleFrom("@examplemotors"),
);

/* ---- reading a reply ---- */

{
  const reply = readWelcomeReply({
    id: "sub_1",
    createdAt: "2026-07-30T12:00:00Z",
    data: {
      [WELCOME_FIELDS.token]: "tok_abc",
      [WELCOME_FIELDS.contactName]: "  Northstar Concepcion ",
      [WELCOME_FIELDS.contactEmail]: "northstar@example.com",
      [WELCOME_FIELDS.contactPhone]: "   ",
      [WELCOME_FIELDS.instagram]: "@examplemotors",
      [WELCOME_FIELDS.tiktok]: "https://tiktok.com/@examplemotors",
      [WELCOME_FIELDS.youtube]: "",
      [WELCOME_FIELDS.notes]: " I post mostly trucks. ",
    },
  });

  assert.equal(reply.token, "tok_abc");
  assert.equal(reply.patch.contactName, "Northstar Concepcion", "trimmed");
  assert.equal(reply.patch.contactEmail, "northstar@example.com");
  assert.equal("contactPhone" in reply.patch, false, "a blank box is not an answer");
  assert.equal(reply.notes, "I post mostly trucks.");

  assert.deepEqual(reply.handles, [
    { platform: "instagram", handle: "examplemotors" },
    { platform: "tiktok", handle: "examplemotors" },
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
  // A blank on file gets filled.
  const fill = fieldsToFill(
    { contactName: "Northstar", contactEmail: "northstar@example.com" },
    { contactName: undefined, contactEmail: "" },
  );
  assert.deepEqual(fill, { contactName: "Northstar", contactEmail: "northstar@example.com" });
}
{
  // Something already on file is never overwritten, and never emptied.
  const fill = fieldsToFill(
    { contactName: "New Name" },
    { contactName: "Existing Name", contactPhone: "+1 555 0100" },
  );
  assert.deepEqual(fill, {}, "a stored value wins over a reply");
}
{
  // A reply that says nothing about a field leaves it exactly as it was.
  const fill = fieldsToFill({}, { contactName: "Existing", contactPhone: "+1 555 0100" });
  assert.deepEqual(fill, {});
}
{
  // Whitespace on file counts as blank, so a form can still fill it.
  const fill = fieldsToFill({ contactPhone: "+1 555 0111" }, { contactPhone: "   " });
  assert.deepEqual(fill, { contactPhone: "+1 555 0111" });
}

/* Nothing in this file can ever produce an empty string to write. */
for (const patch of [
  { contactName: "x" },
  { contactEmail: "y" },
  { contactPhone: "z" },
  {},
]) {
  for (const value of Object.values(fieldsToFill(patch, {}))) {
    assert.equal(value.length > 0, true, "a written value is never empty");
  }
}

console.log("welcome: all checks passed");
