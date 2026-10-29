import { useCallback, useEffect, useState } from "react";
import { ASPECTS, CAPTION_TEMPLATES, type Aspect, type RecipeSettings } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import Modal from "../../modals/Modal";

/**
 * Recipes (mock-up 17): a brand's saved edit styles, a list with the default
 * badged and an editor for captions, layout and the AI passes. "Apply to
 * open clip" shows only from the editor, where onApply is passed.
 * ponytail: brand logo/outro are not part of a recipe yet; the brand kit
 * already carries them.
 */

export interface RecipeRow {
  id: string;
  name: string;
  isDefault: boolean;
  settings: RecipeSettings;
  summary: string;
}

const AI_KEYS = [
  ["hook", "Hook headline"],
  ["fillers", "Remove fillers"],
  ["pauses", "Remove pauses"],
  ["badTakes", "Remove bad takes"],
  ["zooms", "Auto zoom"],
  ["highlights", "Keyword highlights"],
  ["emojis", "Emojis"],
] as const;

const BLANK: RecipeSettings = { aspect: "9:16", captions: { template: "bold" }, ai: { fillers: true, pauses: true, hook: true } };

export function useRecipes(clientId: string) {
  const toast = useToast();
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const load = useCallback(async () => {
    try {
      setRecipes((await api.get<{ recipes: RecipeRow[] }>(`/clients/${clientId}/recipes`)).recipes);
    } catch (e) {
      toast.fail("Loading recipes", e);
    }
  }, [clientId, toast]);
  useEffect(() => void load(), [load]);
  return { recipes, load };
}

export default function RecipesPanel({
  clientId,
  onClose,
  onApply,
}: {
  clientId: string;
  onClose: () => void;
  onApply?: (recipeId: string) => Promise<void>;
}) {
  const toast = useToast();
  const { recipes, load } = useRecipes(clientId);
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [s, setS] = useState<RecipeSettings>(BLANK);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editId === null && recipes.length) pick(recipes.find((r) => r.isDefault) ?? recipes[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipes]);

  function pick(r: RecipeRow | null) {
    setEditId(r ? r.id : "new");
    setName(r ? r.name : "New recipe");
    setS(r ? r.settings : BLANK);
  }

  async function save(extra: { isDefault?: boolean } = {}) {
    setBusy(true);
    try {
      const body = { name: name.trim() || "Recipe", settings: s, ...extra };
      const r =
        editId === "new" || editId === null
          ? await api.post<RecipeRow>(`/clients/${clientId}/recipes`, body)
          : await api.patch<RecipeRow>(`/recipes/${editId}`, body);
      setEditId(r.id);
      await load();
      toast.success(extra.isDefault ? `"${r.name}" is now the default.` : "Recipe saved.");
      return r.id;
    } catch (e) {
      toast.fail("Saving the recipe", e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editId || editId === "new") return;
    try {
      await api.del(`/recipes/${editId}`);
      setEditId(null);
      await load();
    } catch (e) {
      toast.fail("Deleting the recipe", e);
    }
  }

  const cap = s.captions ?? {};
  const style = (cap.style ?? {}) as { color?: string; accentColor?: string; font?: string; case?: string };
  const setStyle = (k: string, v: unknown) => setS({ ...s, captions: { ...cap, style: { ...cap.style, [k]: v } } });
  const ai = s.ai ?? {};

  return (
    <Modal maxWidth={820} onClose={onClose} label="Recipes">
      <div className="rcp">
        <div className="rcp-list">
          <div className="rcp-head">
            <h3>Recipes</h3>
            <button className="btn sm" onClick={() => pick(null)}>+ New</button>
          </div>
          {recipes.map((r) => (
            <div key={r.id} className={`rcp-item${editId === r.id ? " on" : ""}`} onClick={() => pick(r)}>
              <b>{r.name}</b> {r.isDefault && <span className="chip on">Default</span>}
              <div className="sub">{r.summary || "No changes"}</div>
            </div>
          ))}
          {recipes.length === 0 && <div className="sub">No recipes yet. A recipe applies your house style to every clip you open.</div>}
        </div>

        <div className="rcp-edit">
          <input className="field-in" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Recipe name" />

          <div className="lab">Captions</div>
          <div className="rcp-row">
            <select value={cap.template ?? ""} onChange={(e) => setS({ ...s, captions: { ...cap, template: e.target.value || undefined } })}>
              <option value="">Keep the clip's</option>
              {CAPTION_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <label>Text <input type="color" value={style.color ?? "#ffffff"} onChange={(e) => setStyle("color", e.target.value)} /></label>
            <label>Accent <input type="color" value={style.accentColor ?? "#ffd400"} onChange={(e) => setStyle("accentColor", e.target.value)} /></label>
            <input className="field-in" placeholder="Font (template's)" value={style.font ?? ""} onChange={(e) => setStyle("font", e.target.value || undefined)} />
            <label>
              <input type="checkbox" checked={style.case === "upper"} onChange={(e) => setStyle("case", e.target.checked ? "upper" : undefined)} /> Uppercase
            </label>
          </div>

          <div className="lab">Layout</div>
          <div className="rcp-row">
            {ASPECTS.map((a) => (
              <span key={a} className={`chip${s.aspect === a ? " on" : ""}`} onClick={() => setS({ ...s, aspect: s.aspect === a ? undefined : (a as Aspect) })}>{a}</span>
            ))}
          </div>

          <div className="lab">AI passes (free, on this machine)</div>
          <div className="rcp-row">
            {AI_KEYS.map(([k, label]) => (
              <label key={k}>
                <input type="checkbox" checked={!!ai[k]} onChange={(e) => setS({ ...s, ai: { ...ai, [k]: e.target.checked } })} /> {label}
              </label>
            ))}
          </div>

          <div className="rcp-foot">
            {editId && editId !== "new" && <button className="btn ghost" onClick={() => void remove()}>Delete</button>}
            {onApply && (
              <button
                className="btn ghost"
                disabled={busy}
                onClick={async () => {
                  const id = await save();
                  if (id) await onApply(id);
                }}
              >
                Apply to open clip
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => void save({ isDefault: true })}>Set as default</button>
            <button className="btn" disabled={busy} onClick={() => void save()}>Save</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
