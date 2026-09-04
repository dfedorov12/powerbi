"use strict";

/* Kosten aus Azure Cost Management.

   Anders als die CU-Zahlen der Metrik-App ist das eine verlässliche Quelle:
   dieselben Zahlen, die auch in der Kostenanalyse des Azure-Portals stehen.

   Einstellungen:
     KOSTEN_ABO            Abonnement (leer = Kostenanzeige aus)
     KOSTEN_GRUPPEN        Ressourcengruppen, die zu dieser Anwendung gehören,
                           z. B. "rg-dihag-dp-dev-westeurope,rg-berichte-broker"
     KOSTEN_KAPAZITAET_RG  welche davon die Fabric-Kapazität enthält

   Der Dienstuser braucht die Rolle **Cost Management Reader** auf dem
   Abonnement.

   Die eine Eigenheit, um die sich hier alles dreht: **Cost Management drosselt
   hart.** Am 04.09.2026 nachgemessen – zwei Abfragen im Abstand von acht
   Sekunden, die zweite kam als HTTP 429 zurück. Keine Wiederholungsleiter holt
   das zuverlässig ein. Deshalb:

     - **Eine einzige Abfrage** über beide Monate (Custom-Zeitraum mit
       Monatsgranularität) statt zweier Abfragen je Zeitraum.
     - Eine Stunde Zwischenspeicher.
     - Und wenn doch gedrosselt wird: der letzte bekannte Stand statt einer
       Fehlermeldung. Zahlen von vorhin sind besser als keine – solange
       danebensteht, von wann sie sind.                                      */

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

/** Beginn des abgefragten Zeitraums: erster Tag des Vormonats. */
function zeitraum(heute = new Date()) {
  const von = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() - 1, 1));
  return { von: von.toISOString(), bis: heute.toISOString() };
}

/** Die eine Kostenabfrage, mit Rücksicht auf die Drosselung. */
async function abfrage(token, abo) {
  const url = `${API}/subscriptions/${abo}/providers/Microsoft.CostManagement`
            + `/query?api-version=2023-03-01`;
  const z = zeitraum();
  const koerper = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: z.von, to: z.bis },
    dataset: {
      // Monatsweise: eine Abfrage liefert laufenden Monat *und* Vormonat.
      granularity: "Monthly",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ResourceGroupName" }]
    }
  };

  // Wartezeiten der Wiederholung. Über KOSTEN_WARTEMS einstellbar – die Tests
  // setzen sie auf 1 ms, damit die Drosselung ohne echtes Warten prüfbar ist.
  const w = Number(process.env.KOSTEN_WARTEMS || 10000);
  let letzte = null;
  let naechste = 0;
  for (const warte of [0, w, 3 * w]) {
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

/** „2026-09" aus dem, was in der Monatsspalte steht (ISO-Text oder 20260901). */
function monatVon(wert) {
  if (wert === null || wert === undefined) return null;
  const s = String(wert);
  let m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/^(\d{4})(\d{2})\d{2}$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Zeilen der Antwort in eine handliche Form bringen.
 *  Die Monatsspalte heißt je nach Abfrageart `BillingMonth` oder `UsageDate`;
 *  deshalb wird sie über den Spaltentyp gesucht und der Name nur als
 *  Rückfallebene genutzt. */
function zeilen(antwort) {
  const spalten = antwort?.properties?.columns || [];
  const namen = spalten.map(c => c.name);
  const iKosten = namen.indexOf("Cost");
  const iGruppe = namen.indexOf("ResourceGroupName");
  const iWaehrung = namen.indexOf("Currency");
  let iMonat = spalten.findIndex(c => /datetime/i.test(c.type || ""));
  if (iMonat < 0) iMonat = namen.findIndex(n => /BillingMonth|UsageDate/i.test(n));
  return (antwort?.properties?.rows || []).map(r => ({
    gruppe: String(r[iGruppe] ?? "").toLowerCase(),
    betrag: Number(r[iKosten] ?? 0),
    waehrung: iWaehrung >= 0 ? r[iWaehrung] : "EUR",
    monat: iMonat >= 0 ? monatVon(r[iMonat]) : null
  }));
}

const monatsSchluessel = d => d.toISOString().slice(0, 7);

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
    const antwort = await abfrage(token, c.abo);

    const heute = new Date();
    const dieserMonat = monatsSchluessel(heute);
    const letzterMonat = monatsSchluessel(
      new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() - 1, 1)));

    const alle = zeilen(antwort);
    // Fehlt die Monatsspalte (andere API-Fassung), gehört alles in den
    // laufenden Monat – lieber eine leere Vormonatskachel als falsch verteilte
    // Beträge.
    const ohneMonat = alle.length > 0 && alle.every(z => z.monat === null);

    const auswerten = monat => {
      const drin = ohneMonat
        ? (monat === dieserMonat ? alle : [])
        : alle.filter(z => z.monat === monat);
      const unsere = c.gruppen.length
        ? drin.filter(z => c.gruppen.includes(z.gruppe))
        : drin;
      // Dieselbe Gruppe kann je Monat mehrfach vorkommen – zusammenfassen,
      // damit die Aufstellung eine Zeile je Gruppe zeigt.
      const jeGruppe = new Map();
      for (const z of unsere) jeGruppe.set(z.gruppe, (jeGruppe.get(z.gruppe) || 0) + z.betrag);
      const summe = [...jeGruppe.values()].reduce((s, b) => s + b, 0);
      const kapazitaet = c.kapazitaetGruppe
        ? (jeGruppe.get(c.kapazitaetGruppe) || 0)
        : null;
      return {
        summe,
        kapazitaet,
        uebrige: kapazitaet === null ? null : summe - kapazitaet,
        waehrung: unsere[0]?.waehrung || alle[0]?.waehrung || "EUR",
        jeGruppe: [...jeGruppe.entries()].map(([gruppe, betrag]) => ({ gruppe, betrag }))
                                         .sort((a, b) => b.betrag - a.betrag)
      };
    };

    _cache = {
      verfuegbar: true,
      abo: c.abo,
      laufenderMonat: auswerten(dieserMonat),
      vormonat: auswerten(letzterMonat),
      stand: new Date().toISOString()
    };
    _cacheZeit = Date.now();
    return _cache;
  } catch (e) {
    // Gedrosselt, aber wir hatten schon einmal Zahlen? Dann die zeigen – mit
    // sichtbarem Stand, damit niemand sie für taufrisch hält.
    if (e.art === "gedrosselt" && _cache) {
      return { ..._cache, veraltet: true, hinweis: e.message };
    }
    return { verfuegbar: false, grund: e.art || "kosten",
             detail: e.message };
  }
}

module.exports = { kosten, eingerichtet, cfg };
