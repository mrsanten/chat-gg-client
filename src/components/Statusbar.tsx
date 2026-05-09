import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import sunIcon from "../assets/sun.svg";

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Statusbar() {
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
      <div className="gg-statusbar-cell">
        <span>Połączony z siecią GG</span>
        <span className="gg-signal" aria-hidden>
          <span className="gg-signal-bar" />
          <span className="gg-signal-bar" />
          <span className="gg-signal-bar" />
          <span className="gg-signal-bar" />
        </span>
      </div>
      <div className="gg-statusbar-spacer" />
    </div>
  );
}
