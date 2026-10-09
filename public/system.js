// Site view for one Mini SMPS. The Dashboard tab follows the Power Smart CAN GUI layout:
// stat cards, system overview / status / alarms, trend charts, range + auto-refresh footer.

const siteId = new URLSearchParams(location.search).get('id');
const REFRESH_MS = 3000;
const HISTORY_MS = 30000;

const STATS = {
    overview: [
        { id: 'ov-ac', title: 'AC Input', icon: 'pulse', tone: 'blue', unit: 'V', label: 'Voltage', subs: [['st', 'Status'], ['bus', 'PFC Bus']] },
        { id: 'ov-dc', title: 'DC Output', icon: 'flash', tone: 'green', unit: 'V', label: 'Voltage', subs: [['i', 'Current'], ['p', 'Inst Power']] },
        { id: 'ov-load', title: 'Load', icon: 'bar-chart', tone: 'orange', unit: '%', label: 'Percentage', meter: true, subs: [['p', 'Inst Power'], ['max', 'Max Power']] },
        { id: 'ov-bt', title: 'Battery', icon: 'battery-charging', tone: 'green', unit: 'V', label: 'Voltage', subs: [['i', 'Current'], ['soc', 'SOC'], ['bk', 'Backup']] },
        { id: 'ov-tp', title: 'Temperature', icon: 'thermometer', tone: 'orange', unit: '°C', label: 'Heatsink', subs: [['st', 'Status'], ['bt', 'Battery']] }
    ],
    battery: [
        { id: 'bt-v', title: 'Pack Voltage', icon: 'flash', tone: 'green', unit: 'V', label: '--' },
        { id: 'bt-i', title: 'Current', icon: 'swap-vertical', tone: 'blue', unit: 'A', label: '--' },
        { id: 'bt-soc', title: 'State of Charge', icon: 'battery-half', tone: 'green', unit: '%', label: 'Remaining charge', meter: true },
        { id: 'bt-rem', title: 'Remaining', icon: 'layers', tone: 'purple', unit: 'Ah', label: '--' },
        { id: 'bt-cyc', title: 'Cycles', icon: 'repeat', tone: 'cyan', unit: '', label: 'Discharge cycles' }
    ],
    rectifier: [
        { id: 'rc-ac', title: 'AC Input', icon: 'pulse', tone: 'blue', unit: 'V', label: '--' },
        { id: 'rc-dcv', title: 'DC Output', icon: 'flash', tone: 'green', unit: 'V', label: 'Output voltage' },
        { id: 'rc-dci', title: 'DC Current', icon: 'trending-up', tone: 'green', unit: 'A', label: 'Load + battery charge' },
        { id: 'rc-p', title: 'Output Power', icon: 'speedometer', tone: 'orange', unit: 'W', label: '--', meter: true },
        { id: 'rc-bus', title: 'PFC Bus', icon: 'git-commit', tone: 'purple', unit: 'V', label: 'Internal DC link' }
    ]
};

STATS.energy = [
    { id: 'en-load', title: 'Load Energy', icon: 'flash', tone: 'orange', unit: 'Wh', label: 'All outputs · lifetime counter' },
    { id: 'en-batt', title: 'Battery Energy', icon: 'battery-charging', tone: 'green', unit: 'Wh', label: 'Battery energy counter' },
    { id: 'en-in', title: 'Rectifier Input', icon: 'pulse', tone: 'blue', unit: 'Wh', label: 'AC energy in' },
    { id: 'en-out', title: 'Rectifier Output', icon: 'flash-outline', tone: 'green', unit: 'Wh', label: 'DC energy out' },
    { id: 'en-eff', title: 'Efficiency', icon: 'speedometer', tone: 'purple', unit: '%', label: 'Output / input energy' }
];
const LOADS = 3;
const RELAYS = 2;

// The first three trends are the CAN GUI's; the second row adds what SNMP history makes possible.
const TRENDS = {
    main: [
        { key: 'dcV', title: 'Voltage Trend (DC Output)', unit: 'V', decimals: 1, minSpan: 2, tone: 'blue' },
        { key: 'loadA', title: 'Current Trend (DC Output)', unit: 'A', decimals: 1, zero: true, minSpan: 2, tone: 'green' },
        { key: 'temp', title: 'Temperature Trend', unit: '°C', decimals: 0, minSpan: 10, tone: 'orange' }
    ],
    more: [
        { key: 'soc', title: 'Battery SOC', unit: '%', decimals: 0, min: 0, max: 100, tone: 'purple' },
        { key: 'acV', title: 'AC Input Voltage', unit: 'V', decimals: 0, zero: true, minSpan: 50, tone: 'cyan' },
        { key: 'battI', title: 'Battery Current (+chg / −dsg)', unit: 'A', decimals: 1, zero: true, minSpan: 2, tone: 'blue' }
    ]
};

const STATE = {
    running: { label: 'Running', tone: 'green' },
    'on-battery': { label: 'On Battery', tone: 'orange' },
    fault: { label: 'Fault', tone: 'red' },
    standby: { label: 'Standby', tone: 'orange' }
};
const SOURCE = {
    mains: { label: 'AC Grid', tone: 'blue' },
    battery: { label: 'Battery', tone: 'green' },
    none: { label: 'None', tone: 'red' },
    unknown: { label: 'Unknown', tone: '' }
};
const BATT_STATE = { charging: 'Charging', discharging: 'Discharging', idle: 'Idle / float' };

