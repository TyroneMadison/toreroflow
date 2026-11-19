import { useCallback, useState } from "react";
import { useToast } from "../Toasts";
import { api, type SignatureRequest } from "../../lib/api";

/**
 * Opening one contract, and the three things an owner can do to it.
 *
 * Shared by the Overview card and the Contracts screen so the two cannot
 * drift. Every one of these answers with the request itself, which is why each
 * puts the response straight back into `open`: the detail view then shows the
 * result of the action without a second fetch.
 */
export function useRequestActions(reload: () => Promise<void> | void) {
  const toast = useToast();
  const [open, setOpen] = useState<SignatureRequest | null>(null);

  const openRequest = useCallback(
    async (id: string) => {
      try {
        setOpen(await api.get<SignatureRequest>(`/signature-requests/${id}`));
      } catch (err) {
        toast.fail("Could not open that document", err);
      }
    },
    [toast],
  );

  /** Finish, remind or send: all three answer with the request. */
  const act = useCallback(
    async (path: string, ok: string, fail: string) => {
      try {
        const r = await api.post<SignatureRequest>(path);
        setOpen(r);
        // Said here rather than in the detail view because a reminder that sent
        // nothing is the one case where the cheerful toast would be a lie.
        if (r.emailed === false) toast.success(`${ok}, but no email went out. Copy the links and send them yourself`);
        else toast.success(ok);
        await reload();
      } catch (err) {
        toast.fail(fail, err);
      }
    },
    [reload, toast],
  );

  const voidRequest = useCallback(
    async (id: string) => {
      try {
        await api.post<SignatureRequest>(`/signature-requests/${id}/void`, { reason: "" });
        toast.success("Cancelled. The signing links no longer work.");
        setOpen(null);
        await reload();
      } catch (err) {
        toast.fail("Could not cancel it", err);
      }
    },
    [reload, toast],
  );

  return { open, setOpen, openRequest, act, voidRequest };
}
