# Original User Request

## Initial Request — 2026-06-13T16:59:43+02:00

# Teamwork Project Prompt — Draft

Oprava online databáze potravin (API proxy v `api/search.js`) pro aplikaci Calorie Tracker PWA. Cílem je zprovoznit vyhledávání v externí databázi, aby stabilně vracelo výsledky.

Working directory: `c:\Users\Adam\Documents\antigravity\calorie-tracker-pwa`
Integrity mode: demo

## Requirements

### R1. Oprava API Proxy pro vyhledávání
Zajistit, aby serverless funkce `api/search.js` správně komunikovala s online databází potravin a vracela relevantní výsledky bez chybových kódů. Subagent má volnost zkusit nejprve opravit OpenFoodFacts, a v případě nestability napojit jinou volně dostupnou databázi.

### R2. Lokální testovací skript
Vytvořit dedikovaný testovací skript (např. `test_search.js`), kterým bude subagent lokálně ověřovat funkčnost API volání, aniž by bylo nutné aplikaci neustále nasazovat na Vercel.

## Acceptance Criteria

### Funkčnost API
- [ ] Spuštění testovacího skriptu s dotazem "jablko" vrátí alespodn 1 platný produkt s vyplněnými makroživinami (kalorie, bílkoviny, sacharidy, tuky).
- [ ] Spuštění testovacího skriptu s nesmyslným dotazem (např. "xqyzzzz") bezpečně vrátí prázdné pole `[]` bez pádu s chybou 500.
- [ ] Soubor `api/search.js` je úspěšně aktualizován o funkční a stabilní logiku vyhledávání.
