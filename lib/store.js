// Site list persisted to a JSON file so sites added from the dashboard survive restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST_RE = /^[A-Za-z0-9.\-:]{1,253}$/;

function validate(input, partial = false) {
    const out = {};
    const errors = [];

    if (!partial || input.name !== undefined) {
        const name = String(input.name ?? '').trim();
        if (!name || name.length > 60) errors.push('Name is required (max 60 characters)');
        out.name = name;
    }
    if (!partial || input.ip !== undefined) {
        const ip = String(input.ip ?? '').trim();
        if (!HOST_RE.test(ip)) errors.push('A valid IP address or hostname is required');
        out.ip = ip;
    }
    if (input.port !== undefined && input.port !== null && input.port !== '') {
        const port = Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Port must be 1-65535');
        out.port = port;
    } else if (input.port !== undefined) {
        out.port = null;
    }
    for (const key of ['community', 'writeCommunity']) {
        if (input[key] === undefined) continue;
        const c = String(input[key] ?? '').trim();
        if (c.length > 32 || /[^\x21-\x7E]/.test(c)) errors.push('Community must be up to 32 printable characters');
        out[key] = c || null;
    }
    for (const [key, min, max] of [['lat', -90, 90], ['lng', -180, 180]]) {
        if (input[key] === undefined) continue;
        if (input[key] === null || input[key] === '') { out[key] = null; continue; }
        const v = Number(input[key]);
        if (!Number.isFinite(v) || v < min || v > max) errors.push(`${key === 'lat' ? 'Latitude' : 'Longitude'} must be ${min} to ${max}`);
        out[key] = v;
    }
    return { value: out, errors };
}

class DeviceStore {
    constructor(file, seed = []) {
        this.file = file;
        if (fs.existsSync(file)) {
            this.devices = JSON.parse(fs.readFileSync(file, 'utf8'));
        } else {
            this.devices = [];
            for (const d of seed) this.devices.push({ id: this.newId(d.name), port: null, community: null, lat: null, lng: null, ...d });
            this.save();
        }
    }

    newId(name) {
        const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'site';
        let id;
        do { id = `${slug}-${crypto.randomBytes(2).toString('hex')}`; } while (this.get(id));
        return id;
    }

    list() { return this.devices; }

    get(id) { return (this.devices || []).find(d => d.id === id); }

    add(input) {
        const { value, errors } = validate(input);
        if (errors.length) return { errors };
        const device = { id: this.newId(value.name), port: null, community: null, lat: null, lng: null, ...value };
        this.devices.push(device);
        this.save();
        return { device };
    }

    // Returns a new object (not a mutation) so the monitor can compare old vs new address.
    update(id, input) {
        const i = this.devices.findIndex(d => d.id === id);
        if (i === -1) return { notFound: true };
        const { value, errors } = validate(input, true);
        if (errors.length) return { errors };
        const device = { ...this.devices[i], ...value, id };
        this.devices[i] = device;
        this.save();
        return { device };
    }

    remove(id) {
        const i = this.devices.findIndex(d => d.id === id);
        if (i === -1) return false;
        this.devices.splice(i, 1);
        this.save();
        return true;
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2));
        fs.renameSync(tmp, this.file);
    }
}

module.exports = { DeviceStore };
