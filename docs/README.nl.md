# Sonance AutoLogin — Nederlandse handleiding

**Luister naar je muziek op een Samsung-tv, zonder een lang serveradres of wachtwoord met de afstandsbediening in te voeren.**

Sonance AutoLogin is een fork van [Sonance3](https://github.com/MrSimmo/sonance3). Je maakt op je computer een versie van de app met je eigen Navidrome-inloggegevens. Daarna installeer je het WGT-bestand op je Samsung-tv en kun je meteen je muziekbibliotheek openen.

Je Navidrome-server mag overal draaien: thuis, op een VPS of achter je eigen domeinnaam. **Bunny is niet nodig.** Je hoeft op de televisie geen serveradres of wachtwoord in te typen.

![Sonance3 — scherm Tijdens afspelen](../screenshots/nowplaying.png)

## De app bouwen op een Mac

Je hebt Node.js 18 of nieuwer, bash, zip, unzip en perl nodig. Voor de eerste build heb je ook internet nodig, omdat de oorspronkelijke build via npm/npx extra tools kan downloaden.

Open Terminal en voer deze opdrachten uit:

~~~bash
git clone https://github.com/vbrekher/sonance3-autologin.git
cd sonance3-autologin
npm run build:personal
~~~

Werkt `node` of `npm` niet? Installeer dan eerst Node.js via [nodejs.org](https://nodejs.org/).

Het bouwscript stelt vier vragen:

1. **Navidrome URL** — het volledige adres van je server, bijvoorbeeld `https://music.example.com` of `http://192.168.1.20:4533`.
2. **Username** — je gebruikersnaam bij Navidrome.
3. **Playback** — druk op Enter om HTML5 Audio te gebruiken (standaard), of typ `A` voor AVPlay.
4. **Password** — de laatste vraag. Plak je wachtwoord met Cmd+V en druk op Enter. Er verschijnen geen tekens op het scherm. Dat is normaal.

Als de build klaar is, staan er twee bestanden in de map `dist/`:

| Bestand | Uiterlijk op de tv |
| --- | --- |
| `dist/Sonance-AutoLogin-Oblong.wgt` | Brede tegel op het startscherm |
| `dist/Sonance-AutoLogin-Square.wgt` | Vierkant pictogram |

**Installeer maar één van deze twee bestanden.** Het is dezelfde app, alleen met een ander pictogram.

## Installeren op een Samsung-tv

1. Open **Apps** op de tv en ga naar de appinstellingen.
2. Voer met de afstandsbediening `12345` in om **Developer Mode** te openen. Schakel deze in, vul het IP-adres in van de computer waarmee je de app gaat installeren en start de tv opnieuw op.
3. Zorg dat de computer en de tv op hetzelfde lokale netwerk zitten.
4. Download [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases) op je computer.
5. Kies je tv in Apps2Samsung en selecteer de optie om een eigen **WGT**-bestand te installeren. Kies het bestand uit de map `dist/`. Laat Apps2Samsung de app opnieuw ondertekenen als daarom wordt gevraagd.
6. Open **Sonance AutoLogin** op de tv. Het serveradres en de inloggegevens zitten al in je persoonlijke build.

Meer uitleg en links naar de officiële documentatie van Samsung vind je in de [uitgebreide installatiehandleiding](INSTALLATION.md) (Engels).

## Waarom standaard HTML5 Audio?

De oorspronkelijke Sonance3 gebruikt op Samsung-tv's de AVPlay-speler. Op een **Samsung UE43DU7100UXUA met Tizen 9** werd de muziekbibliotheek wel geladen, maar bleef het afspelen op 00:00 staan.

Met HTML5 Audio werkte het afspelen wel. Na een aanvullende aanpassing ging ook het volgende nummer automatisch verder zodra een nummer afgelopen was.

Dit is op **één tv-model** getest. Het betekent niet dat alle Samsung-tv's en alle audioformaten zijn gecontroleerd. Je kunt bij het bouwen nog steeds AVPlay kiezen.

## Belangrijk: je wachtwoord zit in het WGT-bestand

Je voert het wachtwoord in op je computer; het wordt niet naar GitHub of de makers van deze fork gestuurd. Maar **je wachtwoord wordt in het persoonlijke WGT-bestand opgeslagen**. Iedereen die dat bestand in handen krijgt, kan het wachtwoord eruit halen.

Deel je persoonlijke WGT daarom niet met anderen en upload het nooit naar GitHub Issues of Releases. Gebruik bij voorkeur een apart Navidrome-account voor je tv, met zo weinig mogelijk rechten.

Verander je het wachtwoord of het serveradres? **Bouw dan opnieuw een WGT-bestand en installeer dat opnieuw op de tv.**

## Als er iets niet werkt

- **De muziek speelt niet af:** kies HTML5 Audio en controleer of hetzelfde nummer wel werkt in de ingebouwde browser van de Samsung-tv.
- **Je ziet geen tekens bij het invoeren van het wachtwoord:** dat hoort zo. Plak het wachtwoord en druk op Enter.
- **De app kan niet worden geïnstalleerd:** controleer Developer Mode, het IP-adres van je computer en het ondertekenen van de WGT.
- **Je gebruikt Windows:** bekijk [Windows / WSL](INSTALLATION.md#windows) (Engels). Deze werkwijze is nog niet op een echte tv getest.

Meer antwoorden vind je in de [FAQ](FAQ.md) en bij [Problemen oplossen](TROUBLESHOOTING.md) (beide in het Engels).

## Oorspronkelijk project en licentie

De speler is oorspronkelijk gemaakt door [MrSimmo en de andere ontwikkelaars van Sonance3](https://github.com/MrSimmo/sonance3). Sonance AutoLogin is een **onofficiële fork**, geen officiële uitgave van Sonance3. De code valt onder de GNU GPL v3.

[English README](../README.md) · [Русская инструкция](README.ru.md)
