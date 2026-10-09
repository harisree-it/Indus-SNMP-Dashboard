// Fleet overview: KPIs, map, fleet load, site table and alarm log.

const REFRESH_MS = 5000;
const SEV_RANK = { critical: 0, major: 1, minor: 2 };

let sites = [];
let alarms = { active: [], log: [] };
let meta = { ratings: { rectifierWatts: 300 }, thresholds: { socWarn: 35, socCritical: 20, loadWarnPct: 90, loadCriticalPct: 100 } };
let alarmView = 'active';
let map = null;
let tiles = null;
const markers = new Map();
let fittedKey = '';

const KPIS = [
    { id: 'k-total', title: 'Sites', icon: 'server', tone: 'blue', label: 'Configured', subs: [['on', 'Online'], ['off', 'Offline']] },
    { id: 'k-online', title: 'Online', icon: 'checkmark-circle', tone: 'green', label: 'Responding to SNMP', subs: [['conn', 'Connecting']] },
    { id: 'k-offline', title: 'Offline', icon: 'cloud-offline', tone: 'red', label: 'No SNMP response', subs: [['since', 'Longest down']] },
    { id: 'k-batt', title: 'On Battery', icon: 'battery-half', tone: 'orange', label: 'Mains failure', subs: [['soc', 'Lowest SOC'], ['bk', 'Min backup']] },
    { id: 'k-alarms', title: 'Active Alarms', icon: 'warning', tone: 'red', label: 'Across all sites', subs: [['crit', 'Critical'], ['maj', 'Major'], ['min', 'Minor']] }
];

document.addEventListener('DOMContentLoaded', async () => {
    meta = await App.applyBranding('Fleet overview');
    if (meta.demo) document.getElementById('demo-banner').classList.remove('hidden');
    document.getElementById('p-rated').textContent = meta.ratings.rectifierWatts;

    App.renderStats(document.getElementById('kpi-stats'), KPIS);
    initMap();
    initDialogs();
    document.getElementById('search').addEventListener('input', renderSites);
    document.querySelectorAll('[data-alarm-view]').forEach(b => b.addEventListener('click', () => {
        alarmView = b.dataset.alarmView;
        document.querySelectorAll('[data-alarm-view]').forEach(x => {
            x.classList.toggle('active', x === b);
            x.setAttribute('aria-selected', x === b);
        });
        renderAlarms();
    }));
    window.addEventListener('hashchange', markNav);

    await refresh();
    setInterval(refresh, REFRESH_MS);
});

async function refresh() {
    try {
        [sites, alarms] = await Promise.all([App.api('/devices'), App.api('/alarms?limit=200')]);
        render();
    } catch (err) {
        if (err.message !== 'Login required') App.toast(`Dashboard server unreachable: ${err.message}`, 'error');
    }
}

function render() {
    renderKpis();
    renderPower();
    renderSites();
    renderAlarms();
    renderMap();
}

function siteLevel(s) {
    if (s.status !== 'online') return 'offline';
    const c = s.alarmCounts;
    return c.critical ? 'critical' : c.major ? 'major' : c.minor ? 'minor' : 'ok';
}

