# Flight Seat Tracker — LA → TLV

A static dashboard that tracks, once a day, the total available seats on flights
from Los Angeles to Tel Aviv (TLV) departing **Oct 20–27, 2026** and arriving
**no later than Oct 27**. Data comes from the [Duffel](https://duffel.com) flight
API, a GitHub Action takes a daily snapshot, and GitHub Pages serves the
dashboard.

> **What the number means:** the tracker counts open seats on each flight's
> published seat map. Not every airline publishes seat maps, and blocked ≠ sold,
> so the headline is a **floor estimate** — the day-over-day trend is the
> reliable signal. The dashboard's methodology note has details.

## Architecture

```
GitHub Actions (daily 6am PT)
  └─ scripts/fetch-seats.mjs  ── Duffel offer search + seat maps
       └─ appends snapshot to docs/data.json (committed to the repo)
GitHub Pages serves docs/  ── index.html renders counter + trend chart
```

No servers, no database — the repo itself is the time-series store.

## Setup

1. **Duffel account** (free to create): sign up at
   [app.duffel.com](https://app.duffel.com), then create an access token under
   **Developers → Access tokens**. A **test-mode** token works immediately and
   validates the whole pipeline with synthetic flights; switch to a **live**
   token once your account is activated for real data. Duffel charges per
   *booking* — this tracker never books, and at ~8 searches/day any excess
   search fees are pennies per month.

2. **Create a GitHub repo** and push this folder:
   ```sh
   git remote add origin git@github.com:<you>/flight-seat-tracker.git
   git push -u origin main
   ```

3. **Add a repo secret** (Settings → Secrets and variables → Actions):
   - `DUFFEL_API_TOKEN`

4. **Enable GitHub Pages**: Settings → Pages → Deploy from a branch →
   `main` / `docs` folder.

5. **Run it once now**: Actions tab → "Daily seat snapshot" → Run workflow.
   After that it runs automatically every day at 6:00 AM Pacific.

## Adding more origin airports

Edit `config.json` and add IATA codes to `origins`:

```json
"origins": ["LAX", "BUR", "ONT"]
```

That's it — the fetch script queries every origin, the dashboard grows a row per
airport in the breakdown table, and flights reachable from several origins are
counted once in the grand total. (`originLabels` already includes friendly names
for the LA-area airports; add a label for anything else.)

Changing the route or dates works the same way: `destination`,
`departureWindow`, and `arriveBy` all live in `config.json`.

## Local development

```sh
node scripts/fetch-seats.mjs        # real fetch (needs .env, see .env.example)
npm run mock                        # one fake snapshot, no API needed
npm run mock:backfill               # 14 days of fake history for the chart
python3 -m http.server 4173 -d docs # then open http://localhost:4173
```

## Provider notes

The data source is pluggable (`provider` in `config.json`, or a `PROVIDER` env
override). `duffel` is the default. An `amadeus` provider is kept for
reference, but the Amadeus self-service portal was decommissioned on
**July 17, 2026** and no longer accepts new registrations.

Snapshots generated with `MOCK=1` are flagged and the dashboard shows a
"sample data" chip; the first real run replaces the same-day entry.
