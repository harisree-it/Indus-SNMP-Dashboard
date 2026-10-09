// Simulated Mini SMPS SNMP agent(s) for testing the dashboard without hardware.
//
//   node tools/mock-agent.js                       -> 3 agents on 127.0.0.1:16101-16103
//   node tools/mock-agent.js 16101:normal 16102:outage --bind 0.0.0.0
//
// Profiles: normal  - mains present, battery floating
//           outage  - mains fails for 3 min every 7 min, battery discharges and recharges
//           fault   - heavy load, rectifier over-temperature alarm, one weak cell
//
// Values are sent in the raw units the dashboard expects from the real agent
// (10 mV, 10 mA, 0.1 K, ...). Battery SOC moves 20x faster than real time so that
// changes are visible during a demo.

const snmp = require('net-snmp');
const config = require('../config');
const { OIDS, WRITABLE, CELL_COUNT, NTC_COUNT, LOAD_COUNT } = require('../lib/oids');

const STRING_KEYS = new Set(['sysName', 'productName', 'productVersion', 'productDate']);
const RATED_W = 300;
const CAPACITY_AH = 15;
const SOC_SPEEDUP = 20;

// Battery current in the real unit's encoding: the inverse of config.scale.battDischarge,
// battChargeFactor and calibration.battCurrent.
function sensedAmps(amps) {
    const cal = config.calibration.battCurrent;
    return (amps - cal.offset) / cal.gain;
}

function chargeRaw(amps) {
    return Math.max(0, Math.round(sensedAmps(amps) * config.scale.battCurrent / config.scale.battChargeFactor));
}

function dischargeRaw(amps) {
    const { slope, offset } = config.scale.battDischarge;
    return 65536 + Math.round((sensedAmps(amps) - offset) / slope); // negative int16 sent as unsigned
}

function createSim(profile, siteName) {
    const t0 = Date.now();
    let last = t0;
    let soc = profile === 'outage' ? 48 : profile === 'fault' ? 88 : 97;
    const cycles = { normal: 37, outage: 112, fault: 9 }[profile] || 20;
    const cellOffsetMv = Array.from({ length: CELL_COUNT }, (_, i) => ((i * 7919) % 11) - 5);
    // energy counters (Wh), started at plausible lifetime totals; they run 20x fast like SOC
    const e = { rectIn: 18250, rectOut: 16790, loads: [7120, 4310, 2480], batt: 960 };
    const loadShare = [0.5, 0.3, 0.2];
    const efuseOn = [1, 1, 1];
    const faults = [0, 2, 0];
    let nextTrip = 120; // fault profile: Load 3 eFuse trips every 4 min until reset

    // controls = { relays: [..], resets: [..] } as last written by an SNMP SET
    return function tick(controls = { resets: [] }) {
        const now = Date.now();
        const dt = (now - last) / 1000;
        last = now;
        const t = (now - t0) / 1000;

        const mainsOn = profile !== 'outage' || (t % 420) >= 180;
        const baseLoad = profile === 'fault' ? 268 : 150;
        const loadW = baseLoad + 40 * Math.sin(2 * Math.PI * t / 300) + (Math.random() - 0.5) * 8;

        const cellOcv = 3.0 + 0.32 * soc / 100;
        let battI; // + charge, - discharge
        let dcV = 0;
        let rectI = 0;
        if (mainsOn) {
            dcV = 53.5;
            const headroomA = Math.max(0, (RATED_W - loadW) / dcV);
            const wantA = soc < 95 ? 3.0 : Math.max(0, 3.0 * (100 - soc) / 5);
            battI = Math.min(wantA, headroomA);
            rectI = loadW / dcV + battI;
        } else {
            const packV = 15 * cellOcv;
            battI = soc > 3 ? -(loadW / packV) : 0;
        }
        soc = Math.min(100, Math.max(3, soc + battI * dt / 3600 / CAPACITY_AH * 100 * SOC_SPEEDUP));

        controls.resets.forEach((r, i) => { if (r === 1) efuseOn[i] = 1; });
        if (profile === 'fault' && t >= nextTrip) {
            nextTrip = t + 240;
            if (efuseOn[2]) { efuseOn[2] = 0; faults[2]++; }
        }
        const hours = dt / 3600 * SOC_SPEEDUP;
        const rectOutW = dcV * rectI;
        e.rectOut += rectOutW * hours;
        e.rectIn += rectOutW / 0.92 * hours;
        loadShare.forEach((f, i) => { if (efuseOn[i]) e.loads[i] += loadW * f * hours; });
        if (battI < 0) e.batt += -battI * 15 * cellOcv * hours;

        const cellBase = mainsOn ? (dcV - 0.15) / CELL_COUNT : cellOcv + battI * 0.004;
        const cells = cellOffsetMv.map((mv, i) => {
            let v = cellBase * 1000 + mv;
            if (profile === 'fault' && i === 6) v -= 170;
            return Math.round(v);
        });
        const packMv = cells.reduce((a, b) => a + b, 0);
        const avg = packMv / CELL_COUNT;

        const amb = 33 + 3 * Math.sin(2 * Math.PI * t / 900);
        const heat = mainsOn ? loadW / 20 : 0;
        const pfcTemp = profile === 'fault' ? 84 + Math.sin(t / 60) : amb + 8 + heat;

        const v = {
            sysUpTime: Math.floor((now - t0) / 10) + 3 * 86400 * 100,
            sysName: siteName,
            productName: 'Mini SMPS 300W',
            productVersion: '1.0.3',
            productDate: '2026-09-15',
            bmsLive: 1,
            rectifierLive: 1,

            dcOpVoltageRect: Math.round(dcV * 100),
            dcOpCurRect: Math.round(rectI * 10),
            acIpVoltageRect: mainsOn ? Math.round(230 + (Math.random() - 0.5) * 8) : 0,
            busVoltage: mainsOn ? 390 : 0,
            outputPowerRect: RATED_W,
            ambientTempRect: Math.round(amb + (profile === 'fault' ? 22 : 4)),
            srTemp: mainsOn ? Math.round(amb + 6 + heat) : Math.round(amb),
            llcTemp: mainsOn ? Math.round(amb + 5 + heat * 0.8) : Math.round(amb),
            pfcTemp: mainsOn ? Math.round(pfcTemp) : Math.round(amb),
            rectifierOnStatus: mainsOn ? 1 : 0,
            rectifierAlarmStatus: profile === 'fault' ? (1 << 7) : 0, // output overcurrent
            rectInputEnergy: Math.round(e.rectIn),
            rectOutputEnergy: Math.round(e.rectOut),
            energyLoad1: Math.round(e.loads[0]),
            energyLoad2: Math.round(e.loads[1]),
            energyLoad3: Math.round(e.loads[2]),
            energyLoadTotal: Math.round(e.loads[0] + e.loads[1] + e.loads[2]),
            energyBattery: Math.round(e.batt),

            totalVoltageBms: Math.round(packMv / 10),
            chargingCurrent: battI > 0 ? chargeRaw(battI) : 0,
            dischargingCurrent: battI < 0 ? dischargeRaw(-battI) : 0,
            remainingCapacity: Math.round(soc / 100 * CAPACITY_AH * 100),
            totalCapacity: CAPACITY_AH * 100,
            dischargeCycle: cycles,
            remainingSoc: Math.round(soc),
            protectionStatus: 0,
            mosfetControlStatus: 3,
            productionDate: ((2025 - 2000) << 9) | (8 << 5) | 27,
            softwareVersion: 33,
            numberOfBattery: CELL_COUNT,
            numberOfNtc: 4
        };
        for (let i = 1; i <= NTC_COUNT; i++) {
            const c = i <= 4 ? 30 + i * 0.6 + (mainsOn ? battI * 0.3 : -battI * 0.5) : null;
            v[`temperatureValueNtc${i}`] = c === null ? 0 : Math.round((c + 273.15) * 10);
        }
        for (let i = 1; i <= LOAD_COUNT; i++) {
            v[`efuse${i}Status`] = efuseOn[i - 1];
            v[`efuse${i}FaultCount`] = faults[i - 1];
        }
        cells.forEach((mv, i) => {
            v[`voltageValueCell${i + 1}`] = mv;
            v[`cellBalanceStatusFlag${i + 1}`] = battI > 0.2 && mv > avg + 3 ? 1 : 0;
        });
        return v;
    };
}

