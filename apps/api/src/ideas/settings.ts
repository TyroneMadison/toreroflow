import type { z } from "zod";
import { getPrisma, type Prisma } from "@toreroflow/db";

/**
 * One agency setting, parsed with its contract schema. A missing or invalid
 * row reads as the default, so a hand-edited value can never switch a job on.
 */
export async function readSetting<S extends z.ZodTypeAny>(
  agencyId: string,
  key: string,
  schema: S,
  fallback: z.infer<S>,
): Promise<z.infer<S>> {
  const row = await getPrisma().appSetting.findUnique({ where: { agencyId_key: { agencyId, key } } });
  const parsed = schema.safeParse(row?.value);
  return parsed.success ? parsed.data : fallback;
}

export async function writeSetting(agencyId: string, key: string, value: unknown): Promise<void> {
  const json = value as Prisma.InputJsonValue;
  await getPrisma().appSetting.upsert({
    where: { agencyId_key: { agencyId, key } },
    create: { agencyId, key, value: json },
    update: { value: json },
  });
}
