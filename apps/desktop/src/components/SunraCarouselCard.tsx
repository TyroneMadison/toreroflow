import { useCallback, useEffect, useState } from "react";
import type { SunraCarouselQuote, SunraGenerateResult, SunraImageModel } from "@toreroflow/contracts";
import { api, ApiError, fileUrl } from "../lib/api";
import { maxSlides, modelsFor, sunraProblem } from "../lib/ideas";
import { useAppState } from "../state/AppState";
import { useToast } from "./Toasts";
import Select from "./Select";
import { Lbl, Note, Switch } from "./ideas/IdeaBits";
import "../screens/IdeaScreens.css";

/**
 * Create > Carousels: build a whole carousel with Sunra.
 *
 * Pick a model, type what you want, get the price in Sunra credits, approve
 * that exact quote, and every slide is made at the platform's size. Nothing
 * is spent until "Approve" is pressed, and only when Sunra spending is ON
 * (default OFF) for the agency and the server has Sunra connected.
 */

type Platform = "instagram" | "tiktok";
const PLATFORMS = [
  { value: "instagram", label: "Instagram, 1080x1350 (4:5)" },
  { value: "tiktok", label: "TikTok photo post, 1080x1920 (9:16)" },
];

const statusOf = (err: unknown) => (err instanceof ApiError ? err.status : null);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function SunraCarouselCard() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const [status, setStatus] = useState<{ generationEnabled: boolean; connected: boolean } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [models, setModels] = useState<SunraImageModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [slides, setSlides] = useState(5);
  const [quote, setQuote] = useState<SunraCarouselQuote | null>(null);
  const [busy, setBusy] = useState<"quote" | "build" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string[] | null>(null);

  const loadModels = useCallback(() => {
    setModels(null);
    setModelsError(null);
    api
      .get<{ models: SunraImageModel[] }>("/carousels/sunra/models")
      .then((r) => setModels(r.models))
      .catch((err) => setModelsError(messageOf(err)));
  }, []);

  useEffect(() => {
    api
      .get<{ generationEnabled: boolean; connected: boolean }>("/sunra/settings")
      .then(setStatus)
      .catch(() => setStatus(null));
    loadModels();
  }, [loadModels]);

  const offered = modelsFor(models ?? [], platform);
  const model = offered.find((m) => m.id === modelId) ?? offered[0];
  const cap = maxSlides(platform);
  const count = Math.min(slides, cap);
  const canBuild = !!status?.connected && !!status.generationEnabled;

  // Any change to the request makes the old price wrong.
  useEffect(() => {
    setQuote(null);
    setProblem(null);
  }, [prompt, platform, model?.id, count]);

  const getQuote = async () => {
    if (!selectedClient || !prompt.trim() || !model) return;
    setBusy("quote");
    setResult(null);
    setProblem(null);
    try {
      setQuote(
        await api.post<SunraCarouselQuote>("/sunra/carousel/quote", {
          brandId: selectedClient.id,
          prompt: prompt.trim(),
          platform,
          modelId: model.id,
          slides: count,
        }),
      );
    } catch (err) {
      setProblem(sunraProblem(statusOf(err), messageOf(err)).text);
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!quote) return;
    setBusy("build");
    setProblem(null);
    try {
      const r = await api.post<SunraGenerateResult>(`/sunra/carousel/${quote.quoteId}/generate`, {
        approved: true,
        modelId: quote.modelId,
      });
      setResult(r.slideUrls);
      setQuote(null);
    } catch (err) {
      const p = sunraProblem(statusOf(err), messageOf(err));
      if (p.notConnected && status) setStatus({ ...status, connected: false });
      // A 502 from generate means the quote was used up; every other refusal leaves it spendable.
      if (p.newPrice || statusOf(err) === 502) setQuote(null);
      setProblem(p.text);
    } finally {
      setBusy(null);
    }
  };

  const toggleSpending = async (on: boolean) => {
    if (!status) return;
    try {
      const next = await api.put<{ generationEnabled: boolean }>("/sunra/settings", { generationEnabled: on });
      setStatus({ ...status, ...next });
    } catch (err) {
      toast.fail("Could not change Sunra spending", err);
    }
  };

  return (
    <div className="card glass id-card" style={{ marginTop: 16 }} data-testid="carousels.sunra">
      <div className="id-cardhead">
        <div>
          <h3 className="id-h3">Build it with Sunra</h3>
          <p className="id-note">
            Say what the carousel should be. Sunra makes every slide, sized for Instagram or TikTok. You see the price in credits first and
            nothing is spent until you approve it.
          </p>
        </div>
        {status && (
          <span className="id-row" style={{ padding: "0 4px 0 12px" }} data-testid="carousels.sunra-switch">
            <span>Sunra spending</span>
            <Switch on={status.generationEnabled} label="Sunra spending" onChange={(v) => void toggleSpending(v)} />
          </span>
        )}
      </div>

      {status && !status.connected && (
        <Note tone="warn">
          <b>Sunra is not connected.</b> The server has no Sunra key yet, so you can pick a model and see prices, but nothing can be built until it
          is connected in the server settings.
        </Note>
      )}

      <div className="id-filters">
        <label className="id-field">
          <span>Platform</span>
          <Select aria-label="Platform" value={platform} onChange={(v) => setPlatform(v as Platform)} options={PLATFORMS} />
        </label>
        <label className="id-field">
          <span>Slides</span>
          <Select
            aria-label="Slides"
            value={String(count)}
            onChange={(v) => setSlides(Number(v))}
            options={Array.from({ length: cap }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          />
        </label>
      </div>

      <Lbl>Model</Lbl>
      {modelsError ? (
        <Note tone="bad">
          Could not load Sunra models: {modelsError}{" "}
          <button type="button" className="btn ghost" style={{ minHeight: 44, marginLeft: 8 }} onClick={loadModels}>
            Try again
          </button>
        </Note>
      ) : models === null ? (
        <p className="id-note">Loading Sunra models...</p>
      ) : !offered.length ? (
        <p className="id-note">No Sunra model makes {platform === "instagram" ? "4:5" : "9:16"} images right now.</p>
      ) : (
        <ul className="id-models" aria-label="Sunra models">
          {offered.map((m) => (
            <li key={m.id}>
              <button type="button" className="id-model" aria-pressed={m.id === model?.id} onClick={() => setModelId(m.id)}>
                {m.label}
                <small>
                  {m.provider}, {m.creditsPerImage} credits a slide
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="id-field">
        <span>What do you want?</span>
        <textarea
          className="field-in"
          rows={3}
          maxLength={4000}
          value={prompt}
          placeholder="5 slides on spotting a flooded used car, bold headline on each, dark blue and orange"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      {!quote ? (
        <button
          type="button"
          className="btn pri id-full"
          disabled={!selectedClient || !prompt.trim() || !model || busy !== null}
          data-testid="carousels.sunra-build"
          onClick={() => void getQuote()}
        >
          {busy === "quote" ? "Getting the price..." : "Get the price"}
        </button>
      ) : (
        <div className="id-card" style={{ padding: 0 }} data-testid="carousels.sunra-quote">
          <Lbl>Approve</Lbl>
          <p className="id-line">
            {quote.slides} slides x {quote.creditsPerImage} credits = <b>{quote.credits} credits</b>, {quote.width}x{quote.height} ({quote.aspectRatio}
            ), {model?.label ?? quote.modelId}. This price holds until {new Date(quote.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
          </p>
          <div className="id-acts">
            <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setQuote(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={busy !== null || !canBuild}
              data-testid="carousels.sunra-approve"
              onClick={() => void approve()}
            >
              {busy === "build" ? "Building..." : `Approve and spend ${quote.credits} credits`}
            </button>
          </div>
          {!canBuild && (
            <p className="id-note">{!status?.connected ? "Connect Sunra on the server to build." : "Turn Sunra spending ON to build."}</p>
          )}
        </div>
      )}

      {problem && <Note tone="bad">{problem}</Note>}

      {result && (
        <div className="id-slides" data-testid="carousels.sunra-result">
          {result.map((u, i) => (
            <img key={u} src={fileUrl(u) ?? undefined} alt={`Slide ${i + 1}`} />
          ))}
        </div>
      )}
    </div>
  );
}