// ---------------- KPIs & header ----------------
function renderKpis() {
    const online = sites.filter(s => s.status === 'online');
    const offline = sites.filter(s => s.status === 'offline');
    const connecting = sites.filter(s => s.status === 'connecting').length;
    const onBatt = online.filter(s => s.metrics && s.metrics.powerSource === 'battery');
    const c = { critical: 0, major: 0, minor: 0 };
    alarms.active.forEach(a => c[a.severity]++);

    App.setStat('k-total', { value: sites.length, subs: { on: online.length, off: offline.length } });
    App.setStat('k-online', { value: online.length, label: sites.length && online.length === sites.length ? 'All sites reachable' : 'Responding to SNMP', subs: { conn: connecting } });
    const longest = offline.filter(s => s.lastSeen).sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
    App.setStat('k-offline', { value: offline.length, subs: { since: offline.length ? (longest ? App.ago(longest.lastSeen).replace(' ago', '') : 'never seen') : '--' } });
    const lowest = onBatt.filter(s => App.isNum(s.metrics.soc)).sort((a, b) => a.metrics.soc - b.metrics.soc)[0];
    const minBk = onBatt.filter(s => App.isNum(s.metrics.backupHours)).sort((a, b) => a.metrics.backupHours - b.metrics.backupHours)[0];
    App.setStat('k-batt', { value: onBatt.length, subs: { soc: lowest ? `${lowest.metrics.soc} %` : '--', bk: minBk ? App.hours(minBk.metrics.backupHours) : '--' } });
    App.setStat('k-alarms', { value: alarms.active.length, subs: { crit: c.critical, maj: c.major, min: c.minor } });

    // header + sidebar summary (CAN GUI style)
    set('h-update', `Last Update: ${new Date().toLocaleTimeString([], { hour12: false })}`);
    const conn = document.getElementById('h-conn');
    const level = !sites.length ? 'wait' : offline.length ? 'bad' : connecting ? 'wait' : 'ok';
    conn.className = `conn ${level}`;
    conn.querySelector('.dot').className = `dot ${level === 'ok' ? 'ok' : level === 'bad' ? 'bad' : ''}`;
    set('h-conn-t', sites.length ? `${online.length}/${sites.length} Online` : 'No sites');
    set('page-sub', `${sites.length} site${sites.length === 1 ? '' : 's'} · ${online.length} online · ${alarms.active.length} active alarm${alarms.active.length === 1 ? '' : 's'}`);
    const badge = document.getElementById('nav-alarm-count');
    badge.classList.toggle('hidden', !alarms.active.length);
    badge.textContent = alarms.active.length;
    document.getElementById('side-status').innerHTML = `
        <div class="row"><span class="dot ok"></span><span>Online</span><span>${online.length}</span></div>
        <div class="row"><span class="dot bad"></span><span>Offline</span><span>${offline.length}</span></div>
        <div class="row"><span class="dot warn"></span><span>On battery</span><span>${onBatt.length}</span></div>
        <div>SNMP v2c · polling every ${Math.round((meta.pollIntervalMs || 5000) / 1000)} s</div>`;
}

// ---------------- Fleet load ----------------
function renderPower() {
    const rated = meta.ratings.rectifierWatts;
    const online = sites.filter(s => s.status === 'online' && s.metrics);
    const total = online.reduce((a, s) => a + (s.metrics.loadPower || 0), 0);
    set('p-total', online.length ? App.int(total) : '--');
    set('p-sub', online.length ? `across ${online.length} online site${online.length === 1 ? '' : 's'} · ${App.int(online.length * rated)} W installed rectifier capacity` : 'no sites online');

    const bars = online.filter(s => App.isNum(s.metrics.loadPower)).sort((a, b) => b.metrics.loadPower - a.metrics.loadPower);
    const shown = bars.slice(0, 8);
    const scaleMax = Math.max(rated, ...shown.map(s => s.metrics.loadPower));
    const el = document.getElementById('p-bars');
    el.innerHTML = shown.length ? shown.map(s => {
        const w = s.metrics.loadPower / scaleMax * 100;
        const label = `${s.name}: ${App.int(s.metrics.loadPower)} W, ${App.int(s.metrics.loadPct)}% of ${rated} W`;
        return `<a class="bar-row" href="system.html?id=${encodeURIComponent(s.id)}" title="${App.esc(label)}" aria-label="${App.esc(label)}" style="text-decoration:none;color:inherit">
            <span class="name">${App.esc(s.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${w.toFixed(1)}%"></span></span>
            <span class="val">${App.int(s.metrics.loadPower)} W</span></a>`;
    }).join('') + `<div class="bar-axis"><div></div><div><span>0</span><span>${App.int(scaleMax / 2)}</span><span>${App.int(scaleMax)} W</span></div><div></div></div>`
        + (bars.length > shown.length ? `<div class="muted" style="font-size:12px">+ ${bars.length - shown.length} more sites in the table below</div>` : '')
        : '<div class="muted" style="font-size:12.5px">No live load readings yet.</div>';

    const withSoc = online.filter(s => App.isNum(s.metrics.soc));
    if (withSoc.length) {
        const avg = withSoc.reduce((a, s) => a + s.metrics.soc, 0) / withSoc.length;
        const min = withSoc.reduce((a, s) => (s.metrics.soc < a.metrics.soc ? s : a));
        set('p-avgsoc', `${Math.round(avg)}%`);
        document.getElementById('p-minsoc').innerHTML = `${min.metrics.soc}% <small>${App.esc(min.name)}</small>`;
    } else {
        set('p-avgsoc', '--'); set('p-minsoc', '--');
    }
    const withBackup = online.filter(s => App.isNum(s.metrics.backupHours));
    if (withBackup.length) {
        const min = withBackup.reduce((a, s) => (s.metrics.backupHours < a.metrics.backupHours ? s : a));
        document.getElementById('p-backup').innerHTML = `${App.hours(min.metrics.backupHours)} <small>${App.esc(min.name)}</small>`;
    } else {
        set('p-backup', '--');
    }
    const known = online.filter(s => s.metrics.mainsOk !== null);
    set('p-mains', known.length ? `${known.filter(s => s.metrics.mainsOk).length} of ${known.length} sites` : '--');
}

