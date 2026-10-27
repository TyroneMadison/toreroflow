import { useEffect, useState } from "react";
import { api, fileUrl } from "../lib/api";
import { useAppState } from "../state/AppState";
import { useToast } from "./Toasts";
import Select from "./Select";

/**
 * Create > Carousels: build a whole carousel with Sunra.
 *
 * Type what you want, get the price in Sunra credits, approve it, and every
 * slide is made at the platform's size. Nothing is spent until "Approve" is
 * pressed on that exact quote, and only when Sunra spending is ON (default
 * OFF) for the agency.
 */

interface Quote {
  quoteId: string;
  model: string;
  slides: number;
  creditsPerImage: number;
  credits: number;
  width: number;
  height: number;
  aspectRatio: string;
  expiresAt: string;
}

const PLATFORMS = [
  { value: "instagram", label: "Instagram, 1080x1350 (4:5)" },
  { value: "tiktok", label: "TikTok, 1080x1920 (9:16)" },
];
const MODELS = [
  { value: "nano-banana-2", label: "Nano Banana 2, 7 credits a slide" },
  { value: "nano-banana-pro", label: "Nano Banana Pro, 14 credits a slide" },
];

export default function SunraCarouselCard() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const [status, setStatus] = useState<{ generationEnabled: boolean; connected: boolean } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [model, setModel] = useState("nano-banana-2");
  const [slides, setSlides] = useState(5);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  useEffect(() => {
    api
      .get<{ generationEnabled: boolean; connected: boolean }>("/sunra/settings")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Any change to the request makes the old price wrong.
  useEffect(() => setQuote(null), [prompt, platform, model, slides]);

  const maxSlides = platform === "instagram" ? 10 : 20;

  const getQuote = async () => {
    if (!selectedClient || !prompt.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      setQuote(
        await api.post<Quote>("/sunra/carousel/quote", {
          brandId: selectedClient.id,
          prompt: prompt.trim(),
          platform,
          model,
          slides: Math.min(slides, maxSlides),
        }),
      );
    } catch (err) {
      toast.fail("Could not price that carousel", err);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!quote) return;
    setBusy(true);
    try {
      const r = await api.post<{ slideUrls: string[] }>(`/sunra/carousel/${quote.quoteId}/generate`, { approved: true });
      setResult(r.slideUrls);
      setQuote(null);
    } catch (err) {
      toast.fail("Sunra could not build that carousel", err);
      setQuote(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleSpending = async () => {
    if (!status) return;
    try {
      const next = await api.put<{ generationEnabled: boolean }>("/sunra/settings", { generationEnabled: !status.generationEnabled });
      setStatus({ ...status, ...next });
    } catch (err) {
      toast.fail("Could not change Sunra spending", err);
    }
  };

  return (
    <div className="card glass" style={{ marginTop: 16 }} data-testid="carousels.sunra">
      <div className="rowhead">
        <div>
          <h3>Build it with Sunra</h3>
          <div className="sub">
            Say what the carousel should be. Sunra makes every slide, sized for the platform. You see the price in
            credits first and nothing is spent until you approve it.
          </div>
        </div>
        {status && (
          <button className="cbtn" data-testid="carousels.sunra-switch" onClick={() => void toggleSpending()}>
            Sunra spending: {status.generationEnabled ? "ON" : "OFF"}
          </button>
        )}
      </div>

      {status && !status.connected && (
        <p className="insworking" style={{ marginTop: 10 }}>
          Sunra is not connected on the server yet, so pricing works but building does not.
        </p>
      )}

      <div className="pcontact" style={{ maxWidth: 640, marginTop: 10 }}>
        <label className="cfield">
          <span className="lab">What do you want?</span>
          <textarea
            className="field-in"
            rows={3}
            maxLength={4000}
            value={prompt}
            placeholder="5 slides on spotting a flooded used car, bold headline on each, dark blue and orange"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="cfield">
          <span className="lab">Platform</span>
          <Select value={platform} onChange={setPlatform} options={PLATFORMS} />
        </label>
        <label className="cfield">
          <span className="lab">Model</span>
          <Select value={model} onChange={setModel} options={MODELS} />
        </label>
        <label className="cfield">
          <span className="lab">Slides</span>
          <Select
            value={String(Math.min(slides, maxSlides))}
            onChange={(v) => setSlides(Number(v))}
            options={Array.from({ length: maxSlides }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          />
        </label>

        {!quote ? (
          <button
            className="cbtn"
            disabled={!selectedClient || !prompt.trim() || busy}
            data-testid="carousels.sunra-build"
            onClick={() => void getQuote()}
          >
            {busy ? "Working…" : "Build carousel"}
          </button>
        ) : (
          <div data-testid="carousels.sunra-quote">
            <p className="insworking">
              {quote.slides} slides x {quote.creditsPerImage} credits = <b>{quote.credits} credits</b>, {quote.width}x
              {quote.height} ({quote.aspectRatio}). This price holds until{" "}
              {new Date(quote.expiresAt).toLocaleTimeString()}.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="cbtn"
                disabled={busy || !status?.generationEnabled}
                title={status?.generationEnabled ? undefined : "Turn Sunra spending ON first"}
                data-testid="carousels.sunra-approve"
                onClick={() => void approve()}
              >
                {busy ? "Building…" : `Approve and spend ${quote.credits} credits`}
              </button>
              <button className="dangerbtn" disabled={busy} onClick={() => setQuote(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }} data-testid="carousels.sunra-result">
          {result.map((u, i) => (
            <img key={u} src={fileUrl(u) ?? undefined} alt={`Slide ${i + 1}`} style={{ width: 120, borderRadius: 8 }} />
          ))}
        </div>
      )}
    </div>
  );
}
