# Nuotit

Kuoroharrastuksen nuottikirjasto selaimessa. PDF-nuotit tallennetaan laitteelle
(IndexedDB), joten ne toimivat myös ilman verkkoyhteyttä.

## Ominaisuudet

- **Lisää nuotteja**: valitse yksi tai useampi PDF (tietokoneella myös raahaamalla).
- **Kirjasto**: pikkukuvat, haku (nimi, säveltäjä, tunniste), järjestys ja tunnisteet
  (esim. *kevätkonsertti*) suodattimina. Kun tunniste on valittuna, uudet nuotit saavat sen automaattisesti.
- **Katselin**:
  - napauta **oikeaa reunaa** → seuraava sivu, **vasenta reunaa** → edellinen
  - nuotit näytetään aina yksi sivu kerrallaan, sovitettuna näytölle
  - napauta **keskeltä** → valikko (takaisin, koko näyttö, sivuliukusäädin)
  - pyyhkäisy sivuttain vaihtaa myös sivua
  - nuolinäppäimet / PageUp-PageDown / välilyönti → toimii Bluetooth-sivunkääntöpolkimilla
  - näyttö pysyy päällä katselun ajan, ja sovellus muistaa mihin sivuun jäit

## Käynnistys omalla koneella

```bash
npm start
```

Avaa sitten http://localhost:8080/. Riippuvuuksia ei tarvitse asentaa (vain Node.js).

## Käyttö tabletilla tai puhelimella

Offline-tuki ja "Lisää aloitusnäyttöön" -asennus vaativat **HTTPS**-osoitteen. Kansion voi
julkaista sellaisenaan mille tahansa staattiselle palvelulle (esim. GitHub Pages, Netlify,
Cloudflare Pages). Sen jälkeen:

- **iPad / iPhone (Safari)**: Jaa → Lisää Koti-valikkoon
- **Android (Chrome)**: ⋮ → Asenna sovellus

Huom: nuotit tallentuvat vain sille laitteelle, jolla ne lisätään.

## Tiedostot

| Tiedosto | Sisältö |
|---|---|
| `index.html`, `style.css` | Käyttöliittymä |
| `app.js` | Kirjasto, tuonti, muokkaus, reititys |
| `viewer.js` | PDF-katselin ja sivunvaihto |
| `db.js` | IndexedDB-tallennus |
| `sw.js` | Offline-välimuisti (kasvata `CACHE`-versiota julkaistessa) |
| `vendor/` | [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38 (legacy-build vanhemmille laitteille), Apache 2.0 |