let site = null;
let siteLog = [];
let meta = null;
let range = 1;
let trend = [];
let autoRefresh = true;
let rec = null;
const charts = {};

document.addEventListener('DOMContentLoaded', async () => {
    if (!siteId) { location.href = 'index.html'; return; }
    meta = await App.applyBranding();
    set('sample-s', Math.round((meta.sampleEveryMs || 30000) / 1000));

    App.renderStats(document.getElementById('ov-stats'), STATS.overview);
    App.renderStats(document.getElementById('bt-stats'), STATS.battery);
    App.renderStats(document.getElementById('rc-stats'), STATS.rectifier);
    App.renderStats(document.getElementById('en-stats'), STATS.energy);
    initControl();
    initTabs();
    initTrends();
    initRecorder();
    document.getElementById('auto-refresh').addEventListener('change', e => {
        autoRefresh = e.target.checked;
        if (autoRefresh) { refresh(); loadHistory(); }
    });

    await refresh();
    setInterval(() => autoRefresh && refresh(), REFRESH_MS);
    loadHistory();
    setInterval(() => autoRefresh && loadHistory(), HISTORY_MS);
});

async function refresh() {
    try {
        const [detail, alarms] = await Promise.all([
            App.api(`/devices/${encodeURIComponent(siteId)}`),
            App.api(`/alarms?device=${encodeURIComponent(siteId)}&limit=200`)
        ]);
        site = detail;
        siteLog = alarms.log;
        render();
        recordTick();
    } catch (err) {
        if (err.message === 'Site not found') return notFound();
        if (err.message !== 'Login required') App.toast(`Dashboard server unreachable: ${err.message}`, 'error');
    }
}

function notFound() {
    set('site-name', 'Site not found');
    set('site-sub', 'It may have been removed from the fleet.');
    document.getElementById('stale-banner').classList.remove('hidden');
    document.getElementById('stale-text').innerHTML = 'This site no longer exists. <a href="index.html">Back to all sites</a>';
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
}

function render() {
    renderHeader();
    renderSidebar();
    renderOverview();
    renderBattery();
    renderRectifier();
    renderControl();
    renderAlarms();
    renderDiagnostics();
}

// ---------------- Header & sidebar ----------------
function renderHeader() {
    const d = site.data;
    const p = d ? d.product : {};
    set('site-name', site.name);
    document.title = `${site.name} · ${meta.branding.product || 'Mini SMPS'}`;
    set('site-sub', [p.name, `${site.ip}:${site.port || 161}`, d && `uptime ${App.duration(d.uptimeSec)}`].filter(Boolean).join(' · '));
    set('h-site', site.name);
    set('h-fw', `Firmware ${p.version || '--'}`);
    set('h-update', `Last Update: ${site.lastSeen ? new Date(site.lastSeen).toLocaleTimeString([], { hour12: false }) : '--:--:--'}`);

    const conn = document.getElementById('h-conn');
    conn.className = `conn ${site.status === 'online' ? 'ok' : site.status === 'offline' ? 'bad' : 'wait'}`;
    conn.querySelector('.dot').className = `dot ${site.status === 'online' ? 'ok' : site.status === 'offline' ? 'bad' : ''}`;
    set('h-conn-t', site.status === 'online' ? 'Connected' : site.status === 'offline' ? 'Disconnected' : 'Connecting');

    const banner = document.getElementById('stale-banner');
    const text = document.getElementById('stale-text');
    banner.className = 'banner';
    if (site.status === 'offline') {
        text.textContent = d
            ? `Site unreachable - last data received ${App.ago(site.lastSeen)}. Values below are the last known readings.`
            : `Site unreachable - no SNMP response from ${site.ip}:${site.port || 161} yet. Check the IP, port, community and network path.`;
    } else if (!d) {
        banner.classList.add('info');
        text.textContent = `Connecting to ${site.ip}:${site.port || 161} - first poll in progress...`;
    } else {
        banner.classList.add('hidden');
    }
}

function renderSidebar() {
    const d = site.data;
    const ps = site.pollStats;
    set('conn-detail', site.status === 'online' && ps
        ? `SNMP Active · ${ps.answered}/${ps.total} OIDs · ${ps.durationMs} ms`
        : site.status === 'offline' ? `Last seen ${App.ago(site.lastSeen)}` : `Trying ${site.ip}...`);
    const fresh = site.status === 'online' && d;
    liveDot('live-bms', fresh ? d.live.bms : null, 'Live', 'No comms');
    liveDot('live-rect', fresh ? d.live.rectifier : null, 'Live', 'No comms');
    liveDot('live-mains', fresh ? d.system.mainsOk : null, 'Present', 'Failed');

    const n = site.alarms.length;
    const badge = document.getElementById('tab-alarm-count');
    badge.classList.toggle('hidden', !n);
    badge.textContent = n;
}

