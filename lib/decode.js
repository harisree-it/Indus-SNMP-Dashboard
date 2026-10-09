// Raw SNMP values -> engineering units + derived Mini SMPS system view.
// Topology: AC mains -> 300 W rectifier -> DC bus -> load, with the 15 Ah battery floating on the bus.

const config = require('../config');
const { CELL_COUNT, NTC_COUNT, LOAD_COUNT, RELAY_COUNT } = require('./oids');

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Some firmware packs a signed 16-bit value into the Integer32 OID (e.g. 65036 for -500).
function signed16(n) {
    return n > 32767 && n <= 65535 ? n - 65536 : n;
}

function scaled(raw, divisor) {
    const n = num(raw);
    return n === null ? null : n / divisor;
}

// Calibrate a non-negative current magnitude.
function calibrate(amps, cal) {
    if (amps === null) return null;
    if (amps < cal.deadband) return 0;
    return Math.max(0, amps * cal.gain + cal.offset);
}

// Battery current magnitudes in A, before calibration (see config.scale.battDischarge).
function chargeAmps(raw) {
    const n = num(raw);
    return n === null ? null : Math.max(0, signed16(n)) * config.scale.battChargeFactor / config.scale.battCurrent;
}

function dischargeAmps(raw) {
    const n = num(raw);
    if (n === null) return null;
    const s = signed16(n);
    if (s >= 0) return s / config.scale.battCurrent;
    const { slope, offset } = config.scale.battDischarge;
    return slope * s + offset; // below 0 A (s < about -2022) falls under the calibration deadband
}

function ntcCelsius(raw) {
    const n = num(raw);
    if (n === null || n === 0) return null; // 0 = sensor not fitted / not reported
    const unit = config.scale.ntcUnit;
    const deciKelvin = unit === 'deciKelvin' || (unit === 'auto' && n > 2000);
    return deciKelvin ? n / 10 - 273.15 : n;
}

function rectDcVolts(raw) {
    const n = num(raw);
    if (n === null) return null;
    const s = config.scale.rectDcVoltage;
    if (s === 'auto') return n > 200 ? n / 100 : n;
    return n / s;
}

function decodeBits(raw, names) {
    const n = num(raw) || 0;
    const known = Object.entries(names).map(([bit, label]) => ({
        bit: Number(bit), label, active: ((n >>> Number(bit)) & 1) === 1
    }));
    const active = [];
    for (let b = 0; b < 32; b++) {
        if ((n >>> b) & 1) active.push({ bit: b, label: names[b] || `Alarm bit ${b}` });
    }
    return { raw: n, known, active };
}

