#!/usr/bin/env node
// Daily seat-availability snapshot.
//
// For every configured origin airport and every departure date in the window,
// queries a flight API (provider set in config.json), keeps itineraries that
// end at the destination and arrive by the deadline, and records available
// seats on each unique destination-bound flight. Appends the day's snapshot
// to docs/data.json.
//
// Providers:
//   duffel  (default) — counts open seats on the flight's seat map where the
//           airline publishes one; flights without a seat map are counted in
//           the flight/itinerary totals but contribute no seats (the headline
//           stays a floor estimate).
//   amadeus (legacy) — capped booking-class availability. The Amadeus
//           self-service portal shuts down on 2026-07-17; kept for reference.
//
// Env:
//   DUFFEL_API_TOKEN                      Duffel access token (test or live)
//   AMADEUS_API_KEY / AMADEUS_API_SECRET  legacy Amadeus credentials
//   AMADEUS_ENV                           "test" (default) or "production"
//   PROVIDER                              override config.json provider
//   MOCK=1                                generate sample data, no API calls
//   MOCK_BACKFILL=<n>                     with MOCK=1, seed n days of history

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
const DATA_PATH = path.join(ROOT, "docs", "data.json");

loadDotEnv(path.join(ROOT, ".env"));

const MOCK = process.env.MOCK === "1";
const BACKFILL_DAYS = Number(process.env.MOCK_BACKFILL || 0);
const PROVIDER = (process.env.PROVIDER || CONFIG.provider || "duffel").toLowerCase();
const SEAT_CAP = CONFIG.maxSeatsPerClass ?? 9;

async function main() {
  const db = loadDb();
  const today = isoDate(new Date());

  if (MOCK) {
    const days = Math.max(1, BACKFILL_DAYS);
    for (let i = days - 1; i >= 0; i--) {
      upsert(db, mockSnapshot(isoDate(new Date(Date.now() - i * 86_400_000))));
    }
  } else {
    const snapshot = await realSnapshot(today);
    if (snapshot.flights === 0 && snapshot.errors?.length) {
      throw new Error(
        `Every query failed — snapshot not saved so existing data stays intact.\nFirst error: ${snapshot.errors[0]}`
      );
    }
    upsert(db, snapshot);
  }

  db.meta = {
    destination: CONFIG.destination,
    destinationLabel: CONFIG.destinationLabel,
    origins: CONFIG.origins,
    originLabels: CONFIG.originLabels,
    departureWindow: CONFIG.departureWindow,
    arriveBy: CONFIG.arriveBy,
    source: MOCK ? "mock" : PROVIDER,
    updatedAt: new Date().toISOString(),
  };
  db.history.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");

  const latest = db.history[db.history.length - 1];
  console.log(
    `Snapshot ${latest.date}: ${latest.seats} seats on ${latest.flights} ` +
      `${CONFIG.destination}-bound flights (${latest.itineraries} itineraries)` +
      (latest.mappedFlights != null && latest.mappedFlights < latest.flights
        ? ` — seat data for ${latest.mappedFlights}/${latest.flights} flights`
        : "") +
      (latest.errors ? ` — ${latest.errors.length} query error(s)` : "")
  );
}

// ------------------------------------------------------------- core pipeline

// Each provider exposes: init() -> ctx, and legs(ctx, origin, depDate) ->
// [{ key, seats, itineraries }] where `key` identifies a unique
// destination-bound flight, `seats` is a count or null (unknown), and
// `itineraries` is how many qualifying itineraries end on that flight.
const PROVIDERS = {
  duffel: { init: duffelInit, legs: duffelLegs },
  amadeus: { init: amadeusInit, legs: amadeusLegs },
};

async function realSnapshot(date) {
  const provider = PROVIDERS[PROVIDER];
  if (!provider) throw new Error(`Unknown provider "${PROVIDER}" — use "duffel" or "amadeus".`);
  const ctx = await provider.init();

  const dates = dateRange(CONFIG.departureWindow.start, CONFIG.departureWindow.end);
  const byOrigin = {};
  const globalFlights = new Map();
  const errors = [];
  let totalItineraries = 0;

  for (const origin of CONFIG.origins) {
    const flights = new Map();
    let itineraries = 0;

    for (const depDate of dates) {
      try {
        const legs = await provider.legs(ctx, origin, depDate);
        for (const leg of legs) {
          itineraries += leg.itineraries;
          flights.set(leg.key, mergeSeats(flights.get(leg.key), leg.seats));
        }
        console.log(`  ${origin} ${depDate}: ${legs.length} ${CONFIG.destination}-bound flights`);
      } catch (err) {
        errors.push(`${origin} ${depDate}: ${err.message}`);
        console.log(`  ${origin} ${depDate}: FAILED — ${err.message}`);
      }
      await sleep(400); // rate-limit headroom
    }

    byOrigin[origin] = summarize(flights, itineraries);
    totalItineraries += itineraries;
    // The same destination-bound leg can be reachable from several origins;
    // the grand total counts each physical flight once.
    for (const [k, v] of flights) globalFlights.set(k, mergeSeats(globalFlights.get(k), v));
  }

  return {
    date,
    ...summarize(globalFlights, totalItineraries),
    byOrigin,
    ...(errors.length ? { errors } : {}),
  };
}

function summarize(flights, itineraries) {
  let seats = 0;
  let mapped = 0;
  for (const v of flights.values()) {
    if (v != null) {
      seats += v;
      mapped += 1;
    }
  }
  return { seats, flights: flights.size, mappedFlights: mapped, itineraries };
}

