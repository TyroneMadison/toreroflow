import { createContext, useContext, useEffect, useState } from "react";
import type { BrandKit } from "@toreroflow/contracts";
import { api } from "../lib/api";

/**
 * The brand kit inside the Studio editor: its colors lead every color field,
 * and Caption style gets "Apply brand kit". Missing or failing kits are just
 * an empty kit, so the editor never waits on one.
 */
export type KitView = BrandKit & { logoUrl: string | null };

const BrandKitContext = createContext<KitView | null>(null);
export const BrandKitProvider = BrandKitContext.Provider;
export const useKit = () => useContext(BrandKitContext);

export function useBrandKit(brandId: string | null | undefined): KitView | null {
  const [kit, setKit] = useState<KitView | null>(null);
  useEffect(() => {
    setKit(null);
    if (!brandId) return;
    let live = true;
    api
      .get<KitView>(`/brands/${encodeURIComponent(brandId)}/kit`)
      .then((k) => live && setKit(k))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [brandId]);
  return kit;
}
