# Getting lifetime Instagram history

Written 2026-07-26, after YouTube lifetime history shipped.

## The problem

The publishing provider serves 76 Instagram posts. Caleb's account actually
holds **468 media items**. So Instagram rankings and all-time totals are
missing roughly 85% of his catalogue, the same gap YouTube had before we
read it directly from the platform.

## What we already know about the account

Pulled from the provider's own account record, so no guesswork:

| Fact | Value | Why it matters |
| --- | --- | --- |
| Account type | `MEDIA_CREATOR` | Creator account, so the Instagram API path is available. A Personal account would rule it out entirely. |
| Media count | 468 | The real catalogue size. |
| Provider exposes | 76 | The gap we are trying to close. |
| Instagram user id | `27569150829432543` | Needed by any API call. |
| Instagram scoped id | `17841471753708337` | Needed by any API call. |
| Provider's granted scopes | includes `instagram_business_manage_insights` | **The provider already holds insights permission.** |
| Provider token expiry | 2026-09-23 | Their token is current. |
| `byokCredentials.isActive` | `false` | The provider appears to support bring-your-own credentials, switched off. |

## Option A: ask the provider to expose it (cheapest by far)

The provider already has an active token with
`instagram_business_manage_insights` on a qualifying Creator account. Every
permission needed already exists; the only obstacle is that their API does
not offer a per-account lifetime post list with view counts.

What to ask them:

> Our account shows `externalPostCount: 450` for Instagram and
> `mediaCount: 468`, but `GET /analytics` only ever returns posts published
> in roughly the last 90 days (oldest 2026-04-27), and
> `GET /accounts/{id}/posts` returns 25 items with no view counts.
> Is there any endpoint, parameter, or plan that returns the full
> per-account post history with view counts? We need lifetime figures to
> rank a client's best-performing videos of all time.
>
> Separately: what is `byokCredentials`, and can we supply our own Meta app
> credentials to widen what we can read?

Cost: one support message. Risk: they may simply say no.

## Option B: our own Meta app (what Tyrone asked about)

Everything here is **free**. No fees for the developer account, the app,
business verification, App Review, or Instagram Graph API usage. The cost is
time and paperwork.

### Step 1, developer account
Go to developers.facebook.com and register. Free, instant.

### Step 2, create the app
My Apps, Create App. Pick a business-type app. Add the Instagram product.
Meta currently offers two routes, and the newer one is simpler:
- **Instagram API with Instagram Login**, which does not require a Facebook
  Page to be linked.
- **Instagram API with Facebook Login**, the older route, which does.

Prefer Instagram Login if it is offered.

### Step 3, business verification
Business Settings, Security Center. Meta asks for a legal business name,
address, and a supporting document such as a business registration, utility
bill, or bank statement in the business name.

**This is the step to think about before starting.** If Torerone is not a
registered entity, verification can stall. Nothing else in this list is
blocked by paperwork; this one is.

### Step 4, App Review for `instagram_business_manage_insights`
Submit a screencast showing what the app does with the data and why it needs
insights. Meta reviews it. Expect days to weeks, and approval is not
guaranteed for small internal apps. Stating plainly that it is an internal
agency tool reading accounts the agency manages tends to go better than
vague descriptions.

### Step 5, we build the OAuth flow
Once approved: Caleb authorizes our app, we store his long-lived token,
refresh it before the 60-day expiry, and page `/{ig-user-id}/media` for the
full catalogue plus per-media insights.

Roughly the same shape as the YouTube work already done, so the build itself
is the small part.

## What Instagram will and will not give us

Worth setting expectations before anyone invests weeks:

- **Reels** report `plays` and `reach`, so they can be ranked by views.
- **Photos and carousels** have no view metric at all. Those posts can never
  join a most-viewed ranking, regardless of permissions.
- Historical insights on older media have been unreliable in practice, so
  "all-time" on Instagram may still be a shorter window than YouTube's.

So even a fully approved app yields less than the YouTube result. The 468
media items are not 468 rankable videos.

## Recommendation

Send the provider message first, because it is one email against weeks of
verification for a permission they already hold. Start Step 1 and Step 2 of
the Meta app in parallel if wanted, since both are free and instant, but
hold off on business verification until the provider has answered.
