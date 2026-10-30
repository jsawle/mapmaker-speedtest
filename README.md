# MapMaker classroom speed test

Finds MapMaker maps that will be slow when a whole class opens them at once over poor classroom wifi.

| Component | Version | What it does |
|---|---|---|
| Speed test (app) | 0.3.0 | The whole package |
| Recorder | 0.2.0 | Opens each map in the real MapMaker app and records every download, with its cache headers |
| Classroom simulator | 0.2.0 | Plays a recording out for 30 students sharing one connection |
| Classroom profiles | 0.2.0 | The connection settings in `config/profiles.json` |
| Simulator check | 0.1.0 | Compares the simulator with a real throttled browser |
| Delay-by-source split | 0.1.0 | Splits each map's delay into MapMaker app, ArcGIS code, basemap and map data (`src/categories.mjs`) |

Bump a component's version whenever its maths or data handling changes, and the app version on every release.

## How it works

1. **Record (real browser, real MapMaker).** Each map is opened once, as a map link: `…atlas/index.html?appid=…&webmap=<id>`. It opens in a fresh browser with nothing cached, at 1366 × 768, with no sign-in (students mostly use MapMaker anonymously). Every request is written down: when it started, when the first byte arrived, when it finished, and how big it was. That includes requests from the map's background workers. The map counts as loaded after 3 seconds with no network activity. The recorder then clicks **Zoom in** twice and records that as well. One browser, one map at a time: about the same traffic as one person using MapMaker.
2. **Simulate the class.** For each map, 30 students start within 5 seconds of each other and share one classroom connection. The simulator keeps the order the recording showed (a request waits for the one it depended on), shares the bandwidth fairly, and adds latency, jitter and packet loss. It reports the typical student, the student at the 90th percentile, and the slowest student.
   Three lessons are simulated, using each file's own cache settings:
   - **Usual lesson** (the rating): MapMaker was last opened on the device a week ago. Files the browser may keep that long are reused, short-lived ones are re-checked with the server (one round trip each), and the map's own data is downloaded.
   - **First time on the device:** nothing is cached.
   - **Second map in the same lesson:** MapMaker was opened 10 minutes ago.
3. **Compare with MapMaker itself.** The default MapMaker view is simulated the same way. "Extra over MapMaker" (map time minus MapMaker's own time) is the fairest way to rank maps, because no map can load faster than the app around it.
4. **Split the delay by source.** Every request is put in one of four groups:
   - **MapMaker app:** MapMaker's own files, set-up calls and content-group searches. The same for every map.
   - **ArcGIS code:** ArcGIS SDK files, which vary with the layer types a map uses.
   - **Basemap:** basemap tiles, styles and fonts.
   - **Map data:** the map's layers, images and item details.

   The class is then simulated again with each group made free. The difference is how many seconds sooner 9 in 10 students would be ready without that group. The groups overlap in time, so the four figures don't add up to the total. The largest one is the map's **main cause**.
5. **Rate.** A map is **OK** when 9 in 10 students have it ready within **10 seconds**. It is **Slow** up to 30 s and **Very slow** beyond that. This is set in `config/profiles.json`.

### Why 10 seconds, and why 9 in 10 students

10 seconds is the long-standing usability limit for keeping someone's attention on a task while they wait (Nielsen). For comparison, Google's web guideline wants a page's main content within 2.5 seconds, judged at the 75th percentile of visits. A whole map is a heavier load than a web page, so 10 seconds is lenient by web standards. In a lesson the class moves when nearly everyone is ready, which is why the rating uses the 90th-percentile student, not the average. The slowest student is shown separately.

## Running it

Go to **Actions → Classroom speed test → Run workflow**.

- `mode: full` records every map, then simulates. Use `limit: 5` for a quick trial.
- `mode: simulate` re-runs only the simulation on the last recordings, which takes minutes. Use it after editing `config/profiles.json`.
- `validate` also runs the simulator check on 10 maps.

Results are committed to `results/` (CSV and JSON) and shown on the results page in `docs/`. To publish the page, turn on **Settings → Pages → Deploy from branch → main / docs**.

To run it locally:

```
npm ci && npx playwright install chromium
node src/record.mjs --limit 5
node src/run-sim.mjs
```

## Classroom profiles (assumptions)

| Profile | Shared speed | Round trip | Jitter | Loss |
|---|---|---|---|---|
| Good school wifi | 50 Mbps | 30 ms | 10 ms | 0.1% |
| Poor classroom wifi | 10 Mbps | 80 ms | 40 ms | 2% |
| Far from the servers | 20 Mbps | 250 ms | 50 ms | 1% |

These numbers are assumptions, not measurements. They should be replaced with figures from a real classroom: for example, a speed test run on one Chromebook while the class is online.

## Simulator model and its limits

- **Dependencies.** Each request waits for the request that finished most recently before it started in the recording, plus the same gap. That gap is the browser's own work.
- **Connections.** The first use of a host costs 2 round trips to set up a connection, and requests to that host wait for it (HTTP/1.1: per connection, at most 6 per host). Each request then costs 1 round trip plus the server's recorded response time, then the download.
- **Sharing.** The class's capacity is shared fairly between connections (TCP is fair per connection, not per request). Each connection is also capped by the Mathis et al. (1997) packet-loss formula. HTTP/2 requests to one host share one connection. Each request has a chance of one retransmission stall, max(200 ms, 2 × RTT).
- **Not modelled.** TCP slow start beyond the loss cap; wifi airtime effects beyond "shared capacity"; school web filters; time students spend reading before acting.
- **Recorded on a cloud computer, not a Chromebook.** Without graphics hardware, the ArcGIS SDK may use a simpler drawing mode, so the browser's own work between requests may differ from a Chromebook's. Check a few maps on a real Chromebook.
- **Memory** is the main page's JavaScript heap only; background workers use more.
- **Not tested:** switching on hidden layers, adding layers from Browse, and third-party servers (UNEP-WCMC, NPS and others) under many simultaneous classes. Load-testing other people's servers isn't appropriate.

The **simulator check** (`src/validate.mjs`) loads maps again in a browser throttled to a slow line and compares the real time with the simulator's prediction for one student. The browser's throttling can't produce packet loss or jitter, so the check covers bandwidth, latency and dependencies only.

## Version history

- **0.3.0.** Delay split by source (MapMaker app / ArcGIS code / basemap / map data) with a main cause per map, and a flag for any single download over 1 MB.
- **0.2.0.** Simulator 0.2.0: the line is shared per connection; requests wait for their connection to be set up; browser caching follows each file's recorded cache headers; it is about 100 times faster. Recorder 0.2.0: records cache headers, and separates requests the map cancelled (normal) from real errors. Profiles 0.2.0: usual lesson = MapMaker last used 7 days ago. Results: MapMaker's own default map as a reference, and "extra over MapMaker" for ranking.
- **0.1.0.** First release.

## Files

- `config/maps.json`: the web maps to test, from the stage-1 scan of the MapMaker content group.
- `config/profiles.json`: classroom profiles, number of students and threshold.
- `src/record.mjs`, `src/simulate.mjs`, `src/run-sim.mjs`, `src/validate.mjs`: the recorder, simulator, runner and check.
- `results/traces/*.json.gz`: one recording per map (used by `mode: simulate`).
- `docs/index.html`: the results page.
