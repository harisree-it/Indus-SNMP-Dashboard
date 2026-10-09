// Mini SMPS dashboard configuration.
// Everything a deployment may need to tune lives here: SNMP access, product ratings,
// raw-value scaling, alarm thresholds and login. Environment variables override the
// values that differ per server.

module.exports = {
    server: {
        port: Number(process.env.PORT) || 3000,
        host: process.env.HOST || '0.0.0.0'
    },

    branding: {
        company: 'Power Smart',
        product: 'Mini SMPS',
        tagline: 'Telecom SMPS · SNMP Monitor'
    },

    // Login for the web UI. Change these (or set DASH_USER / DASH_PASS) before deploying.
    auth: {
        username: process.env.DASH_USER || 'admin',
        password: process.env.DASH_PASS || 'Delta@123',
        sessionHours: 12
    },

    snmp: {
        readCommunity: 'read',        // default per site; a site can override it
        port: 161,                    // default per site; use another port for NAT/port-forwarded sites
        timeoutMs: 1500,
        retries: 1,
        // OIDs per GET request. The previous dashboard polled one OID per request because the
        // agent struggled with large requests; 10 keeps a cycle fast over WAN links. If a batch is
        // rejected (tooBig/genErr) the poller automatically retries that batch one OID at a time.
        batchSize: 10,
        pollIntervalMs: 5000,         // pause between the end of one cycle and the start of the next
        offlineAfterFailures: 3,      // consecutive failed cycles before a site is shown offline
        // SET (relay switching, eFuse reset). Default per site; a site can override it.
        // Set controlsEnabled: false to make the dashboard strictly read-only.
        writeCommunity: process.env.SNMP_WRITE_COMMUNITY || 'write',
        controlsEnabled: true
    },

    // Product ratings used for load %, backup time and fallbacks.
    ratings: {
        rectifierWatts: 300,
        batteryAh: 15,
        batteryNominalV: 48
    },

    // Raw SNMP value -> engineering unit. value = raw / divisor.
    // Units marked "MIB" come from the agent MIB; the rest follow what the previous
    // dashboard used on hardware. Verify on the first unit with the Diagnostics tab.
    scale: {
        battVoltage: 100,       // MIB: 10 mV
        // Battery current, decoded as in the previous SNMP dashboard (checked on the first unit 2026-10-09
        // against the SOC drop rate). The result then goes through calibration.battCurrent.
        battCurrent: 100,       // MIB: 10 mA
        battChargeFactor: 1.12, // chargingCurrent: sensed A = raw * 1.12 / battCurrent
        // dischargingCurrent does NOT follow the MIB's 10 mA: under load the unit sends a negative int16
        // that rises toward zero as the current increases (about -2022 at 0 A, e.g. -1808 = 2.2 A).
        // sensed A = slope * signed + offset. 0 = idle; positive values are read as 10 mA.
        battDischarge: { slope: 0.0115, offset: 23.25 },
        battCapacity: 100,      // MIB: 10 mAh
        cellVoltage: 1000,      // MIB: mV
        // NTC: MIB says 0.1 K, but earlier firmware sent plain °C.
        // 'auto' treats values above 2000 as 0.1 K and the rest as °C. Or force 'deciKelvin' / 'celsius'.
        ntcUnit: 'auto',
        // Rectifier DC output voltage: 'auto' treats values above 200 as 10 mV units, else volts.
        rectDcVoltage: 'auto',
        rectDcCurrent: 10,      // 0.1 A
        rectAcVoltage: 1,
        rectBusVoltage: 1,
        rectTemp: 1,
        // Energy counters (rectInputEnergy, rectOutputEnergy, energyLoad*, energyBattery).
        // NOT CONFIRMED: assumed raw = Wh. Check against the CAN GUI's energy value and adjust.
        energy: 1
    },

    // Load outputs (eFuse + energy meter each) and relays, as named on the dashboard.
    outputs: {
        loadNames: ['Load 1', 'Load 2', 'Load 3'],
        relayNames: ['Relay 1', 'Relay 2'],
        // eFuse status value meaning "output on". NOT CONFIRMED - assumed 1 = on, 0 = off/tripped.
        efuseOnValue: 1,
        // A rising eFuse fault count raises "eFuse tripped" for this long (independent of the status encoding).
        efuseTripAlarmMinutes: 15
    },

    // Linear correction applied after scaling: actual = sensed * gain + offset.
    // Readings below the deadband are treated as 0 A to suppress noise around zero.
    calibration: {
        rectCurrent: { gain: 1, offset: 0, deadband: 0.1 },
        // Sensed -> actual battery current, from the previous dashboard's calibration table.
        battCurrent: { gain: 0.8778, offset: 0.0182, deadband: 0.1 }
    },

    thresholds: {
        acFailV: 90,              // AC input below this = mains failure
        socWarn: 35,              // matches the agent's bmsSocLowTrap level
        socCritical: 20,
        rectTempWarn: 65,         // hottest rectifier sensor, °C
        rectTempCritical: 80,
        battTempWarn: 45,         // hottest battery NTC, °C
        battTempCritical: 55,
        cellDeltaWarnMv: 150,     // max - min cell voltage
        loadWarnPct: 90,          // of ratings.rectifierWatts
        loadCriticalPct: 100,
        // "System status" rows (same checks as the CAN GUI)
        pfcBusMinV: 300,          // PFC bus above this = PFC active
        dcOutputMinV: 42          // DC output above this (and no rectifier fault) = DC output OK
    },

    // Rectifier alarm bitfield (rectifierAlarmStatus). Uses the Mini SMPS rectifier fault byte from the
    // Power Smart CAN GUI (CAN ID 0x201, byte 1), assuming the SNMP card relays it unchanged - confirm
    // once the rectifier reports. Unlisted bits show as "Alarm bit n".
    rectifierAlarmBits: {
        0: 'Input overvoltage',
        1: 'Input undervoltage',
        2: 'Input overvoltage (recovery)',
        3: 'Input undervoltage (recovery)',
        4: 'Output short circuit',
        5: 'Output overvoltage',
        6: 'Output undervoltage',
        7: 'Output overcurrent'
    },

    // BMS protection bitfield (protectionStatus).
    // NOT CONFIRMED: the first unit (fw v1.1, 2026-10-07) reports 27 (0x1B) on a healthy idle pack,
    // which this JBD-style layout reads as contradictory faults. Until the real bit map is known the
    // value is shown raw and raises no alarms. Fill in the correct names and set this to true.
    bmsProtectionAlarms: false,
    bmsProtectionBits: {
        0: 'Cell overvoltage',
        1: 'Cell undervoltage',
        2: 'Pack overvoltage',
        3: 'Pack undervoltage',
        4: 'Charge over-temperature',
        5: 'Charge under-temperature',
        6: 'Discharge over-temperature',
        7: 'Discharge under-temperature',
        8: 'Charge overcurrent',
        9: 'Discharge overcurrent',
        10: 'Short circuit',
        11: 'Front-end IC error',
        12: 'MOSFET software lock'
    },

    // Map tiles for the fleet map. OpenStreetMap needs no API key (keep usage light, per its
    // tile policy); point this at an internal tile server for intranet-only deployments.
    map: {
        tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    },

    history: {
        sampleEveryMs: 30000,     // one trend point per site every 30 s
        keepHours: 24
    },

    alarmLogSize: 500,

    // Seeded into data/devices.json the first time the server starts.
    // After that, add/edit/remove sites from the dashboard.
    defaultDevices: [
        { name: 'Lab Unit', ip: '192.168.100.12', lat: 12.8237, lng: 77.6826 }
    ]
};
