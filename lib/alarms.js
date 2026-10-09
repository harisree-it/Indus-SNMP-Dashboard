// Alarm rules for one site, plus a tracker that turns per-poll alarm sets into
// raise/clear events for the fleet alarm log.

const config = require('../config');

const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 };

const f1 = v => (v === null || v === undefined ? '--' : Number(v).toFixed(1));

function evaluate(st) {
    const th = config.thresholds;
    const out = [];
    const add = (key, severity, message, detail) => out.push({ key, severity, message, detail });

    if (st.status === 'offline') {
        add('comm', 'critical', 'Site unreachable',
            `No SNMP response from ${st.device.ip}:${st.device.port || config.snmp.port}`);
        return out;
    }
    const d = st.data;
    if (st.status !== 'online' || !d) return out;

    const { battery: b, rectifier: r, system: s, live } = d;

    if (!live.rectifier) {
        add('rect_comm', 'major', 'Rectifier communication lost', 'rectifierLive = 0');
        // The rectifier may stop reporting when it loses AC, so a discharging battery means mains is down.
        if (live.bms && b.state === 'discharging') {
            const backup = s.backupHours !== null ? ` · est. backup ${s.backupHours.toFixed(1)} h` : '';
            add('mains_fail', 'major', 'Mains failure (inferred)', `Rectifier not reporting and battery discharging ${f1(-b.current)} A${backup}`);
        }
    }
    if (!live.bms) add('bms_comm', 'major', 'BMS communication lost', 'bmsLive = 0');

    if (live.rectifier) {
        if (s.mainsOk === false) {
            const backup = s.backupHours !== null ? ` · est. backup ${s.backupHours.toFixed(1)} h` : '';
            add('mains_fail', 'major', 'Mains failure', `AC input ${f1(r.acVoltage)} V${backup}`);
        } else if (s.mainsOk && !r.on) {
            add('rect_off', 'major', 'Rectifier output off', `AC present (${f1(r.acVoltage)} V) but rectifier is not running`);
        }
        for (const bit of r.alarm.active) {
            add(`rect_bit_${bit.bit}`, 'critical', `Rectifier: ${bit.label}`, `rectifierAlarmStatus = 0x${r.alarm.raw.toString(16).toUpperCase()}`);
        }
        if (r.tempMax !== null) {
            if (r.tempMax >= th.rectTempCritical) {
                add('rect_temp', 'critical', 'Rectifier temperature critical', `Hottest sensor ${f1(r.tempMax)} °C (limit ${th.rectTempCritical} °C)`);
            } else if (r.tempMax >= th.rectTempWarn) {
                add('rect_temp', 'minor', 'Rectifier temperature high', `Hottest sensor ${f1(r.tempMax)} °C (warn ${th.rectTempWarn} °C)`);
            }
        }
    }

    if (live.bms) {
        for (const bit of b.protection.confirmed ? b.protection.active : []) {
            add(`bms_prot_${bit.bit}`, 'critical', `BMS protection: ${bit.label}`, `protectionStatus = 0x${b.protection.raw.toString(16).toUpperCase()}`);
        }
        if (b.soc !== null) {
            if (b.soc < th.socCritical) {
                add('soc', 'critical', 'Battery SOC critical', `${b.soc}% (limit ${th.socCritical}%)`);
            } else if (b.soc < th.socWarn) {
                add('soc', 'minor', 'Battery SOC low', `${b.soc}% (warn ${th.socWarn}%)`);
            }
        }
        if (b.tempMax !== null) {
            if (b.tempMax >= th.battTempCritical) {
                add('batt_temp', 'critical', 'Battery temperature critical', `Hottest NTC ${f1(b.tempMax)} °C (limit ${th.battTempCritical} °C)`);
            } else if (b.tempMax >= th.battTempWarn) {
                add('batt_temp', 'minor', 'Battery temperature high', `Hottest NTC ${f1(b.tempMax)} °C (warn ${th.battTempWarn} °C)`);
            }
        }
        if (b.cellDeltaMv !== null && b.cellDeltaMv >= th.cellDeltaWarnMv) {
            add('cell_delta', 'minor', 'Cell imbalance',
                `Δ ${b.cellDeltaMv} mV (min ${b.cellMin.toFixed(3)} V, max ${b.cellMax.toFixed(3)} V)`);
        }
    }

    // eFuse trips: a rising fault count is a trip whatever the status encoding turns out to be.
    const tripMs = config.outputs.efuseTripAlarmMinutes * 60e3;
    for (const [n, t] of Object.entries(st.efuseTrips || {})) {
        if (Date.now() - new Date(t.at) > tripMs) continue;
        const load = d.loads[n - 1];
        add(`efuse_${n}`, 'major', `${load ? load.name : `Load ${n}`} eFuse tripped`,
            `Fault count ${t.from} → ${t.to} at ${new Date(t.at).toLocaleTimeString()}`);
    }

    if (s.loadPct !== null) {
        if (s.loadPct >= th.loadCriticalPct) {
            add('load', 'major', 'Overload', `${Math.round(s.loadPower)} W (${Math.round(s.loadPct)}% of ${s.ratedPower} W)`);
        } else if (s.loadPct >= th.loadWarnPct) {
            add('load', 'minor', 'Load high', `${Math.round(s.loadPower)} W (${Math.round(s.loadPct)}% of ${s.ratedPower} W)`);
        }
    }

    return out;
}

function bySeverity(a, b) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.raisedAt < b.raisedAt ? 1 : -1);
}

class AlarmTracker {
    constructor(maxLog) {
        this.maxLog = maxLog;
        this.active = new Map(); // deviceId -> Map(alarmId -> event)
        this.log = [];           // newest first; events are shared with `active`
        this.seq = 0;
    }

    update(device, alarms) {
        const now = new Date().toISOString();
        const prev = this.active.get(device.id) || new Map();
        const next = new Map();

        for (const a of alarms) {
            // A severity change (minor -> critical) is logged as a new event.
            const id = `${a.key}:${a.severity}`;
            let ev = prev.get(id);
            if (ev) {
                ev.detail = a.detail;
                ev.site = device.name;
            } else {
                ev = {
                    id: ++this.seq, deviceId: device.id, site: device.name,
                    key: a.key, severity: a.severity, message: a.message, detail: a.detail,
                    raisedAt: now, clearedAt: null
                };
                this.log.unshift(ev);
                if (this.log.length > this.maxLog) this.log.length = this.maxLog;
            }
            next.set(id, ev);
        }
        for (const [id, ev] of prev) {
            if (!next.has(id)) ev.clearedAt = now;
        }
        this.active.set(device.id, next);
    }

    remove(deviceId) {
        this.update({ id: deviceId, name: '' }, []);
        this.active.delete(deviceId);
    }

    activeFor(deviceId) {
        return [...(this.active.get(deviceId) || new Map()).values()].sort(bySeverity);
    }

    allActive() {
        return [...this.active.values()].flatMap(m => [...m.values()]).sort(bySeverity);
    }

    logFor(deviceId, limit = 100) {
        const items = deviceId ? this.log.filter(e => e.deviceId === deviceId) : this.log;
        return items.slice(0, limit);
    }
}

function countBySeverity(list) {
    const c = { critical: 0, major: 0, minor: 0 };
    for (const a of list) c[a.severity]++;
    return c;
}

module.exports = { evaluate, AlarmTracker, countBySeverity };
