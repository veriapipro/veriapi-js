// Sahte yerel HTTP sunucusuyla birim testleri. Çalıştırma: npm test (Node 22.18+ / 24: .ts dosyasını doğrudan yükler).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { VeriApi, VeriApiHatasi, imzaDogrula } from "../src/index.ts";

const KOTA = {
  "X-RateLimit-Limit-Day": "1000", "X-RateLimit-Remaining-Day": "999", "X-RateLimit-Limit-Minute": "20",
  "X-RateLimit-Remaining-Minute": "19", "X-Istek-Maliyeti": "1",
};
const ZARF = {
  veri: { kurlar: [{ kod: "USD" }] },
  kaynak: [{ kod: "ecb", ad: "ECB", lisans: "x", atif: "y", url: "z" }],
  guncelleme: "2026-11-05T10:00:00",
  bayat: true,
};
const SINIR = { hata: { kod: 429, mesaj: "Dakikalık istek sınırı aşıldı" } };

let sunucu, adres;
let istekler = [];
let yanitlar = [];
let beklemeler = [];

const istemci = (secenekler = {}) => new VeriApi({
  anahtar: "va_test", temelAdres: `${adres}/`, bekle: async (ms) => { beklemeler.push(ms); }, ...secenekler,
});
const son = () => {
  const { url, headers } = istekler.at(-1);
  const u = new URL(url, adres);
  return { yol: u.pathname, ham: url, sorgu: Object.fromEntries(u.searchParams), headers };
};
const hataBekle = async (cagri) => {
  try {
    await cagri();
  } catch (hata) {
    assert.ok(hata instanceof VeriApiHatasi, String(hata));
    return hata;
  }
  assert.fail("hata bekleniyordu");
};

before(async () => {
  sunucu = createServer((istek, yanit) => {
    istekler.push({ url: istek.url, headers: istek.headers });
    const { durum = 200, basliklar = KOTA, govde = ZARF, gecikme = 0 } = yanitlar.shift() ?? {};
    setTimeout(() => {
      yanit.writeHead(durum, basliklar);
      yanit.end(typeof govde === "string" ? govde : JSON.stringify(govde));
    }, gecikme);
  });
  await new Promise((coz) => sunucu.listen(0, "127.0.0.1", coz));
  adres = `http://127.0.0.1:${sunucu.address().port}`;
});
after(() => { sunucu.closeAllConnections(); sunucu.close(); });
beforeEach(() => { istekler = []; yanitlar = []; beklemeler = []; });

describe("başarı", () => {
  it("zarfı ve kotayı çözer", async () => {
    const sonuc = await istemci().get("/v1/doviz", { kod: "USD", bos: null, yok: undefined });
    assert.deepEqual(sonuc.veri, ZARF.veri);
    assert.equal(sonuc.kaynak[0].kod, "ecb");
    assert.equal(sonuc.guncelleme, ZARF.guncelleme);
    assert.equal(sonuc.bayat, true);
    assert.deepEqual(sonuc.kota, { gunlukLimit: 1000, gunlukKalan: 999, dakikalikLimit: 20, dakikalikKalan: 19, istekMaliyeti: 1 });
    const { yol, sorgu, headers, ham } = son();
    assert.equal(yol, "/v1/doviz");
    assert.deepEqual(sorgu, { kod: "USD" });
    assert.equal(headers["x-api-key"], "va_test");
    assert.ok(!ham.includes("anahtar"));
  });

  it("kısa yol ve zarfsız gövde", async () => {
    yanitlar.push({ basliklar: {}, govde: { durum: "ok" } });
    const sonuc = await istemci().get("durum");
    assert.equal(son().yol, "/v1/durum");
    assert.deepEqual(sonuc.veri, { durum: "ok" });
    assert.deepEqual(sonuc.kaynak, []);
    assert.equal(sonuc.kota.gunlukKalan, null);
  });

  it("kolaylık yöntemleri", async () => {
    const api = istemci();
    await api.doviz({ kod: ["USD", "EUR"], tur: "referans" });
    assert.equal(son().yol, "/v1/doviz");
    assert.deepEqual(son().sorgu, { kod: "USD,EUR", tur: "referans" });
    await api.hava({ il: "Düzce", ilce: "Akçakoca" });
    assert.equal(son().yol, "/v1/hava");
    assert.deepEqual(son().sorgu, { il: "Düzce", ilce: "Akçakoca" });
    await api.hava({ enlem: 0, boylam: 32.5 });
    assert.deepEqual(son().sorgu, { enlem: "0", boylam: "32.5" });
    await api.namaz({ konum: "duzce-akcakoca", tarih: "2026-11-05", gun: 7 });
    assert.equal(son().yol, "/v1/namaz");
    assert.deepEqual(son().sorgu, { konum: "duzce-akcakoca", tarih: "2026-11-05", gun: "7" });
    await api.depremler({ limit: 5, min_buyukluk: 4.5, saat: 24, il: 81, yurtici: true });
    assert.equal(son().yol, "/v1/deprem/son");
    assert.deepEqual(son().sorgu, { limit: "5", min_buyukluk: "4.5", saat: "24", il: "81", yurtici: "true" });
    await api.iller();
    assert.equal(son().yol, "/v1/konumlar/iller");
    await api.ilceler("Düzce/x");
    assert.equal(son().ham, "/v1/konumlar/iller/D%C3%BCzce%2Fx/ilceler");
  });
});

