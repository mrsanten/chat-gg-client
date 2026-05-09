import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Statusbar() {
  const [time, setTime] = useState(clock());
  useEffect(() => {
    const t = setInterval(() => setTime(clock()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="gg-statusbar">
      <div className="gg-statusbar-cell">
        <span className="gg-statusbar-clock"><img src={sunIcon} alt="" /></span>
        <span>{time}</span>
      </div>
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
      <span className="gg-statusbar-link">www.gadu-gadu.pl</span>
    </div>
  );
}