function mergeSeats(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

// ----------------------------------------------------------------- Duffel

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_SEATMAP_BUDGET = 80; // max seat-map lookups per whole run
const FETCH_TIMEOUT_MS = 30_000;

function duffelHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Duffel-Version": "v2",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function timedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function duffelInit() {
  const token = process.env.DUFFEL_API_TOKEN;
  if (!token) throw new Error("Set DUFFEL_API_TOKEN (or run with MOCK=1 for sample data).");
  return { token, seatCache: new Map(), seatMapBudget: DUFFEL_SEATMAP_BUDGET };
}

async function duffelLegs(ctx, origin, depDate) {
  const res = await withRetry(() =>
    timedFetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
      method: "POST",
      headers: duffelHeaders(ctx.token),
      body: JSON.stringify({
        data: {
          slices: [{ origin, destination: CONFIG.destination, departure_date: depDate }],
          passengers: [{ type: "adult" }],
        },
      }),
    })
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.errors?.[0]?.message ?? json.errors?.[0]?.title ?? `HTTP ${res.status}`);

  // Group qualifying offers by their final destination-bound flight.
  const finals = new Map();
  for (const offer of json.data?.offers ?? []) {
    const segments = offer.slices?.[0]?.segments ?? [];
    const last = segments[segments.length - 1];
    if (!last || last.destination?.iata_code !== CONFIG.destination) continue;
    if (CONFIG.arriveBy && (last.arriving_at ?? "") > CONFIG.arriveBy) continue;

    const carrier = last.marketing_carrier?.iata_code ?? last.operating_carrier?.iata_code ?? "??";
    const number = last.marketing_carrier_flight_number ?? last.operating_carrier_flight_number ?? "?";
    const key = `${carrier}${number}@${(last.departing_at ?? "").slice(0, 10)}`;
    const f = finals.get(key) ?? { offerId: offer.id, segmentId: last.id, itineraries: 0 };
    f.itineraries += 1;
    finals.set(key, f);
  }

  const legs = [];
  for (const [key, f] of finals) {
    let seats = ctx.seatCache.has(key) ? ctx.seatCache.get(key) : null;
    if (!ctx.seatCache.has(key) && ctx.seatMapBudget > 0) {
      ctx.seatMapBudget -= 1;
      try {
        seats = await duffelSeatCount(ctx, f.offerId, f.segmentId);
      } catch {
        seats = null; // seat map unavailable for this airline/flight
      }
      ctx.seatCache.set(key, seats);
      await sleep(200);
    }
    legs.push({ key, seats, itineraries: f.itineraries });
  }
  return legs;
}

async function duffelSeatCount(ctx, offerId, segmentId) {
  const res = await withRetry(() =>
    timedFetch(`${DUFFEL_BASE}/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`, {
      headers: duffelHeaders(ctx.token),
    })
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

// ------------------------------------------------- Amadeus (legacy provider)

async function amadeusInit() {
  const key = process.env.AMADEUS_API_KEY;
  const secret = process.env.AMADEUS_API_SECRET;
  if (!key || !secret) {
    throw new Error("Set AMADEUS_API_KEY and AMADEUS_API_SECRET (or run with MOCK=1 for sample data).");
  }
  const env = (process.env.AMADEUS_ENV || "test").toLowerCase();
  const base = env === "production" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";
  const res = await timedFetch(`${base}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: key, client_secret: secret }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description ?? "Amadeus authentication failed");
  return { base, token: json.access_token };
}

async function amadeusLegs(ctx, origin, depDate) {
  const res = await withRetry(() =>
    timedFetch(`${ctx.base}/v1/shopping/availability/flight-availabilities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({
        originDestinations: [
          {
            id: "1",
            originLocationCode: origin,
            destinationLocationCode: CONFIG.destination,
            departureDateTime: { date: depDate },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      }),
    })
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.errors?.[0]?.detail ?? json.errors?.[0]?.title ?? `HTTP ${res.status}`);

  const finals = new Map();
  for (const option of json.data ?? []) {
    const segments = option.segments ?? [];
    const last = segments[segments.length - 1];
    if (!last || last.arrival?.iataCode !== CONFIG.destination) continue;
    if (CONFIG.arriveBy && last.arrival?.at > CONFIG.arriveBy) continue;

    const key = `${last.carrierCode}${last.number}@${(last.departure?.at ?? "").slice(0, 10)}`;
    const seats = (last.availabilityClasses ?? []).reduce(
      (sum, c) => sum + Math.min(c.numberOfBookableSeats ?? 0, SEAT_CAP),
      0
    );
    const f = finals.get(key) ?? { seats: 0, itineraries: 0 };
    f.seats = Math.max(f.seats, seats);
    f.itineraries += 1;
    finals.set(key, f);
  }
  return [...finals].map(([key, f]) => ({ key, seats: f.seats, itineraries: f.itineraries }));
}

// ---------------------------------------------------------------- mock data

function mockSnapshot(date) {
  const byOrigin = {};
  const totals = { seats: 0, flights: 0, mappedFlights: 0, itineraries: 0 };
  for (const origin of CONFIG.origins) {
    const rand = mulberry32(hash(origin + date));
    const flights = 24 + Math.floor(rand() * 8);
    const seats = Math.round(flights * (4.5 + rand() * 3.5));
    const itineraries = flights * 3 + Math.floor(rand() * 20);
    byOrigin[origin] = { seats, flights, mappedFlights: flights, itineraries };
    totals.seats += seats;
    totals.flights += flights;
    totals.mappedFlights += flights;
    totals.itineraries += itineraries;
  }
  return { date, ...totals, byOrigin, mock: true };
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

// ------------------------------------------------------------------ helpers

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
    const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    return { history: [], ...db };
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
