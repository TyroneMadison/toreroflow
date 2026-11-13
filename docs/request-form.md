# Public request form

Clients send content requests without logging in, but only through their
brand's signed link. The old `POST /requests` with a `brandId` in the body
is gone.

## Public routes (no login)

- `GET /r/:token`: brand name, Turnstile site key (null when off), max file
  size, allowed file types.
- `POST /r/:token`: JSON, or multipart with one optional file in field
  `file`. Fields: `what` (required, 2000 chars), `dueDate` (YYYY-MM-DD),
  `footageUrl` (http/https, 2000 chars), `notes` (4000 chars), `website`
  (honeypot, leave hidden and empty), `turnstileToken` (or the widget's own
  `cf-turnstile-response`). Unknown fields are refused.

Checks, in order: 5 per IP per 10 minutes and 100 per link per day (counted
in the `RateLimitBucket` table, so they hold across restarts and servers),
live link (forged 404, revoked 410), honeypot, fields, Turnstile, file.
JSON bodies over 32 KB answer 413. Files: 10 MB, PNG, JPEG, WebP or PDF,
decided by the file's first bytes, never its name or Content-Type.

Behind Caddy in production the client address is the last
`X-Forwarded-For` entry, which Caddy writes.

## Operator routes (login; viewers read only)

- `POST /request-links` `{ brandId }`: a new link. The response has `url`
  (`/r/<token>`), the link to give the client on the API host.
- `GET /request-links?brandId=`: every link, with revoked ones.
- `POST /request-links/:id/rotate`: turn this link off and get its
  replacement in one step.
- `DELETE /request-links/:id`: turn a link off for good.
- `GET /request-links/audit?brandId=`: the latest 200 audit entries:
  submitted, rejected (with why), rate_limited (once per window),
  captcha_failed, bad_token, link_created, link_rotated, link_revoked.

Tokens are `<link id>.<HMAC>` signed with `JWT_SECRET` and never stored, so
changing `JWT_SECRET` turns every form link (and approval link) off.

## Captcha (off by default)

Set `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` in the API server's
repo root `.env` and restart. With the secret empty the API never calls
Cloudflare.

## Migration

`packages/db/prisma/migrations/20261027130000_ideas_request_form_hardening`
(generated offline). Brands have no links after it runs: make one per brand
with `POST /request-links` and send it to the client.