function liveDot(id, ok, yes, no) {
    document.getElementById(id).className = `dot ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
    set(`${id}-t`, ok === true ? yes : ok === false ? no : '--');
}

// ---------------- Dashboard ----------------
function renderOverview() {
    const d = site.data;
    const th = meta.thresholds;
    const rated = meta.ratings.rectifierWatts;
    const fresh = site.status === 'online' && d;

    renderAlarmCard();

    if (!d) {
        renderStatusRows(null);
        setFact('s-state', 'No Data', '');
        setFact('s-source', '--', '');
        return;
    }
    const { battery: b, rectifier: r, system: s } = d;

    App.setStat('ov-ac', {
        value: App.num(r.acVoltage, 0),
        subs: { st: s.mainsOk === true ? 'Present' : s.mainsOk === false ? 'Failed' : 'Unknown', bus: `${App.num(r.busVoltage, 0)} V` }
    });
    App.setStat('ov-dc', {
        value: App.num(s.busVoltage, 1),
        label: r.on && r.dcVoltage > 1 ? 'Voltage' : 'Voltage (from battery)',
        subs: { i: `${App.num(r.dcCurrent, 1)} A`, p: `${App.int(r.outputPower)} W` } // rectifier output, not load
    });
    App.setStat('ov-load', {
        value: App.int(s.loadPct),
        meter: [s.loadPct, App.meterClass(s.loadPct, th.loadWarnPct, th.loadCriticalPct)],
        subs: { p: `${App.int(s.loadPower)} W`, max: `${rated} W` }
    });
    App.setStat('ov-bt', {
        value: App.num(b.voltage, 1),
        label: `Voltage · ${BATT_STATE[b.state]}`,
        subs: { i: `${App.num(b.current, 1)} A`, soc: `${b.soc ?? '--'} %`, bk: App.hours(s.backupHours) }
    });

    const heatsink = r.tempMax;
    const tempNow = heatsink ?? b.tempMax;
    const warnAt = heatsink !== null ? th.rectTempWarn : th.battTempWarn;
    const critAt = heatsink !== null ? th.rectTempCritical : th.battTempCritical;
    App.setStat('ov-tp', {
        value: App.num(tempNow, heatsink !== null ? 0 : 1),
        label: heatsink !== null ? 'Heatsink' : 'Battery (rectifier not reporting)',
        subs: {
            st: tempNow === null ? '--' : tempNow >= critAt ? 'Critical' : tempNow >= warnAt ? 'Warning' : 'Normal',
            bt: `${App.num(b.tempMax, 1)} °C`
        }
    });

    const st = fresh ? (STATE[s.state] || STATE.standby) : { label: 'No Data', tone: '' };
    const src = fresh ? (SOURCE[s.powerSource] || SOURCE.unknown) : { label: '--', tone: '' };
    setFact('s-state', st.label, st.tone);
    setFact('s-source', src.label, src.tone);
    set('s-backup', App.isNum(s.backupHours)
        ? `${App.hours(s.backupHours)} ${s.backupBasis === 'discharge' ? 'at present discharge' : `if mains fails (${App.int(s.loadPower)} W)`}`
        : '-- (no load to estimate from)');

    renderStatusRows(fresh ? d : null);
}

function setFact(id, text, tone) {
    const el = document.getElementById(id);
    el.textContent = text;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

// Same six checks as the CAN GUI "System Status" panel, from SNMP values.
function renderStatusRows(d) {
    const th = meta.thresholds;
    let rows;
    if (!d) {
        rows = ['AC Present', 'PFC Active', 'LLC Active', 'DC Output OK', 'Battery Normal', 'Temperature Normal'].map(l => [l, false, 'no data']);
    } else {
        const { battery: b, rectifier: r, system: s, live } = d;
        const protOk = !b.protection.confirmed || b.protection.raw === 0;
        const rectHot = r.tempMax !== null && r.tempMax >= th.rectTempWarn;
        const battHot = b.tempMax !== null && b.tempMax >= th.battTempWarn;
        rows = [
            ['AC Present', s.mainsOk === true, s.mainsOk === null ? 'rectifier not reporting' : `${App.num(r.acVoltage, 0)} V`],
            ['PFC Active', live.rectifier && r.busVoltage > th.pfcBusMinV, live.rectifier ? `bus ${App.num(r.busVoltage, 0)} V` : 'no comms'],
            ['LLC Active', live.rectifier && r.on && r.dcVoltage > th.dcOutputMinV, live.rectifier ? (r.on ? `${App.num(r.dcVoltage, 1)} V` : 'output off') : 'no comms'],
            ['DC Output OK', s.busVoltage > th.dcOutputMinV && r.alarm.raw === 0, `${App.num(s.busVoltage, 1)} V`],
            ['Battery Normal', live.bms && b.voltage > th.dcOutputMinV && (b.soc ?? 0) >= th.socWarn && protOk,
                live.bms ? `${b.soc ?? '--'}% · ${App.num(b.voltage, 1)} V` : 'no comms'],
            ['Temperature Normal', (r.tempMax !== null || b.tempMax !== null) && !rectHot && !battHot,
                [r.tempMax !== null && `rect ${App.num(r.tempMax, 0)} °C`, b.tempMax !== null && `batt ${App.num(b.tempMax, 1)} °C`].filter(Boolean).join(' · ') || '--']
        ];
    }
    html('s-status', rows.map(([label, ok, why]) =>
        `<div class="status-row"><span class="dot ${ok ? 'ok' : 'bad'}"></span><span>${label}</span><span class="why">${App.esc(why)}</span></div>`).join(''));
    const n = site.alarms.length;
    html('s-status-foot', `<span class="dot ${n ? 'bad' : 'ok'}"></span><span style="color:var(--${n ? 'red' : 'green'})">${n} Active Alarm${n === 1 ? '' : 's'}</span>`);
}

function renderAlarmCard() {
    const n = site.alarms.length;
    const badge = document.getElementById('o-alarm-count');
    badge.textContent = n;
    badge.classList.toggle('alert', n > 0);
    html('o-alarms', n ? site.alarms.slice(0, 3).map(alarmItem).join('') +
        (n > 3 ? `<div class="muted" style="font-size:11.5px">+ ${n - 3} more</div>` : '')
        : '<div class="all-clear"><ion-icon name="checkmark-circle"></ion-icon>No alarms - system operating normally</div>');
}

function alarmItem(a) {
    const icon = a.severity === 'critical' ? 'alert-circle' : 'warning';
    return `<div class="alarm-item ${a.severity}">
        <span class="alarm-ico"><ion-icon name="${icon}"></ion-icon></span>
        <div style="min-width:0"><div class="msg">${App.esc(a.message)}</div>
        <div class="det">${App.SEVERITY[a.severity].label} · ${App.esc(a.detail)}</div></div>
        <div class="when" title="${App.esc(App.dateTime(a.raisedAt))}">${App.ago(a.raisedAt)}</div></div>`;
}

// ---------------- Battery ----------------
function renderBattery() {
    const d = site.data;
    if (!d) return;
    const b = d.battery;
    const th = meta.thresholds;

    App.setStat('bt-v', { value: App.num(b.voltage, 2), label: `${b.cells.length} cells in series` });
    App.setStat('bt-i', { value: App.isNum(b.current) ? (b.current > 0 ? '+' : '') + b.current.toFixed(2) : '--', label: BATT_STATE[b.state] });
    App.setStat('bt-soc', { value: b.soc ?? '--', meter: [b.soc, App.meterClass(b.soc, th.socWarn, th.socCritical, true)] });
    App.setStat('bt-rem', { value: App.num(b.remainingAh, 1), label: `of ${App.num(b.fullAh, 1)} Ah full · ${b.ratedAh} Ah rated` });
    App.setStat('bt-cyc', { value: b.cycles ?? '--' });

    const valid = b.cells.filter(c => c.v !== null);
    const avg = valid.length ? valid.reduce((a, c) => a + c.v, 0) / valid.length : null;
    const minCell = valid.find(c => c.v === b.cellMin);
    const maxCell = valid.find(c => c.v === b.cellMax);
    html('cell-summary', valid.length ? `
        <span>Min <b>${b.cellMin.toFixed(3)} V</b> (cell ${minCell.n})</span>
        <span>Max <b>${b.cellMax.toFixed(3)} V</b> (cell ${maxCell.n})</span>
        <span>Spread <b>${b.cellDeltaMv} mV</b>${b.cellDeltaMv >= th.cellDeltaWarnMv ? ' ' + App.sevBadge('minor') : ''}</span>
        <span>Average <b>${avg.toFixed(3)} V</b></span>` : '<span>No cell data reported.</span>');
    set('cells-note', b.cellsReported > b.cells.length ? `BMS reports ${b.cellsReported} cells; SNMP exposes ${b.cells.length}` : '');
    html('cells', b.cells.map(c => {
        const tag = valid.length > 1 && c === minCell ? 'MIN' : valid.length > 1 && c === maxCell ? 'MAX' : '';
        const dev = c.v !== null && avg !== null ? Math.round((c.v - avg) * 1000) : null;
        return `<div class="cell${c.balancing ? ' is-bal' : ''}">
            ${tag ? `<span class="tag">${tag}</span>` : ''}
            <span class="n">${c.n}</span>
            <div class="v">${c.v !== null ? c.v.toFixed(3) : '--'}<span class="muted" style="font-size:11px;font-weight:600"> V</span></div>
            <div class="dev">${dev === null ? '&nbsp;' : `${dev > 0 ? '+' : ''}${dev} mV vs avg`}</div>
            ${c.balancing ? '<div class="bal"><ion-icon name="sync-outline"></ion-icon>Balancing</div>' : ''}
        </div>`;
    }).join(''));

    const protHex = `0x${b.protection.raw.toString(16).toUpperCase().padStart(4, '0')}`;
    const prot = !b.protection.confirmed ? `${protHex} (layout not confirmed)`
        : b.protection.active.length ? `${b.protection.active.length} active` : 'Normal';
    kv('batt-kv', [
        ['Total voltage', `${App.num(b.voltage, 2)} V`],
        ['Current', `${App.num(b.current, 2)} A`],
        ['State of charge', `${b.soc ?? '--'} %`],
        ['Remaining capacity', `${App.num(b.remainingAh, 2)} Ah`],
        ['Full capacity (BMS)', b.reportedFullAh ? `${App.num(b.reportedFullAh, 2)} Ah` : 'not reported'],
        ['Rated capacity', `${b.ratedAh} Ah`],
        ['Charge cycles', b.cycles ?? '--'],
        ['Production date', b.productionDate || '--'],
        ['BMS software version', b.softwareVersion ?? '--'],
        ['Charge / discharge MOSFET', b.mosfet ? `${b.mosfet.charge ? 'ON' : 'OFF'} / ${b.mosfet.discharge ? 'ON' : 'OFF'}` : '--'],
        ['Protection', prot]
    ]);

    html('ntc', b.ntc.map((t, i) => {
        const hot = t !== null && t >= th.battTempCritical ? 'critical' : t !== null && t >= th.battTempWarn ? 'minor' : null;
        return `<div class="thermal"><span class="k">${i + 1}</span>
            <div class="v">${t === null ? '--' : t.toFixed(1)}<span class="unit"> °C</span></div>
            <div style="margin-top:2px">${t === null ? '<span class="muted" style="font-size:11.5px">not fitted</span>' : hot ? App.sevBadge(hot) : '<span class="muted" style="font-size:11.5px">Normal</span>'}</div></div>`;
    }).join(''));

    set('prot-raw', protHex);
    html('prot-bits', b.protection.confirmed ? bitRows(b.protection) : `
        <div class="banner info" style="margin-bottom:8px"><ion-icon name="information-circle-outline"></ion-icon>
        <span>Bit layout not confirmed for this BMS, so protection bits raise no alarms. Raw value ${protHex}
        (decimal ${b.protection.raw}). Set the bit names in <code class="mono">config.js</code> and enable
        <code class="mono">bmsProtectionAlarms</code> once the BMS protocol is known.</span></div>
        ${rawBitRows(b.protection.raw)}`);
}

// ---------------- Rectifier ----------------
function renderRectifier() {
    const d = site.data;
    if (!d) return;
    const r = d.rectifier;
    const s = d.system;
    const th = meta.thresholds;
    const live = d.live.rectifier;

    App.setStat('rc-ac', { value: App.num(r.acVoltage, 0), label: s.mainsOk === true ? 'Mains present' : s.mainsOk === false ? `Mains failure (< ${th.acFailV} V)` : 'Unknown (not reporting)' });
    App.setStat('rc-dcv', { value: App.num(r.dcVoltage, 2) });
    App.setStat('rc-dci', { value: App.num(r.dcCurrent, 2) });
    App.setStat('rc-p', { value: App.int(r.outputPower), label: `${App.int(r.loadPct)}% of ${r.ratedPower} W`, meter: [r.loadPct, App.meterClass(r.loadPct, th.loadWarnPct, th.loadCriticalPct)] });
    App.setStat('rc-bus', { value: App.num(r.busVoltage, 0) });

    kv('rect-kv', [
        ['Communication', live ? 'Live' : 'Not reporting'],
        ['Operating state', !live ? '--' : r.alarm.raw ? 'FAULT' : r.on ? 'RUNNING' : 'OFF'],
        ['AC input voltage', `${App.num(r.acVoltage, 0)} V`],
        ['PFC bus voltage', `${App.num(r.busVoltage, 0)} V`],
        ['DC output voltage', `${App.num(r.dcVoltage, 2)} V`],
        ['DC output current', `${App.num(r.dcCurrent, 2)} A`],
        ['Output power', `${App.int(r.outputPower)} W`],
        ['Rated power', `${r.ratedPower} W`],
        ['Max deliverable (reported)', r.maxPowerReported !== null ? `${r.maxPowerReported} W` : '--'],
        ['Input energy', App.energy(d.energy.rectInputWh).join(' ')],
        ['Output energy', App.energy(d.energy.rectOutputWh).join(' ')],
        ['Lifetime efficiency', d.energy.rectEfficiency !== null ? `${d.energy.rectEfficiency.toFixed(1)} %` : '--'],
        ['Active faults', !live ? '--' : r.alarm.active.length ? r.alarm.active.map(a => a.label).join(', ') : 'None']
    ]);

    const temps = [['Ambient', r.temps.ambient], ['SR', r.temps.sr], ['LLC', r.temps.llc], ['PFC', r.temps.pfc]];
    html('rect-temps', temps.map(([k, t]) => {
        const hot = t !== null && t >= th.rectTempCritical ? 'critical' : t !== null && t >= th.rectTempWarn ? 'minor' : null;
        return `<div class="thermal"><span class="k">${k}</span>
            <div class="v">${App.num(t, 0)}<span class="unit"> °C</span></div>
            <div style="margin-top:2px">${t === null ? '<span class="muted" style="font-size:11.5px">--</span>' : hot ? App.sevBadge(hot) : '<span class="muted" style="font-size:11.5px">Normal</span>'}</div></div>`;
    }).join(''));

    set('rect-raw', live ? `0x${r.alarm.raw.toString(16).toUpperCase().padStart(2, '0')}` : '');
    html('rect-bits', live ? bitRows(r.alarm) : '<div class="all-clear" style="color:var(--muted)"><ion-icon name="help-circle-outline" style="color:var(--muted)"></ion-icon>Rectifier not reporting - fault flags unavailable</div>');
}

// Neutral view of a bitfield whose meaning is not yet known: which bits are set, no severity.
function rawBitRows(raw) {
    const on = [];
    for (let b = 0; b < 16; b++) if ((raw >>> b) & 1) on.push(b);
    return on.length ? on.map(b => `<div class="bit-row"><span class="bit">bit ${b}</span><span class="muted">meaning unknown</span>
        <span class="status">Set</span></div>`).join('') : '<div class="all-clear">No bits set</div>';
}

function bitRows(bits) {
    const known = new Set(bits.known.map(k => k.bit));
    const rows = [...bits.known, ...bits.active.filter(a => !known.has(a.bit)).map(a => ({ ...a, active: true }))];
    return rows.map(k => `<div class="bit-row"><span class="bit">bit ${k.bit}</span><span>${App.esc(k.label)}</span>${k.active
        ? '<span class="sev sev-critical"><ion-icon name="alert-circle"></ion-icon>Active</span>'
        : '<span class="status status-good"><ion-icon name="checkmark-circle"></ion-icon>Normal</span>'}</div>`).join('');
}

// ---------------- Control: load outputs, relays, energy ----------------
const pending = new Set();

function initControl() {
    const loads = document.getElementById('loads');
    for (let n = 1; n <= LOADS; n++) {
        loads.insertAdjacentHTML('beforeend', `<div class="card load-card">
            <div class="card-head"><h2 id="ld${n}-name">Load ${n}</h2><span class="right" id="ld${n}-badge"></span></div>
            <div class="load-row"><span class="dot" id="ld${n}-dot"></span>eFuse status<b id="ld${n}-st">--</b></div>
            <div class="load-row">Fault count<b id="ld${n}-fc">--</b></div>
            <div class="load-row">Energy<b id="ld${n}-en">--</b></div>
            <button class="btn" id="ld${n}-reset"><ion-icon name="refresh"></ion-icon>Reset eFuse</button>
        </div>`);
        document.getElementById(`ld${n}-reset`).addEventListener('click', () => {
            const name = document.getElementById(`ld${n}-name`).textContent;
            sendCommand(`efuse${n}Reset`, 1, `Reset the ${name} eFuse at ${site.name}?`, `Reset ${name} eFuse`);
        });
    }
    const relays = document.getElementById('relays');
    for (let n = 1; n <= RELAYS; n++) {
        relays.insertAdjacentHTML('beforeend', `<div class="relay-row">
            <span class="dot" id="rl${n}-dot"></span><span class="name" id="rl${n}-name">Relay ${n}</span>
            <span class="state" id="rl${n}-st">--</span>
            <label class="switch" title="Switch relay"><input type="checkbox" id="rl${n}-sw" aria-label="Relay ${n}"><span></span></label>
        </div>`);
        const sw = document.getElementById(`rl${n}-sw`);
        sw.addEventListener('change', async () => {
            const want = sw.checked ? 1 : 0;
            sw.checked = !sw.checked; // stays at the reported state until the unit confirms the change
            const name = document.getElementById(`rl${n}-name`).textContent;
            await sendCommand(`relay${n}State`, want, `Turn ${name} ${want ? 'ON' : 'OFF'} at ${site.name}?`, `${name} ${want ? 'ON' : 'OFF'}`);
        });
    }
    document.getElementById('confirm-cancel').addEventListener('click', () => document.getElementById('confirm-dialog').close('cancel'));
    document.getElementById('confirm-ok').addEventListener('click', () => document.getElementById('confirm-dialog').close('ok'));
}

function confirmAction(text, okLabel) {
    const dlg = document.getElementById('confirm-dialog');
    document.getElementById('confirm-text').textContent = text;
    document.getElementById('confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function sendCommand(key, value, question, label) {
    if (!(await confirmAction(question, label))) return;
    pending.add(key);
    renderControl();
    try {
        await App.api(`/devices/${encodeURIComponent(siteId)}/set`, { method: 'POST', body: { key, value } });
        App.toast(`${label}: command sent`);
    } catch (err) {
        App.toast(`${label} failed: ${err.message}`, 'error');
    } finally {
        pending.delete(key);
        setTimeout(refresh, 600); // the server re-polls the unit right after a SET
    }
}

function renderControl() {
    if (!site) return;
    const d = site.data;
    const canSend = site.controlsEnabled && site.status === 'online';
    document.getElementById('ctl-disabled').classList.toggle('hidden', !!site.controlsEnabled);

    if (d) {
        const e = d.energy;
        const put = (id, wh) => { const [v, u] = App.energy(wh); App.setStat(id, { value: v, unit: u }); };
        put('en-load', e.loadTotalWh);
        put('en-batt', e.batteryWh);
        put('en-in', e.rectInputWh);
        put('en-out', e.rectOutputWh);
        App.setStat('en-eff', { value: e.rectEfficiency !== null ? e.rectEfficiency.toFixed(1) : '--' });
    }

    for (let n = 1; n <= LOADS; n++) {
        const l = d ? d.loads[n - 1] : null;
        set(`ld${n}-name`, l ? l.name : `Load ${n}`);
        document.getElementById(`ld${n}-dot`).className = `dot ${l && l.efuseOn === true ? 'ok' : l && l.efuseOn === false ? 'bad' : ''}`;
        set(`ld${n}-st`, !l || l.efuseStatus === null ? '--' : `${l.efuseOn ? 'ON' : 'OFF'} (${l.efuseStatus})`);
        set(`ld${n}-fc`, l && l.faultCount !== null ? l.faultCount : '--');
        set(`ld${n}-en`, l ? App.energy(l.energyWh).join(' ') : '--');
        const tripped = site.alarms.find(a => a.key === `efuse_${n}`);
        html(`ld${n}-badge`, tripped ? '<span class="sev sev-major"><ion-icon name="warning"></ion-icon>Tripped</span>' : '');
        const btn = document.getElementById(`ld${n}-reset`);
        btn.disabled = !canSend || pending.has(`efuse${n}Reset`);
        btn.title = site.controlsEnabled ? (site.status === 'online' ? '' : 'Site is not online') : 'Controls are disabled';
    }
    for (let n = 1; n <= RELAYS; n++) {
        const r = d ? d.relays[n - 1] : null;
        set(`rl${n}-name`, r ? r.name : `Relay ${n}`);
        document.getElementById(`rl${n}-dot`).className = `dot ${r && r.on ? 'ok' : ''}`;
        set(`rl${n}-st`, pending.has(`relay${n}State`) ? 'sending...' : !r || r.state === null ? '--' : `${r.on ? 'ON' : 'OFF'} (${r.state})`);
        const sw = document.getElementById(`rl${n}-sw`);
        if (!pending.has(`relay${n}State`)) sw.checked = !!(r && r.on);
        sw.disabled = !canSend || pending.has(`relay${n}State`) || !r || r.state === null;
    }

    const log = site.controlLog || [];
    html('ctl-log', log.length ? log.slice(0, 8).map(c => `<div class="ctl-entry">
        <span class="status ${c.ok ? 'status-good' : 'status-offline'}"><ion-icon name="${c.ok ? 'checkmark-circle' : 'close-circle'}"></ion-icon>${c.ok ? 'Sent' : 'Failed'}</span>
        <span><b>${App.esc(c.key)}</b> = ${App.esc(c.value)}${c.error ? ` <span class="muted">· ${App.esc(c.error)}</span>` : ''}</span>
        <span class="when">${App.dateTime(c.at)}</span></div>`).join('')
        : '<div class="muted" style="font-size:12.5px;padding:6px 0">No commands sent yet.</div>');
}

// ---------------- Alarms ----------------
function renderAlarms() {
    html('a-active', site.alarms.length ? site.alarms.map(alarmItem).join('')
        : '<div class="all-clear"><ion-icon name="checkmark-circle"></ion-icon>No active alarms</div>');
    html('a-log', siteLog.length ? siteLog.map(a => `<tr>
        <td>${App.sevBadge(a.severity)}</td>
        <td><b>${App.esc(a.message)}</b></td>
        <td class="muted">${App.esc(a.detail)}</td>
        <td class="num">${App.dateTime(a.raisedAt)}</td>
        <td>${a.clearedAt ? `<span class="muted">Cleared after ${App.duration((new Date(a.clearedAt) - new Date(a.raisedAt)) / 1000)}</span>`
            : `<b>Active</b> <span class="muted">${App.duration((Date.now() - new Date(a.raisedAt)) / 1000)}</span>`}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">No alarm events recorded for this site yet.</td></tr>');
}

