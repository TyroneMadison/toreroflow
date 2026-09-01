import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./autostart";

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

/*
 * A note left on disk before an install, read back on the next launch.
 *
 * On Windows the updater hands the installer to the shell and then calls
 * std::process::exit(0) on the spot, without looking at whether the shell
 * accepted it. Everything after that point happens with this app already dead,
 * so an install that never lands has nobody left to report it: the "failed"
 * phase below cannot render, because the process that would render it is gone.
 * What the operator sees is the window vanish, come back, and still say the old
 * version, which is indistinguishable from an update that was never offered.
 *
 * This is the smallest thing that survives that: write down what was attempted,
 * and on the next launch, if the app is still not the version it tried to
 * become, say so. It cannot prevent the failure. It ends the silence, which is
 * what made this take a week to notice.
 */
const ATTEMPT_KEY = "toreroflow-update-attempt";

interface Attempt {
  version: string;
  at: number;
}

/** Parse a stored note. A corrupt one is the same as none: this is a hint, not a record. */
export function parseAttempt(raw: string | null): Attempt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Attempt>;
    return typeof parsed.version === "string" &&
      parsed.version !== "" &&
      typeof parsed.at === "number"
      ? { version: parsed.version, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * The version an earlier run tried and failed to become, or null.
 *
 * Null when there was no attempt, when the attempt is the version now running
 * (so it worked), or when the note is unreadable. Only a note naming a version
 * this app is not counts as stranded.
 */
export function strandedVersion(attempt: Attempt | null, running: string): string | null {
  if (!attempt) return null;
  return attempt.version === running ? null : attempt.version;
}

function readAttempt(): Attempt | null {
  try {
    return parseAttempt(localStorage.getItem(ATTEMPT_KEY));
  } catch {
    // Storage itself refusing to be read, which is not the same as a bad value.
    return null;
  }
}

export interface AppUpdate {
  update: Update | null;
  phase: UpdatePhase;
  progress: number;
  problem: string | null;
  /** Set once a check has finished and found nothing, so a button can say so. */
  checkedAndCurrent: boolean;
  /**
   * The version a previous run downloaded, pressed install on, and did not
   * become. Null when the last attempt worked or there has not been one.
   */
  strandedAt: string | null;
  look(): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

export function useAppUpdate(): AppUpdate {
  /*
   * In a plain browser tab (the web-hosted app) there is no updater and
   * nothing to update: a refresh IS the update. Every phase stays idle and
   * the banner and Settings card render nothing, which is the truth.
   */
  const inTauri = isTauri();
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [checkedAndCurrent, setCheckedAndCurrent] = useState(false);
  const [strandedAt, setStrandedAt] = useState<string | null>(null);

  // Read the note from the last attempt once, on mount. Running the version it
  // was trying to reach means it worked, and the note goes.
  useEffect(() => {
    if (!inTauri) return;
    const attempt = readAttempt();
    if (!attempt) return;
    void getVersion()
      .then((running) => {
        const stranded = strandedVersion(attempt, running);
        if (stranded) setStrandedAt(stranded);
        else localStorage.removeItem(ATTEMPT_KEY);
      })
      .catch(() => {
        // No version to compare against is not evidence either way, so the note
        // stays for the next launch rather than being cleared on a guess.
      });
  }, []);

  const look = useCallback(async () => {
    if (!isTauri()) return;
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
    // Written before the attempt, not after: on Windows there is no "after" in
    // this process. See the note on ATTEMPT_KEY.
    try {
      localStorage.setItem(
        ATTEMPT_KEY,
        JSON.stringify({ version: update.version, at: Date.now() } satisfies Attempt),
      );
    } catch {
      // Storage being unavailable costs the warning on the next launch, not the
      // update, so it must not stop the install.
    }
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

  return { update, phase, progress, problem, checkedAndCurrent, strandedAt, look, install, dismiss };
}
