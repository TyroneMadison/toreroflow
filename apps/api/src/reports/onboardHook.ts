/**
 * Lets the client routes publish and unpublish a report page without owning
 * the report builder.
 *
 * Onboarding a client should create their page and offboarding should take it
 * down, but all of that machinery (the merged post source, the template, the
 * Netlify deploy) lives in the reports route. Lifting it out would mean moving
 * a few hundred lines of the code that deploys to the public web, which is not
 * a refactor to do in passing.
 *
 * So the reports route registers what it can do here at startup, and the
 * client routes ask for it by name.
 *
 * ponytail: module-level singleton, fine while the API is one process
 * registering one set of report routes. If either stops being true, pass these
 * through Fastify decorators instead.
 */

export interface ReportPageHooks {
  /** Build and publish this client's page. */
  publish(clientId: string): Promise<void>;
  /** Take this client's page off the site. Absent pages are not an error. */
  unpublish(slug: string): Promise<void>;
}

let hooks: ReportPageHooks | null = null;

export function setReportPageHooks(next: ReportPageHooks): void {
  hooks = next;
}

/** Whether publishing is wired up at all, which it is not without a token. */
export function reportPageHooksReady(): boolean {
  return hooks !== null;
}

/**
 * Runs `fn` if publishing is configured, swallowing failures.
 *
 * Deliberately never throws. Onboarding a client must not fail because
 * Netlify was slow, and offboarding must not fail because a page was already
 * gone: the client record is the thing that matters, and the page can be
 * fixed with one button afterwards. `onError` gets the reason so the caller
 * can log it rather than lose it.
 */
export async function withReportPage(
  fn: (h: ReportPageHooks) => Promise<void>,
  onError: (err: unknown) => void,
): Promise<void> {
  if (!hooks) return;
  try {
    await fn(hooks);
  } catch (err) {
    onError(err);
  }
}
