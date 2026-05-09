import sunIcon from "../assets/sun.svg";

interface Props {
  onOpenSettings: () => void;
  onOpenMacros: () => void;
  onOpenNetwork: () => void;
  /** Czy WebSocket jest aktywny — kropka na ikonie. Phase 2B.3+. */
  networkOnline?: boolean;
}

const TOOLBAR_ITEMS: Array<{ icon: string; label: string; action: keyof Actions }> = [
  { icon: "👤", label: "Dodaj", action: "noop" },
  { icon: "🔍", label: "Szukaj", action: "noop" },
  { icon: "🌐", label: "Sieć", action: "openNetwork" },
  { icon: "✦", label: "Makra", action: "openMacros" },
  { icon: "⚙", label: "Ustawienia", action: "openSettings" },
];

interface Actions {
  noop: () => void;
  openSettings: () => void;
  openMacros: () => void;
  openNetwork: () => void;
}

export function Toolbar({ onOpenSettings, onOpenMacros, onOpenNetwork, networkOnline }: Props) {
  const actions: Actions = {
    noop: () => {},
    openSettings: onOpenSettings,
    openMacros: onOpenMacros,
    openNetwork: onOpenNetwork,
  };

  return (
    <div className="gg-toolbar">
      <div className="gg-toolbar-brand" aria-hidden>
        <img src={sunIcon} alt="" />
      </div>
      {TOOLBAR_ITEMS.map((item) => {
        const isNetwork = item.action === "openNetwork";
        return (
          <button
            key={item.label}
            className={`gg-toolbar-btn${isNetwork && networkOnline ? " is-online" : ""}`}
            type="button"
            onClick={actions[item.action]}
          >
            <span className="gg-toolbar-btn-icon">{item.icon}</span>
            <span className="gg-toolbar-btn-label">{item.label}</span>
            {isNetwork && (
              <span
                className={`gg-toolbar-net-dot${networkOnline ? " is-online" : ""}`}
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
