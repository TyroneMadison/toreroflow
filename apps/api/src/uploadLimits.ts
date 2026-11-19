/**
 * The largest video the API takes in one upload (Clips source, library video).
 *
 * 10 GiB. The ceiling is the server's disk, not Node or Fastify: uploads
 * stream straight to STORAGE_DIR, so memory never holds the file. The prod
 * volume has about 26 GB free, which fits one 10 GiB source plus its proxy and
 * clip encodes. Caddy's request_body max_size (infra/Caddyfile) sits just above
 * this so the API, not the proxy, answers with a clear 413.
 *
 * This is the source cap only. Platform caps (Instagram 300 MB via Zernio) are
 * checked when a post is scheduled, see PLATFORM_MAX_UPLOAD_BYTES in core.
 */
export const MAX_VIDEO_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * The largest document taken for signature. 25 MiB.
 *
 * Lower than the video cap on purpose: unlike a video, this file is read whole
 * into memory to hash it and count its pages before anything is stored, and it
 * is read again on every signature to stamp a copy.
 */
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
