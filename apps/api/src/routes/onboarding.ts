import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  fieldsToUpdate,
  mergeHandles,
  readWelcomeReply,
  type WelcomeReply,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { NetlifyPublisher } from "../reports/netlify";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { ZernioProvider } from "@toreroflow/publishers";

/**
 * The welcome link a client gets after they pay.
 *
 * The whole point is that this works with the API sitting on one laptop.
 * A client's phone cannot reach it, so nothing here asks it to:
 *
 *  - The form lives on torerone.com, where the site already captures form
 *    submissions. The link carries a token identifying the brand.
 *  - The app PULLS those submissions from the host's API when the operator
 *    asks. Nothing pushes to us, so there is nothing to host.
 *  - Connecting a social account happens on the publishing provider's own
 *    hosted pages, which the client can open on their phone and authorise
 *    directly. Those links are generated here and sent with the welcome link.
 *
 * That is why this exists without the hosted backend everything else in this
 * area has been waiting on.
 */

/** Where the form lives. The site is found by this domain, not by an id. */
const SITE_DOMAIN = "torerone.com";
const WELCOME_FORM = "client-welcome";

/**
 * Where a brand's connect links are published for their own welcome page to
 * read. Same site the report pages go to, reached from torerone.com through
 * the `/connect/*` proxy so the page fetches it same-origin.
 */
