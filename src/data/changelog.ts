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
    version: "0.9.1",
    date: "2026-05-09",
    notes: [
      "Historia wiadomości E2E w peer chat była dotąd niewidoczna — endpoint /history zwracał tylko legacy plain text z phase 2, pomijał wszystkie zaszyfrowane blob-y MLS z phase 3+. Teraz serwer zwraca oba typy w jednej liście, klient deszyfruje historic blob-y lokalnie. Stare wiadomości, dla których klucze MLS już rotowały, dostają placeholder „[stara wiadomość — klucze rotowane]”.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-05-09",
    notes: [
      'Wskaźnik „pisze…" w peer chat: gdy znajomy klepie odpowiedź, pod jego username pojawia się napis. Wysyłka po stronie nadawcy debounce-owana 3s, automatyczny stop przy wysyłce/blur.',
      "Niebieski znacznik liczby nieprzeczytanych wiadomości obok znajomego w sidebarze, gdy chat z nim nie jest aktywny. Reset przy wybraniu peera.",
      "Ikona 🔒 obok timestampu wiadomości peer-to-peer, która faktycznie przeszła przez MLS encrypt/decrypt. Wiadomości plain z legacy chats jej nie dostają, więc widać kontrolnie, czy konwersacja jest E2E.",
      "Główny widok profilu w sidebarze pokazuje teraz username sieciowy (po zalogowaniu na serwer GAIdu), zamiast lokalnego nicka z ProfileDialog.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-05-09",
    notes: [
      "Adres serwera GAIdu (gg.jacula.cloud) jest na stałe wbudowany w klienta. Nie ma już pola edycji w dialogu Konto sieciowe — to upraszcza onboarding i likwiduje całą klasę błędów konfiguracyjnych.",
      "Pusty response z serwera (HTTP 200, brak body) zamiast crashu pokazuje teraz czytelny komunikat z podpowiedzią.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-05-09",
    notes: [
      "End-to-end encryption (E2E) wiadomości peer-to-peer przez MLS (RFC 9420). Każda nowa konwersacja zakłada zaszyfrowaną grupę MLS przy pierwszej wiadomości; serwer widzi tylko ciphertext i metadane (kto-do-kogo, rozmiar, czas), nie treść.",
      "Klient automatycznie tworzy lokalną tożsamość MLS (signing key Ed25519) i publikuje paczki KeyPackage'ów na serwerze (uzupełnia gdy zostanie < 3).",
      "Storage MLS w app_local_data_dir/mls/<account_id>.json — atomowy save z .tmp + rename. Identity przeżywa restart apki.",
      "Stare konwersacje plain-text (sprzed v0.8) zostają plain — migracja na MLS dotyczy tylko nowych chatów.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-05-09",
    notes: [
      'Pierwsza wersja czatu między użytkownikami: Toolbar → „Sieć" daje rejestrację/login na serwerze GAIdu (Twoim VPS lub lokalnym dev), z hasłem i tokenem JWT zapisanym lokalnie.',
      'Nowa sekcja „Znajomi" w panelu bocznym — dodawanie po username (auto-bidirectional), kropka presence (zielona = online, szara = offline), klik = otwiera czat z osobą.',
      "WebSocket realtime: doręczanie wiadomości na żywo, kolejka offline (gdy znajomy jest offline, wiadomość czeka na serwerze i dolatuje przy jego reconnect), auto-reconnect klienta z exponential backoff.",
      'Mała zielona kropka na ikonie „Sieć" w toolbarze pokazuje, czy WebSocket jest aktywny.',
      "Wiadomości w trybie peer-to-peer są jeszcze plaintextem na serwerze (TLS na drucie). Pełne E2E (MLS) przyjdzie w wersji 0.8+.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-05-09",
    notes: [
      'OpenAI: nowy tryb logowania „Subskrypcja (Codex CLI)". Używa Twojego konta ChatGPT Plus/Pro/Business przez oficjalne CLI OpenAI (`@openai/codex`). Apka nie potrzebuje już osobnego klucza API z platform.openai.com, jeśli masz aktywną subskrypcję ChatGPT.',
      'Konfiguracja: 1) `npm i -g @openai/codex`, 2) `codex login` (otworzy ChatGPT w przeglądarce, jednorazowo), 3) Ustawienia → OpenAI → „Subskrypcja (Codex CLI)" → Zapisz.',
      'Tryb subskrypcji nie obsługuje wysyłania obrazków — do obrazków trzeba przełączyć na „API key (platform.openai.com)".',
    ],
  },
  {
    version: "0.5.5",
    date: "2026-05-09",
    notes: [
      'W stopce panelu bocznego pojawia się sekcja reklamowa: grafika Larry\'ego po lewej, tekst po prawej („A czy ty zjadłeś japuszko? Larry patrzy!").',
      "Drobne porządki w UI: neutralny placeholder w polu nicka.",
      "Pod kapotą: pierwsze fundamenty serwera czatu między użytkownikami (auth + chat 1:1 + offline queue + presence). Patrz docs/adr/0001 i server/. To na razie nie dotyka klienta — integracja w kolejnej wersji.",
    ],
  },
  {
    version: "0.5.3",
    date: "2026-05-09",
    notes: [
      "W dropdownie GAIdu GAIdu nowa pozycja „Sprawdź aktualizacje” — manualne sprawdzenie odświeża powiadomienie nawet jeśli wcześniej kliknąłeś „Później”, a przy braku nowej wersji pokazuje krótki komunikat „Masz najnowszą wersję”.",
    ],
  },
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
