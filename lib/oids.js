// Mini SMPS OID map, from the agent firmware's mib.h (2026-10-07).
// Base 1.3.6.1.4.1.2254.2.51.1.1 (the firmware header writes it as 43.6.1.4.1.2254...).

const BASE = '1.3.6.1.4.1.2254.2.51.1.1';

const CELL_COUNT = 15;
const NTC_COUNT = 3;
const LOAD_COUNT = 3;     // DC load outputs, each behind an eFuse and with its own energy meter
const RELAY_COUNT = 2;

// Polled every cycle. Order matters: the first batch doubles as the reachability probe.
const OIDS = {
    // Standard MIB-II
    sysUpTime: '1.3.6.1.2.1.1.3.0',
    sysName: '1.3.6.1.2.1.1.5.0',

    // product (static strings in the agent; not in mib.h but answered by the unit)
    productName: `${BASE}.1.1.0`,
    productVersion: `${BASE}.1.2.0`,
    productDate: `${BASE}.1.3.0`,

    // status
    bmsLive: `${BASE}.12.1.0`,
    rectifierLive: `${BASE}.12.2.0`,

    // rectifier
    dcOpVoltageRect: `${BASE}.8.1.0`,
    dcOpCurRect: `${BASE}.8.2.0`,
    acIpVoltageRect: `${BASE}.8.3.0`,
    busVoltage: `${BASE}.8.4.0`,
    outputPowerRect: `${BASE}.8.5.0`,
    ambientTempRect: `${BASE}.8.6.0`,
    srTemp: `${BASE}.8.7.0`,
    llcTemp: `${BASE}.8.8.0`,
    pfcTemp: `${BASE}.8.9.0`,
    rectifierOnStatus: `${BASE}.8.10.0`,
    rectifierAlarmStatus: `${BASE}.8.11.0`,
    rectInputEnergy: `${BASE}.8.12.0`,
    rectOutputEnergy: `${BASE}.8.13.0`,

    // relays (read-write)
    relay1State: `${BASE}.9.1.0`,
    relay2State: `${BASE}.9.2.0`,

    // eFuses on the load outputs (status + fault count; reset is write-only in practice)
    efuse1Status: `${BASE}.10.1.0`,
    efuse1FaultCount: `${BASE}.10.3.0`,
    efuse2Status: `${BASE}.10.4.0`,
    efuse2FaultCount: `${BASE}.10.6.0`,
    efuse3Status: `${BASE}.10.7.0`,
    efuse3FaultCount: `${BASE}.10.9.0`,

    // energy meters
    energyLoad1: `${BASE}.13.1.0`,
    energyLoad2: `${BASE}.13.2.0`,
    energyLoad3: `${BASE}.13.3.0`,
    energyLoadTotal: `${BASE}.13.4.0`,
    energyBattery: `${BASE}.13.5.0`,

    // bms
    totalVoltageBms: `${BASE}.7.1.0`,
    chargingCurrent: `${BASE}.7.2.0`,
    dischargingCurrent: `${BASE}.7.3.0`,
    remainingCapacity: `${BASE}.7.4.0`,
    totalCapacity: `${BASE}.7.5.0`,
    dischargeCycle: `${BASE}.7.6.0`,
    remainingSoc: `${BASE}.7.7.0`,
    protectionStatus: `${BASE}.7.8.0`,
    mosfetControlStatus: `${BASE}.7.24.0`,
    productionDate: `${BASE}.7.25.0`,
    softwareVersion: `${BASE}.7.26.0`,
    numberOfBattery: `${BASE}.7.27.0`,
    numberOfNtc: `${BASE}.7.28.0`
};

for (let i = 1; i <= NTC_COUNT; i++) {
    OIDS[`temperatureValueNtc${i}`] = `${BASE}.7.${28 + i}.0`;
}
for (let i = 1; i <= CELL_COUNT; i++) {
    OIDS[`voltageValueCell${i}`] = `${BASE}.7.${33 + i}.0`;
}
for (let i = 1; i <= CELL_COUNT; i++) {
    OIDS[`cellBalanceStatusFlag${i}`] = `${BASE}.7.${8 + i}.0`;
}

// Objects the dashboard may SET (all READWRITE BYTE in mib.h). value lists are what the UI sends.
const WRITABLE = {
    relay1State: { oid: `${BASE}.9.1.0`, values: [0, 1] },
    relay2State: { oid: `${BASE}.9.2.0`, values: [0, 1] },
    efuse1Reset: { oid: `${BASE}.10.2.0`, values: [1] },
    efuse2Reset: { oid: `${BASE}.10.5.0`, values: [1] },
    efuse3Reset: { oid: `${BASE}.10.8.0`, values: [1] }
};

module.exports = { OIDS, WRITABLE, BASE, CELL_COUNT, NTC_COUNT, LOAD_COUNT, RELAY_COUNT };
