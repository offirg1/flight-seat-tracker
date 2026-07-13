#!/usr/bin/env node
// Daily snapshot of open seats on flights LANDING at the destination airport
// inside the arrival window (config.json -> "arrivals").
//
// No public API enumerates every arrival months ahead, so this approximates
// it: Duffel searches destination-bound routes from a configured list of
// origin airports, harvests EVERY destination-landing segment those searches
// surface (including final legs of connecting itineraries from anywhere),
// filters to arrivals inside the window, dedupes by flight+date, and counts
// open seats on each flight's seat map where the airline publishes one.
//
// Env:
//   DUFFEL_API_TOKEN   Duffel access token (test or live)
//   MOCK=1             generate sample data, no API calls
//   MOCK_BACKFILL=<n>  with MOCK=1, seed n days of history

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
const ARR = CONFIG.arrivals;
const DEST = CONFIG.destination;
const DATA_PATH = path.join(ROOT, "docs", "arrivals.json");

loadDotEnv(path.join(ROOT, ".env"));

const MOCK = process.env.MOCK === "1";
const BACKFILL_DAYS = Number(process.env.MOCK_BACKFILL || 0);

const DUFFEL_BASE = "https://api.duffel.com";
const SEARCH_CONCURRENCY = 3;
const SEATMAP_CONCURRENCY = 4;
const SEATMAP_BUDGET = 150;
const SEATMAP_MISS_LIMIT = 12;
const FETCH_TIMEOUT_MS = 30_000;
const SEATMAP_TIMEOUT_MS = 15_000;

async function main() {
  if (!ARR?.window || !ARR?.origins?.length) {
    throw new Error('config.json needs an "arrivals" block with "window" and "origins".');
  }
  const db = loadDb();

  if (MOCK) {
    const days = Math.max(1, BACKFILL_DAYS);
    for (let i = days - 1; i >= 0; i--) {
      upsert(db, mockSnapshot(isoDate(new Date(Date.now() - i * 86_400_000))));
    }
  } else {
    const snapshot = await realSnapshot(isoDate(new Date()));
    if (snapshot.flights === 0 && snapshot.errors?.length) {
      throw new Error(
        `Every query failed — snapshot not saved so existing data stays intact.\nFirst error: ${snapshot.errors[0]}`
      );
    }
    upsert(db, snapshot);
  }

  db.meta = {
    destination: DEST,
    destinationLabel: CONFIG.destinationLabel,
    window: ARR.window,
    origins: ARR.origins,
    source: MOCK ? "mock" : "duffel",
    updatedAt: new Date().toISOString(),
  };
  db.history.sort((a, b) => a.date.localeCompare(b.date));
  db.history.forEach((s, i) => {
    if (i < db.history.length - 1) delete s.flightList;
  });
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");

  const latest = db.history[db.history.length - 1];
  console.log(
    `Arrivals snapshot ${latest.date}: ${latest.seats} open seats on ${latest.flights} ` +
      `${DEST}-landing flights` +
      (latest.mappedFlights < latest.flights
        ? ` — seat data for ${latest.mappedFlights}/${latest.flights}`
        : "") +
      (latest.errors ? ` — ${latest.errors.length} query error(s)` : "")
  );
}

// ------------------------------------------------------------------- real

async function realSnapshot(date) {
  const token = process.env.DUFFEL_API_TOKEN;
  if (!token) throw new Error("Set DUFFEL_API_TOKEN (or run with MOCK=1 for sample data).");
  const ctx = { token };

  // Long-haul flights arriving on the window's first day depart the day
  // before, so search one extra departure date at the front.
  const depDates = dateRange(addDays(ARR.window.start, -1), ARR.window.end);
  const arriveMin = `${ARR.window.start}T00:00`;
  const arriveMax = `${ARR.window.end}T23:59`;

  const landings = new Map(); // "LY316@2026-10-23" -> flight record
  const errors = [];

  const queries = [];
  for (const origin of ARR.origins) for (const depDate of depDates) queries.push({ origin, depDate });
  console.log(`${queries.length} searches (${ARR.origins.length} origins × ${depDates.length} dates)`);

  for (let i = 0; i < queries.length; i += SEARCH_CONCURRENCY) {
    const batch = queries.slice(i, i + SEARCH_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ origin, depDate }) => {
        try {
          const offers = await duffelOffers(ctx, origin, depDate);
          for (const offer of offers) {
            for (const segment of offer.slices?.[0]?.segments ?? []) {
              if (segment.destination?.iata_code !== DEST) continue;
              const arriving = segment.arriving_at ?? "";
              if (arriving < arriveMin || arriving > arriveMax) continue;

              const carrier =
                segment.marketing_carrier?.iata_code ?? segment.operating_carrier?.iata_code ?? "??";
              const number =
                segment.marketing_carrier_flight_number ??
                segment.operating_carrier_flight_number ??
                "?";
              const key = `${carrier}${number}@${arriving.slice(0, 10)}`;
              if (!landings.has(key)) {
                landings.set(key, {
                  flight: `${carrier} ${number}`,
                  from: segment.origin?.iata_code ?? "?",
                  date: arriving.slice(0, 10),
                  time: arriving.slice(11, 16),
                  offerId: offer.id,
                  segmentId: segment.id,
                  seats: null,
                });
              }
            }
          }
        } catch (err) {
          errors.push(`${origin} ${depDate}: ${err.message}`);
        }
      })
    );
    await sleep(400);
  }
  console.log(`${landings.size} unique ${DEST}-landing flights in window`);

  // Seat-map lookups: parallel batches, bounded budget, bail out if maps
  // keep coming back empty.
  const pending = [...landings.values()];
  let budget = SEATMAP_BUDGET;
  let consecutiveMisses = 0;
  for (let i = 0; i < pending.length; i += SEATMAP_CONCURRENCY) {
    if (budget <= 0 || consecutiveMisses >= SEATMAP_MISS_LIMIT) break;
    const batch = pending.slice(i, i + SEATMAP_CONCURRENCY).slice(0, budget);
    budget -= batch.length;
    const counts = await Promise.all(
      batch.map((f) => duffelSeatCount(ctx, f.offerId, f.segmentId).catch(() => null))
    );
    batch.forEach((f, j) => {
      f.seats = counts[j];
      consecutiveMisses = counts[j] == null ? consecutiveMisses + 1 : 0;
    });
  }

  return { date, ...aggregate([...landings.values()]), ...(errors.length ? { errors } : {}) };
}

