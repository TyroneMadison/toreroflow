# Zernio support request, ready to send

Drafted 2026-07-26. Copy the body below. Everything in it was verified
against the live API, so any number quoted can be backed up if they ask.

---

**Subject:** API question: retrieving full per-account post history with view counts

---

Hi,

I'm building an internal analytics tool on top of the Zernio API and I've hit
a limit I'm hoping you can help with. I need lifetime post history with view
counts so I can rank a client's best performing videos of all time, and I
can't find a way to get further back than about 90 days.

Here's exactly what I'm seeing on my account.

**`GET /analytics`** returns 136 posts in total across 2 pages at
`limit=100`. The oldest is dated 2026-04-27. Pagination ends naturally on
page 2, so I don't think I'm truncating anything myself. I also tried these
parameters in case a date window is supported, and each one returned the same
set:

`startDate`, `from`, `since`, `start` + `end`, `dateFrom` + `dateTo`, `days`,
`period=all`, `range=all`

**`GET /accounts/{id}/posts`** returns 25 items with `likeCount` and
`commentCount` but no view or play counts, and passing `limit` or `page`
doesn't change the response.

**Meanwhile the account records themselves report much more content.** My
Instagram account shows `externalPostCount: 450` and my YouTube account shows
`externalPostCount: 201`. So Zernio clearly tracks that there is more history
than `/analytics` exposes.

One extra data point that might be useful to you: I pulled the same YouTube
channel directly from the YouTube Data API and it returns **481 videos**, not
201. So `externalPostCount` may be undercounting as well as the history being
truncated.

My questions:

1. Is there any endpoint, parameter, or plan tier that returns the **full
   per-account post history including view counts**? Even a slower or
   paginated bulk export would work fine for my use case.

2. Is the roughly 90 day window on `/analytics` a deliberate retention
   policy, a sync backfill limit, or something specific to my account? If
   it's a backfill that can be re-run, I'm happy to trigger it.

3. What is the `byokCredentials` field on the account object? It appears with
   `isActive: false` for me. If it means I can supply my own Meta and Google
   app credentials to widen what can be read, I'd like to know how to enable
   it.

4. For Instagram specifically, my account shows
   `instagram_business_manage_insights` among its granted permissions, so the
   access appears to already be in place. Is the limitation purely on the API
   surface rather than on permissions?

Happy to provide account ids or profile ids if that helps you look at the
specific records. Thanks for taking a look.

Best,
Tyrone Madison
Torerone

---

## Notes for me, not for the email

- Account ids if they ask: Instagram `6a64ff84542d8bc5a6f94a9e`, YouTube
  `6a64ffd5542d8bc5a6f95054`, profile `6a64ff7906b3124969ce0cb0`.
- Do not paste the API key into a support thread. If they ask for
  verification, send the account ids and let them look it up.
- If the answer to Q1 is no, the fallback is documented in
  `instagram-history-options.md` (our own Meta app, free but needs business
  verification and App Review).
- If the answer to Q3 is yes, that is the best outcome available: it would
  widen both Instagram and YouTube through the provider we already use,
  without a separate OAuth flow to build and maintain.
