/** VeriApi.Pro resmî istemcisi. Bağımlılıksız; Node 20+, Deno, Bun, Workers ve tarayıcıda `fetch` ile çalışır. */

export const SURUM = "0.1.0";
const VARSAYILAN_ADRES = "https://api.veriapi.pro";
const VARSAYILAN_BEKLEME_MS = 1000; // 429'da Retry-After yoksa

export interface Kaynak {
  kod: string;
  ad: string;
  lisans?: string | null;
  atif?: string | null;
  url?: string | null;
}

/** X-RateLimit-* ve X-Istek-Maliyeti başlıkları; başlık yoksa alan null. */
export interface Kota {
  gunlukLimit: number | null;
  gunlukKalan: number | null;
  dakikalikLimit: number | null;
  dakikalikKalan: number | null;
  istekMaliyeti: number | null;
}

/** Çözülmüş yanıt zarfı. Zarfsız uçlarda (/v1/durum) `veri` gövdenin tamamıdır. */
export interface Sonuc<T = any> {
  veri: T;
  kaynak: Kaynak[];
  guncelleme: string | null;
  bayat: boolean;
  kota: Kota;
}

export interface HataliAlan {
  alan: string;
  mesaj: string;
}

export interface HataAyrintisi {
  alanlar?: HataliAlan[];
  retryAfter?: number | null;
  kota?: Kota;
  zamanAsimi?: boolean;
  cause?: unknown;
}

/** API ya da bağlantı hatası. Bağlantı ve zaman aşımında `kod` ve `httpDurumu` 0'dır. */
export class VeriApiHatasi extends Error {
  readonly kod: number;
  readonly mesaj: string;
  readonly httpDurumu: number;
  /** 422'de hatalı parametreler. */
  readonly alanlar: HataliAlan[];
  /** 429'da saniye. */
  readonly retryAfter: number | null;
  readonly kota: Kota;
  readonly zamanAsimi: boolean;

  constructor(kod: number, mesaj: string, httpDurumu: number, ayrinti: HataAyrintisi = {}) {
    super(mesaj, ayrinti.cause === undefined ? undefined : { cause: ayrinti.cause });
    this.name = "VeriApiHatasi";
    this.kod = kod;
    this.mesaj = mesaj;
    this.httpDurumu = httpDurumu;
    this.alanlar = ayrinti.alanlar ?? [];
    this.retryAfter = ayrinti.retryAfter ?? null;
    this.kota = ayrinti.kota ?? kotaOku(new Headers());
    this.zamanAsimi = ayrinti.zamanAsimi ?? false;
  }
}

export interface Secenekler {
  anahtar: string;
  /** Varsayılan https://api.veriapi.pro */
  temelAdres?: string;
  /** İstek başına; varsayılan 10000. */
  zamanAsimiMs?: number;
  /** 429'da en çok kaç kez daha denensin; varsayılan 2, 0 kapatır. */
  yenidenDeneme?: number;
  /** Bundan uzun Retry-After beklenmez, hata hemen fırlatılır (günlük kota aşımı saatler sürebilir). Varsayılan 60000. */
  azamiBeklemeMs?: number;
  /** Sahte istemci ya da özel fetch. */
  fetch?: typeof globalThis.fetch;
  /** Beklemeyi değiştirmek için (testler). */
  bekle?: (ms: number) => Promise<void>;
}

export type Parametre = string | number | boolean | readonly (string | number)[] | null | undefined;
export type Parametreler = Record<string, Parametre>;

export interface KonumParametreleri {
  /** Konum slug'ı (ör. duzce-akcakoca). */
  konum?: string;
  /** İl adı, slug'ı ya da plaka. */
  il?: string | number;
  ilce?: string;
  enlem?: number;
  boylam?: number;
}

export interface DovizParametreleri {
  /** "USD,EUR" ya da ["USD", "EUR"]. */
  kod?: string | readonly string[];
  tur?: "anlik" | "referans";
}

export interface NamazParametreleri extends KonumParametreleri {
  /** YYYY-AA-GG; varsayılan bugün. */
  tarih?: string;
  /** 1-31. */
  gun?: number;
}

export interface DepremParametreleri {
  limit?: number;
  min_buyukluk?: number;
  saat?: number;
  il?: string | number;
  yurtici?: boolean;
}

function tam(deger: string | null): number | null {
  if (deger === null || !/^-?\d+$/.test(deger.trim())) return null;
  return Number(deger);
}

function kotaOku(b: Headers): Kota {
  return {
    gunlukLimit: tam(b.get("X-RateLimit-Limit-Day")),
    gunlukKalan: tam(b.get("X-RateLimit-Remaining-Day")),
    dakikalikLimit: tam(b.get("X-RateLimit-Limit-Minute")),
    dakikalikKalan: tam(b.get("X-RateLimit-Remaining-Minute")),
    istekMaliyeti: tam(b.get("X-Istek-Maliyeti")),
  };
}

function retryAfterOku(deger: string | null): number | null {
  if (deger === null || deger.trim() === "") return null;
  const saniye = Number(deger);
  return Number.isFinite(saniye) ? Math.max(0, saniye) : null;
}

