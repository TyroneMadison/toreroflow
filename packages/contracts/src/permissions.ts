import { z } from "zod";

/** owner and viewer match the UserRole enum; bot is a minted bot token. */
export const RoleSchema = z.enum(["owner", "viewer", "bot"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Named bot scopes. Bots never get templates:write (SPLIT-PLAN W5).
 * Everything else a bot may do stays on the route whitelist in
 * apps/api/src/auth/botAccess.ts.
 */
export const ScopeSchema = z.enum(["templates:read", "templates:apply"]);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * A bot identity. fullAccess = read, write, edit and publish across all of
 * Toreroflow, as the operator. Only Polly has it; every other bot keeps its
 * current scope. Defaults to false.
 */
export const BotIdentitySchema = z.object({
  name: z.string().min(1),
  fullAccess: z.boolean().default(false),
  scopes: z.array(ScopeSchema).default([]),
});
export type BotIdentity = z.infer<typeof BotIdentitySchema>;

export const POLLY: BotIdentity = { name: "polly", fullAccess: true, scopes: ["templates:read", "templates:apply"] };

export type Principal = { role: "owner" } | { role: "viewer" } | { role: "bot"; bot: BotIdentity };

export function hasScope(p: Principal, scope: Scope): boolean {
  if (p.role === "owner") return true;
  if (p.role === "viewer") return false;
  return p.bot.fullAccess || p.bot.scopes.includes(scope);
}

/** Preflight override: the operator or a full-access bot (Polly), always with a logged reason. */
export function canOverridePreflight(p: Principal): boolean {
  return p.role === "owner" || (p.role === "bot" && p.bot.fullAccess);
}