function aggregate(flights) {
  const byDay = {};
  let seats = 0;
  let mapped = 0;
  for (const f of flights) {
    const d = (byDay[f.date] ??= { seats: 0, flights: 0, mappedFlights: 0 });
    d.flights += 1;
    if (f.seats != null) {
      d.seats += f.seats;
      d.mappedFlights += 1;
      seats += f.seats;
      mapped += 1;
    }
  }
  const flightList = flights
    .map(({ flight, from, date, time, seats }) => ({ flight, from, date, time, seats }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  return { seats, flights: flights.length, mappedFlights: mapped, byDay, flightList };
}

function duffelHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Duffel-Version": "v2",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function duffelOffers(ctx, origin, depDate) {
  const res = await withRetry(() =>
    fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
      method: "POST",
      headers: duffelHeaders(ctx.token),
      body: JSON.stringify({
        data: {
          slices: [{ origin, destination: DEST, departure_date: depDate }],
          passengers: [{ type: "adult" }],
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.errors?.[0]?.message ?? json.errors?.[0]?.title ?? `HTTP ${res.status}`);
  return json.data?.offers ?? [];
}

async function duffelSeatCount(ctx, offerId, segmentId) {
  const res = await withRetry(
    () =>
      fetch(`${DUFFEL_BASE}/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`, {
        headers: duffelHeaders(ctx.token),
        signal: AbortSignal.timeout(SEATMAP_TIMEOUT_MS),
      }),
    2
  );
  if (!res.ok) return null;
  const json = await res.json();
  const maps = json.data ?? [];
  const map = maps.find((m) => m.segment_id === segmentId) ?? maps[0];
  if (!map) return null;

  let open = 0;
  for (const cabin of map.cabins ?? [])
    for (const row of cabin.rows ?? [])
      for (const section of row.sections ?? [])
        for (const el of section.elements ?? [])
          if (el.type === "seat" && (el.available_services?.length ?? 0) > 0) open += 1;
  return open;
}

// ------------------------------------------------------------------- mock

function mockSnapshot(date) {
  const rand = mulberry32(hash("arrivals" + date));
  const carriers = ["LY", "6H", "IZ", "TK", "PC", "A3", "LH", "AF", "BA", "LX", "OS", "LO", "W6", "FR", "EK", "FZ", "UA", "DL", "AC", "ET"];
  const days = dateRange(ARR.window.start, ARR.window.end);
  const flights = [];
  for (const d of days) {
    const count = 26 + Math.floor(rand() * 10);
    for (let i = 0; i < count; i++) {
      flights.push({
        flight: `${carriers[Math.floor(rand() * carriers.length)]} ${100 + Math.floor(rand() * 900)}`,
        from: ARR.origins[Math.floor(rand() * ARR.origins.length)],
        date: d,
        time: `${String(Math.floor(rand() * 24)).padStart(2, "0")}:${String(Math.floor(rand() * 12) * 5).padStart(2, "0")}`,
        seats: rand() < 0.25 ? null : 3 + Math.floor(rand() * 60),
      });
    }
  }
  return { date, ...aggregate(flights), mock: true };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- helpers

async function withRetry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fn();
      if (res.status !== 429 && res.status < 500) return res;
      if (i >= attempts - 1) return res;
    } catch (err) {
      if (i >= attempts - 1) throw new Error(`network error: ${err.message}`);
    }
    await sleep(1000 * 2 ** i);
  }
}

function loadDb() {
  if (!existsSync(DATA_PATH)) return { history: [] };
  try {
    return { history: [], ...JSON.parse(readFileSync(DATA_PATH, "utf8")) };
  } catch {
    return { history: [] };
  }
}

function upsert(db, snapshot) {
  const i = db.history.findIndex((s) => s.date === snapshot.date);
  if (i >= 0) db.history[i] = snapshot;
  else db.history.push(snapshot);
}

function dateRange(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); isoDate(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(isoDate(d));
  }
  return out;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
