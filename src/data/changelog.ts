export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

/**
 * Lista wpisów do okienka Changelog. Najnowsza wersja na górze.
 * Każdy entry to wersja z datą i listą krótkich punktów. Trzymamy
 * po stronie klienta, żeby działało offline; przy każdym release
 * dorzucamy tu nowy blok.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.2",
    date: "2026-05-09",
    notes: [
      "Nowa ikona aplikacji (XP-blue niebo, słoneczko z promieniami, AI-sparkle).",
      'Aplikacja sprawdza dostępność aktualizacji co 5 minut oraz przy powrocie do okna, nie tylko przy starcie. „Później" wycisza powiadomienie dla danej wersji do końca działania apki.',
    ],
  },
  {
    version: "0.5.1",
    date: "2026-05-09",
    notes: [
      "Wersja w pasku stanu dziedziczy kolor i font-size od reszty stopki.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-05-09",
    notes: [
      "Profil użytkownika: pierwszy start prosi o nick i wyświetla go w panelu bocznym.",
      'Zmieniona belka menu: Kontakty/Sklep/Usługi wycięte, dodany Changelog, klik w „GAIdu GAIdu" otwiera dropdown z Ustawieniami i Zamknij.',
      "Wersja apki widoczna w pasku stanu obok zegara.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-05-09",
    notes: [
      'Updater nie instaluje już cicho aktualizacji. Pojawia się powiadomienie w prawym górnym rogu z przyciskami „Aktualizuj i zrestartuj" / „Później".',
    ],
  },
  {
    version: "0.3.0",
    date: "2026-05-09",
    notes: [
      "Makra usera: chipsy nad polem wiadomości oraz presety sesji niewidocznie dołączane do każdej wiadomości w włączonym chacie.",
      "Konfiguracja makr w osobnym oknie (Toolbar → Makra) zamiast w Ustawieniach.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-09",
    notes: [
      "Rebrand: aplikacja nazywa się teraz GAIdu GAIdu.",
      "Bundle identifier zmieniony, wymagana ręczna reinstalacja dla użytkowników z 0.1.0.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-05-09",
    notes: [
      "Pierwsze wydanie z auto-updaterem opartym o Tauri.",
    ],
  },
];
