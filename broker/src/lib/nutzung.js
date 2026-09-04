"use strict";

/* Nutzungszählung: Wie oft wird welcher Bericht geöffnet?

   Das ist die eine Zahl, die diese Anwendung wirklich selbst kennt – jedes
   Einbettungs-Token geht durch den Broker. Der CU-Verbrauch dahinter kommt aus
   Fabric (siehe metriken.js) und ist eine andere Quelle.

   Gezählt werden zwei Arten:
     "oeffnen"   – jemand ruft den Bericht auf
     "erneuern"  – ein offenes Dashboard holt sich nach ~55 Minuten ein neues
                   Token. Das kostet Kapazität wie eine Öffnung, ist aber kein
                   neuer Aufruf; getrennt zu zählen macht den Unterschied
                   sichtbar.

   Datenschutz: Gespeichert werden Zeitpunkt, Berichtsschlüssel und die
   E-Mail-Adresse – nicht mehr. Einträge älter als NUTZUNG_TAGE (Vorgabe 90)
   werden beim Lesen entfernt. Wer gar keine Personenbezüge will, setzt
   NUTZUNG_ANONYM=1; dann steht statt der Adresse ein je Tag wechselnder
   Kurz-Hash, mit dem sich Nutzerzahlen noch zählen, Personen aber nicht mehr
   zurückverfolgen lassen.                                                   */

const crypto = require("crypto");
const { TableClient } = require("@azure/data-tables");

const TABELLE = "Nutzung";

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

function bereit() {
  if (!_bereit) {
    _bereit = client().createTable().catch(e => {
      if (e?.statusCode !== 409) { _bereit = null; throw e; }
    });
  }
  return _bereit;
}

const tag = d => d.toISOString().slice(0, 10);

/** Kennung der Person – Klartext oder tageweise wechselnder Kurz-Hash. */
function kennung(upn, datum) {
  if (process.env.NUTZUNG_ANONYM !== "1") return String(upn || "").toLowerCase();
  return "anon:" + crypto.createHash("sha256")
    .update(datum + "|" + String(upn || "").toLowerCase())
    .digest("hex").slice(0, 12);
}

/** Einen Vorgang festhalten. Fehler werden geschluckt – eine misslungene
 *  Zählung darf niemals einen Bericht verhindern. */
async function zaehlen(key, upn, art, context) {
  try {
    await bereit();
    const jetzt = new Date();
    const t = tag(jetzt);
    await client().createEntity({
      // Partition = Tag: so lässt sich ein Zeitraum in wenigen Abfragen lesen
      // und alte Tage in einem Rutsch entfernen.
      partitionKey: t,
      rowKey: jetzt.getTime() + "-" + crypto.randomBytes(4).toString("hex"),
      bericht: key,
      person: kennung(upn, t),
      art: art === "erneuern" ? "erneuern" : "oeffnen",
      zeit: jetzt.toISOString()
    });
  } catch (e) {
    context?.warn?.("Nutzung nicht gezählt: " + e.message);
  }
}

/** Alte Einträge entfernen. Läuft beim Lesen mit, damit es keinen zweiten
 *  Zeitplan braucht. */
async function aufraeumen(tage) {
  const grenze = tag(new Date(Date.now() - tage * 86400000));
  const weg = [];
  for await (const e of client().listEntities({
    queryOptions: { filter: `PartitionKey lt '${grenze}'`, select: ["partitionKey", "rowKey"] }
  })) {
    weg.push(e);
    if (weg.length >= 500) break;   // je Aufruf begrenzt, der Rest folgt beim nächsten
  }
  const nachPartition = new Map();
  for (const e of weg) {
    if (!nachPartition.has(e.partitionKey)) nachPartition.set(e.partitionKey, []);
    nachPartition.get(e.partitionKey).push(e);
  }
  for (const [, liste] of nachPartition) {
    for (let i = 0; i < liste.length; i += 100) {
      await client().submitTransaction(liste.slice(i, i + 100)
        .map(e => ["delete", { partitionKey: e.partitionKey, rowKey: e.rowKey }]));
    }
  }
  return weg.length;
}

/** Auswertung über die letzten `tage` Tage.
 *  @returns {Promise<{von:string, bis:string, gesamt:object,
 *                     jeBericht:object[], jeTag:object[]}>} */
async function auswertung(tage = 30) {
  await bereit();
  const behalten = Number(process.env.NUTZUNG_TAGE || 90);
  try { await aufraeumen(behalten); } catch { /* Aufräumen darf nie stören */ }

  const von = tag(new Date(Date.now() - (tage - 1) * 86400000));
  const bis = tag(new Date());

  const jeBericht = new Map();   // key -> { oeffnen, erneuern, personen:Set }
  const jeTag = new Map();       // tag -> { oeffnen, erneuern, personen:Set }
  const allePersonen = new Set();

  for await (const e of client().listEntities({
    queryOptions: { filter: `PartitionKey ge '${von}'` }
  })) {
    const b = jeBericht.get(e.bericht) || { oeffnen: 0, erneuern: 0, personen: new Set() };
    const t = jeTag.get(e.partitionKey) || { oeffnen: 0, erneuern: 0, personen: new Set() };
    const feld = e.art === "erneuern" ? "erneuern" : "oeffnen";
    b[feld]++; t[feld]++;
    if (e.person) { b.personen.add(e.person); t.personen.add(e.person); allePersonen.add(e.person); }
    jeBericht.set(e.bericht, b);
    jeTag.set(e.partitionKey, t);
  }

  const raus = m => [...m.entries()].map(([k, v]) => ({
    schluessel: k, oeffnen: v.oeffnen, erneuern: v.erneuern, personen: v.personen.size
  }));

  const berichte = raus(jeBericht).sort((a, b) => b.oeffnen - a.oeffnen);
  const tage_ = raus(jeTag).sort((a, b) => a.schluessel.localeCompare(b.schluessel));

  return {
    von, bis, aufbewahrungTage: behalten,
    anonym: process.env.NUTZUNG_ANONYM === "1",
    gesamt: {
      oeffnen: berichte.reduce((s, b) => s + b.oeffnen, 0),
      erneuern: berichte.reduce((s, b) => s + b.erneuern, 0),
      // Über den ganzen Zeitraum entzerrt gezählt: wer an drei Tagen kommt,
      // ist eine Person, nicht drei. Bei NUTZUNG_ANONYM=1 wechselt der Hash
      // täglich - dann ist das die Summe der Tagesbesucher.
      personen: allePersonen.size
    },
    jeBericht: berichte,
    jeTag: tage_
  };
}

module.exports = { zaehlen, auswertung };
