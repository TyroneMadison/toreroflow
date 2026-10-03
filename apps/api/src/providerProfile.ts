import { getPrisma } from "@toreroflow/db";
import { ZernioError, type ZernioProvider } from "@toreroflow/publishers";

/**
 * The publishing profile backing a client, created on first use.
 *
 * The provider refuses a second profile with the same name, and a deleted
 * client's profile can outlive the client (it cannot be deleted while
 * accounts are still connected to it). Re-adding a client under the same
 * name then failed on every press, and the welcome page went out with no
 * connect buttons. A same-name profile that no live client uses is that
 * client's own workspace coming back, accounts and all, so it is adopted.
 * One a live client still uses is never shared.
 */
export async function ensureProviderProfile(
  zernio: ZernioProvider,
  client: { id: string; name: string; providerProfileId: string | null },
): Promise<string> {
  if (client.providerProfileId) return client.providerProfileId;
  const prisma = getPrisma();
  let profileId: string;
  try {
    profileId = await zernio.createProfile(client.name);
  } catch (err) {
    if (!(err instanceof ZernioError && err.code === "profile_name_conflict")) throw err;
    const sameName = (await zernio.listProfiles()).find(
      (p) => p.name.trim().toLowerCase() === client.name.trim().toLowerCase(),
    );
    const inUse = sameName
      ? await prisma.client.findFirst({
          where: { providerProfileId: sameName._id, deletedAt: null, id: { not: client.id } },
          select: { id: true },
        })
      : null;
    if (!sameName || inUse) throw err;
    profileId = sameName._id;
  }
  await prisma.client.update({ where: { id: client.id }, data: { providerProfileId: profileId } });
  return profileId;
}