// ---------------- Sites table ----------------
function renderSites() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const list = sites
        .filter(s => !q || s.name.toLowerCase().includes(q) || s.ip.toLowerCase().includes(q))
        .sort((a, b) => levelRank(a) - levelRank(b) || a.name.localeCompare(b.name));
    set('sites-count', q ? `${list.length} of ${sites.length}` : `${sites.length} total`);
    const th = meta.thresholds;
    const rated = meta.ratings.rectifierWatts;

    const body = document.getElementById('sites-body');
    if (!list.length) {
        body.innerHTML = `<tr><td colspan="9" class="empty">${sites.length ? 'No sites match your search.' : 'No sites yet - use <b>Add site</b> to start monitoring a Mini SMPS.'}</td></tr>`;
        return;
    }
    body.innerHTML = list.map(s => {
        const m = s.status === 'online' ? s.metrics : null;
        const c = s.alarmCounts;
        const counts = c.critical + c.major + c.minor
            ? `<span class="counts">${['critical', 'major', 'minor'].filter(k => c[k]).map(k =>
                `<span class="count-pill sev-${k}" title="${c[k]} ${k}"><ion-icon name="${App.SEVERITY[k].icon}"></ion-icon>${c[k]}</span>`).join('')}</span>`
            : '<span class="muted">None</span>';
        const battery = m && App.isNum(m.soc)
            ? `<span class="num" style="display:inline-block;width:38px">${m.soc}%</span>${App.meter(m.soc, App.meterClass(m.soc, th.socWarn, th.socCritical, true)).replace('class="meter', 'class="meter inline')}
               <div class="site-addr num">${App.num(m.battVoltage, 1)} V · ${m.battState}</div>`
            : '<span class="muted">--</span>';
        const load = m && App.isNum(m.loadPower)
            ? `${App.int(m.loadPower)} W<div class="site-addr">${App.int(m.loadPct)}% of ${rated} W</div>` : '<span class="muted">--</span>';
        const backup = m && App.isNum(m.backupHours)
            ? `${App.hours(m.backupHours)}<div class="site-addr">${m.backupBasis === 'discharge' ? 'on battery now' : 'at current load'}</div>` : '<span class="muted">--</span>';
        return `<tr class="clickable" data-id="${App.esc(s.id)}">
            <td><div class="site-name">${App.esc(s.name)}</div><div class="site-addr mono">${App.esc(s.ip)}:${s.port || 161}</div></td>
            <td>${App.statusBadge(s.status)}</td>
            <td>${m ? App.sourceBadge(m) : '<span class="muted">--</span>'}</td>
            <td>${battery}</td>
            <td class="num">${load}</td>
            <td class="num">${backup}</td>
            <td>${counts}${s.topAlarm ? `<div class="site-addr">${App.esc(s.topAlarm.message)}</div>` : ''}</td>
            <td class="num">${App.ago(s.lastSeen)}</td>
            <td><div class="actions">
                <button class="icon-btn" data-edit="${App.esc(s.id)}" title="Edit site" aria-label="Edit ${App.esc(s.name)}"><ion-icon name="create-outline"></ion-icon></button>
                <button class="icon-btn" data-delete="${App.esc(s.id)}" title="Remove site" aria-label="Remove ${App.esc(s.name)}"><ion-icon name="trash-outline"></ion-icon></button>
                <a class="icon-btn" href="system.html?id=${encodeURIComponent(s.id)}" title="Open site" aria-label="Open ${App.esc(s.name)}"><ion-icon name="chevron-forward"></ion-icon></a>
            </div></td>
        </tr>`;
    }).join('');
}

