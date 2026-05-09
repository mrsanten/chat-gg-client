const ITEMS = ["GAIdu GAIdu", "Kontakty", "Sklep", "Usługi", "Pomoc"];

export function Menubar() {
  return (
    <div className="gg-menubar">
      {ITEMS.map((label) => (
        <div key={label} className="gg-menubar-item">
          <span><u>{label[0]}</u>{label.slice(1)}</span>
        </div>
      ))}
    </div>
  );
}
