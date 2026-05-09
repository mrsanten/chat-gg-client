# Architecture Decision Records

Każdy znaczący wybór architektoniczny w GAIdu GAIdu jest zapisany jako ADR
(Architecture Decision Record). ADR-y są ponumerowane chronologicznie i nie
edytujemy starych — jeśli decyzja się zmienia, dodajemy nowy ADR i ustawiamy
status starego na `Superseded by ADR-XXXX`.

## Status, który ADR może mieć

- `Proposed` — dyskusja w toku, jeszcze nie zaczynamy implementacji.
- `Accepted` — decyzja zatwierdzona, kod może się o nią opierać.
- `Implemented` — kod realizujący tę decyzję jest na main.
- `Superseded` — zastąpiony nowszym ADR. Dolny header musi linkować do następcy.
- `Deprecated` — przestaliśmy stosować, ale brak następcy (np. wymóg odpadł).

## Konwencja

- Plik: `NNNN-kebab-case-tytul.md`, np. `0001-network-chat-architecture.md`.
- Numer rośnie monotonicznie, nawet jeśli ADR zostanie zarzucony.
- Każdy ADR powinien dać się przeczytać samodzielnie — bez zaglądania do
  kodu — żeby ktoś (Ty za rok, ktoś nowy w projekcie) zrozumiał, dlaczego
  jest tak a nie inaczej.

## Lista

| #    | Tytuł                                                           | Status                |
|------|-----------------------------------------------------------------|-----------------------|
| 0001 | [Architektura czatu między użytkownikami](0001-network-chat-architecture.md) | Accepted              |
