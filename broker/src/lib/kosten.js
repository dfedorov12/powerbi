"use strict";

/* Kosten aus Azure Cost Management.

   Anders als die CU-Zahlen der Metrik-App ist das eine verlässliche Quelle:
   dieselben Zahlen, die auch in der Kostenanalyse des Azure-Portals stehen.

   Einstellungen:
     KOSTEN_ABO            Abonnement (Vorgabe: PBI_ABO bzw. leer = aus)
     KOSTEN_GRUPPEN        Ressourcengruppen, die zu dieser Anwendung gehören,
                           z. B. "rg-dihag-dp-dev-westeurope,rg-berichte-broker"
     KOSTEN_KAPAZITAET_RG  welche davon die Fabric-Kapazität enthält

   Der Dienstuser braucht die Rolle **Cost Management Reader** auf dem
   Abonnement.

   Zwei Eigenheiten der API, die hier berücksichtigt sind:
     - Sie drosselt gern mit HTTP 429. Deshalb Wiederholung mit wachsender
       Wartezeit statt eines harten Fehlers.
     - Kosten ändern sich nicht im Minutentakt. Eine Stunde Zwischenspeicher
       spart die meisten Aufrufe und damit auch die Drosselung.            */

const API = "https://management.azure.com";

const cfg = () => ({
  abo: process.env.KOSTEN_ABO || "",
  gruppen: String(process.env.KOSTEN_GRUPPEN || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  kapazitaetGruppe: String(process.env.KOSTEN_KAPAZITAET_RG || "").trim().toLowerCase()
});

const eingerichtet = () => Boolean(cfg().abo);

/* ── Token des Dienstusers für die Azure-Verwaltung ─────────────────── */

let _tok = { wert: null, exp: 0 };

async function verwaltungsToken(pbiCfg) {
  if (_tok.wert && Date.now() < _tok.exp - 5 * 60000) return _tok.wert;
  const res = await fetch(
    `https://login.microsoftonline.com/${pbiCfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: pbiCfg.clientId,
        client_secret: pbiCfg.clientSecret,
        scope: `${API}/.default`,
        grant_type: "client_credentials"
      }).toString()
    });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    const e = new Error("Anmeldung für Azure-Kosten fehlgeschlagen: "
      + (d.error_description || d.error || res.statusText));
    e.art = "kosten";
    throw e;
  }
  _tok = { wert: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tok.wert;
}

/** Eine Kostenabfrage stellen, mit Rücksicht auf die Drosselung. */
async function abfrage(token, abo, zeitraum) {
  const url = `${API}/subscriptions/${abo}/providers/Microsoft.CostManagement`
            + `/query?api-version=2023-03-01`;
  const koerper = {
    type: "ActualCost",
    timeframe: zeitraum,
    dataset: {
      granularity: "None",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ResourceGroupName" }]
    }
  };

  // Wartezeiten der Wiederholung. Über KOSTEN_WARTEMS einstellbar – die Tests
  // setzen sie auf 1 ms, damit die Drosselung ohne echtes Warten prüfbar ist.
  const w = Number(process.env.KOSTEN_WARTEMS || 10000);
  let letzte = null;
  let naechste = 0;
  for (const warte of [0, w, 3 * w, 6 * w]) {
    // `Retry-After` schlägt die eigene Leiter: Azure weiß besser, wann es
    // wieder mag.
    const pause = naechste || warte;
    if (pause) await new Promise(r => setTimeout(r, pause));
    naechste = 0;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(koerper)
    });
    if (res.ok) return res.json();
    const retryAfter = Number(res.headers?.get?.("retry-after") || 0);
    if (retryAfter > 0) naechste = Math.min(retryAfter * 1000, 120000);
    letzte = { status: res.status, text: (await res.text()).slice(0, 300) };
    // 429 = gedrosselt, 503 = kurzzeitig nicht verfügbar: beides erneut versuchen
    if (res.status !== 429 && res.status !== 503) break;
  }
  const e = new Error(letzte?.status === 403
    ? "Der Dienstuser darf die Kosten nicht lesen (Rolle „Cost Management Reader“ fehlt)."
    : letzte?.status === 429
      ? "Azure drosselt die Kostenabfrage gerade. Der nächste Aufruf in einigen "
        + "Minuten liefert die Zahlen; die Kostenanalyse im Portal geht sofort."
      : `Kostenabfrage fehlgeschlagen (HTTP ${letzte?.status}).`);
  e.art = letzte?.status === 403 ? "kein_zugriff"
        : letzte?.status === 429 ? "gedrosselt" : "kosten";
  e.detail = letzte?.text || "";
  throw e;
}

/** Zeilen der Antwort in eine handliche Form bringen. */
function zeilen(antwort) {
  const spalten = (antwort?.properties?.columns || []).map(c => c.name);
  const iKosten = spalten.indexOf("Cost");
  const iGruppe = spalten.indexOf("ResourceGroupName");
  const iWaehrung = spalten.indexOf("Currency");
  return (antwort?.properties?.rows || []).map(r => ({
    gruppe: String(r[iGruppe] ?? "").toLowerCase(),
    betrag: Number(r[iKosten] ?? 0),
    waehrung: iWaehrung >= 0 ? r[iWaehrung] : "EUR"
  }));
}

/* ── Zwischenspeicher ────────────────────────────────────────────────── */

let _cache = null;
let _cacheZeit = 0;
const TTL = 60 * 60 * 1000;

/** Kosten für den laufenden und den vergangenen Monat.
 *  @returns {Promise<object>} immer ein Objekt – nie ein Wurf, damit die
 *  Verbrauchsansicht auch ohne Kostenzugriff funktioniert. */
async function kosten(pbiCfg, frisch = false) {
  const c = cfg();
  if (!eingerichtet()) return { verfuegbar: false, grund: "nicht_eingerichtet" };
  if (!frisch && _cache && Date.now() - _cacheZeit < TTL) return _cache;

  try {
    const token = await verwaltungsToken(pbiCfg);
    // Nacheinander, nicht parallel: zwei gleichzeitige Abfragen treten bei
    // Cost Management sofort ins Drosselungslimit.
    const jetzt = await abfrage(token, c.abo, "MonthToDate");
    const vorher = await abfrage(token, c.abo, "TheLastMonth");

    const auswerten = antwort => {
      const alle = zeilen(antwort);
      const unsere = c.gruppen.length
        ? alle.filter(z => c.gruppen.includes(z.gruppe))
        : alle;
      const summe = unsere.reduce((s, z) => s + z.betrag, 0);
      const kapazitaet = c.kapazitaetGruppe
        ? unsere.filter(z => z.gruppe === c.kapazitaetGruppe)
                .reduce((s, z) => s + z.betrag, 0)
        : null;
      return {
        summe,
        kapazitaet,
        uebrige: kapazitaet === null ? null : summe - kapazitaet,
        waehrung: unsere[0]?.waehrung || alle[0]?.waehrung || "EUR",
        jeGruppe: unsere.map(z => ({ gruppe: z.gruppe, betrag: z.betrag }))
                        .sort((a, b) => b.betrag - a.betrag)
      };
    };

    _cache = {
      verfuegbar: true,
      abo: c.abo,
      laufenderMonat: auswerten(jetzt),
      vormonat: auswerten(vorher),
      stand: new Date().toISOString()
    };
    _cacheZeit = Date.now();
    return _cache;
  } catch (e) {
    return { verfuegbar: false, grund: e.art || "kosten",
             detail: e.message };
  }
}

module.exports = { kosten, eingerichtet, cfg };