// BMS production date, packed as (year-2000)<<9 | month<<5 | day.
function productionDate(raw) {
    const n = num(raw);
    if (n === null || n <= 0) return null;
    if (n >= 19000101 && n <= 29991231) {
        const s = String(n);
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    if (n > 0xFFFF) return null;
    const d = n & 0x1F, m = (n >> 5) & 0x0F, y = 2000 + (n >> 9);
    if (m < 1 || m > 12 || d < 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function maxOf(values) {
    const v = values.filter(x => x !== null && x !== undefined);
    return v.length ? Math.max(...v) : null;
}

function decode(raw) {
    const sc = config.scale;
    const cal = config.calibration;
    const th = config.thresholds;
    const ratedW = config.ratings.rectifierWatts;

    // If the agent does not implement the live flags, infer them from data presence.
    const live = {
        bms: raw.bmsLive != null ? num(raw.bmsLive) === 1 : raw.totalVoltageBms != null,
        rectifier: raw.rectifierLive != null ? num(raw.rectifierLive) === 1 : raw.acIpVoltageRect != null
    };

    // ---- Battery ----
    const battV = scaled(raw.totalVoltageBms, sc.battVoltage);
    const chgA = calibrate(chargeAmps(raw.chargingCurrent), cal.battCurrent) || 0;
    const dsgA = calibrate(dischargeAmps(raw.dischargingCurrent), cal.battCurrent) || 0;
    const battI = chgA > 0 ? chgA : -dsgA; // + charging, - discharging
    const battState = battI > 0 ? 'charging' : battI < 0 ? 'discharging' : 'idle';

    const reportedFull = scaled(raw.totalCapacity, sc.battCapacity);
    const fullAh = reportedFull > 0 ? reportedFull : config.ratings.batteryAh;
    const soc = num(raw.remainingSoc);
    let remAh = scaled(raw.remainingCapacity, sc.battCapacity);
    if (!(remAh > 0 && remAh <= fullAh * 1.05) && soc !== null) remAh = fullAh * soc / 100;

    const cellsReported = num(raw.numberOfBattery);
    const cellCount = cellsReported >= 1 && cellsReported <= CELL_COUNT ? cellsReported : CELL_COUNT;
    const cells = [];
    for (let i = 1; i <= cellCount; i++) {
        const v = scaled(raw[`voltageValueCell${i}`], sc.cellVoltage);
        cells.push({ n: i, v: v > 0 ? v : null, balancing: num(raw[`cellBalanceStatusFlag${i}`]) === 1 });
    }
    const cellVs = cells.map(c => c.v).filter(v => v !== null);
    const cellMin = cellVs.length ? Math.min(...cellVs) : null;
    const cellMax = cellVs.length ? Math.max(...cellVs) : null;
    const cellDeltaMv = cellVs.length > 1 ? Math.round((cellMax - cellMin) * 1000) : null;

    const ntcReported = num(raw.numberOfNtc);
    const ntcCount = ntcReported >= 1 && ntcReported <= NTC_COUNT ? ntcReported : NTC_COUNT;
    const ntc = [];
    for (let i = 1; i <= ntcCount; i++) ntc.push(ntcCelsius(raw[`temperatureValueNtc${i}`]));

    const mos = num(raw.mosfetControlStatus);

    const battery = {
        voltage: battV,
        current: battI,
        state: battState,
        soc,
        remainingAh: remAh,
        fullAh,
        reportedFullAh: reportedFull,
        ratedAh: config.ratings.batteryAh,
        cycles: num(raw.dischargeCycle),
        protection: { ...decodeBits(raw.protectionStatus, config.bmsProtectionBits), confirmed: !!config.bmsProtectionAlarms },
        mosfet: mos === null ? null : { raw: mos, charge: (mos & 1) === 1, discharge: (mos & 2) === 2 },
        productionDate: productionDate(raw.productionDate),
        softwareVersion: raw.softwareVersion ?? null,
        cellsReported,
        cells,
        cellMin,
        cellMax,
        cellDeltaMv,
        ntc,
        tempMax: maxOf(ntc)
    };

    // ---- Rectifier ----
    // While rectifierLive = 0 the agent returns placeholder zeros; show them as unknown, not as readings.
    const rv = key => (live.rectifier ? raw[key] : null);
    const acV = scaled(rv('acIpVoltageRect'), sc.rectAcVoltage);
    const dcV = rectDcVolts(rv('dcOpVoltageRect'));
    const dcIraw = scaled(rv('dcOpCurRect'), sc.rectDcCurrent);
    const dcI = calibrate(dcIraw === null ? null : Math.max(0, dcIraw), cal.rectCurrent);
    const on = num(rv('rectifierOnStatus')) === 1;
    const outW = dcV !== null && dcI !== null ? dcV * dcI : null;
    const temps = {
        ambient: scaled(rv('ambientTempRect'), sc.rectTemp),
        sr: scaled(rv('srTemp'), sc.rectTemp),
        llc: scaled(rv('llcTemp'), sc.rectTemp),
        pfc: scaled(rv('pfcTemp'), sc.rectTemp)
    };

    const rectifier = {
        on,
        acVoltage: acV,
        dcVoltage: dcV,
        dcCurrent: dcI,
        busVoltage: scaled(rv('busVoltage'), sc.rectBusVoltage),
        outputPower: outW,
        loadPct: outW !== null ? outW / ratedW * 100 : null,
        ratedPower: ratedW,
        maxPowerReported: num(rv('outputPowerRect')),
        temps,
        tempMax: maxOf(Object.values(temps)),
        alarm: decodeBits(rv('rectifierAlarmStatus'), config.rectifierAlarmBits)
    };

    // ---- Energy, load outputs (eFuses) and relays ----
    const wh = v => scaled(v, sc.energy);
    const out = config.outputs;
    const rectInWh = wh(rv('rectInputEnergy'));
    const rectOutWh = wh(rv('rectOutputEnergy'));
    const energy = {
        rectInputWh: rectInWh,
        rectOutputWh: rectOutWh,
        rectEfficiency: rectInWh > 0 && rectOutWh !== null ? rectOutWh / rectInWh * 100 : null,
        loadTotalWh: wh(raw.energyLoadTotal),
        batteryWh: wh(raw.energyBattery)
    };
    const loads = [];
    for (let i = 1; i <= LOAD_COUNT; i++) {
        const status = num(raw[`efuse${i}Status`]);
        loads.push({
            n: i,
            name: out.loadNames[i - 1] || `Load ${i}`,
            efuseStatus: status,
            efuseOn: status === null ? null : status === out.efuseOnValue,
            faultCount: num(raw[`efuse${i}FaultCount`]),
            energyWh: wh(raw[`energyLoad${i}`])
        });
    }
    const relays = [];
    for (let i = 1; i <= RELAY_COUNT; i++) {
        const state = num(raw[`relay${i}State`]);
        relays.push({ n: i, name: out.relayNames[i - 1] || `Relay ${i}`, state, on: state === null ? null : state !== 0 });
    }

    // ---- System ----
    const mainsOk = live.rectifier && acV !== null ? acV >= th.acFailV : null; // null = unknown
    const busV = on && dcV > 1 ? dcV : battV;
    const loadI = Math.max(0, (dcI || 0) - battI);
    const loadW = busV !== null ? busV * loadI : null;

    let powerSource = 'unknown';
    if (mainsOk && on) powerSource = 'mains';
    else if (battState === 'discharging') powerSource = 'battery';
    else if (mainsOk === false) powerSource = live.bms ? 'battery' : 'none';

    let backupHours = null;
    let backupBasis = null;
    if (remAh !== null) {
        if (battState === 'discharging') {
            backupHours = remAh / -battI;
            backupBasis = 'discharge';
        } else if (loadW > 5 && battV) {
            backupHours = remAh * battV / loadW;
            backupBasis = 'load';
        }
    }

    const faulted = rectifier.alarm.raw !== 0 || (battery.protection.confirmed && battery.protection.raw !== 0);
    let state = 'standby';
    if (faulted) state = 'fault';
    else if (powerSource === 'battery') state = 'on-battery';
    else if (powerSource === 'mains') state = 'running';

    const uptimeTicks = num(raw.sysUpTime);

    return {
        product: {
            name: raw.productName || null,
            version: raw.productVersion || null,
            date: raw.productDate || null,
            sysName: raw.sysName || null
        },
        uptimeSec: uptimeTicks === null ? null : Math.floor(uptimeTicks / 100),
        live,
        battery,
        rectifier,
        energy,
        loads,
        relays,
        system: {
            state,
            powerSource,
            mainsOk,
            busVoltage: busV,
            loadCurrent: loadI,
            loadPower: loadW,
            loadPct: loadW !== null ? loadW / ratedW * 100 : null,
            ratedPower: ratedW,
            backupHours,
            backupBasis
        }
    };
}

module.exports = { decode, signed16, chargeAmps, dischargeAmps, ntcCelsius, rectDcVolts, productionDate };
