// One SNMP poll cycle against one site.
// OIDs are fetched in batches; the first batch is the reachability probe. A batch the agent
// rejects (tooBig / genErr) is retried one OID at a time, and OIDs the agent does not
// implement (noSuchObject) are simply skipped.

const snmp = require('net-snmp');
const { OIDS } = require('./oids');

const KEYS = Object.keys(OIDS);
const KEY_BY_OID = Object.fromEntries(KEYS.map(k => [OIDS[k], k]));

function get(session, oids) {
    return new Promise((resolve, reject) => {
        session.get(oids, (err, varbinds) => (err ? reject(err) : resolve(varbinds)));
    });
}

function absorb(raw, varbinds) {
    let n = 0;
    for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue;
        const key = KEY_BY_OID[vb.oid];
        if (!key) continue;
        let v = vb.value;
        if (Buffer.isBuffer(v)) v = v.toString('utf8').replace(/\0+$/, '').trim();
        raw[key] = v;
        n++;
    }
    return n;
}

async function pollOnce(device, opts) {
    const started = Date.now();
    const session = snmp.createSession(device.ip, device.community || opts.readCommunity, {
        port: device.port || opts.port,
        timeout: opts.timeoutMs,
        retries: opts.retries,
        version: snmp.Version2c
    });
    session.on('error', () => { /* socket errors surface through the request callback */ });

    const raw = {};
    let answered = 0;
    let reachable = false;
    let timeouts = 0;
    let lastError = null;

    try {
        for (let i = 0; i < KEYS.length; i += opts.batchSize) {
            const batch = KEYS.slice(i, i + opts.batchSize);
            try {
                answered += absorb(raw, await get(session, batch.map(k => OIDS[k])));
                reachable = true;
            } catch (err) {
                lastError = err.message;
                if (!(err instanceof snmp.RequestFailedError)) {
                    // timeout / network error: give up on an unreachable site, tolerate one blip otherwise
                    if (!reachable || ++timeouts >= 2) break;
                    continue;
                }
                reachable = true; // the agent answered, it just refused the batch
                for (const key of batch) {
                    try {
                        answered += absorb(raw, await get(session, [OIDS[key]]));
                    } catch (e) {
                        if (!(e instanceof snmp.RequestFailedError) && ++timeouts >= 2) break;
                    }
                }
                if (timeouts >= 2) break;
            }
        }
    } finally {
        session.close();
    }

    return { reachable, raw, answered, total: KEYS.length, durationMs: Date.now() - started, error: reachable ? null : lastError };
}

// SET one INTEGER object (relay state, eFuse reset). Agents usually ignore a wrong community
// rather than reject it, so a write-community mistake shows up as a timeout.
function setOnce(device, community, oid, value, opts) {
    const session = snmp.createSession(device.ip, community, {
        port: device.port || opts.port,
        timeout: opts.timeoutMs * 2,
        retries: 0,
        version: snmp.Version2c
    });
    session.on('error', () => { });
    return new Promise((resolve, reject) => {
        session.set([{ oid, type: snmp.ObjectType.Integer, value }], (err, varbinds) => {
            session.close();
            if (err instanceof snmp.RequestTimedOutError) return reject(new Error('No response - check the write community and that the object is writable'));
            if (err) return reject(err);
            if (snmp.isVarbindError(varbinds[0])) return reject(new Error(snmp.varbindError(varbinds[0])));
            resolve();
        });
    });
}

module.exports = { pollOnce, setOnce };