// ---------------- Diagnostics ----------------
function renderDiagnostics() {
    const ps = site.pollStats;
    kv('poll-kv', [
        ['Status', site.status],
        ['Address', `${site.ip}:${site.port || 161}`],
        ['Read community', site.hasCommunity ? 'custom (per site)' : 'default (config.js)'],
        ['Last poll', site.lastPoll ? App.dateTime(site.lastPoll) : '--'],
        ['Last response', site.lastSeen ? App.dateTime(site.lastSeen) : 'never'],
        ['Cycle duration', ps ? `${ps.durationMs} ms` : '--'],
        ['OIDs answered', ps ? `${ps.answered} of ${ps.total}` : '--'],
        ['Consecutive failures', site.failures],
        ['Last error', site.lastError || 'none']
    ]);
    const keys = Object.keys(site.oids);
    const answered = keys.filter(k => site.raw[k] !== undefined).length;
    set('raw-count', `${answered} of ${keys.length} returned at least once`);
    html('raw-body', keys.map(k => {
        const v = site.raw[k];
        return `<tr><td>${k}</td><td class="mono muted">${site.oids[k]}</td>
            <td class="num mono">${v === undefined ? '<span class="muted">no response</span>' : App.esc(v)}</td>
            <td class="muted">${site.rawAt[k] ? App.ago(site.rawAt[k]) : '--'}</td></tr>`;
    }).join(''));
}

