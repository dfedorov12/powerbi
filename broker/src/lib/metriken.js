"use strict";

/* CU-Verbrauch aus der App „Microsoft Fabric Capacity Metrics".

   Das ist die **einzige belastbare Quelle** für den Kapazitätsverbrauch.
   Rechnen wir ihn selbst aus, wäre es geraten – und geratene Zahlen sind
   schlimmer als keine.

   Abgefragt wird das Semantikmodell der Metrik-App per DAX
   (`executeQueries`). Nötig dafür:

     METRIK_WORKSPACE   Arbeitsbereich der Metrik-App
     METRIK_DATASET     deren Semantikmodell
     PBI_KAPAZITAET_ID  unsere Kapazität (Power-BI-seitige Id)

   und – das ist der eigentliche Aufwand – der Dienstuser braucht Lesezugriff
   auf diesen Arbeitsbereich sowie die Mandanteneinstellung
   „Dataset Execute Queries REST API". Fehlt eines davon, liefert dieses Modul
   `{ verfuegbar: false, grund: "…" }`; die Oberfläche sagt dann offen, dass
   keine CU-Zahlen vorliegen, statt etwas zu erfinden.

   Tabelle `MetricsByItemandOperationandDay`:
     ItemId · OperationName · Date · sum_CU · count_operations · count_users   */

const API = "https://api.powerbi.com/v1.0/myorg";

const cfg = () => ({
  workspace: process.env.METRIK_WORKSPACE || "",
  dataset:   process.env.METRIK_DATASET || "",
  kapazitaet: process.env.PBI_KAPAZITAET_ID || ""
});

const eingerichtet = () => {
  const c = cfg();
  return Boolean(c.workspace && c.dataset);
};

/** DAX-Zeichenkette absichern: Anführungszeichen verdoppeln. Die Werte kommen
 *  zwar aus der eigenen Konfiguration, aber eine Abfrage baut man nicht
 *  ungeprüft zusammen. */
const dax = s => String(s || "").replace(/"/g, '""');

/** Verbrauch je Element über die letzten `tage` Tage.
 *  @param {object} pbiCfg   Zugangsdaten des Dienstusers (siehe powerbi.js)
 *  @param {Function} appToken  liefert das Token des Dienstusers
 *  @param {string[]} itemIds   Bericht- und Semantikmodell-Ids
 *  @returns {Promise<{verfuegbar:boolean, grund?:string, zeilen?:object[]}>} */
async function verbrauch(pbiCfg, appToken, itemIds, tage = 30) {
  const c = cfg();
  if (!eingerichtet()) {
    return { verfuegbar: false, grund: "nicht_eingerichtet" };
  }
  const ids = (itemIds || []).filter(Boolean);
  if (!ids.length) return { verfuegbar: true, zeilen: [] };

  const liste = ids.map(i => `"${dax(i)}"`).join(", ");
  const abfrage = `
EVALUATE
SUMMARIZECOLUMNS(
  MetricsByItemandOperationandDay[ItemId],
  MetricsByItemandOperationandDay[OperationName],
  TREATAS({ ${liste} }, MetricsByItemandOperationandDay[ItemId]),
  FILTER(ALL(MetricsByItemandOperationandDay[Date]),
         MetricsByItemandOperationandDay[Date] >= TODAY() - ${Number(tage) || 30}),
  "CU", SUM(MetricsByItemandOperationandDay[sum_CU]),
  "Vorgaenge", SUM(MetricsByItemandOperationandDay[count_operations]),
  "DauerMs", SUM(MetricsByItemandOperationandDay[sum_duration])
)`.trim();

  let res;
  try {
    const token = await appToken(pbiCfg);
    res = await fetch(
      `${API}/groups/${c.workspace}/datasets/${c.dataset}/executeQueries`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: [{ query: abfrage }],
          serializerSettings: { includeNulls: false }
        })
      });
  } catch (e) {
    return { verfuegbar: false, grund: "nicht_erreichbar", detail: e.message };
  }

  if (res.status === 401 || res.status === 403) {
    return { verfuegbar: false, grund: "kein_zugriff",
             detail: "Der Dienstuser darf das Metrikmodell nicht lesen." };
  }
  const text = await res.text();
  if (!res.ok) {
    return { verfuegbar: false, grund: "abfrage_fehler",
             detail: text.slice(0, 300) };
  }

  let d = null;
  try { d = JSON.parse(text); } catch { /* unerwartete Antwort */ }
  const zeilen = d?.results?.[0]?.tables?.[0]?.rows || [];
  return {
    verfuegbar: true,
    zeilen: zeilen.map(z => ({
      itemId:  z["MetricsByItemandOperationandDay[ItemId]"],
      vorgang: z["MetricsByItemandOperationandDay[OperationName]"],
      cu:        Number(z["[CU]"] || 0),
      vorgaenge: Number(z["[Vorgaenge]"] || 0),
      dauerMs:   Number(z["[DauerMs]"] || 0)
    }))
  };
}

module.exports = { verbrauch, eingerichtet, cfg };
