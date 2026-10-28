# Monthly client report: going live

On the 1st of each month (New York time) the API builds every brand's report
for the month that just ended. It only emails clients when both of these are
true:

1. The Toreronee@gmail.com sender is connected (the three env vars below).
2. The kill switch is ON (`PUT /reports/job-config` with `killSwitch: true`).
   It is OFF by default, and OFF only stores previews.

Each brand is emailed at most once per month, so restarts on the 1st are safe.

## Env vars (API server, repo root `.env` on the server)

| Name | What | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client id | Reused. Same "Toreroflow server" client the YouTube Analytics connect uses. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Reused, same client. |
| `GMAIL_REFRESH_TOKEN` | Refresh token for Toreronee@gmail.com, scope `https://www.googleapis.com/auth/gmail.send` | New. Must be minted with the client above or Google rejects it. |

No other variable is needed. The From address is fixed in code
(`REPORT_SENDER` in `packages/contracts`).

## Minting GMAIL_REFRESH_TOKEN (human, one time)

1. In console.cloud.google.com, project of the "Toreroflow server" OAuth
   client: enable the **Gmail API**.
2. OAuth consent screen: add the `gmail.send` scope. Set the publishing
   status to **In production**. In "Testing" Google expires refresh tokens
   after 7 days, so reports would stop silently.
3. On the OAuth client, add `https://developers.google.com/oauthplayground`
   as an Authorised redirect URI.
4. Open the OAuth 2.0 Playground, gear icon, tick "Use your own OAuth
   credentials", paste the client id and secret.
5. Authorise `https://www.googleapis.com/auth/gmail.send` signed in as
   **Toreronee@gmail.com** (doubled E), then "Exchange authorization code for
   tokens" and copy the refresh token.
6. Put it in the server `.env` as `GMAIL_REFRESH_TOKEN`, restart the API.
   You can remove the Playground redirect URI afterwards.

## Checking it

`GET /reports/monthly/preflight` (operator or Polly):

- `503` with `missing: [...]` and an error naming the unset vars when the
  sender is not connected. The API also logs this at boot.
- `200` with `ready: true` when all three are set.
- `?verify=true` also trades the refresh token with Google (sends no email).
  A revoked or expired token answers `503` with
  `Google rejected GMAIL_REFRESH_TOKEN (...)`.

Preview any brand without sending: `GET /reports/monthly/:brandId/:month`.

Go-live order: set the token, restart, preflight with `?verify=true` until
it answers 200, check a preview, then turn the kill switch ON.