describe("hatalar", () => {
  it("tipli hata", async () => {
    yanitlar.push({ durum: 404, govde: { hata: { kod: 404, mesaj: "İl bulunamadı: x" } } });
    const hata = await hataBekle(() => istemci().ilceler("x"));
    assert.deepEqual([hata.kod, hata.mesaj, hata.httpDurumu, hata.message], [404, "İl bulunamadı: x", 404, "İl bulunamadı: x"]);
    assert.equal(hata.kota.gunlukKalan, 999);
  });

  it("422 alanlar", async () => {
    const alanlar = [{ alan: "gun", mesaj: "çok büyük" }];
    yanitlar.push({ durum: 422, basliklar: {}, govde: { hata: { kod: 422, mesaj: { metin: "Geçersiz parametre", alanlar } } } });
    const hata = await hataBekle(() => istemci().namaz({ il: "duzce", gun: 99 }));
    assert.equal(hata.mesaj, "Geçersiz parametre");
    assert.deepEqual(hata.alanlar, alanlar);
  });

  it("JSON olmayan hata", async () => {
    yanitlar.push({ durum: 502, basliklar: { "Content-Type": "text/html" }, govde: "<html>Bad Gateway</html>" });
    const hata = await hataBekle(() => istemci().iller());
    assert.deepEqual([hata.kod, hata.httpDurumu], [502, 502]);
  });

  it("geçersiz JSON başarı", async () => {
    yanitlar.push({ basliklar: {}, govde: "<html>" });
    const hata = await hataBekle(() => istemci().iller());
    assert.deepEqual([hata.kod, hata.httpDurumu], [0, 200]);
  });

  it("yönlendirme izlenmez", async () => {
    yanitlar.push({ durum: 302, basliklar: { Location: "/v1/baska" }, govde: "" });
    const hata = await hataBekle(() => istemci().iller());
    assert.equal(hata.httpDurumu, 0);
    assert.equal(istekler.length, 1);
  });

  it("zaman aşımı", async () => {
    yanitlar.push({ gecikme: 300 });
    const hata = await hataBekle(() => istemci({ zamanAsimiMs: 30 }).iller());
    assert.equal(hata.zamanAsimi, true);
    assert.deepEqual([hata.kod, hata.httpDurumu], [0, 0]);
  });

  it("bağlantı hatası", async () => {
    const hata = await hataBekle(() => new VeriApi({ anahtar: "k", temelAdres: "http://127.0.0.1:9" }).iller());
    assert.equal(hata.zamanAsimi, false);
    assert.equal(hata.httpDurumu, 0);
  });

  it("boş anahtar", () => {
    assert.throws(() => new VeriApi({ anahtar: "" }), TypeError);
  });
});

