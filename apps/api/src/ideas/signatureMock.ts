/*
 * The in-memory stand-in for Postgres that the signature checks run against.
 *
 * Extracted so signatures.check.ts and signaturesNoEmail.check.ts share ONE
 * definition. Two copies of a mock is two sets of query semantics that can
 * drift apart, and a check that passes against a mock the real client would
 * not agree with is worse than no check at all.
 *
 * Install it before building the app under test, and keep the returned arrays:
 * the assertions read them directly to see what was actually written.
 */
import { getPrisma } from "@toreroflow/db";
import { mockRateLimits } from "./testApp";

export type Row = Record<string, any>;

export interface SignatureMock {
  requests: Row[];
  signers: Row[];
  fields: Row[];
  events: Row[];
  clients: Row[];
}

export async function installSignatureMock(): Promise<SignatureMock> {
  const requests: Row[] = [];
  const signers: Row[] = [];
  const fields: Row[] = [];
  const events: Row[] = [];
  const clients: Row[] = [{ id: "c1", agencyId: "A" }];

  const prisma = getPrisma();
  const mock = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value, configurable: true });
  await mockRateLimits();

  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const hydrate = (r: Row, include?: Row) => {
    if (!include) return r;
    const mine = signers.filter((s) => s.requestId === r.id).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    return {
      ...r,
      ...(include.signers ? { signers: include.signers.select ? mine.map((s) => ({ status: s.status })) : mine } : {}),
      ...(include.fields ? { fields: fields.filter((f) => f.requestId === r.id) } : {}),
    };
  };

  mock("$transaction", async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  mock("client", { findFirst: async ({ where }: Row) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null });
  mock("signatureRequest", {
    create: async ({ data }: Row) => {
      const r = {
        id: id("req"),
        status: "draft",
        message: "",
        clientId: null,
        signedFileKey: null,
        signedSha256: null,
        sentAt: null,
        completedAt: null,
        voidedAt: null,
        voidReason: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      requests.push(r);
      return r;
    },
    findFirst: async ({ where, include }: Row) => {
      const r = requests.find((x) => x.id === where.id && x.agencyId === where.agencyId);
      return r ? hydrate(r, include) : null;
    },
    findMany: async ({ where, include }: Row) =>
      requests
        .filter(
          (r) =>
            r.agencyId === where.agencyId &&
            (!where.status || r.status === where.status) &&
            (!where.clientId || r.clientId === where.clientId),
        )
        .map((r) => hydrate(r, include))
        .reverse(),
    findUniqueOrThrow: async ({ where, include }: Row) => hydrate(requests.find((r) => r.id === where.id)!, include),
    update: async ({ where, data, include }: Row) => {
      const r = Object.assign(requests.find((x) => x.id === where.id)!, data, { updatedAt: new Date() });
      return hydrate(r, include);
    },
    // Conditional update, which is how the real code claims a document
    // exclusively: it only matches rows that still satisfy `where`, so a second
    // caller that arrives after the first has flipped the column gets count 0.
    updateMany: async ({ where, data }: Row) => {
      const matches = requests.filter((r) => {
        if (r.id !== where.id) return false;
        for (const [field, want] of Object.entries(where)) {
          if (field === "id") continue;
          if (want !== null && typeof want === "object" && "not" in (want as Row)) {
            if (r[field] === (want as Row).not) return false;
          } else if (r[field] !== want) return false;
        }
        return true;
      });
      for (const r of matches) Object.assign(r, data);
      return { count: matches.length };
    },
  });
  mock("signatureSigner", {
    create: async ({ data }: Row) => {
      const s = {
        id: id("sgn"),
        status: "pending",
        name: "",
        order: 1,
        consentAt: null,
        viewedAt: null,
        signedAt: null,
        declinedAt: null,
        declineReason: "",
        signedIp: "",
        signedUserAgent: "",
        createdAt: seq,
        ...data,
      };
      signers.push(s);
      return s;
    },
    deleteMany: async ({ where }: Row) => {
      for (let i = signers.length - 1; i >= 0; i--) if (signers[i]!.requestId === where.requestId) signers.splice(i, 1);
      return { count: 0 };
    },
    findUnique: async ({ where, include }: Row) => {
      const s = signers.find((x) => x.id === where.id);
      return s ? { ...s, ...(include?.request ? { request: hydrate(requests.find((r) => r.id === s.requestId)!, include.request.include) } : {}) } : null;
    },
    findUniqueOrThrow: async ({ where, include }: Row) => {
      const s = signers.find((x) => x.id === where.id)!;
      return { ...s, ...(include?.request ? { request: hydrate(requests.find((r) => r.id === s.requestId)!, include.request.include) } : {}) };
    },
    update: async ({ where, data }: Row) => Object.assign(signers.find((s) => s.id === where.id)!, data),
  });
  mock("signatureField", {
    createMany: async ({ data }: Row) => {
      for (const f of data) fields.push({ id: id("fld"), value: null, filledAt: null, createdAt: new Date(), ...f });
      return { count: data.length };
    },
    deleteMany: async ({ where }: Row) => {
      for (let i = fields.length - 1; i >= 0; i--) if (fields[i]!.requestId === where.requestId) fields.splice(i, 1);
      return { count: 0 };
    },
    update: async ({ where, data }: Row) => Object.assign(fields.find((f) => f.id === where.id)!, data),
  });
  mock("signatureAuditEvent", {
    create: async ({ data }: Row) => {
      const e = { id: id("evt"), signerId: null, ip: "", userAgent: "", detail: null, at: new Date(Date.now() + seq), ...data };
      events.push(e);
      return e;
    },
    findMany: async ({ where }: Row) =>
      events.filter((e) => e.requestId === where.requestId && (!where.type || e.type === where.type)),
  });

  return { requests, signers, fields, events, clients };
}
