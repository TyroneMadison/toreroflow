/** Base URL of the Toreroflow API (Fastify service). */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4700";
