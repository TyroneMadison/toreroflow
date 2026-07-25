import { z } from "zod";
import { PLATFORMS } from "./types";

export const platformSchema = z.enum(PLATFORMS);

export const registerSchema = z.object({
  agencyName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createClientSchema = z.object({
  name: z.string().min(1).max(120),
  plan: z.string().max(60).optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const connectAccountSchema = z.object({
  handle: z.string().min(1).max(120).optional(),
});
export type ConnectAccountInput = z.infer<typeof connectAccountSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(120),
  sourcePlatform: platformSchema,
  destinations: z.array(platformSchema).min(1),
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const schedulePostSchema = z.object({
  platforms: z.array(platformSchema).min(1),
  scheduledAt: z.string().datetime({ offset: true }),
  caption: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});
export type SchedulePostInput = z.infer<typeof schedulePostSchema>;

export const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  sourcePlatform: platformSchema.optional(),
  destinations: z.array(platformSchema).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
