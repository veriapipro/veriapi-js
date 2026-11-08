# VeriApi.Pro JavaScript / TypeScript SDK: döviz kuru, namaz vakti, hava durumu ve deprem API'si

Node.js, Deno, Bun ve tarayıcıda döviz kurlarını, namaz vakitlerini, hava durumunu, son depremleri ve il/ilçe listesini tek API anahtarıyla çekin.

Official JavaScript/TypeScript client for [VeriApi.Pro](https://veriapi.pro/?ref=github): Turkish exchange rates, prayer times, weather, earthquakes and cities.

Bağımlılık yok, `fetch` kullanır. Node 20+, Deno, Bun, Workers ve tarayıcı. Yalnızca ESM, tipler pakette.

```bash
npm install @veriapipro/sdk
```

## Hızlı başlangıç

```js
import { VeriApi, VeriApiHatasi } from "@veriapipro/sdk";

const api = new VeriApi({ anahtar: process.env.VERIAPI_ANAHTAR });

const sonuc = await api.doviz({ kod: "USD,EUR" });
console.log(sonuc.veri.kurlar);
console.log(sonuc.kaynak[0].atif); // veriyi gösterdiğiniz yerde görünür yazın
console.log(sonuc.guncelleme, sonuc.bayat);
console.log(sonuc.kota.gunlukKalan, sonuc.kota.dakikalikKalan, sonuc.kota.istekMaliyeti);
```

Anahtarı tarayıcı koduna koymayın; görülebilir. Tarayıcıdan kullanacaksanız panelde alan adı kısıtı tanımlayın.

## Yöntemler

```js
await api.doviz({ kod: ["USD", "EUR"], tur: "referans" }); // tur: anlik | referans
await api.hava({ il: "duzce", ilce: "akcakoca" });         // ya da { konum: "duzce-akcakoca" }, ya da { enlem, boylam }
await api.namaz({ il: "ankara", tarih: "2026-11-05", gun: 7 });
await api.depremler({ limit: 10, min_buyukluk: 4, saat: 24, il: "izmir", yurtici: true });
await api.iller();
await api.ilceler("duzce");                                // ad, slug ya da plaka

await api.get("/v1/takvim/tatiller", { yil: 2026 });       // diğer tüm uçlar
```

TypeScript'te `veri` tipi verilebilir:

```ts
const { veri } = await api.get<{ yil: number; tatiller: unknown[] }>("/v1/takvim/tatiller");
```

## Seçenekler

```js
const api = new VeriApi({
  anahtar: "va_ANAHTARINIZ",
  zamanAsimiMs: 10000,    // istek başına
  yenidenDeneme: 2,       // 429'da en çok kaç kez daha; 0 kapatır
  azamiBeklemeMs: 60000,  // bundan uzun Retry-After beklenmez, hata hemen fırlatılır
  fetch: globalThis.fetch // özel fetch
});
```

## Hatalar

```js
try {
  await api.namaz({ il: "duzce", gun: 99 });
} catch (hata) {
  if (hata instanceof VeriApiHatasi) {
    console.log(hata.kod, hata.mesaj, hata.httpDurumu);
    console.log(hata.alanlar);    // 422: [{ alan: "gun", mesaj: "..." }]
    console.log(hata.retryAfter); // 429: saniye
    console.log(hata.zamanAsimi); // zaman aşımında true; bağlantı hatasında kod ve httpDurumu 0
  }
}
```

Yönlendirmeler izlenmez (anahtar başka adrese gitmesin); 3xx bağlantı hatası olarak döner.

## Webhook doğrulama

Ham gövdeyi kullanın; `JSON.stringify` ile yeniden üretilen gövdede imza tutmaz. `imzaDogrula` Promise döndürür.

```js
import express from "express";
import { imzaDogrula } from "@veriapipro/sdk";

const app = express();

app.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const gecerli = await imzaDogrula({
    govde: req.body,
    imza: req.get("X-VeriApi-Imza"),
    zaman: req.get("X-VeriApi-Zaman"),
    gizli: process.env.VERIAPI_WEBHOOK_GIZLI,
  });
  if (!gecerli) return res.sendStatus(401);
  console.log(req.get("X-VeriApi-Olay"), JSON.parse(req.body));
  res.sendStatus(204);
});
```

`toleransSn` (varsayılan 300) saniyeden eski ya da ileri tarihli imza reddedilir; 0 kapatır.

## Geliştirme

```bash
npm install && npm run build  # dist/ üretir (TypeScript 5.8+)
npm test                      # Node 22.18+; kaynağı doğrudan yükler
```

## Bağlantılar

- Ücretsiz anahtar ve canlı deneme: <https://veriapi.pro/?ref=github>
- Dokümantasyon: <https://veriapi.pro/dokumantasyon>
- OpenAPI: <https://api.veriapi.pro/v1/openapi.json>

Lisans: MIT