function hataOlustur(durum: number, govde: string, basliklar: Headers): VeriApiHatasi {
  let kod = durum;
  let mesaj = `Beklenmeyen yanıt (HTTP ${durum})`;
  let alanlar: HataliAlan[] | undefined;
  try {
    const hata = JSON.parse(govde)?.hata;
    if (typeof hata?.kod === "number") kod = hata.kod;
    if (typeof hata?.mesaj === "string" && hata.mesaj) {
      mesaj = hata.mesaj;
    } else if (hata?.mesaj && typeof hata.mesaj === "object") {
      // 422: {"metin": "...", "alanlar": [...]}
      if (hata.mesaj.metin) mesaj = String(hata.mesaj.metin);
      if (Array.isArray(hata.mesaj.alanlar)) alanlar = hata.mesaj.alanlar;
    }
  } catch {
    // JSON olmayan yanıt (vekil sunucu 502 sayfası vb.)
  }
  return new VeriApiHatasi(kod, mesaj, durum, {
    alanlar,
    kota: kotaOku(basliklar),
    retryAfter: retryAfterOku(basliklar.get("Retry-After")),
  });
}

function sorgu(parametreler: Parametreler): string {
  const q = new URLSearchParams();
  for (const [ad, deger] of Object.entries(parametreler)) {
    if (deger === null || deger === undefined) continue;
    q.set(ad, Array.isArray(deger) ? deger.join(",") : String(deger));
  }
  return q.toString();
}

/** Tarayıcıda User-Agent ön uçuş (CORS) isteğini bozar; yalnızca sunucu tarafında gönderilir. */
function sunucuTarafinda(): boolean {
  return (globalThis as { process?: unknown }).process !== undefined;
}

export class VeriApi {
  #anahtar: string;
  #temel: string;
  #zamanAsimiMs: number;
  #yenidenDeneme: number;
  #azamiBeklemeMs: number;
  #fetch: typeof globalThis.fetch;
  #bekle: (ms: number) => Promise<void>;

  constructor(secenekler: Secenekler) {
    if (!secenekler?.anahtar) throw new TypeError("API anahtarı gerekli");
    this.#anahtar = secenekler.anahtar;
    this.#temel = (secenekler.temelAdres ?? VARSAYILAN_ADRES).replace(/\/+$/, "");
    this.#zamanAsimiMs = secenekler.zamanAsimiMs ?? 10_000;
    this.#yenidenDeneme = Math.max(0, secenekler.yenidenDeneme ?? 2);
    this.#azamiBeklemeMs = secenekler.azamiBeklemeMs ?? 60_000;
    this.#fetch = secenekler.fetch ?? globalThis.fetch.bind(globalThis);
    this.#bekle = secenekler.bekle ?? ((ms) => new Promise((coz) => setTimeout(coz, ms)));
  }

  /** `yol` "/v1/doviz" ya da "doviz" olabilir. null / undefined parametreler gönderilmez. */
  async get<T = any>(yol: string, parametreler: Parametreler = {}): Promise<Sonuc<T>> {
    const url = this.#url(yol, parametreler);
    let deneme = 0;
    for (;;) {
      const { durum, govde, basliklar } = await this.#istek(url);
      if (durum === 429 && deneme < this.#yenidenDeneme) {
        const saniye = retryAfterOku(basliklar.get("Retry-After"));
        const ms = saniye === null ? VARSAYILAN_BEKLEME_MS : saniye * 1000;
        if (ms <= this.#azamiBeklemeMs) {
          await this.#bekle(ms);
          deneme += 1;
          continue;
        }
      }
      if (durum < 200 || durum >= 300) throw hataOlustur(durum, govde, basliklar);
      return this.#coz<T>(durum, govde, basliklar);
    }
  }

