# Nuotit

Kuoroharrastuksen nuottikirjasto. PDF-nuotit tallennetaan laitteelle (IndexedDB), joten ne
toimivat myös ilman verkkoyhteyttä. Sama sovellus toimii verkkosovelluksena (PWA) ja
Capacitorilla tehtynä Android-sovelluksena (ks. [Android-sovellus](#android-sovellus)).

Verkkoversio: https://hsippola.github.io/nuotit/

## Ominaisuudet

- **Lisää nuotteja**: valitse yksi tai useampi PDF (tietokoneella myös raahaamalla).
- **Kirjasto**: pikkukuvat, haku (nimi, säveltäjä, tunniste), järjestys ja tunnisteet
  (esim. *kevätkonsertti*) suodattimina. Kun tunniste on valittuna, uudet nuotit saavat sen automaattisesti.
- **Oma järjestys**: paina korttia hetki ja raahaa se uuteen paikkaan (tietokoneella raahaa hiirellä).
  Järjestys vaihtuu samalla *Oma järjestys* -tilaan. Kun haku tai tunniste on valittuna,
  näkyvät nuotit vaihtavat paikkaa keskenään ja muut pysyvät paikoillaan. Uudet nuotit tulevat loppuun.
- **Katselin**:
  - napauta **oikeaa reunaa** → seuraava sivu, **vasenta reunaa** → edellinen
  - nuotit näytetään aina yksi sivu kerrallaan, sovitettuna näytölle
  - sivunumero näkyy hetken vasemmassa yläkulmassa, kun sivu vaihtuu
  - napauta **keskeltä** → valikko (takaisin, zoomaus −/+, koko näyttö, sivuliukusäädin)
  - **zoomaus**: nipistä kahdella sormella tai kaksoisnapauta keskeltä (vaakatasossa sivu
    sovitetaan leveyden mukaan, muuten 2×; uusi kaksoisnapautus palauttaa koko sivun).
    Tietokoneella Ctrl + rulla tai +/−-näppäimet. Zoomattua sivua siirretään vetämällä.
  - zoomattuna reunan napautus vierittää ensin sivua alas/ylös ja vaihtaa sivun vasta,
    kun sivun loppu (tai alku) on näkyvissä. Zoomaus säilyy sivulta toiselle ja muistetaan nuotin mukaan.
  - pyyhkäisy sivuttain vaihtaa myös sivua
  - nuolinäppäimet / PageUp-PageDown / välilyönti → toimii Bluetooth-sivunkääntöpolkimilla
  - näyttö pysyy päällä katselun ajan, ja sovellus muistaa mihin sivuun jäit

Nuotit tallentuvat vain sille laitteelle, jolla ne lisätään. Android-sovelluksen ja
verkkoversion nuotit ovat erillään toisistaan.

## Rakenne

```
app/                   julkaistava sovellus (verkkoversio ja Android-sovelluksen sisältö)
  index.html, style.css
  app.js               kirjasto, tuonti, muokkaus, reititys, Android-takaisin-painike
  viewer.js            PDF-katselin: sivunvaihto, zoomaus, sivunumero
  reorder.js           korttien järjestäminen raahaamalla
  db.js                IndexedDB-tallennus
  sw.js                offline-välimuisti (uudet tiedostot lisätään sen ASSETS-listaan)
  icons/               verkkoversion kuvakkeet
  vendor/              pdf.js 4.10.38 (legacy-build vanhemmille laitteille), Apache 2.0
android/               Android-sovellus (Capacitor), joka näyttää app-kansion sisällön
assets/                Android-sovelluksen kuvakkeen ja käynnistyskuvan lähdekuvat
tools/kuvakkeet.py     tekee kuvakkeet (app/icons ja assets)
capacitor.config.json  sovelluksen tunnus (fi.nakoalapaikka.nuotit), nimi ja lähdekansio
serve.js               paikallinen palvelin kehitykseen
```

## Paikallinen ajo

```bash
npm start
```

Avaa http://localhost:8080/. Palvelin tarvitsee vain Node.js:n.

## Julkaisu (verkkoversio)

GitHubiin viety muutos julkaistaan automaattisesti GitHub Pagesiin
(`.github/workflows/pages.yml`, julkaisee `app`-kansion). Julkaisu vaihtaa samalla
`app/sw.js`-tiedoston `CACHE`-version commitin tunnisteeseen, joten asennetut sovellukset
hakevat uuden version ja latautuvat itse uudelleen.

Puhelimeen tai tablettiin verkkoversion voi asentaa aloitusnäytölle:

- **iPad / iPhone (Safari)**: Jaa → Lisää Koti-valikkoon
- **Android (Chrome)**: ⋮ → Asenna sovellus

## Android-sovellus

Android-sovellus on tehty [Capacitorilla](https://capacitorjs.com) samalla tavalla kuin
Yhteyden helmet -sovellus. Se pakkaa `app`-kansion sovelluksen sisään, joten sovellus toimii
heti ilman verkkoa. Sovelluksessa Androidin takaisin-painike sulkee muokkausikkunan tai
nuotin ja kirjastossa sulkee sovelluksen. Service workeria ja koko näytön painiketta ei
käytetä (`NATIVE` app.js-tiedostossa).

Tarvitaan Node.js ja Android Studio. Gradle hakee tarvitsemansa Java-version itse.

**Ensimmäisellä kerralla** asenna riippuvuudet projektin juuressa:

```bash
npm install
```

**Kun `app`-kansio muuttuu**, kopioi muutokset Android-projektiin ja avaa se Android Studiossa:

```bash
npx cap sync android
```

```bash
npx cap open android
```

Android Studiossa sovelluksen voi ajaa emulaattorissa tai USB:llä kytketyssä puhelimessa (Run ▶).

**APK-tiedosto suoraan puhelimeen** (ilman Google Playta):

1. Android Studiossa *Build → Generate Signed App Bundle or APK → APK → Next*.
2. Ensimmäisellä kerralla *Create new…*: avaimen paikka `C:\Users\HarriSippola\Avaimet\nuotit.jks`
   (projektikansion ulkopuolella, samassa kansiossa kuin Yhteyden helmien avain), salasana,
   *Alias* `nuotit` ja *Certificate*-kohtaan vähintään nimi. Myöhemmin valitse sama tiedosto.
3. Valitse *release* ja *Create*. APK syntyy kansioon `android/app/release/app-release.apk`.

APK:n voi lähettää puhelimeen (esim. sähköpostilla, WhatsAppilla tai Driven kautta) ja asentaa.
Puhelin pyytää sallimaan asennuksen tuntemattomasta lähteestä. Päivitys asennetaan samalla
tavalla uuden APK:n päälle, kunhan `versionCode` on kasvanut ja APK on allekirjoitettu samalla
avaimella; tallennetut nuotit säilyvät. Varmuuskopioi avain ja salasana.

**Google Play -julkaisu**

1. Kasvata `android/app/build.gradle`-tiedostossa `versionCode`-arvoa yhdellä (jokaisen Playhin
   ladatun paketin pitää olla suurempi kuin edellinen) ja päivitä `versionName`.
2. Valitse Android Studiossa *Build → Generate Signed App Bundle or APK → Android App Bundle*.
   Luo ensimmäisellä kerralla uusi allekirjoitusavain (keystore) **projektikansion ulkopuolelle**.
   Varmuuskopioi avain ja sen salasanat, koska ilman niitä sovellukseen ei voi julkaista päivityksiä.
3. Lataa syntynyt `app-release.aab` Play Consolessa: *Test and release → Testing → Internal
   testing → Create new release*.

Sovelluksen sisältö päivittyy vain uuden APK:n tai Play-julkaisun mukana. Verkkoversio
päivittyy GitHubin kautta.

**Kuvakkeet**: `tools/kuvakkeet.py` tekee verkkoversion kuvakkeet (`app/icons`) ja
Android-kuvakkeiden lähdekuvat (`assets/`). Android-kuvakkeet ja käynnistyskuva tehdään niistä:

```bash
python tools/kuvakkeet.py
```

```bash
npx capacitor-assets generate --android --iconBackgroundColor "#1f3a5f" --splashBackgroundColor "#1f3a5f" --splashBackgroundColorDark "#1f3a5f"
```

**Komentoriviltä rakentaminen**: jos Gradle kaatuu virheeseen *Unable to establish loopback
connection*, Javan väliaikaiskansio ei kelpaa. Aseta ennen rakentamista
`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Temp`.