function startAgent({ port, profile = 'normal', name, bind = '127.0.0.1', community = 'read', writeCommunity = 'write' }) {
    const agent = snmp.createAgent({ port, address: bind, accessControlModelType: snmp.AccessControlModelType.None },
        err => { if (err) console.error(`[mock ${port}]`, err.message); });
    agent.getAuthorizer().addCommunity(community);
    agent.getAuthorizer().addCommunity(writeCommunity);
    const mib = agent.getMib();

    const objects = { ...OIDS, ...Object.fromEntries(Object.entries(WRITABLE).map(([k, w]) => [k, w.oid])) };
    for (const [key, oid] of Object.entries(objects)) {
        mib.registerProvider({
            name: key,
            type: snmp.MibProviderType.Scalar,
            oid: oid.replace(/\.0$/, ''),
            scalarType: key === 'sysUpTime' ? snmp.ObjectType.TimeTicks
                : STRING_KEYS.has(key) ? snmp.ObjectType.OctetString : snmp.ObjectType.Integer,
            maxAccess: snmp.MaxAccess[key in WRITABLE ? 'read-write' : 'read-only']
        });
    }
    // writable objects keep whatever an SNMP SET wrote; seed them once
    mib.setScalarValue('relay1State', 1);
    mib.setScalarValue('relay2State', 0);
    for (let i = 1; i <= LOAD_COUNT; i++) mib.setScalarValue(`efuse${i}Reset`, 0);

    const tick = createSim(profile, name || `mini-smps-${port}`);
    const update = () => {
        const resets = [];
        for (let i = 1; i <= LOAD_COUNT; i++) {
            resets.push(mib.getScalarValue(`efuse${i}Reset`));
            mib.setScalarValue(`efuse${i}Reset`, 0); // reset is a one-shot command
        }
        for (const [k, val] of Object.entries(tick({ resets }))) mib.setScalarValue(k, val);
    };
    update();
    const timer = setInterval(update, 1000);
    return { port, profile, close: () => { clearInterval(timer); agent.close(); } };
}

function startAgents(specs, bind) {
    return specs.map(s => startAgent({ bind, ...s }));
}

module.exports = { startAgents, startAgent };

if (require.main === module) {
    const args = process.argv.slice(2);
    const bindIdx = args.indexOf('--bind');
    const bind = bindIdx >= 0 ? args.splice(bindIdx, 2)[1] : '127.0.0.1';
    const specs = args.length
        ? args.map(a => { const [port, profile] = a.split(':'); return { port: Number(port), profile: profile || 'normal' }; })
        : [{ port: 16101, profile: 'normal' }, { port: 16102, profile: 'outage' }, { port: 16103, profile: 'fault' }];
    startAgents(specs, bind);
    for (const s of specs) console.log(`Mock Mini SMPS agent (${s.profile}) on ${bind}:${s.port}, community "read"`);
}