  #coz<T>(durum: number, govde: string, basliklar: Headers): Sonuc<T> {
    const kota = kotaOku(basliklar);
    let belge: any;
    try {
      belge = JSON.parse(govde);
    } catch (cause) {
      throw new VeriApiHatasi(0, "Yanıt JSON değil", durum, { kota, cause });
    }
    if (belge === null || typeof belge !== "object" || !("veri" in belge)) {
      return { veri: belge as T, kaynak: [], guncelleme: null, bayat: false, kota };
    }
    return {
      veri: belge.veri as T,
      kaynak: belge.kaynak ?? [],
      guncelleme: belge.guncelleme ?? null,
      bayat: Boolean(belge.bayat),
      kota,
    };
  }

  #url(yol: string, parametreler: Parametreler): string {
    const tamYol = yol.startsWith("/v1/") ? yol : `/v1/${yol.replace(/^\/+/, "")}`;
    const q = sorgu(parametreler);
    if (!q) return this.#temel + tamYol;
    return this.#temel + tamYol + (tamYol.includes("?") ? "&" : "?") + q;
  }

  async #istek(url: string): Promise<{ durum: number; govde: string; basliklar: Headers }> {
    const basliklar: Record<string, string> = { "X-API-Key": this.#anahtar, Accept: "application/json" };
    if (sunucuTarafinda()) basliklar["User-Agent"] = `veriapi-js/${SURUM}`;
    const iptal = new AbortController();
    const sayac = setTimeout(() => iptal.abort(), this.#zamanAsimiMs);
    try {
      // redirect "error": fetch özel başlıkları yönlendirmede taşır, X-API-Key başka adrese gitmesin
      const yanit = await this.#fetch(url, { method: "GET", headers: basliklar, signal: iptal.signal, redirect: "error" });
      return { durum: yanit.status, govde: await yanit.text(), basliklar: yanit.headers };
    } catch (cause) {
      if (iptal.signal.aborted) {
        throw new VeriApiHatasi(0, `Zaman aşımı (${this.#zamanAsimiMs} ms)`, 0, { zamanAsimi: true, cause });
      }
      throw new VeriApiHatasi(0, `Bağlantı hatası: ${String(cause)}`, 0, { cause });
    } finally {
      clearTimeout(sayac);
    }
  }

  // Kolaylık yöntemleri (parametreler api/app/routers/data.py ile aynı)

  doviz<T = any>(p: DovizParametreleri = {}): Promise<Sonuc<T>> {
    return this.get<T>("/v1/doviz", { kod: p.kod, tur: p.tur });
  }

  hava<T = any>(p: KonumParametreleri): Promise<Sonuc<T>> {
    return this.get<T>("/v1/hava", { konum: p.konum, il: p.il, ilce: p.ilce, enlem: p.enlem, boylam: p.boylam });
  }

  namaz<T = any>(p: NamazParametreleri): Promise<Sonuc<T>> {
    return this.get<T>("/v1/namaz", {
      konum: p.konum, il: p.il, ilce: p.ilce, enlem: p.enlem, boylam: p.boylam, tarih: p.tarih, gun: p.gun,
    });
  }

  depremler<T = any>(p: DepremParametreleri = {}): Promise<Sonuc<T>> {
    return this.get<T>("/v1/deprem/son", {
      limit: p.limit, min_buyukluk: p.min_buyukluk, saat: p.saat, il: p.il, yurtici: p.yurtici,
    });
  }

  iller<T = any>(): Promise<Sonuc<T>> {
    return this.get<T>("/v1/konumlar/iller");
  }

  /** il: ad, slug ya da plaka. */
  ilceler<T = any>(il: string | number): Promise<Sonuc<T>> {
    return this.get<T>(`/v1/konumlar/iller/${encodeURIComponent(String(il))}/ilceler`);
  }
}

// Webhook imzası: imzalanan metin `<zaman>.<ham gövde>`, HMAC-SHA256 hex, başlık `sha256=<hex>`

export interface ImzaGirdisi {
  /** Ayrıştırılmamış ham gövde (JSON.stringify ile yeniden üretmeyin, imza tutmaz). */
  govde: string | Uint8Array;
  /** X-VeriApi-Imza başlığı. */
  imza: string | null | undefined;
  /** X-VeriApi-Zaman başlığı. */
  zaman: string | null | undefined;
  gizli: string;
  /** Yeniden oynatmaya karşı zaman farkı sınırı, saniye; varsayılan 300, 0 kapatır. */
  toleransSn?: number;
  /** Unix saniyesi; varsayılan şu an. */
  simdi?: number;
}

function saniyeOku(zaman: string): number | null {
  if (/^\d+(\.\d+)?$/.test(zaman)) return Number(zaman);
  if (/^\d{4}-\d{2}-\d{2}T\S+(Z|[+-]\d{2}:\d{2})$/.test(zaman)) {
    const ms = Date.parse(zaman);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

/**
 * X-VeriApi-Imza başlığını doğrular; geçersiz her girdide false döner.
 * Karşılaştırma `crypto.subtle.verify` ile sabit zamanlıdır.
 */
export async function imzaDogrula(girdi: ImzaGirdisi): Promise<boolean> {
  const { govde, gizli, toleransSn = 300, simdi } = girdi;
  if (!gizli || !girdi.imza || !girdi.zaman) return false;
  const eslesme = /^sha256=([0-9a-fA-F]{64})$/.exec(girdi.imza.trim());
  if (!eslesme) return false;
  const zaman = girdi.zaman.trim();
  const hex = eslesme[1] as string;
  const beklenen = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) beklenen[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  const kodlayici = new TextEncoder();
  const onEk = kodlayici.encode(`${zaman}.`);
  const ham = typeof govde === "string" ? kodlayici.encode(govde) : govde;
  const metin = new Uint8Array(onEk.length + ham.length);
  metin.set(onEk);
  metin.set(ham, onEk.length);

  const anahtar = await crypto.subtle.importKey("raw", kodlayici.encode(gizli), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", anahtar, beklenen, metin))) return false;
  if (toleransSn <= 0) return true;
  const saniye = saniyeOku(zaman);
  if (saniye === null) return false;
  return Math.abs((simdi ?? Date.now() / 1000) - saniye) <= toleransSn;
}
