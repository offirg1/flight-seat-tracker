#!/usr/bin/env node
// Daily seat-availability snapshot.
//
// For every configured origin airport and every departure date in the window,
// queries the Amadeus Flight Availabilities Search API, keeps itineraries that
// end at the destination and arrive by the deadline, and counts available
// seats on each unique destination-bound flight (per booking class, capped —
// airlines never expose more than 9 per class, so this is a floor, not an
// exact count). Appends the day's snapshot to docs/data.json.
//
// Env:
//   AMADEUS_API_KEY / AMADEUS_API_SECRET  Amadeus Self-Service credentials
//   AMADEUS_ENV                           "test" (default) or "production"
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
const ENV = (process.env.AMADEUS_ENV || "test").toLowerCase();
const BASE = ENV === "production" ? "https://api.amadeus.com" : "https://test.api.amadeus.com";
const SEAT_CAP = CONFIG.maxSeatsPerClass ?? 9;

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

async function main() {
  const db = loadDb();
  const today = isoDate(new Date());

  if (MOCK) {
    const days = Math.max(1, BACKFILL_DAYS);
    for (let i = days - 1; i >= 0; i--) {
      upsert(db, mockSnapshot(isoDate(new Date(Date.now() - i * 86_400_000))));
    }
  } else {
    upsert(db, await realSnapshot(today));
  }

  db.meta = {
    destination: CONFIG.destination,
    destinationLabel: CONFIG.destinationLabel,
    origins: CONFIG.origins,
    originLabels: CONFIG.originLabels,
    departureWindow: CONFIG.departureWindow,
    arriveBy: CONFIG.arriveBy,
    maxSeatsPerClass: SEAT_CAP,
    source: MOCK ? "mock" : `amadeus-${ENV}`,
    updatedAt: new Date().toISOString(),
  };
  db.history.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");

  const latest = db.history[db.history.length - 1];
  console.log(
    `Snapshot ${latest.date}: ${latest.seats} seats on ${latest.flights} ` +
      `${CONFIG.destination}-bound flights (${latest.itineraries} itineraries)` +
      (latest.errors ? ` — ${latest.errors.length} query error(s)` : "")
  );
}

// ---------------------------------------------------------------- real data

async function realSnapshot(date) {
  const token = await getToken();
  const dates = dateRange(CONFIG.departureWindow.start, CONFIG.departureWindow.end);
  const byOrigin = {};
  const globalFlights = new Map();
  const errors = [];
  let totalItineraries = 0;

  for (const origin of CONFIG.origins) {
    const flights = new Map(); // "LY6@2026-10-20" -> seats on that leg
    let itineraries = 0;

    for (const depDate of dates) {
      try {
        for (const option of await searchAvailability(token, origin, depDate)) {
          const segments = option.segments ?? [];
          const last = segments[segments.length - 1];
          if (!last || last.arrival?.iataCode !== CONFIG.destination) continue;
          if (CONFIG.arriveBy && last.arrival?.at > CONFIG.arriveBy) continue;

          itineraries += 1;
          const key = `${last.carrierCode}${last.number}@${(last.departure?.at ?? "").slice(0, 10)}`;
          const seats = (last.availabilityClasses ?? []).reduce(
            (sum, c) => sum + Math.min(c.numberOfBookableSeats ?? 0, SEAT_CAP),
            0
          );
          flights.set(key, Math.max(flights.get(key) ?? 0, seats));
        }
      } catch (err) {
        errors.push(`${origin} ${depDate}: ${err.message}`);
      }
      await sleep(300); // free-tier rate limit headroom
    }

    byOrigin[origin] = summarize(flights, itineraries);
    totalItineraries += itineraries;
    // The same destination-bound leg can be reachable from several origins;
    // the grand total counts each physical flight once.
    for (const [k, v] of flights) globalFlights.set(k, Math.max(globalFlights.get(k) ?? 0, v));
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
  for (const v of flights.values()) seats += v;
  return { seats, flights: flights.size, itineraries };
}

async function searchAvailability(token, origin, date) {
  const res = await withRetry(() =>
    fetch(`${BASE}/v1/shopping/availability/flight-availabilities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        originDestinations: [
          {
            id: "1",
            originLocationCode: origin,
            destinationLocationCode: CONFIG.destination,
            departureDateTime: { date },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      }),
    })
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.errors?.[0]?.detail ?? json.errors?.[0]?.title ?? `HTTP ${res.status}`);
  return json.data ?? [];
}

async function getToken() {
  const key = process.env.AMADEUS_API_KEY;
  const secret = process.env.AMADEUS_API_SECRET;
  if (!key || !secret) {
    throw new Error("Set AMADEUS_API_KEY and AMADEUS_API_SECRET (or run with MOCK=1 for sample data).");
  }
  const res = await fetch(`${BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: key, client_secret: secret }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description ?? "Amadeus authentication failed");
  return json.access_token;
}

async function withRetry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    const res = await fn();
    if (res.status !== 429 && res.status < 500) return res;
    if (i >= attempts - 1) return res;
    await sleep(1000 * 2 ** i);
  }
}

// ---------------------------------------------------------------- mock data

function mockSnapshot(date) {
  const byOrigin = {};
  const totals = { seats: 0, flights: 0, itineraries: 0 };
  for (const origin of CONFIG.origins) {
    const rand = mulberry32(hash(origin + date));
    const flights = 24 + Math.floor(rand() * 8);
    const seats = Math.round(flights * (4.5 + rand() * 3.5));
    const itineraries = flights * 3 + Math.floor(rand() * 20);
    byOrigin[origin] = { seats, flights, itineraries };
    totals.seats += seats;
    totals.flights += flights;
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
