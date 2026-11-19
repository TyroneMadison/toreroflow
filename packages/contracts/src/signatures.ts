import { z } from "zod";

/**
 * Contracts for document signing.
 *
 * Field positions are fractions of the page (0-1), never pixels: the placement
 * UI renders the PDF at whatever size fits the screen, while stamping happens
 * at the PDF's real point size. Storing pixels would move every signature the
 * moment those two differ.
 */

export const SignatureFieldTypeSchema = z.enum(["signature", "initials", "date", "text", "checkbox"]);
export const SignerStatusSchema = z.enum(["pending", "viewed", "signed", "declined"]);
export const SignatureRequestStatusSchema = z.enum(["draft", "sent", "completed", "declined", "voided"]);

/** A box placed on the document, as the builder sends it up. */
export const SignatureFieldInputSchema = z.object({
  /** Index into the signers array, so fields can be placed before signers have ids. */
  signerIndex: z.number().int().min(0),
  type: SignatureFieldTypeSchema,
  page: z.number().int().min(0),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  required: z.boolean().default(true),
});

export const SignerInputSchema = z.object({
  email: z.string().email(),
  name: z.string().default(""),
  /** 1-based. Equal numbers are asked to sign at the same time. */
  order: z.number().int().min(1).default(1),
});

export const SignatureRequestCreateSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().max(2000).default(""),
  clientId: z.string().nullable().default(null),
  signers: z.array(SignerInputSchema).min(1).max(20),
  fields: z.array(SignatureFieldInputSchema).default([]),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

export const SignatureFieldSchema = z.object({
  id: z.string(),
  signerId: z.string().nullable(),
  type: SignatureFieldTypeSchema,
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  required: z.boolean(),
  value: z.string().nullable(),
  filledAt: z.string().datetime().nullable(),
});

export const SignerSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  order: z.number().int(),
  status: SignerStatusSchema,
  consentAt: z.string().datetime().nullable(),
  viewedAt: z.string().datetime().nullable(),
  signedAt: z.string().datetime().nullable(),
  declinedAt: z.string().datetime().nullable(),
  declineReason: z.string(),
  /** Only ever sent to the owner, never to another signer. */
  signingUrl: z.string().optional(),
});

export const SignatureAuditEventSchema = z.object({
  id: z.string(),
  signerId: z.string().nullable(),
  type: z.string(),
  ip: z.string(),
  userAgent: z.string(),
  at: z.string().datetime(),
});

export const SignatureRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  message: z.string(),
  clientId: z.string().nullable(),
  status: SignatureRequestStatusSchema,
  pageCount: z.number().int(),
  sourceSha256: z.string(),
  signedSha256: z.string().nullable(),
  documentUrl: z.string(),
  signedUrl: z.string().nullable(),
  expiresAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string(),
  createdAt: z.string().datetime(),
  signers: z.array(SignerSchema),
  fields: z.array(SignatureFieldSchema),
  /*
   * Only /send and /remind set these: they are what that one call did, not
   * state of the document, so a later GET cannot know them and leaves them out.
   * Optional rather than defaulted for exactly that reason: `emailed: false`
   * on a fetched document would read as "the email failed" when the truth is
   * "this response is not about an email".
   *
   * A plain z.object strips unknown keys, so without these two lines the
   * fields would vanish on parse and every caller would see undefined.
   */
  emailed: z.boolean().optional(),
  emailedTo: z.array(z.string()).optional(),
  /** Whether the server can email signers at all. Optional: servers before it never sent it. */
  emailConnected: z.boolean().optional(),
});

export const SignatureRequestListSchema = z.object({
  requests: z.array(SignatureRequestSchema),
});

/** The counts the Overview tab shows. */
export const SignatureSummarySchema = z.object({
  awaitingOthers: z.number().int(),
  completed: z.number().int(),
  drafts: z.number().int(),
  expiringSoon: z.number().int(),
  recent: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: SignatureRequestStatusSchema,
      signedCount: z.number().int(),
      signerCount: z.number().int(),
      updatedAt: z.string().datetime(),
    }),
  ),
});

export const SignatureVoidSchema = z.object({ reason: z.string().max(500).default("") });

/* ---------- Public, token only ---------- */

/** What a signer is shown. Carries no other signer's contact details. */
export const PublicSigningSchema = z.object({
  requestTitle: z.string(),
  message: z.string(),
  senderName: z.string(),
  status: SignatureRequestStatusSchema,
  pageCount: z.number().int(),
  documentUrl: z.string(),
  expiresAt: z.string().datetime(),
  signer: z.object({
    name: z.string(),
    email: z.string(),
    status: SignerStatusSchema,
    consentAt: z.string().datetime().nullable(),
  }),
  /** Only this signer's own fields. */
  fields: z.array(SignatureFieldSchema),
  /** False while an earlier signer in the order still has to sign. */
  yourTurn: z.boolean(),
});

/** ESIGN consent. Must be recorded before any signature counts. */
export const SignConsentSchema = z.object({
  agreed: z.literal(true),
});

export const SignSubmitSchema = z.object({
  /** fieldId to value. A drawn signature is a PNG data URL; others are plain text. */
  values: z.record(z.string(), z.string()),
  /** The explicit act of signing, recorded alongside the values. */
  intent: z.literal(true),
});

export const SignDeclineSchema = z.object({
  reason: z.string().max(500).default(""),
});

export type SignatureFieldType = z.infer<typeof SignatureFieldTypeSchema>;
export type SignerStatus = z.infer<typeof SignerStatusSchema>;
export type SignatureRequestStatus = z.infer<typeof SignatureRequestStatusSchema>;
export type SignatureFieldInput = z.infer<typeof SignatureFieldInputSchema>;
export type SignerInput = z.infer<typeof SignerInputSchema>;
export type SignatureRequestCreate = z.infer<typeof SignatureRequestCreateSchema>;
export type SignatureField = z.infer<typeof SignatureFieldSchema>;
export type Signer = z.infer<typeof SignerSchema>;
export type SignatureRequest = z.infer<typeof SignatureRequestSchema>;
export type SignatureSummary = z.infer<typeof SignatureSummarySchema>;
export type PublicSigning = z.infer<typeof PublicSigningSchema>;
