import type { FastifyInstance } from "fastify";
import { encryptSecret, getPrisma } from "@toreroflow/db";
import {
  authorizedChannel,
  exchangeCode,
  GoogleAuthError,
  googleAuthUrl,
  GOOGLE_SCOPES,
  YouTubeProvider,
  type GoogleCredentials,
} from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { signState, STATE_TTL_MS, verifyState } from "../oauth/state";

/**
 * Direct platform authorization, starting with Google for YouTube.
 *
 * Two routes with deliberately different front doors. The start is the
 * operator asking for a link and is behind the operator's session like every
 * other route. The callback is Google redirecting a browser we have never seen,
 * so it cannot be, and it authenticates on the signed state instead. See
 * ../oauth/state.ts, which is the whole of that argument.
 *
 * What lands at the end is a refresh token encrypted at rest, attached to a
 * PlatformConnection row rather than to SocialAccount.tokensEncrypted. That
 * separation is load-bearing: tokensEncrypted is what the publish path reads to
 * decide where a video goes, and a Google token sitting in it would have routed
 * every YouTube post to the dry-run publisher while the calendar cheerfully
 * said "posted".
 */

/** The connect link lands here after consent. Must match the console exactly. */
const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

function googleCreds(): GoogleCredentials | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OAUTH_REDIRECT_BASE) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.OAUTH_REDIRECT_BASE}${GOOGLE_CALLBACK_PATH}`,
  };
}

/**
 * The page the client's browser lands on when it comes back.
 *
 * Plain HTML written here rather than a redirect to the website, because this
 * is the one moment the app has the client's attention and a redirect to a
 * marketing page would tell them nothing about whether it worked. Self
 * contained: this page renders on a phone, in a browser that has never loaded
 * anything else of ours.
 */
function resultPage(ok: boolean, heading: string, detail: string): string {
  const accent = ok ? "#3ddc97" : "#ff6f61";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${ok ? "Connected" : "Not connected"} · Torerone</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0B0B10; color:#B9B9C6;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { max-width:30rem; margin:1.5rem; padding:2rem; background:#14141C;
          border:1px solid #282834; border-radius:14px; text-align:center; }
  h1 { margin:0 0 .75rem; font-size:1.35rem; color:#fff; }
  p { margin:0; line-height:1.6; }
  .mark { font-size:2.5rem; line-height:1; color:${accent}; margin-bottom:.75rem; }
</style></head>
<body><div class="card">
  <div class="mark">${ok ? "&check;" : "&times;"}</div>
  <h1>${heading}</h1>
  <p>${detail}</p>
</div></body></html>`;
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  /**
   * Mint the consent link for one account.
   *
   * The link is handed back rather than redirected to, because the operator is
   * usually not the person who has to click it. Caleb owns Caleb's channel, so
   * the operator copies this to him and he authorizes on his own machine, signed
   * into his own Google account. Opening it in the operator's browser would
   * authorize whatever channel the operator is signed into, which is the failure
   * the callback's channel check exists to catch.
   */
  app.post<{ Params: { accountId: string } }>(
    "/oauth/google/start/:accountId",
    { onRequest: requireAuth },
    async (request, reply) => {
      const creds = googleCreds();
      if (!creds) {
        return reply.status(503).send({
          error:
            "Google is not configured on this server. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OAUTH_REDIRECT_BASE all have to be set.",
        });
      }

      const account = await prisma.socialAccount.findFirst({
        where: {
          id: request.params.accountId,
          deletedAt: null,
          client: { agencyId: request.user.agencyId, deletedAt: null },
        },
        select: { id: true, platform: true, handle: true, tokensEncrypted: true },
      });
      if (!account) return reply.status(404).send({ error: "not found" });
      if (account.platform !== "youtube") {
        return reply
          .status(400)
          .send({ error: "Google authorization only applies to YouTube accounts." });
      }
      // A reminder account is a handle and an email address; there is no channel
      // behind it to authorize and no videos of ours on it to read.
      if (account.tokensEncrypted === "reminder") {
        return reply.status(400).send({
          error: "A reminder account has nothing to authorize. Connect the channel itself first.",
        });
      }

      const state = signState(
        { agencyId: request.user.agencyId, socialAccountId: account.id },
        env.JWT_SECRET,
      );
      return {
        authUrl: googleAuthUrl(creds, state),
        handle: account.handle,
        /** The link is good for a week, so it can be sent and forgotten about. */
        expiresInDays: Math.round(STATE_TTL_MS / (24 * 60 * 60 * 1000)),
        /*
         * Said plainly because the operator is about to send this to a client
         * and will be asked. The app is in production but unverified, which
         * Google presents as a full-page warning that reads like a malware
         * notice unless you know it is coming.
         */
        expectWarning:
          "Google will show an 'unverified app' warning. Choose Advanced, then continue.",
      };
    },
  );

  /**
   * Where Google sends the browser back.
   *
   * Everything here answers in HTML, including every failure, because a person
   * is looking at it. A JSON error body would be the last thing a client sees
   * after being asked to do the agency a favour.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    GOOGLE_CALLBACK_PATH,
    async (request, reply) => {
      const html = (status: number, ok: boolean, heading: string, detail: string) =>
        reply.status(status).type("text/html; charset=utf-8").send(resultPage(ok, heading, detail));

      const creds = googleCreds();
      if (!creds) {
        return html(503, false, "Not connected", "This server is not set up for Google yet.");
      }

      // The client pressed Cancel, or Google refused before we were involved.
      if (request.query.error) {
        return html(
          400,
          false,
          "Not connected",
          "The authorization was cancelled, so nothing was changed. You can close this page.",
        );
      }

      const verdict = verifyState(request.query.state, env.JWT_SECRET);
      if (!verdict.ok) {
        return html(
          400,
          false,
          "Not connected",
          verdict.reason === "expired"
            ? "That link has expired. Ask for a fresh one and try again."
            : "That link is not valid. Ask for a fresh one and try again.",
        );
      }

      const code = typeof request.query.code === "string" ? request.query.code : "";
      if (!code) {
        return html(400, false, "Not connected", "Google sent no authorization back.");
      }

      /*
       * The account is re-read under the agency from the state rather than
       * trusted from it, so a state that outlived its account (offboarded,
       * deleted, moved) fails here rather than writing an orphan credential.
       */
      const account = await prisma.socialAccount.findFirst({
        where: {
          id: verdict.state.socialAccountId,
          deletedAt: null,
          platform: "youtube",
          tokensEncrypted: { not: "reminder" },
          client: { agencyId: verdict.state.agencyId, deletedAt: null },
        },
        select: { id: true, handle: true },
      });
      if (!account) {
        return html(404, false, "Not connected", "That account no longer exists in the app.");
      }

      try {
        const grant = await exchangeCode(creds, code);
        const channel = await authorizedChannel(grant.accessToken);

        /*
         * Which channel actually authorized, checked against which one this
         * account is.
         *
         * A client signed into several Google accounts picks one on the consent
         * screen, and picking the wrong one is the likeliest thing to go wrong
         * in this entire flow. It also fails silently if nobody looks: the
         * report comes back full of the other channel's video ids, none of which
         * match a row here, so the sync updates nothing and says nothing while
         * the screen reads "connected".
         *
         * The expected id is resolved from the account's handle rather than read
         * from providerAccountId, which for a Zernio-connected account is
         * Zernio's own id and would never match anything. That resolution needs
         * the Data API key; without one the check is skipped rather than faked,
         * and the channel that authorized is recorded either way.
         */
        if (env.YOUTUBE_API_KEY && account.handle) {
          try {
            const expected = await new YouTubeProvider(env.YOUTUBE_API_KEY).resolveChannel(
              account.handle,
            );
            if (expected.channelId !== channel.channelId) {
              return html(
                409,
                false,
                "Wrong channel",
                `That Google account owns "${channel.title || channel.channelId}", but this is set up for "${expected.title}". Sign in with the account that owns the right channel and open the link again.`,
              );
            }
          } catch (err) {
            // A handle that cannot be resolved is not a reason to refuse a
            // credential the owner just granted. Recorded and carried on with.
            request.log.warn({ err }, "could not resolve the expected channel to compare");
          }
        }

        const row = {
          platform: "youtube" as const,
          externalId: channel.channelId,
          externalName: channel.title || null,
          refreshTokenEnc: encryptSecret(grant.refreshToken),
          scopes: grant.scopes.length ? grant.scopes : [...GOOGLE_SCOPES],
          status: "active",
          error: null,
          connectedAt: new Date(),
        };
        // One row per account: authorizing again replaces the credential rather
        // than leaving a second one nobody knows is there.
        await prisma.platformConnection.upsert({
          where: { socialAccountId: account.id },
          create: { socialAccountId: account.id, ...row },
          update: row,
        });

        /*
         * This sentence is a promise to a client, so it has to track the
         * scopes. It used to say nothing here can change anything, which was
         * true of the read-only grant and stopped being true the day
         * youtube.force-ssl joined it for the long-form work. The claim is
         * now about what the app does, stated in both directions: what the
         * connection is for, and the two things it will never do.
         */
        return html(
          200,
          true,
          "Connected",
          `${channel.title || "Your channel"} is connected. You can close this page. ` +
            "This lets Toreroflow read your channel's stats and keep your videos' details " +
            "(tags, subtitles, thumbnails) up to date. It never uploads new videos and never " +
            "deletes anything.",
        );
      } catch (error) {
        request.log.error(error, "google oauth callback failed");
        const detail =
          error instanceof GoogleAuthError
            ? error.message
            : "Something went wrong finishing the connection. Try the link again.";
        return html(502, false, "Not connected", detail);
      }
    },
  );

  /** What is directly connected, for the Settings screen. */
  app.get(
    "/oauth/connections",
    { onRequest: requireAuth },
    async (request) => {
      const rows = await prisma.platformConnection.findMany({
        where: { socialAccount: { deletedAt: null, client: { agencyId: request.user.agencyId } } },
        select: {
          socialAccountId: true,
          platform: true,
          externalName: true,
          status: true,
          error: true,
          lastSyncedAt: true,
          connectedAt: true,
        },
      });
      return { connections: rows, googleConfigured: googleCreds() !== null };
    },
  );

  /** Forget a direct credential. The account keeps publishing through Zernio. */
  app.delete<{ Params: { accountId: string } }>(
    "/oauth/connections/:accountId",
    { onRequest: requireAuth },
    async (request, reply) => {
      const connection = await prisma.platformConnection.findFirst({
        where: {
          socialAccountId: request.params.accountId,
          socialAccount: { client: { agencyId: request.user.agencyId } },
        },
        select: { id: true },
      });
      if (!connection) return reply.status(404).send({ error: "not found" });
      await prisma.platformConnection.delete({ where: { id: connection.id } });
      return { ok: true };
    },
  );
}
