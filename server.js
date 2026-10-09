// Mini SMPS SNMP dashboard - backend.
//   npm start        -> monitor the sites in data/devices.json
//   npm run demo     -> start simulated agents and monitor them (data/devices.demo.json)

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const { DeviceStore } = require('./lib/store');
const { Monitor, publicDevice } = require('./lib/monitor');
const { OIDS, WRITABLE } = require('./lib/oids');
const pkg = require('./package.json');

const DEMO = process.argv.includes('--demo');

const DEMO_SITES = [
    { name: 'Chennai - Site 101', ip: '127.0.0.1', port: 16101, lat: 13.0827, lng: 80.2707, profile: 'normal' },
    { name: 'Mumbai - Site 214', ip: '127.0.0.1', port: 16102, lat: 19.0760, lng: 72.8777, profile: 'outage' },
    { name: 'Delhi - Site 307', ip: '127.0.0.1', port: 16103, lat: 28.6139, lng: 77.2090, profile: 'fault' },
    { name: 'Bengaluru - Site 412', ip: '127.0.0.1', port: 16104, lat: 12.9716, lng: 77.5946, profile: null } // no agent -> offline
];

if (DEMO) {
    config.history.sampleEveryMs = 5000; // fill the trend charts quickly
    const { startAgents } = require('./tools/mock-agent');
    startAgents(DEMO_SITES.filter(s => s.profile).map(s => ({ port: s.port, profile: s.profile, name: s.name })));
}

const store = new DeviceStore(
    path.join(__dirname, 'data', DEMO ? 'devices.demo.json' : 'devices.json'),
    DEMO ? DEMO_SITES.map(({ profile, ...d }) => d) : config.defaultDevices
);
const monitor = new Monitor(config);
store.list().forEach(d => monitor.track(d));

// ---------------- Auth ----------------
// Session tokens live in memory; a server restart simply asks users to log in again.
const sessions = new Map(); // token -> expiry ms

function digest(s) {
    return crypto.createHash('sha256').update(String(s)).digest();
}

function checkCredentials(user, pass) {
    const u = crypto.timingSafeEqual(digest(user), digest(config.auth.username));
    const p = crypto.timingSafeEqual(digest(pass), digest(config.auth.password));
    return u && p;
}

function requireAuth(req, res, next) {
    const m = /^Bearer (\w+)$/.exec(req.get('authorization') || '');
    const exp = m && sessions.get(m[1]);
    if (!exp || exp < Date.now()) {
        if (m) sessions.delete(m[1]);
        return res.status(401).json({ error: 'Login required' });
    }
    next();
}

// ---------------- App ----------------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/meta', (req, res) => {
    res.json({
        branding: config.branding, ratings: config.ratings, thresholds: config.thresholds, map: config.map,
        sampleEveryMs: config.history.sampleEveryMs, pollIntervalMs: config.snmp.pollIntervalMs, version: pkg.version, demo: DEMO
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || !checkCredentials(username, password)) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, now + config.auth.sessionHours * 3600e3);
    res.json({ token, user: config.auth.username });
});

app.use('/api', requireAuth);

app.post('/api/logout', (req, res) => {
    sessions.delete(req.get('authorization').slice(7));
    res.json({ ok: true });
});

app.get('/api/devices', (req, res) => {
    res.json(store.list().map(d => monitor.summary(d.id)).filter(Boolean));
});

app.post('/api/devices', (req, res) => {
    const { device, errors } = store.add(req.body || {});
    if (errors) return res.status(400).json({ error: errors.join('; ') });
    monitor.track(device);
    res.status(201).json(publicDevice(device));
});

app.get('/api/devices/:id', (req, res) => {
    const detail = monitor.detail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Site not found' });
    res.json({
        ...detail, thresholds: config.thresholds, ratings: config.ratings, oids: OIDS,
        controlsEnabled: !!config.snmp.controlsEnabled, writable: Object.keys(WRITABLE)
    });
});

app.patch('/api/devices/:id', (req, res) => {
    const { device, errors, notFound } = store.update(req.params.id, req.body || {});
    if (notFound) return res.status(404).json({ error: 'Site not found' });
    if (errors) return res.status(400).json({ error: errors.join('; ') });
    monitor.retarget(device);
    res.json(publicDevice(device));
});

app.delete('/api/devices/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'Site not found' });
    monitor.untrack(req.params.id);
    res.json({ ok: true });
});

// SNMP SET for relays and eFuse resets: { key: 'relay1State', value: 1 }
app.post('/api/devices/:id/set', async (req, res) => {
    if (!config.snmp.controlsEnabled) return res.status(403).json({ error: 'Controls are disabled in config.js (snmp.controlsEnabled)' });
    const { key, value } = req.body || {};
    try {
        await monitor.setValue(req.params.id, String(key), Number(value));
        res.json({ ok: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.get('/api/devices/:id/history', (req, res) => {
    const hours = Math.min(config.history.keepHours, Math.max(0.1, Number(req.query.hours) || 1));
    const points = monitor.historyFor(req.params.id, hours);
    if (!points) return res.status(404).json({ error: 'Site not found' });
    res.json({ hours, sampleEveryMs: config.history.sampleEveryMs, points });
});

app.get('/api/alarms', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const deviceId = req.query.device || null;
    res.json({
        active: deviceId ? monitor.alarms.activeFor(deviceId) : monitor.alarms.allActive(),
        log: monitor.alarms.logFor(deviceId, limit)
    });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.server.port, config.server.host, () => {
    console.log(`${config.branding.product} dashboard ${DEMO ? '(DEMO) ' : ''}on http://localhost:${config.server.port}`);
    console.log(`Monitoring ${store.list().length} site(s): ${store.list().map(d => `${d.name} (${d.ip}:${d.port || config.snmp.port})`).join(', ')}`);
    if (config.auth.password === 'Delta@123' && !DEMO) {
        console.warn('WARNING: default dashboard password in use - set DASH_PASS or edit config.js before deploying.');
    }
});
