import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * "There is a newer version", and the button that takes it.
 *
 * Deliberately not automatic. An app that updates itself mid-upload, or in the
 * ninety seconds before a scheduled post goes out, is an app that eats work.
 * The operator decides when.
 *
 * Every check and every download is verified against the public key baked into
 * the build, so a compromised release host cannot ship a modified binary: an
 * unsigned or wrongly-signed update is refused by the updater before anything
 * touches disk.
 */

/** Checked on launch and then daily, which is far more often than we ship. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

type Phase = "idle" | "downloading" | "installing" | "done" | "failed";

export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const look = useCallback(async () => {
    try {
      const found = await check();
      if (found?.available) setUpdate(found);
    } catch {
      // A failed check is not worth telling the operator about: it usually
      // means no internet, which they already know, and an update they have
      // not heard of is not something they are waiting on.
    }
  }, []);

  useEffect(() => {
    void look();
    const t = setInterval(() => void look(), CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [look]);

  const install = async () => {
    if (!update) return;
    setProblem(null);
    setPhase("downloading");
    let total = 0;
    let got = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          got += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((got / total) * 100)));
        } else if (event.event === "Finished") setPhase("installing");
      });
      setPhase("done");
      // Relaunch rather than leaving them on the old build with a new one on
      // disk, which is the state where "I updated and nothing changed" comes
      // from.
      await relaunch();
    } catch (err) {
      setPhase("failed");
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  if (!update || dismissed) return null;

  return (
    <div className="updatebar" role="status">
      <div className="updatebar-body">
        <b>Version {update.version} is ready</b>
        {phase === "idle" && update.body && <div className="updatebar-notes">{update.body}</div>}
        {phase === "downloading" && (
          <div className="updatebar-notes">
            Downloading{progress > 0 ? ` ${progress}%` : "…"}
          </div>
        )}
        {phase === "installing" && <div className="updatebar-notes">Installing, hold on…</div>}
        {phase === "done" && <div className="updatebar-notes">Restarting…</div>}
        {phase === "failed" && <div className="updatebar-notes bad">{problem}</div>}
      </div>
      {(phase === "idle" || phase === "failed") && (
        <>
          <button className="btn" onClick={() => void install()}>
            {phase === "failed" ? "Try again" : "Update now"}
          </button>
          <button
            className="btn ghost"
            title="It will offer again next time you open the app"
            onClick={() => setDismissed(true)}
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