// ---------------- Trends ----------------
function initTrends() {
    for (const [row, list] of Object.entries(TRENDS)) {
        const box = document.getElementById(`trends-${row}`);
        for (const c of list) {
            const card = document.createElement('div');
            card.className = 'card trend';
            card.dataset.tone = c.tone;
            card.innerHTML = `<div class="trend-head"><h3></h3><span class="latest"><i></i><span>-- ${App.esc(c.unit)}</span></span></div><div></div>`;
            card.querySelector('h3').textContent = c.title;
            box.appendChild(card);
            charts[c.key] = { chart: new App.LineChart(card.lastElementChild, { ...c, sampleMs: meta.sampleEveryMs, height: 160 }), card, spec: c };
        }
    }
    document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
        range = Number(b.dataset.range);
        document.querySelectorAll('[data-range]').forEach(x => x.classList.toggle('active', x === b));
        Object.values(charts).forEach(c => c.chart.el.classList.add('loading'));
        loadHistory();
    }));
    document.getElementById('export-csv').addEventListener('click', exportCsv);
}

async function loadHistory() {
    try {
        const res = await App.api(`/devices/${encodeURIComponent(siteId)}/history?hours=${range}`);
        trend = res.points;
    } catch { return; /* keep the previous render */ }

    // Temperature trend shows the rectifier heatsink; on a unit whose rectifier is not reporting, the battery.
    const hasRect = trend.some(p => App.isNum(p.rectTemp));
    for (const { chart, card, spec } of Object.values(charts)) {
        const key = spec.key === 'temp' ? (hasRect ? 'rectTemp' : 'battTemp') : spec.key;
        const pts = trend.map(p => ({ t: p.t, v: p[key] }));
        chart.setData(pts, { hours: range });
        chart.el.classList.remove('loading');
        if (spec.key === 'temp') card.querySelector('h3').textContent = hasRect || !trend.length ? spec.title : `${spec.title} (Battery)`;
        const last = [...pts].reverse().find(p => App.isNum(p.v));
        card.querySelector('.latest span').textContent = `${last ? last.v.toFixed(spec.decimals) : '--'} ${spec.unit}`;
    }
}

