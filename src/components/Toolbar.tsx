import sunIcon from "../assets/sun.svg";

interface Props {
  onOpenSettings: () => void;
}

const TOOLBAR_ITEMS: Array<{ icon: string; label: string; action: keyof Actions }> = [
  { icon: "👤", label: "Dodaj", action: "noop" },
  { icon: "🔍", label: "Szukaj", action: "noop" },
  { icon: "✉", label: "SMS", action: "noop" },
  { icon: "🗄", label: "Archiwum", action: "noop" },
  { icon: "⚙", label: "Ustawienia", action: "openSettings" },
];

interface Actions {
  noop: () => void;
  openSettings: () => void;
}

export function Toolbar({ onOpenSettings }: Props) {
  const actions: Actions = {
    noop: () => {},
    openSettings: onOpenSettings,
  };

  return (
    <div className="gg-toolbar">
      <div className="gg-toolbar-brand" aria-hidden>
        <img src={sunIcon} alt="" />
      </div>
      {TOOLBAR_ITEMS.map((item) => (
        <button
          key={item.label}
          className="gg-toolbar-btn"
          type="button"
          onClick={actions[item.action]}
        >
          <span className="gg-toolbar-btn-icon">{item.icon}</span>
          <span className="gg-toolbar-btn-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
