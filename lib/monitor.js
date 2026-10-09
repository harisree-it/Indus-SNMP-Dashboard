// Fleet monitor: an independent poll loop per site, so one slow or dead site
// never delays the others. Holds live state, alarms and trend history.

const { pollOnce, setOnce } = require('./poller');
const { decode } = require('./decode');
const { WRITABLE, LOAD_COUNT } = require('./oids');
const { evaluate, AlarmTracker, countBySeverity } = require('./alarms');

class Monitor {
    constructor(config) {
        this.config = config;
        this.states = new Map();
        this.history = new Map();
        this.alarms = new AlarmTracker(config.alarmLogSize);
    }

    track(device) {
        const st = {
            device,
            status: 'connecting', // connecting -> online / offline
            failures: 0,
            lastPoll: null,
            lastSeen: null,
            lastError: null,
            pollStats: null,
            raw: {},
            rawAt: {},
            data: null,
            timer: null,
            polling: false,
            repoll: false,
            lastSample: 0,
            efuseTrips: {},   // load n -> { at, from, to } when its eFuse fault count rose
            controlLog: []    // recent SET commands, newest first
        };
        this.states.set(device.id, st);
        this.history.set(device.id, []);
        st.timer = setTimeout(() => this.cycle(device.id), 0);
    }

    untrack(id) {
        const st = this.states.get(id);
        if (!st) return;
        clearTimeout(st.timer);
        this.states.delete(id);
        this.history.delete(id);
        this.alarms.remove(id);
    }

    // Called after a site is edited. A new address means old readings no longer apply.
    retarget(device) {
        const st = this.states.get(device.id);
        if (!st) return this.track(device);
        const moved = st.device.ip !== device.ip || st.device.port !== device.port || st.device.community !== device.community;
        if (moved) {
            this.untrack(device.id);
            this.track(device);
        } else {
            st.device = device;
        }
    }

    async cycle(id) {
        const st = this.states.get(id);
        if (!st || st.polling) return;
        st.polling = true;
        clearTimeout(st.timer);
        try {
            const res = await pollOnce(st.device, this.config.snmp);
            if (this.states.get(id) !== st) return; // removed or retargeted meanwhile

            const now = new Date().toISOString();
            st.lastPoll = now;
            st.pollStats = { answered: res.answered, total: res.total, durationMs: res.durationMs };
            if (res.reachable) {
                st.failures = 0;
                st.status = 'online';
                st.lastSeen = now;
                st.lastError = null;
                for (let i = 1; i <= LOAD_COUNT; i++) {
                    const k = `efuse${i}FaultCount`;
                    const sk = `efuse${i}Status`;
                    const before = Number(st.raw[k]);
                    const after = Number(res.raw[k]);
                    if (k in st.raw && Number.isFinite(before) && Number.isFinite(after) && after > before) {
                        st.efuseTrips[i] = { at: now, from: before, to: after, statusBefore: st.raw[sk], statusAtTrip: res.raw[sk] };
                    }
                    // Cleared once the status is back to its pre-trip value (e.g. after a reset);
                    // this works whichever way the status is encoded.
                    const trip = st.efuseTrips[i];
                    if (trip && trip.statusAtTrip !== trip.statusBefore && res.raw[sk] === trip.statusBefore) {
                        delete st.efuseTrips[i];
                    }
                }
                Object.assign(st.raw, res.raw);
                for (const k of Object.keys(res.raw)) st.rawAt[k] = now;
                st.data = decode(st.raw);
            } else {
                st.failures++;
                st.lastError = res.error;
                if (st.failures >= this.config.snmp.offlineAfterFailures) st.status = 'offline';
            }
            this.alarms.update(st.device, evaluate(st));
            this.sample(st);
        } catch (err) {
            console.error(`[${id}] poll cycle error:`, err);
        } finally {
            st.polling = false;
        }
        if (this.states.get(id) === st) {
            st.timer = setTimeout(() => this.cycle(id), st.repoll ? 300 : this.config.snmp.pollIntervalMs);
            st.repoll = false;
        }
    }

