import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import sunIcon from "../assets/sun.svg";

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type NetState = "connected" | "connecting" | "disconnected" | "logged_out";

interface Props {
  net?: NetState;
}

export function Statusbar({ net = "logged_out" }: Props) {
  const [time, setTime] = useState(clock());
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setTime(clock()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const netLabel =
    net === "connected"
      ? "Połączony z siecią GG"
      : net === "connecting"
        ? "Łączenie z siecią GG…"
        : net === "disconnected"
          ? "Brak połączenia z siecią GG"
          : "Niezalogowany";

  // Sygnał (4 paski) zaplaszający się w zależności od stanu.
  const signalLevel = net === "connected" ? 4 : net === "connecting" ? 2 : 0;

  return (
    <div className="gg-statusbar">
      <div className="gg-statusbar-cell">
        <span className="gg-statusbar-clock"><img src={sunIcon} alt="" /></span>
        <span>{time}</span>
      </div>
      {version && (
        <div className="gg-statusbar-cell gg-statusbar-version">
          <span title="Wersja aplikacji">v{version}</span>
        </div>
      )}
      <div className={`gg-statusbar-cell gg-statusbar-net gg-statusbar-net--${net}`}>
        <span>{netLabel}</span>
        <span className="gg-signal" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`gg-signal-bar${i < signalLevel ? " is-active" : ""}`}
            />
          ))}
        </span>
      </div>
      <div className="gg-statusbar-spacer" />
    </div>
  );
}
