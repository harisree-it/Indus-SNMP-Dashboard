// Shared client helpers: auth/API, formatting, theme, badges and the trend chart.

const App = (() => {
    const TOKEN_KEY = 'smps.token';
    const THEME_KEY = 'smps.theme';

    // ---------------- Auth & API ----------------
    function token() {
        try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { return null; }
    }

    function setToken(t, remember) {
        try {
            sessionStorage.setItem(TOKEN_KEY, t);
            if (remember) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
        } catch { /* storage blocked: session lasts for this page only */ }
    }

    function clearToken() {
        try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { }
    }

    function toLogin() {
        clearToken();
        const next = location.pathname.split('/').pop() + location.search;
        location.href = 'login.html?next=' + encodeURIComponent(next);
    }

    async function logout() {
        const t = token();
        clearToken();
        if (t) await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => { });
        location.href = 'login.html';
    }

    async function api(path, opts = {}) {
        const res = await fetch('/api' + path, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (res.status === 401) { toLogin(); throw new Error('Login required'); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
    }

    let metaPromise = null;
    function meta() {
        if (!metaPromise) metaPromise = fetch('/api/meta').then(r => r.json()).catch(() => ({ branding: {}, ratings: {} }));
        return metaPromise;
    }

    async function applyBranding(pageTitle) {
        const m = await meta();
        document.querySelectorAll('[data-brand]').forEach(el => {
            el.textContent = m.branding[el.dataset.brand] || el.textContent;
        });
        if (pageTitle) document.title = `${pageTitle} · ${m.branding.product || 'Mini SMPS'}`;
        return m;
    }

    // ---------------- Theme ----------------
    function storedTheme() {
        try { return localStorage.getItem(THEME_KEY); } catch { return null; }
    }

    // Light by default, like the CAN GUI; dark only when the viewer picks it.
    function currentTheme() {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    function toggleTheme() {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(THEME_KEY, next); } catch { }
        updateThemeIcons();
        window.dispatchEvent(new CustomEvent('themechange', { detail: next }));
    }

    function updateThemeIcons() {
        document.querySelectorAll('[data-theme-toggle] ion-icon').forEach(i => {
            i.setAttribute('name', currentTheme() === 'dark' ? 'sunny-outline' : 'moon-outline');
        });
    }

    (function initTheme() {
        document.documentElement.dataset.theme = storedTheme() === 'dark' ? 'dark' : 'light';
    })();

    document.addEventListener('DOMContentLoaded', () => {
        updateThemeIcons();
        document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', toggleTheme));
        document.querySelectorAll('[data-logout]').forEach(b => b.addEventListener('click', logout));
    });

    // ---------------- Formatting ----------------
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const num = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '--');
    const int = v => (isNum(v) ? Math.round(v).toLocaleString() : '--');

    function hours(h) {
        if (!isNum(h)) return '--';
        if (h > 99) return '>99 h';
        if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
        return `${h.toFixed(1)} h`;
    }

    // Energy counter in Wh -> [value, unit]
    function energy(wh) {
        if (!isNum(wh)) return ['--', 'Wh'];
        if (Math.abs(wh) >= 10000) return [(wh / 1000).toFixed(2), 'kWh'];
        return [Math.round(wh).toLocaleString(), 'Wh'];
    }

    function duration(sec) {
        if (!isNum(sec)) return '--';
        const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
        return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
    }

    function ago(iso) {
        if (!iso) return 'never';
        const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
        return dateTime(iso);
    }

    function dateTime(iso) {
        if (!iso) return '--';
        const d = new Date(iso);
        return d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function clock(t) {
        return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---------------- Badges ----------------
    const SEVERITY = {
        critical: { label: 'Critical', icon: 'alert-circle' },
        major: { label: 'Major', icon: 'warning' },
        minor: { label: 'Minor', icon: 'information-circle' }
    };

    function sevBadge(sev) {
        const s = SEVERITY[sev] || SEVERITY.minor;
        return `<span class="sev sev-${sev}"><ion-icon name="${s.icon}"></ion-icon>${s.label}</span>`;
    }

    const STATUS = {
        online: { label: 'Online', icon: 'checkmark-circle' },
        offline: { label: 'Offline', icon: 'close-circle' },
        connecting: { label: 'Connecting', icon: 'ellipsis-horizontal-circle' }
    };

    function statusBadge(status) {
        const s = STATUS[status] || STATUS.connecting;
        return `<span class="status status-${status}"><ion-icon name="${s.icon}"></ion-icon>${s.label}</span>`;
    }

    function sourceBadge(m) {
        if (!m) return '<span class="muted">--</span>';
        if (m.powerSource === 'mains') return '<span class="status status-good"><ion-icon name="flash"></ion-icon>Mains</span>';
        if (m.powerSource === 'battery') return '<span class="status status-battery"><ion-icon name="battery-half"></ion-icon>Battery</span>';
        if (m.powerSource === 'none') return '<span class="status status-offline"><ion-icon name="close-circle"></ion-icon>No power</span>';
        return '<span class="muted">Unknown</span>';
    }

    function meterClass(pct, warnAt, critAt, lowIsBad) {
        if (!isNum(pct)) return '';
        if (lowIsBad) return pct < critAt ? 'crit' : pct < warnAt ? 'warn' : '';
        return pct >= critAt ? 'crit' : pct >= warnAt ? 'warn' : '';
    }

    function meter(pct, cls = '') {
        const w = isNum(pct) ? Math.max(0, Math.min(100, pct)) : 0;
        return `<div class="meter ${cls}" role="presentation"><span style="width:${w}%"></span></div>`;
    }

    // ---------------- Stat card (CAN GUI StatCard) ----------------
    // spec: { id, title, icon, tone, unit, label, meter?, subs?: [[key, label], ...] }
    function statCard(spec) {
        const subs = (spec.subs || []).map(([key, label]) =>
            `<div><b id="${spec.id}-${key}">--</b><span>${esc(label)}</span></div>`).join('');
        return `<div class="stat" data-tone="${spec.tone || 'blue'}">
            <div class="stat-top"><span class="stat-title">${esc(spec.title)}</span>
                <span class="stat-icon"><ion-icon name="${spec.icon}"></ion-icon></span></div>
            <div class="stat-main"><span class="stat-value" id="${spec.id}-v">--</span><span class="stat-unit" id="${spec.id}-u">${esc(spec.unit || '')}</span></div>
            <div class="stat-label" id="${spec.id}-l">${esc(spec.label || '')}</div>
            ${spec.meter ? `<div id="${spec.id}-m">${meter(null)}</div>` : ''}
            ${subs ? `<div class="stat-subs">${subs}</div>` : ''}
        </div>`;
    }

    function renderStats(container, specs) {
        container.innerHTML = specs.map(statCard).join('');
    }

    // values: { value, label?, meter?: [pct, cls], subs?: { key: text } }
    function setStat(id, values) {
        const put = (sfx, text) => { const el = document.getElementById(`${id}-${sfx}`); if (el) el.textContent = text; };
        if ('value' in values) put('v', values.value);
        if ('label' in values) put('l', values.label);
        if ('unit' in values) put('u', values.unit);
        if (values.meter) {
            const el = document.getElementById(`${id}-m`);
            if (el) el.innerHTML = meter(values.meter[0], values.meter[1] || '');
        }
        for (const [k, v] of Object.entries(values.subs || {})) put(k, v);
    }

    function toast(message, kind = 'info') {
        let box = document.querySelector('.toasts');
        if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
        const el = document.createElement('div');
        el.className = `toast ${kind}`;
        el.setAttribute('role', 'status');
        el.innerHTML = `<ion-icon name="${kind === 'error' ? 'alert-circle' : 'checkmark-circle'}"></ion-icon><span></span>`;
        el.querySelector('span').textContent = message;
        box.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    function downloadCsv(filename, rows) {
        const csv = rows.map(r => r.map(v => {
            const s = String(v ?? '');
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // ---------------- Trend chart ----------------
    // Single-series SVG line chart: hairline grid, 2px line, 10% area wash, end-dot with value,
    // crosshair + tooltip on hover, arrow-key navigation on focus. Gaps (site offline) break the line.
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function niceStep(range, count) {
        const raw = range / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / mag;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    }

    class LineChart {
        constructor(el, opts) {
            this.el = el;
            this.opts = { decimals: 1, height: 170, ticks: 4, ...opts };
            this.points = [];
            this.el.classList.add('chart');
            this.tip = document.createElement('div');
            this.tip.className = 'chart-tip hidden';
            this.el.appendChild(this.tip);
            this.svg = document.createElementNS(SVG_NS, 'svg');
            this.svg.setAttribute('tabindex', '0');
            this.svg.setAttribute('role', 'img');
            this.svg.setAttribute('aria-label', `${opts.title} trend. Use left and right arrow keys to read values.`);
            this.el.appendChild(this.svg);
            this.empty = document.createElement('div');
            this.empty.className = 'chart-empty hidden';
            this.empty.innerHTML = '<span>No data for this period yet</span>';
            this.el.appendChild(this.empty);
            this.focusIdx = null;

            this.svg.addEventListener('pointermove', e => this.hover(e));
            this.svg.addEventListener('pointerleave', () => this.hideTip());
            this.svg.addEventListener('blur', () => this.hideTip());
            this.svg.addEventListener('focus', () => this.showAt(this.lastIndex()));
            this.svg.addEventListener('keydown', e => this.key(e));
            new ResizeObserver(() => this.draw()).observe(this.el);
        }

        setData(points, range) {
            this.points = points.filter(p => isNum(p.v));
            this.range = range;
            this.draw();
        }

        lastIndex() { return this.points.length ? this.points.length - 1 : null; }

        draw() {
            const W = this.el.clientWidth, H = this.opts.height;
            if (!W) return;
            const pad = { l: 44, r: 52, t: 12, b: 22 };
            const svg = this.svg;
            svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
            svg.innerHTML = '';
            this.empty.classList.toggle('hidden', this.points.length > 1);

            const now = Date.now();
            const t1 = this.range ? this.range.end || now : now;
            const t0 = this.range ? t1 - this.range.hours * 3600e3 : (this.points[0]?.t ?? now - 3600e3);
            const vals = this.points.map(p => p.v);
            let lo = this.opts.min ?? Math.min(...vals, Infinity);
            let hi = this.opts.max ?? Math.max(...vals, -Infinity);
            if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
            // zero: keep the 0 line in view (power, AC volts, signed battery current)
            if (this.opts.zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
            const span = this.opts.minSpan || 1;
            if (hi - lo < span) {
                if (this.opts.zero && lo === 0) hi = span;
                else if (this.opts.zero && hi === 0) lo = -span;
                else { const m = (hi + lo) / 2; lo = m - span / 2; hi = m + span / 2; }
            }
            const step = niceStep(hi - lo, this.opts.ticks);
            if (this.opts.min === undefined) lo = Math.floor(lo / step) * step;
            if (this.opts.max === undefined) hi = Math.ceil(hi / step) * step;

            const x = t => pad.l + (t - t0) / (t1 - t0) * (W - pad.l - pad.r);
            const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
            this.scale = { x, y, t0, t1, pad, W, H };

            const add = (tag, attrs, parent = svg) => {
                const n = document.createElementNS(SVG_NS, tag);
                for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
                parent.appendChild(n);
                return n;
            };

            // y grid + ticks
            const decimalsTick = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
            for (let v = lo; v <= hi + step / 2; v += step) {
                const yy = Math.round(y(v)) + 0.5;
                add('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: Math.abs(v - lo) < step / 2 ? 'baseline' : 'gridline' });
                const t = add('text', { x: pad.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' });
                t.textContent = v.toFixed(decimalsTick);
            }
            // x ticks
            const spanH = (t1 - t0) / 3600e3;
            const tickMin = spanH <= 1 ? 15 : spanH <= 6 ? 60 : 240;
            const first = Math.ceil(t0 / (tickMin * 60e3)) * tickMin * 60e3;
            for (let t = first; t <= t1; t += tickMin * 60e3) {
                const txt = add('text', { x: x(t), y: H - 4, 'text-anchor': 'middle', class: 'tick' });
                txt.textContent = clock(t);
            }

            if (this.points.length < 2) return;

            // segments, broken where the gap is larger than 3 samples (site was offline)
            const maxGap = (this.opts.sampleMs || 30000) * 3;
            const segs = [];
            let cur = [];
            this.points.forEach((p, i) => {
                if (i && p.t - this.points[i - 1].t > maxGap) { segs.push(cur); cur = []; }
                cur.push(p);
            });
            segs.push(cur);
            const base = y(lo <= 0 && hi >= 0 ? 0 : lo);
            for (const s of segs) {
                if (s.length < 2) continue;
                const d = s.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
                add('path', { d: `${d}L${x(s[s.length - 1].t).toFixed(1)},${base}L${x(s[0].t).toFixed(1)},${base}Z`, class: 'area' });
                add('path', { d, class: 'series' });
            }
            const last = this.points[this.points.length - 1];
            add('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'end-dot' });
            const lbl = add('text', { x: x(last.t) + 8, y: y(last.v) + 4, class: 'end-label' });
            lbl.textContent = `${last.v.toFixed(this.opts.decimals)}`;

            this.cross = add('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
            this.hoverDot = add('circle', { r: 4, class: 'end-dot', visibility: 'hidden' });
        }

        nearest(t) {
            let best = null, bestD = Infinity;
            this.points.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bestD) { bestD = d; best = i; } });
            return best;
        }

        hover(e) {
            if (this.points.length < 2 || !this.scale) return;
            const r = this.svg.getBoundingClientRect();
            const px = (e.clientX - r.left) * (this.scale.W / r.width);
            const t = this.scale.t0 + (px - this.scale.pad.l) / (this.scale.W - this.scale.pad.l - this.scale.pad.r) * (this.scale.t1 - this.scale.t0);
            this.showAt(this.nearest(t));
        }

        key(e) {
            if (!this.points.length) return;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const i = this.focusIdx ?? this.lastIndex();
            this.showAt(Math.max(0, Math.min(this.points.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1))));
        }

        showAt(i) {
            if (i === null || !this.cross) return;
            this.focusIdx = i;
            const p = this.points[i];
            const { x, y, W } = this.scale;
            const cx = x(p.t), cy = y(p.v);
            this.cross.setAttribute('x1', cx); this.cross.setAttribute('x2', cx);
            this.cross.setAttribute('visibility', 'visible');
            this.hoverDot.setAttribute('cx', cx); this.hoverDot.setAttribute('cy', cy);
            this.hoverDot.setAttribute('visibility', 'visible');
            const scaleX = this.el.clientWidth / W;
            this.tip.innerHTML = `<div class="tv"><i></i><span></span></div><div class="tt"></div>`;
            this.tip.querySelector('.tv span').textContent = `${p.v.toFixed(this.opts.decimals)} ${this.opts.unit}`;
            this.tip.querySelector('.tt').textContent = `${this.opts.title} · ${new Date(p.t).toLocaleTimeString()}`;
            this.tip.style.left = `${Math.min(this.el.clientWidth - 70, Math.max(70, cx * scaleX))}px`;
            this.tip.style.top = `${cy}px`;
            this.tip.classList.remove('hidden');
        }

        hideTip() {
            this.tip.classList.add('hidden');
            this.focusIdx = null;
            if (this.cross) this.cross.setAttribute('visibility', 'hidden');
            if (this.hoverDot) this.hoverDot.setAttribute('visibility', 'hidden');
        }
    }

    return {
        token, setToken, toLogin, logout, api, meta, applyBranding, toggleTheme, currentTheme,
        isNum, num, int, hours, energy, duration, ago, dateTime, clock, esc,
        SEVERITY, sevBadge, statusBadge, sourceBadge, meter, meterClass, toast, downloadCsv, LineChart,
        statCard, renderStats, setStat
    };
})();