describe("yeniden deneme", () => {
  const sinir = (retryAfter) => ({ durum: 429, basliklar: retryAfter ? { "Retry-After": retryAfter } : {}, govde: SINIR });

  it("Retry-After'a uyar", async () => {
    yanitlar.push(sinir("7"), sinir("3"));
    const sonuc = await istemci().iller();
    assert.equal(sonuc.bayat, true);
    assert.deepEqual(beklemeler, [7000, 3000]);
    assert.equal(istekler.length, 3);
  });

  it("en çok iki deneme", async () => {
    yanitlar.push(sinir("1"), sinir("1"), sinir("1"));
    const hata = await hataBekle(() => istemci().iller());
    assert.deepEqual([hata.httpDurumu, hata.retryAfter], [429, 1]);
    assert.equal(istekler.length, 3);
  });

  it("kapatılabilir", async () => {
    yanitlar.push(sinir("1"));
    await hataBekle(() => istemci({ yenidenDeneme: 0 }).iller());
    assert.deepEqual(beklemeler, []);
    assert.equal(istekler.length, 1);
  });

  it("uzun bekleme denenmez", async () => {
    yanitlar.push(sinir("40000"));
    const hata = await hataBekle(() => istemci().iller());
    assert.equal(hata.retryAfter, 40000);
    assert.deepEqual(beklemeler, []);
  });

  it("başlık yoksa varsayılan bekleme", async () => {
    yanitlar.push(sinir());
    await istemci().iller();
    assert.deepEqual(beklemeler, [1000]);
  });

  it("başka hata denenmez", async () => {
    yanitlar.push({ durum: 503, basliklar: { "Retry-After": "1" }, govde: { hata: { kod: 503, mesaj: "hazır değil" } } });
    await hataBekle(() => istemci().iller());
    assert.equal(istekler.length, 1);
  });
});

describe("webhook", () => {
  // Dört SDK'nın testlerinde aynı örnek
  const ornek = {
    gizli: "whsec_ornek",
    zaman: "1762300800",
    govde: '{"olay":"deprem.yeni","veri":{"buyukluk":4.2,"il":"Düzce"}}',
    imza: "sha256=c7be673a84807aac83b2d3f90ef21166c532c8006043a2558cefe9c3d839edab",
    simdi: 1762300900,
  };
  const dogrula = (degisen = {}) => imzaDogrula({ ...ornek, ...degisen });

  it("geçerli", async () => {
    assert.equal(await dogrula(), true);
    assert.equal(await dogrula({ govde: new TextEncoder().encode(ornek.govde) }), true);
    assert.equal(await dogrula({ imza: `sha256=${ornek.imza.slice(7).toUpperCase()}` }), true);
  });

  it("geçersiz", async () => {
    for (const degisen of [
      { govde: `${ornek.govde} ` }, { gizli: "baska" }, { gizli: "" }, { zaman: "1762300801" }, { imza: ornek.imza.slice(7) },
      { imza: "sha256=zz" }, { imza: "sha256=ğğ" }, { imza: null }, { zaman: undefined },
    ]) {
      assert.equal(await dogrula(degisen), false, JSON.stringify(degisen));
    }
  });

  it("tolerans", async () => {
    assert.equal(await dogrula({ simdi: ornek.simdi + 300 }), false);
    assert.equal(await dogrula({ simdi: ornek.simdi + 300, toleransSn: 0 }), true);
    assert.equal(await dogrula({ simdi: ornek.simdi + 300, toleransSn: 1000 }), true);
  });

  it("ISO zaman", async () => {
    const zaman = "2026-11-05T00:00:00+03:00";
    const imza = `sha256=${createHmac("sha256", "g").update(`${zaman}.x`).digest("hex")}`;
    const an = 1793826000;
    assert.equal(await imzaDogrula({ govde: "x", imza, zaman, gizli: "g", simdi: an + 10 }), true);
    assert.equal(await imzaDogrula({ govde: "x", imza, zaman, gizli: "g", simdi: an + 1000 }), false);
  });
});
