# Mini SMPS SNMP Dashboard

Fleet monitoring for the **Mini SMPS** (300 W rectifier + 15 Ah Li-ion battery) over SNMP v2c.
One dashboard server polls every site, raises alarms, keeps 24 h of trends and serves the web UI.

The OID map follows the agent firmware's object table (`mib/firmware-mib-objects.txt`, from `mib.h`). It covers the
BMS (`.7`), rectifier and its energy counters (`.8`), relays (`.9`), load-output eFuses (`.10`), live flags (`.12`)
and energy meters (`.13`) under `1.3.6.1.4.1.2254.2.51.1.1`. It is the same Delta agent as the earlier SNMP
dashboard ([SNMP_dashboard](https://github.com/harisree-it/SNMP_dashboard)), whose MPPT (`.9`) and PoE (`.10`)
groups this firmware has replaced.

The UI mirrors this product's CAN tool, the Power Smart CAN GUI
([Jio-PowerSmart-GUI](https://github.com/harisree-it/Jio-PowerSmart-GUI)): the same `POWER SMART | TELECOM SMPS`
header with a Record button, sidebar, and light theme (dark via the toggle). The site dashboard keeps the same
layout: AC Input / DC Output / Load / Battery / Temperature cards, System Overview with the product photo
(`public/img/mini-smps.png`), System Status, Active Alarms, voltage/current/temperature trends, and the 1H–24H plus
Auto Refresh footer.

## Quick start

Requires Node.js 18 or newer.

```shell
git clone https://github.com/harisree-it/Indus-SNMP-Dashboard.git
cd Indus-SNMP-Dashboard
npm install
npm run demo      # simulated sites, no hardware needed -> http://localhost:3000
npm start         # monitor real units listed in data/devices.json
```

Login: `admin` / `Delta@123`. **Change it before deploying:** set `DASH_USER` / `DASH_PASS`, or edit `config.js`.

Demo mode starts three simulated Mini SMPS agents (`normal`, `outage` and `fault` profiles) plus one unreachable
site. It uses its own site list (`data/devices.demo.json`), so it never touches the real one.

## Adding sites

Use **Add site** on the fleet overview. Enter the name, IP or hostname, SNMP port (default 161), an optional per-site
read community, and latitude/longitude for the map. Sites are saved to `data/devices.json` and polled immediately.
For sites behind NAT, forward a different UDP port to each unit and enter that port.

Site lists are specific to each deployment and are not committed to git (`data/*.json` is in `.gitignore`). On first
run, `npm start` creates `data/devices.json` from `config.js → defaultDevices` (the bench unit at 192.168.100.12),
and `npm run demo` creates `data/devices.demo.json` with the four demo sites.

Check a unit from the command line before adding it:

```shell
npm run test:connection -- 192.168.100.11 161 read
```

## What it shows

| Page | Contents |
|---|---|
| **Fleet overview** | Sites / online / offline / on-battery / active-alarm counts, status map, fleet load and load per site, lowest SOC, shortest backup, a site table and the fleet alarm log. |
| **Site → Dashboard** | CAN GUI layout: AC Input, DC Output, Load, Battery and Temperature cards; System Overview (photo, operating state, power source, est. backup); System Status (AC Present, PFC Active, LLC Active, DC Output OK, Battery Normal, Temperature Normal); Active Alarms; voltage/current/temperature trends plus SOC, AC input and battery current; 1/6/12/24 h range, Auto Refresh, Export CSV. **Record** captures every polled value to CSV while the page is open, like the CAN GUI. |
| **Site → Control** | Energy counters (load total, battery, rectifier in/out, lifetime efficiency); the three load outputs with eFuse status, fault count, energy and a **Reset eFuse** button; **Relay 1/2** switches; a log of recent commands. Every command needs confirmation. |
| **Site → Battery** | Pack V/A, SOC, remaining Ah, cycles, 15 cell voltages (min/max/spread, balancing), NTC temperatures, MOSFET state, BMS protection bits. |
| **Site → Rectifier** | AC in, DC out V/A, output power (% of 300 W), PFC bus, SR/LLC/PFC/ambient temperatures, alarm bits. |
| **Site → Alarms** | Active alarms and this site's alarm history. |
| **Site → Diagnostics** | Poll statistics and every raw OID value, used for commissioning. |

Alarms raised by the dashboard: site unreachable, mains failure, rectifier output off, rectifier/BMS communication
lost, rectifier alarm bits, BMS protection bits, low/critical SOC, rectifier and battery temperature, cell imbalance,
high load / overload, and eFuse trips. Thresholds are in `config.js → thresholds`. BMS protection-bit alarms stay off until the bit layout is confirmed (see below).

## Commissioning: what has been verified on hardware

First unit checked on 2026-10-07: **192.168.100.12**, "Mini Power System" firmware v1.1 (Feb 10 2026), on battery
with no AC and no load. The agent answered 10-OID batches in about 170 ms, and 18 of 18 poll cycles succeeded at the
5 s interval. NTC 4–5 are not implemented (`numberOfNtc = 3`), which is handled.

| Value | Setting | Status |
|---|---|---|
| `totalVoltageBms` (10 mV), cells (mV) | 4993 → 49.93 V = sum of 15 cells | **verified** |
| capacities (10 mAh), SOC | 1065 / 1500 → 10.65 / 15 Ah = 71% | **verified** |
| `temperatureValueNtc*` | `auto` → plain °C (25–26) | **verified** |
| `productionDate` (packed) | 13594 → 2026-08-26 | plausible |
| `dischargingCurrent` | not 10 mA: negative int16 rising toward 0 with current (`scale.battDischarge`, from the previous dashboard). 2026-10-09: −1758…−1858 → avg 2.1 A, matching the SOC drop rate (18 A if read as 10 mA) | **verified** (~2 A load) |
| `chargingCurrent` (10 mA × 1.12, then `calibration.battCurrent`) | previous dashboard's conversion | not yet verified against a meter |
| all rectifier OIDs | `rectifierLive = 0`, all zeros | **not yet verified**: rectifier not reporting |
| `protectionStatus` | reads 27 (0x1B) on a healthy idle pack | **layout unknown**: alarms disabled (`bmsProtectionAlarms: false`) |
| energy counters (`.8.12–13`, `.13.x`) | `scale.energy: 1` (raw = Wh) | **not yet verified**: compare with the CAN GUI energy value |
| `efuseNStatus` (`.10.1/4/7`) | 1 = on, 0 = off/tripped (`outputs.efuseOnValue`) | **not yet verified** |
| `relayNState` (`.9.1–2`) | 1 = on | **not yet verified**: what each relay switches is not documented yet |

eFuse trip alarms do not depend on the status encoding. A trip is raised when an eFuse **fault count rises**, and it
clears when the status returns to its pre-trip value (for example after **Reset eFuse**), or after
`outputs.efuseTripAlarmMinutes`.

Still to check once the rectifier reports: `dcOpVoltageRect` (`auto`: values > 200 treated as 10 mV),
`dcOpCurRect` (0.1 A), `outputPowerRect` (treated as max deliverable power), and the `rectifierAlarmStatus` bits
(assumed to match the CAN fault byte: OV, UV, OV_R, UV_R, SC, OV_Vout, UV_Vout, OC_Iout).
PFC Active and LLC Active come from SNMP values instead of the CAN GPIO frame: PFC bus voltage above
`pfcBusMinV`, and output on with voltage above `dcOutputMinV`. Use **Diagnostics** to compare raw values against a meter and adjust
`config.js → scale` if needed.

While `rectifierLive = 0`, the agent returns zeros for every rectifier OID, and the dashboard shows them as "--"
instead of 0. If the rectifier stops reporting while the battery is discharging, the dashboard raises
**Mains failure (inferred)**.

The previous dashboard's battery-current decoding **is** carried over: the `dischargingCurrent` encoding
(`scale.battDischarge`), the ×1.12 charge factor and the sensed→actual gain (`calibration.battCurrent`: ×0.8778 + 0.0182).
Its rectifier/MPPT current calibrations and demo temperature offsets are **not**. If the new hardware needs a
gain/offset correction, set it in `config.js → calibration`.

## Configuration (`config.js`)

- `snmp`: read/write community, port, timeout, batch size, poll interval, failures before "offline", `controlsEnabled`
- `ratings`: 300 W rectifier, 15 Ah battery
- `scale`, `calibration`: raw-to-engineering conversion (including energy)
- `outputs`: load-output and relay names, eFuse status encoding, trip-alarm duration
- `thresholds`: alarm levels
- `map`: tile server (OpenStreetMap by default, no key needed; use an internal tile server on intranet-only networks)
- `auth`, `branding`, `history`, `defaultDevices`

`PORT` and `HOST` environment variables override the listen address.

## Polling design

Each site has its own poll loop, so a slow or dead site never delays the others. OIDs are fetched 10 per request.
If the agent rejects a batch, that batch is retried one OID at a time, and OIDs the agent lacks are skipped. A site
goes offline only after 3 consecutive failed cycles, which prevents status flapping. A healthy local unit polls in
under 10 ms.

## Project layout

```
server.js            Express app, login/session, REST API, --demo mode
config.js            all deployment settings
lib/oids.js          Mini SMPS OID map
lib/poller.js        SNMP poll cycle (batching + fallback)
lib/decode.js        raw -> engineering units, load / power source / backup time
lib/alarms.js        alarm rules + raise/clear log
lib/monitor.js       per-site loops, state, 24 h trend history
lib/store.js         data/devices.json persistence
data/                site lists, created on first run (not in git)
public/              login, fleet overview (index.html) and site view (system.html)
tools/mock-agent.js  simulated Mini SMPS SNMP agent(s)
tools/test-connection.js
mib/                 agent MIB (reference)
```

## REST API

All endpoints except `/api/meta` and `/api/login` need `Authorization: Bearer <token>`. Get the token from `POST /api/login`.

| Method | Path | |
|---|---|---|
| GET | `/api/devices` | fleet summary |
| POST | `/api/devices` | add site `{name, ip, port?, community?, lat?, lng?}` |
| GET / PATCH / DELETE | `/api/devices/:id` | site detail (decoded + raw) / edit / remove |
| GET | `/api/devices/:id/history?hours=1..24` | trend points |
| POST | `/api/devices/:id/set` | SNMP SET `{key, value}`: `relay1State`/`relay2State` 0 or 1; `efuse1Reset`–`efuse3Reset` 1 |
| GET | `/api/alarms?device=&limit=` | active alarms and log |

## Notes

- Alarm history and trends are kept in memory and reset when the server restarts. The site list is persisted.
- Relay and eFuse commands use the SNMP **write** community (`config.js → snmp.writeCommunity`, or per site in the
  site dialog). A wrong write community shows up as "No response". Set `snmp.controlsEnabled: false` for a
  read-only dashboard.
- The firmware also defines traps (`.0.2–.0.7`: BMS SOC low / fault / comms failure / cycle threshold, rectifier
  fault / comms failure). The dashboard polls and does not receive traps yet.
- The UI loads fonts, icons, Leaflet and map tiles from public CDNs. Everything still works without them, but icons
  and the map will be missing.
- Version 1.0.0: initial Mini SMPS release.
