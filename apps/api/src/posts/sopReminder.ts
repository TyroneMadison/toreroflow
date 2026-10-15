/*
 * The SOP is a gentle reminder, never a gate: scheduling always goes ahead,
 * and the response carries a nudge when the client has an SOP the caller did
 * not say it checked.
 */
export interface SopReminder {
  clientId: string;
  message: string;
}

export function sopReminder(
  client: { id: string; name: string; sop: string | null | undefined },
  acknowledged: boolean | undefined,
): SopReminder | null {
  if (!client.sop?.trim() || acknowledged === true) return null;
  return { clientId: client.id, message: `Reminder: check ${client.name}'s SOP` };
}
