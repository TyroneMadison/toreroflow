import { env } from "../env";
import { signedFilePath } from "./signing";

/**
 * The one way a route hands out a file address.
 *
 * A thin wrapper over signedFilePath so no call site has to remember to reach
 * for the secret, and so `grep fileLink` finds every place the app gives out a
 * link to something in storage. A bare `/files/${key}` anywhere in a route is
 * now a bug: it will 404 rather than serve.
 */
export function fileLink(storageKey: string): string {
  return signedFilePath(storageKey, env.JWT_SECRET);
}

/**
 * The same, with a cache-buster for content that changes under a stable key.
 *
 * A regenerated game plan keeps its storage key, so without this the webview
 * would keep showing the copy it already had. The parameter sits outside the
 * signature, which is free to ignore it.
 */
export function fileLinkVersioned(storageKey: string, version: number | null): string {
  const base = fileLink(storageKey);
  return version === null ? base : `${base}&v=${version}`;
}
