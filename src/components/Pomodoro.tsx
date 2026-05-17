import { useEffect, useRef, useState } from "react";

type Phase = "work" | "short" | "long";

const DURATIONS: Record<Phase, number> = {
  work: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

const PHASE_LABEL: Record<Phase, string> = {
  work: "Skupienie",
  short: "Krótka przerwa",
  long: "Długa przerwa",
};

function fmt(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Krótki sygnał dźwiękowy na koniec fazy (Web Audio, bez assetów). */
function beep(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    osc.onended = () => ctx.close();
  } catch {
    /* brak audio — pomijamy dźwięk */
  }
}

/** Moduł Pomodoro — timer skupienia z przerwami. Co 4 fazy skupienia
 *  proponuje długą przerwę. Stan jest ulotny (reset po restarcie apki). */
export function Pomodoro() {
  const [phase, setPhase] = useState<Phase>("work");
  const [secs, setSecs] = useState(DURATIONS.work);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);
  const completedRef = useRef(0);

  // Odliczanie — tyka tylko gdy `running`.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setSecs((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Koniec fazy — sygnał, przejście do następnej, pauza (user świadomie
  // startuje kolejną fazę).
  useEffect(() => {
    if (secs > 0) return;
    beep();
    setRunning(false);
    if (phase === "work") {
      const next = completedRef.current + 1;
      completedRef.current = next;
      setCompleted(next);
      const np: Phase = next % 4 === 0 ? "long" : "short";
      setPhase(np);
      setSecs(DURATIONS[np]);
    } else {
      setPhase("work");
      setSecs(DURATIONS.work);
    }
  }, [secs, phase]);

  const selectPhase = (p: Phase) => {
    setPhase(p);
    setSecs(DURATIONS[p]);
    setRunning(false);
  };

  const total = DURATIONS[phase];
  const progress = total > 0 ? 1 - secs / total : 0;

  return (
    <div className="gg-module gg-pomodoro">
      <div className="gg-pomodoro-card">
        <div className="gg-pomodoro-tabs">
          {(["work", "short", "long"] as Phase[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`gg-pomodoro-tab${phase === p ? " is-active" : ""}`}
              onClick={() => selectPhase(p)}
            >
              {PHASE_LABEL[p]}
            </button>
          ))}
        </div>

        <div
          className={`gg-pomodoro-dial gg-pomodoro-dial--${phase}`}
          style={{ ["--gg-pomo-progress" as string]: progress }}
        >
          <div className="gg-pomodoro-time">{fmt(secs)}</div>
          <div className="gg-pomodoro-phase">{PHASE_LABEL[phase]}</div>
        </div>

        <div className="gg-pomodoro-controls">
          <button
            type="button"
            className="gg-send-btn"
            onClick={() => setRunning((r) => !r)}
          >
            <span>{running ? "Pauza" : "Start"}</span>
          </button>
          <button
            type="button"
            className="gg-btn"
            onClick={() => {
              setRunning(false);
              setSecs(DURATIONS[phase]);
            }}
          >
            Reset
          </button>
        </div>

        <div className="gg-pomodoro-stat">
          Ukończone sesje skupienia: <strong>{completed}</strong>
        </div>
      </div>
    </div>
  );
}
