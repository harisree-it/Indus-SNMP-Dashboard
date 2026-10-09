// Quick SNMP reachability check for one Mini SMPS unit, e.g. during commissioning.
//   node tools/test-connection.js 192.168.100.11 [port] [community]

const snmp = require('net-snmp');
const { OIDS } = require('../lib/oids');

const [ip = '192.168.100.11', port = '161', community = 'read'] = process.argv.slice(2);
const keys = ['sysUpTime', 'productName', 'productVersion', 'bmsLive', 'rectifierLive',
    'totalVoltageBms', 'remainingSoc', 'acIpVoltageRect', 'dcOpVoltageRect', 'dcOpCurRect'];

console.log(`Mini SMPS SNMP check -> ${ip}:${port} community "${community}" (v2c)\n`);

const session = snmp.createSession(ip, community, { port: Number(port), retries: 1, timeout: 3000, version: snmp.Version2c });
session.on('error', () => {});

session.get(keys.map(k => OIDS[k]), (error, varbinds) => {
    if (error) {
        console.error(`[FAIL] ${error.message}\n`);
        console.log('Check: IP/port reachable (ping), UDP 161 allowed by firewall/antivirus,');
        console.log('community string, and that the unit has finished booting.');
    } else {
        varbinds.forEach((vb, i) => {
            const v = snmp.isVarbindError(vb) ? `(${snmp.varbindError(vb)})` : Buffer.isBuffer(vb.value) ? vb.value.toString() : vb.value;
            console.log(`  ${keys[i].padEnd(18)} ${vb.oid.padEnd(36)} ${v}`);
        });
        console.log('\n[OK] Agent is responding. Add this unit from the dashboard.');
    }
    session.close();
});
