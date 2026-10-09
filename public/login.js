document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');
    const params = new URLSearchParams(location.search);
    // Only allow redirects to our own pages.
    const next = /^[\w-]+\.html(\?[\w=&%.-]*)?$/.test(params.get('next') || '') ? params.get('next') : 'index.html';

    if (App.token()) {
        // Already signed in? Verify the session is still valid before skipping the form.
        const ok = await fetch('/api/devices', { headers: { Authorization: 'Bearer ' + App.token() } }).then(r => r.ok).catch(() => false);
        if (ok) { location.href = next; return; }
    }

    App.applyBranding('Login').then(m => {
        if (m.demo) document.getElementById('demo-hint').classList.remove('hidden');
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        btn.disabled = true;
        btn.textContent = 'Signing in...';
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Login failed');
            App.setToken(data.token, document.getElementById('remember').checked);
            location.href = next;
        } catch (err) {
            errorEl.textContent = err.message === 'Failed to fetch' ? 'Cannot reach the dashboard server.' : err.message;
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = 'Sign in';
        }
    });

    initGlobe();
});

function initGlobe() {
    const el = document.getElementById('globe');
    if (typeof Globe !== 'function' || !el.offsetWidth) return; // offline or hidden on small screens

    const cities = [
        [28.61, 77.21], [19.08, 72.88], [13.08, 80.27], [12.97, 77.59], [22.57, 88.36],
        [17.39, 78.49], [23.02, 72.57], [26.91, 75.79], [18.52, 73.86], [26.85, 80.95],
        [21.15, 79.09], [25.59, 85.14], [30.73, 76.78], [9.93, 76.27], [20.30, 85.82]
    ];
    const hub = cities[3];
    const arcs = cities.filter(c => c !== hub).map(c => ({
        startLat: hub[0], startLng: hub[1], endLat: c[0], endLng: c[1]
    }));

    const world = Globe()(el)
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('rgba(0,0,0,0)')
        .arcsData(arcs)
        .arcColor(() => ['rgba(59,130,246,0.15)', 'rgba(59,130,246,0.9)'])
        .arcDashLength(0.4)
        .arcDashGap(1.2)
        .arcDashInitialGap(() => Math.random())
        .arcDashAnimateTime(2600)
        .arcStroke(0.35)
        .pointsData(cities.map(([lat, lng]) => ({ lat, lng })))
        .pointColor(() => '#22C55E')
        .pointAltitude(0.01)
        .pointRadius(0.35)
        .width(el.offsetWidth)
        .height(el.offsetHeight);

    world.pointOfView({ lat: 18, lng: 70, altitude: 1.6 });
    const controls = world.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.enableZoom = false;

    window.addEventListener('resize', () => world.width(el.offsetWidth).height(el.offsetHeight));
}
