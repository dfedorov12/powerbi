"use strict";

/* Ablage der Zugriffsregeln in Azure Table Storage.

   Warum dort und nicht in einer SharePoint-Liste wie in den übrigen
   DIHAG-Apps: Die Regeln müssen an der Stelle gelten, an der die Token
   entstehen – im Broker. Läge die Liste in SharePoint, bräuchte der Broker
   dafür Graph-Berechtigungen, und die Regeln wären nur so verbindlich wie
   das Frontend. Das Speicherkonto der Function App ist ohnehin vorhanden.

   Eine Partition („regel“) reicht: die Regelmenge ist klein und lässt sich
   damit in einem Rutsch (Transaktion) austauschen.                         */

const { TableClient } = require("@azure/data-tables");

const TABELLE = "Rechte";
const PART = "regel";

let _client = null;
let _bereit = null;

function client() {
  if (_client) return _client;
  const cs = process.env.RECHTE_STORAGE || process.env.AzureWebJobsStorage;
  if (!cs) {
    const e = new Error("Kein Speicher konfiguriert (AzureWebJobsStorage fehlt)");
    e.art = "einrichtung";
    e.status = 500;
    throw e;
  }
  _client = TableClient.fromConnectionString(cs, TABELLE);
  return _client;
}

/** Tabelle einmalig anlegen. Mehrfachaufrufe kosten nichts. */
function bereit() {
  if (!_bereit) {
    _bereit = client().createTable().catch(e => {
      // 409 = existiert bereits, alles andere ist ein echter Fehler.
      if (e?.statusCode !== 409) { _bereit = null; throw e; }
    });
  }
  return _bereit;
}

const ausEntity = e => ({
  id: e.rowKey,
  typ: e.typ,
  wert: e.wert,
  name: e.name || "",
  berichte: (() => { try { return JSON.parse(e.berichte || "[]"); } catch { return []; } })(),
  admin: e.admin === true,
  aktiv: e.aktiv !== false,
  notiz: e.notiz || "",
  geaendertVon: e.geaendertVon || "",
  geaendertAm: e.geaendertAm || ""
});

const zuEntity = (r, wer) => ({
  partitionKey: PART,
  rowKey: r.id,
  typ: r.typ,
  wert: r.wert,
  name: r.name,
  berichte: JSON.stringify(r.berichte),
  admin: r.admin,
  aktiv: r.aktiv,
  notiz: r.notiz,
  geaendertVon: wer || "",
  geaendertAm: new Date().toISOString()
});

/* ── Zwischenspeicher ────────────────────────────────────────────────
   Jeder Berichtsaufruf wertet die Regeln aus. Ohne Zwischenspeicher wäre
   das eine Tabellenabfrage pro Aufruf; eine halbe Minute ist kurz genug,
   dass eine Änderung praktisch sofort greift.                            */

let _cache = null;
let _cacheZeit = 0;
const TTL = 30000;

async function lesen(frisch = false) {
  if (!frisch && _cache && Date.now() - _cacheZeit < TTL) return _cache;
  await bereit();
  const out = [];
  for await (const e of client().listEntities({
    queryOptions: { filter: `PartitionKey eq '${PART}'` }
  })) {
    out.push(ausEntity(e));
  }
  out.sort((a, b) => a.typ.localeCompare(b.typ) || a.wert.localeCompare(b.wert));
  _cache = out;
  _cacheZeit = Date.now();
  return out;
}

/** Regelmenge vollständig ersetzen.
 *  @param {object[]} regeln bereits normalisierte Regeln
 *  @param {string} wer      UPN für das Änderungsprotokoll */
async function schreiben(regeln, wer) {
  await bereit();
  const vorher = await lesen(true);
  const behalten = new Set(regeln.map(r => r.id));

  const aktionen = [
    ...regeln.map(r => ["upsert", zuEntity(r, wer)]),
    ...vorher.filter(a => !behalten.has(a.id))
             .map(a => ["delete", { partitionKey: PART, rowKey: a.id }])
  ];

  // Table Storage nimmt bis zu 100 Vorgänge je Transaktion.
  for (let i = 0; i < aktionen.length; i += 100) {
    await client().submitTransaction(aktionen.slice(i, i + 100));
  }
  _cache = null;
  return lesen(true);
}

module.exports = { lesen, schreiben };