function exportCsv() {
    if (!trend.length) return App.toast('No trend data to export yet', 'error');
    const rows = [['time', 'load_w', 'load_a', 'ac_input_v', 'dc_bus_v', 'soc_pct', 'battery_v', 'battery_a', 'rectifier_temp_c', 'battery_temp_c']];
    for (const p of trend) {
        rows.push([new Date(p.t).toISOString(), r2(p.loadW), r2(p.loadA), r2(p.acV), r2(p.dcV), p.soc, r2(p.battV), r2(p.battI), r2(p.rectTemp), r2(p.battTemp)]);
    }
    App.downloadCsv(`${fileStem()}_trends_${range}h.csv`, rows);
}

const r2 = v => (App.isNum(v) ? Math.round(v * 100) / 100 : '');
const fileStem = () => `${site ? site.name : siteId}`.replace(/[^\w-]+/g, '_');

// ---------------- Record (like the CAN GUI) ----------------
// Captures every polled value while this page is open; Stop downloads the CSV.
function initRecorder() {
    const btn = document.getElementById('record-btn');
    btn.addEventListener('click', () => (rec ? stopRecording() : startRecording()));
    window.addEventListener('beforeunload', e => { if (rec && rec.rows.length) { e.preventDefault(); e.returnValue = ''; } });
    setInterval(() => {
        if (!rec) return;
        const s = Math.floor((Date.now() - rec.start) / 1000);
        set('record-t', `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
}

function startRecording() {
    if (!site || !site.data) return App.toast('No SNMP data received yet - wait for the site to come online', 'error');
    rec = { start: Date.now(), rows: [], keys: new Set() };
    const btn = document.getElementById('record-btn');
    btn.classList.add('on');
    btn.querySelector('ion-icon').setAttribute('name', 'stop');
    set('record-t', '00:00:00');
    recordTick();
}

function recordTick() {
    if (!rec || !site || !site.data || site.status !== 'online') return;
    const { battery: b, rectifier: r, system: s } = site.data;
    const row = {
        timestamp: new Date().toISOString(),
        state: s.state, power_source: s.powerSource,
        load_w: r2(s.loadPower), load_a: r2(s.loadCurrent), dc_bus_v: r2(s.busVoltage),
        ac_input_v: r2(r.acVoltage), rect_dc_v: r2(r.dcVoltage), rect_dc_a: r2(r.dcCurrent), rect_temp_c: r2(r.tempMax),
        batt_v: r2(b.voltage), batt_a: r2(b.current), soc_pct: b.soc, batt_temp_c: r2(b.tempMax),
        backup_h: r2(s.backupHours), active_alarms: site.alarms.map(a => a.message).join('; ')
    };
    for (const [k, v] of Object.entries(site.raw)) row[`raw_${k}`] = v;
    Object.keys(row).forEach(k => rec.keys.add(k));
    rec.rows.push(row);
}

function stopRecording() {
    const r = rec;
    rec = null;
    const btn = document.getElementById('record-btn');
    btn.classList.remove('on');
    btn.querySelector('ion-icon').setAttribute('name', 'radio-button-on');
    set('record-t', 'Record');
    if (!r.rows.length) return App.toast('Nothing recorded', 'error');
    const keys = [...r.keys];
    const d = new Date(r.start);
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    App.downloadCsv(`${fileStem()}_recording_${stamp}.csv`, [keys, ...r.rows.map(row => keys.map(k => row[k] ?? ''))]);
    App.toast(`Saved ${r.rows.length} sample(s)`);
}

// ---------------- Tabs & utils ----------------
function initTabs() {
    const show = name => {
        if (!document.getElementById(`tab-${name}`)) name = 'overview';
        document.querySelectorAll('.nav-item[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
        history.replaceState(null, '', `${location.search}#${name}`);
        if (name === 'overview') Object.values(charts).forEach(c => c.chart.draw());
    };
    document.querySelectorAll('.nav-item[data-tab]').forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
    document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); show(b.dataset.goto); }));
    window.addEventListener('hashchange', () => show(location.hash.slice(1)));
    show(location.hash.slice(1) || 'overview');
}

function kv(id, rows) {
    html(id, rows.map(([k, v]) => `<dt>${App.esc(k)}</dt><dd>${App.esc(v)}</dd>`).join(''));
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function html(id, markup) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = markup;
}