function levelRank(s) {
    return { critical: 0, offline: 1, major: 2, minor: 3, ok: 4 }[siteLevel(s)];
}

// ---------------- Alarms ----------------
function renderAlarms() {
    const rows = alarmView === 'active' ? alarms.active : alarms.log;
    const body = document.getElementById('alarms-body');
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="6" class="empty">${alarmView === 'active'
            ? '<ion-icon name="checkmark-circle" style="color:var(--good);vertical-align:-3px"></ion-icon> No active alarms across the fleet.'
            : 'No alarm events recorded yet.'}</td></tr>`;
        return;
    }
    body.innerHTML = rows.map(a => {
        const state = a.clearedAt
            ? `<span class="muted">Cleared after ${App.duration((new Date(a.clearedAt) - new Date(a.raisedAt)) / 1000)}</span>`
            : `<b>Active</b> <span class="muted">${App.duration((Date.now() - new Date(a.raisedAt)) / 1000)}</span>`;
        return `<tr class="clickable" data-site="${App.esc(a.deviceId)}">
            <td>${App.sevBadge(a.severity)}</td>
            <td>${App.esc(a.site)}</td>
            <td><b>${App.esc(a.message)}</b></td>
            <td class="muted">${App.esc(a.detail)}</td>
            <td class="num">${App.dateTime(a.raisedAt)}</td>
            <td>${state}</td>
        </tr>`;
    }).join('');
}

// ---------------- Map ----------------
function initMap() {
    const el = document.getElementById('map');
    if (typeof L === 'undefined') {
        el.innerHTML = '<div class="empty">Map library could not be loaded (no internet access?).</div>';
        return;
    }
    const cfg = meta.map || { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 };
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([21.5, 79], 4.4);
    map.attributionControl.setPrefix(false);
    tiles = L.tileLayer(cfg.tileUrl, { maxZoom: cfg.maxZoom || 19, attribution: cfg.attribution }).addTo(map);
    const applyTheme = () => el.classList.toggle('tiles-dark', App.currentTheme() === 'dark');
    applyTheme();
    window.addEventListener('themechange', applyTheme);
    new ResizeObserver(() => map.invalidateSize()).observe(el);
}

function renderMap() {
    if (!map) return;
    const seen = new Set();
    for (const s of sites) {
        if (!App.isNum(s.lat) || !App.isNum(s.lng)) continue;
        seen.add(s.id);
        const level = siteLevel(s);
        const html = `<div style="display:grid;place-items:center;width:24px;height:24px"><i class="map-pin ${level}${level === 'critical' ? ' pulse' : ''}"></i></div>`;
        const statusText = s.status === 'online'
            ? (s.topAlarm ? `${App.SEVERITY[s.topAlarm.severity].label}: ${s.topAlarm.message}` : 'Normal')
            : App.statusBadge(s.status).replace(/<[^>]+>/g, '');
        const tip = `<b>${App.esc(s.name)}</b><br>${App.esc(statusText)}${s.metrics && s.status === 'online'
            ? `<br>SOC ${s.metrics.soc ?? '--'}% · Load ${App.int(s.metrics.loadPower)} W` : ''}`;
        let mk = markers.get(s.id);
        if (!mk) {
            mk = L.marker([s.lat, s.lng], { keyboard: true, title: s.name });
            mk.on('click', () => { location.href = `system.html?id=${encodeURIComponent(s.id)}`; });
            mk.addTo(map);
            markers.set(s.id, mk);
        }
        mk.setLatLng([s.lat, s.lng]);
        mk.setIcon(L.divIcon({ className: '', html, iconSize: [24, 24], iconAnchor: [12, 12] }));
        mk.bindTooltip(tip, { direction: 'top', offset: [0, -8] });
    }
    for (const [id, mk] of markers) {
        if (!seen.has(id)) { map.removeLayer(mk); markers.delete(id); }
    }
    // Fit to the sites once (and again when the site set changes) - never while the user is browsing.
    const key = [...seen].sort().join('|');
    if (key && key !== fittedKey) {
        fittedKey = key;
        const pts = sites.filter(s => seen.has(s.id)).map(s => [s.lat, s.lng]);
        if (pts.length === 1) map.setView(pts[0], 9);
        else map.fitBounds(pts, { padding: [40, 40], maxZoom: 9 });
    }
}

// ---------------- Menus & dialogs ----------------
function markNav() {
    const h = location.hash || '#top';
    document.querySelectorAll('.sidenav a.nav-item').forEach(a => a.classList.toggle('active', a.getAttribute('href') === h));
}

let editingId = null;
let deletingId = null;

function initDialogs() {
    const dlg = document.getElementById('site-dialog');
    const form = document.getElementById('site-form');
    const confirmDlg = document.getElementById('confirm-dialog');

    document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    document.getElementById('add-site').addEventListener('click', () => openSiteDialog(null));

    document.getElementById('sites-body').addEventListener('click', e => {
        const edit = e.target.closest('[data-edit]');
        const del = e.target.closest('[data-delete]');
        if (edit) { e.stopPropagation(); openSiteDialog(edit.dataset.edit); return; }
        if (del) { e.stopPropagation(); openDelete(del.dataset.delete); return; }
        if (e.target.closest('a')) return;
        const row = e.target.closest('tr[data-id]');
        if (row) location.href = `system.html?id=${encodeURIComponent(row.dataset.id)}`;
    });
    document.getElementById('alarms-body').addEventListener('click', e => {
        const row = e.target.closest('tr[data-site]');
        if (row && sites.some(s => s.id === row.dataset.site)) location.href = `system.html?id=${encodeURIComponent(row.dataset.site)}`;
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const err = document.getElementById('site-error');
        err.classList.add('hidden');
        const body = {
            name: form.name.value.trim(),
            ip: form.ip.value.trim(),
            port: form.port.value.trim() || null,
            lat: form.lat.value.trim() || null,
            lng: form.lng.value.trim() || null
        };
        // blank on edit = keep the stored value
        for (const key of ['community', 'writeCommunity']) {
            const v = form[key].value.trim();
            if (v || !editingId) body[key] = v || null;
        }
        const save = document.getElementById('site-save');
        save.disabled = true;
        try {
            if (editingId) await App.api(`/devices/${encodeURIComponent(editingId)}`, { method: 'PATCH', body });
            else await App.api('/devices', { method: 'POST', body });
            dlg.close();
            App.toast(editingId ? `Updated ${body.name}` : `Added ${body.name} - polling started`);
            refresh();
        } catch (ex) {
            err.textContent = ex.message;
            err.classList.remove('hidden');
        } finally {
            save.disabled = false;
        }
    });

    document.getElementById('confirm-ok').addEventListener('click', async () => {
        const s = sites.find(x => x.id === deletingId);
        try {
            await App.api(`/devices/${encodeURIComponent(deletingId)}`, { method: 'DELETE' });
            App.toast(`Removed ${s ? s.name : 'site'}`);
            confirmDlg.close();
            refresh();
        } catch (ex) {
            App.toast(ex.message, 'error');
        }
    });
}

function openSiteDialog(id) {
    editingId = id;
    const s = id ? sites.find(x => x.id === id) : null;
    const form = document.getElementById('site-form');
    form.reset();
    document.getElementById('site-error').classList.add('hidden');
    document.getElementById('site-dialog-title').textContent = s ? `Edit ${s.name}` : 'Add site';
    document.getElementById('site-save').textContent = s ? 'Save changes' : 'Add site';
    document.getElementById('f-community-hint').textContent = s
        ? `Read: ${s.hasCommunity ? 'custom' : 'default'} · Write: ${s.hasWriteCommunity ? 'custom' : 'default'}. Leave blank to keep the current value.`
        : 'Leave blank to use the defaults from config.js. The write community is only used for relay and eFuse commands.';
    if (s) {
        form.name.value = s.name;
        form.ip.value = s.ip;
        form.port.value = s.port || '';
        form.lat.value = s.lat ?? '';
        form.lng.value = s.lng ?? '';
    }
    document.getElementById('site-dialog').showModal();
    form.name.focus();
}

function openDelete(id) {
    deletingId = id;
    const s = sites.find(x => x.id === id);
    document.getElementById('confirm-text').textContent =
        `${s ? s.name : 'This site'} (${s ? s.ip : ''}) will stop being polled and its trend history will be discarded.`;
    document.getElementById('confirm-dialog').showModal();
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
