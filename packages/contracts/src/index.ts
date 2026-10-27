import { z } from "zod";
import * as W from "./workflow";
import * as I from "./ideas";

export * from "./workflow";
export * from "./ideas";
export * from "./permissions";

interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  request?: z.ZodTypeAny;
  response: z.ZodTypeAny;
}

const Ok = z.object({ ok: z.literal(true) });

/** Every route the workflow and ideas branches build, with its schemas. */
export const ENDPOINTS = {
  // Workflow (feat/toreroflow-workflow-be)
  getDraft: { method: "GET", path: "/drafts/:id", response: W.DraftSchema },
  putDraft: { method: "PUT", path: "/drafts/:id", request: W.DraftUpsertSchema, response: W.DraftSchema },
  preflight: { method: "POST", path: "/preflight", request: W.PreflightRequestSchema, response: W.PreflightResultSchema },
  overrideDraft: { method: "POST", path: "/drafts/:id/override", request: W.OverrideRequestSchema, response: W.OverrideLogSchema },
  getQueue: { method: "GET", path: "/queue", response: W.QueueResponseSchema },
  reorderQueue: { method: "PATCH", path: "/queue/reorder", request: W.QueueReorderRequestSchema, response: W.QueueResponseSchema },
  rollup: { method: "GET", path: "/rollup/:videoId", response: W.RollupSchema },
  listTemplates: { method: "GET", path: "/templates", response: W.TemplateListSchema },
  createTemplate: { method: "POST", path: "/templates", request: W.TemplateUpsertSchema, response: W.TemplateSchema },
  updateTemplate: { method: "PUT", path: "/templates/:id", request: W.TemplateUpsertSchema, response: W.TemplateSchema },
  deleteTemplate: { method: "DELETE", path: "/templates/:id", response: Ok },
  applyTemplate: { method: "POST", path: "/templates/:id/apply", request: W.TemplateApplyRequestSchema, response: W.DraftSchema },

  // Ideas (feat/toreroflow-ideas-be)
  monthlyReport: { method: "GET", path: "/reports/monthly/:brandId/:month", response: I.MonthlyReportSchema },
  getReportJobConfig: { method: "GET", path: "/reports/job-config", response: I.ReportJobConfigSchema },
  putReportJobConfig: { method: "PUT", path: "/reports/job-config", request: I.ReportJobConfigSchema, response: I.ReportJobConfigSchema },
  contentRequest: { method: "POST", path: "/requests", request: I.ContentRequestSchema, response: Ok },
  insights: { method: "GET", path: "/insights/:postId", response: I.InsightsResponseSchema },
  getBrandKit: { method: "GET", path: "/brands/:brandId/kit", response: I.BrandKitSchema },
  putBrandKit: { method: "PUT", path: "/brands/:brandId/kit", request: I.BrandKitSchema, response: I.BrandKitSchema },
  sunraQuote: { method: "POST", path: "/sunra/carousel/quote", request: I.SunraCarouselRequestSchema, response: I.SunraCarouselQuoteSchema },
  sunraGenerate: { method: "POST", path: "/sunra/carousel/:quoteId/generate", request: I.SunraGenerateRequestSchema, response: I.SunraGenerateResultSchema },
  getSunraSettings: { method: "GET", path: "/sunra/settings", response: I.SunraSettingsSchema },
  putSunraSettings: { method: "PUT", path: "/sunra/settings", request: I.SunraSettingsSchema, response: I.SunraSettingsSchema },
  createApprovalLink: { method: "POST", path: "/approval-links", request: I.ApprovalLinkCreateSchema, response: I.ApprovalLinkSchema },
  revokeApprovalLink: { method: "DELETE", path: "/approval-links/:id", response: Ok },
  listApprovalLinks: { method: "GET", path: "/approval-links", response: I.ApprovalLinkListSchema },
  publicApproval: { method: "GET", path: "/a/:token", response: I.PublicApprovalSchema },
  publicApprovalComment: { method: "POST", path: "/a/:token/comments", request: I.ApprovalCommentCreateSchema, response: I.ApprovalCommentSchema },
  publicApprovalDecision: { method: "POST", path: "/a/:token/decision", request: I.ApprovalDecisionSchema, response: I.PublicApprovalSchema },
  listFailedPosts: { method: "GET", path: "/failed-posts", response: I.FailedPostListSchema },
  retryFailedPost: { method: "POST", path: "/failed-posts/:postTargetId/retry", response: I.FailedPostRetryResultSchema },
  listAssets: { method: "GET", path: "/assets", response: I.AssetListSchema },
  repurpose: { method: "POST", path: "/repurpose", request: z.object({ sourceVideoId: z.string().min(1) }), response: I.RepurposeJobSchema },
} as const satisfies Record<string, Endpoint>;