const connectFilePath = (token: string) => `/connect/${token}.json`;

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  const publisher = () =>
    env.NETLIFY_AUTH_TOKEN ? new NetlifyPublisher(env.NETLIFY_AUTH_TOKEN) : null;

  const notConfigured = {
    error: "welcome links need the publishing token",
    detail:
      "Set NETLIFY_AUTH_TOKEN in the repo root .env and restart the API. It is the same token report publishing uses.",
  } as const;

  /**
   * The site the connect files are published to: the same one report pages use.
   *
   * torerone.com proxies /connect/* to it, so the welcome page fetches the file
   * same-origin and nothing has to think about cross-origin rules.
   */
  const reportsSiteId = async (): Promise<string | null> =>
    env.NETLIFY_SITE_ID || null;

  /** The site serving torerone.com, found by its domain so no id is stored. */
  const welcomeSiteId = async (): Promise<string | null> => {
    const net = publisher();
    if (!net) return null;
    const sites = await net.listSites();
    const match = sites.find((s) => s.custom_domain === SITE_DOMAIN);
    return match?.id ?? null;
  };

  /**
   * The link to send, and the connect links to send with it.
   *
   * The token is minted once and kept. Regenerating it would break a link
   * already sitting in a client's messages, and this is the link they were
   * told to use.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/welcome-link",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: {
          id: true,
          name: true,
          onboardingToken: true,
          onboardedAt: true,
          providerProfileId: true,
        },
      });
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const token =
        client.onboardingToken ??
        (
          await prisma.client.update({
            where: { id: client.id },
            data: { onboardingToken: crypto.randomBytes(9).toString("base64url") },
            select: { onboardingToken: true },
          })
        ).onboardingToken!;

      /*
       * The provider's own hosted authorise pages, one per platform.
       *
       * These are the piece that lets a client connect their accounts from
       * their phone: the login happens on the platform's page, the tokens stay
       * with the provider, and this app is not involved in the round trip.
       * Best effort, because a provider outage should still produce a link
       * the client can fill in.
       */
      const connect: Array<{ platform: string; url: string }> = [];
      const provider =
        env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
          ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
          : null;
      if (provider && client.providerProfileId) {
        for (const platform of ["instagram", "tiktok", "youtube", "facebook"] as const) {
          try {
            connect.push({
              platform,
              url: await provider.connectUrl(platform, client.providerProfileId),
            });
          } catch (err) {
            app.log.warn({ err, platform }, "could not build a connect link");
          }
        }
      }

      /*
       * The connect links are published where the client's own welcome page
       * can read them, so one link does everything: they fill in the form and
       * tap to connect on the same page.
       *
       * They cannot be generated by that page. Building one needs the
       * publishing provider's API key, which must never sit in a public page,
       * and this API is not reachable from a phone. So they are made here and
       * left somewhere static for the page to pick up by token.
       *
       * Republished every time this runs, so pressing the button again is also
       * how stale links get refreshed.
       */
      let connectPublished = false;
      const net = publisher();
      if (net && connect.length) {
        try {
          const siteId = await reportsSiteId();
          if (siteId) {
            await net.publish(siteId, {
              [connectFilePath(token)]: JSON.stringify({
                brand: client.name,
                connect,
                builtAt: new Date().toISOString(),
              }),
            });
            connectPublished = true;
          }
        } catch (err) {
          app.log.error({ err }, "could not publish the connect links for the welcome page");
        }
      }

      return {
        url: `https://${SITE_DOMAIN}/welcome?c=${encodeURIComponent(token)}`,
        token,
        connect,
        /** False when the page will show the form only, so the screen can say so. */
        connectPublished,
        onboardedAt: client.onboardedAt,
        /** Said plainly so the screen never implies the page is live when it is not. */
        note:
          connect.length === 0
            ? "No connect links yet: this brand has no publishing workspace, so they can only fill in the form for now."
            : null,
      };
    },
  );

  /**
   * Pulls replies and applies them.
   *
   * An answer wins. The client is the authority on their own name, number and
   * handles, so what they write replaces what is on file: that is the point of
   * sending the link to a brand that already exists. A box they left empty is
   * not an answer and clears nothing, because no field on the form is required
   * and a half finished reply is the normal case.
   */
  app.post("/onboarding/check", async (request, reply) => {
    const net = publisher();
    if (!net) return reply.status(503).send(notConfigured);

    let submissions: WelcomeReply[];
    try {
      const siteId = await welcomeSiteId();
      if (!siteId) {
        return reply.status(502).send({
          error: "could not find the website",
          detail: `No Netlify site is serving ${SITE_DOMAIN} on this account, so there is nowhere to read replies from.`,
        });
      }
      submissions = await net.formSubmissions(siteId, WELCOME_FORM);
    } catch (err) {
      app.log.error({ err }, "could not read welcome replies");
      return reply.status(502).send({
        error: "could not read the replies",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const applied: Array<{ client: string; filled: string[]; handles: number }> = [];
    let unmatched = 0;
    /** Replies seen before. Counted so a quiet check can say why it was quiet. */
    let alreadyApplied = 0;

    for (const submission of submissions) {
      const parsed = readWelcomeReply(submission);
      if (!parsed.token) {
        unmatched += 1;
        continue;
      }
      const client = await prisma.client.findFirst({
        where: {
          onboardingToken: parsed.token,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
        select: { id: true, name: true, handles: true, welcomeRepliesApplied: true },
      });
      if (!client) {
        unmatched += 1;
        continue;
      }

      /*
       * Applied once, ever.
       *
       * Every check reads the whole list of replies back from the host, so
       * without this the same answers would be written again on every press.
       * That is not harmless now that an answer wins: a detail corrected by
       * hand afterwards would be silently reverted to what the client typed
       * weeks earlier.
       */
      if (client.welcomeRepliesApplied.includes(submission.id)) {
        alreadyApplied += 1;
        continue;
      }

      const fill = fieldsToUpdate(parsed.patch);

      /*
       * Their handles are merged, not replaced. Answering only the YouTube box
       * must not erase the Instagram handle they gave last time.
       *
       * Stored apart from connected accounts on purpose: a typed handle cannot
       * post anything, and writing one in as an account would put a row on
       * screen that looks connected and is not. Connecting is the separate tap
       * that goes to the provider.
       */
      const handles = parsed.handles.length
        ? mergeHandles(client.handles as Record<string, string> | null, parsed.handles)
        : undefined;

      await prisma.client.update({
        where: { id: client.id },
        data: {
          ...fill,
          ...(handles ? { handles } : {}),
          onboardedAt: new Date(),
          welcomeRepliesApplied: { push: submission.id },
        },
      });

      /*
       * What they wrote is kept as a note, not turned into accounts.
       *
       * A handle they typed is not a connected account: connected accounts
       * only ever come back from the publishing provider, and writing one here
       * would put a row on screen that cannot post anything. Nor are these
       * inspiration accounts, which mean the opposite thing, someone whose
       * content they want theirs to resemble.
       *
       * So it lands where free text about a brand belongs, ready for the
       * operator to read and act on, and easy to delete.
       */
      const body = [
        ...parsed.handles.map((h) => `${h.platform}: @${h.handle}`),
        ...(parsed.notes ? ["", parsed.notes] : []),
      ].join("\n");
      if (body.trim()) {
        await prisma.knowledgeNote.create({
          data: {
            clientId: client.id,
            title: `From their welcome form, ${new Date(submission.createdAt || Date.now()).toLocaleDateString("en-US")}`,
            body,
          },
        });
      }

      applied.push({
        // The name they gave, where they gave one, so the operator reads what
        // the brand is called now rather than what it used to be.
        client: fill.name ?? client.name,
        filled: Object.keys(fill),
        handles: parsed.handles.length,
      });
    }

    return { checked: submissions.length, applied, unmatched, alreadyApplied };
  });
}