    // Poll a site right away (e.g. after a command) instead of waiting for the next cycle.
    pollNow(id) {
        const st = this.states.get(id);
        if (!st) return;
        if (st.polling) st.repoll = true;
        else this.cycle(id);
    }

    // SNMP SET on one of the WRITABLE objects (relay state, eFuse reset). Every attempt is logged.
    async setValue(id, key, value) {
        const st = this.states.get(id);
        if (!st) throw Object.assign(new Error('Site not found'), { status: 404 });
        const target = WRITABLE[key];
        if (!target) throw Object.assign(new Error(`${key} is not writable`), { status: 400 });
        if (!target.values.includes(value)) throw Object.assign(new Error(`Invalid value ${value} for ${key}`), { status: 400 });

        const entry = { at: new Date().toISOString(), key, value, ok: false, error: null };
        st.controlLog.unshift(entry);
        st.controlLog.length = Math.min(st.controlLog.length, 50);
        try {
            const community = st.device.writeCommunity || this.config.snmp.writeCommunity;
            await setOnce(st.device, community, target.oid, value, this.config.snmp);
            entry.ok = true;
            console.log(`[${id}] SET ${key} = ${value} OK`);
        } catch (err) {
            entry.error = err.message;
            console.warn(`[${id}] SET ${key} = ${value} failed: ${err.message}`);
            throw Object.assign(err, { status: 502 });
        } finally {
            this.pollNow(id);
            setTimeout(() => this.pollNow(id), 2000); // firmware may apply the change a moment later
        }
    }

    sample(st) {
        if (st.status !== 'online' || !st.data) return;
        const now = Date.now();
        if (now - st.lastSample < this.config.history.sampleEveryMs) return;
        st.lastSample = now;
        const { battery: b, rectifier: r, system: s } = st.data;
        const series = this.history.get(st.device.id);
        series.push({
            t: now,
            loadW: s.loadPower,
            loadA: s.loadCurrent,
            battV: b.voltage,
            battI: b.current,
            soc: b.soc,
            acV: r.acVoltage,
            dcV: s.busVoltage,
            rectTemp: r.tempMax,
            battTemp: b.tempMax
        });
        const cutoff = now - this.config.history.keepHours * 3600e3;
        while (series.length && series[0].t < cutoff) series.shift();
    }

    summary(id) {
        const st = this.states.get(id);
        if (!st) return null;
        const d = st.data;
        const active = this.alarms.activeFor(id);
        return {
            ...publicDevice(st.device),
            status: st.status,
            lastSeen: st.lastSeen,
            lastPoll: st.lastPoll,
            product: d ? d.product : null,
            uptimeSec: d ? d.uptimeSec : null,
            metrics: d ? {
                state: d.system.state,
                powerSource: d.system.powerSource,
                mainsOk: d.system.mainsOk,
                acVoltage: d.rectifier.acVoltage,
                busVoltage: d.system.busVoltage,
                loadPower: d.system.loadPower,
                loadPct: d.system.loadPct,
                soc: d.battery.soc,
                battVoltage: d.battery.voltage,
                battCurrent: d.battery.current,
                battState: d.battery.state,
                backupHours: d.system.backupHours,
                backupBasis: d.system.backupBasis
            } : null,
            alarmCounts: countBySeverity(active),
            topAlarm: active[0] || null
        };
    }

    detail(id) {
        const st = this.states.get(id);
        if (!st) return null;
        return {
            ...this.summary(id),
            failures: st.failures,
            lastError: st.lastError,
            pollStats: st.pollStats,
            data: st.data,
            raw: st.raw,
            rawAt: st.rawAt,
            controlLog: st.controlLog,
            alarms: this.alarms.activeFor(id)
        };
    }

    historyFor(id, hours) {
        const series = this.history.get(id);
        if (!series) return null;
        const cutoff = Date.now() - hours * 3600e3;
        return series.filter(p => p.t >= cutoff);
    }
}

// Never send the SNMP community string to the browser.
function publicDevice(d) {
    return {
        id: d.id, name: d.name, ip: d.ip, port: d.port, lat: d.lat, lng: d.lng,
        hasCommunity: !!d.community, hasWriteCommunity: !!d.writeCommunity
    };
}

module.exports = { Monitor, publicDevice };
