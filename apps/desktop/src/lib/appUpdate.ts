import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Finding and taking an app update, in one place.
 *
 * Two things ask for this: the banner that appears by itself when a release
 * lands, and the Check for updates button in Settings for when the operator
 * does not want to wait for the daily check. They have to agree about what
 * counts as available and what installing does, so they share this rather than
 * each carrying a copy of downloadAndInstall.
 *
 * Every check and every download is verified against the public key baked into
 * the build, so a compromised release host cannot ship a modified binary: an
 * unsigned or wrongly-signed update is refused before anything touches disk.
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "done" | "failed";

export interface AppUpdate {
  update: Update | null;
  phase: UpdatePhase;
  progress: number;
  problem: string | null;
  /** Set once a check has finished and found nothing, so a button can say so. */
  checkedAndCurrent: boolean;
  look(): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

export function useAppUpdate(): AppUpdate {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [checkedAndCurrent, setCheckedAndCurrent] = useState(false);

  const look = useCallback(async () => {
    setPhase("checking");
    setProblem(null);
    try {
      const found = await check();
      if (found?.available) {
        setUpdate(found);
        setCheckedAndCurrent(false);
      } else {
        setUpdate(null);
        setCheckedAndCurrent(true);
      }
      setPhase("idle");
    } catch (err) {
      // The automatic check swallows this: a failure usually means no
      // internet, which the operator already knows, and an update they have
      // never heard of is not something they are waiting on. A check they
      // pressed themselves is different, so the reason is kept for the caller
      // that wants to show it.
      setProblem(err instanceof Error ? err.message : String(err));
      setPhase("idle");
      setCheckedAndCurrent(false);
    }
  }, []);

  const install = useCallback(async () => {
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
      // disk, which is the state "I updated and nothing changed" comes from.
      await relaunch();
    } catch (err) {
      setPhase("failed");
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [update]);

  const dismiss = useCallback(() => {
    setUpdate(null);
    setCheckedAndCurrent(false);
  }, []);

  return { update, phase, progress, problem, checkedAndCurrent, look, install, dismiss };
}
