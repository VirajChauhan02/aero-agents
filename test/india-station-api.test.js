import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIndiaCpcbStations } from '../services/indiaAqiService.js';

const stationTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date()).replace(',', '');
const ok = data => ({ ok: true, json: async () => data });

test('station API validates coordinates/time/AQI, recalculates Haversine distance, deduplicates and accepts AQI zero', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ok({
    meta: { source: { name: 'CPCB feed', url: 'https://data.gov.in/example' } },
    data: [
      { id: 'bad-coord', station: 'Invalid Coordinates', latitude: 99, longitude: 77, updated: stationTime, aqi: 20 },
      { id: 'bad-aqi', station: 'Invalid AQI', latitude: 28.62, longitude: 77.2, updated: stationTime, aqi: 700 },
      { id: 'stale', station: 'Stale nearest', latitude: 28.621, longitude: 77.2, updated: '2020-01-01 10:00', aqi: 20 },
      { id: 'zero', station: 'Zero valid - DPCC', latitude: 28.62181, longitude: 77.1944633, updated: stationTime, aqi: 0, pollutants: {} },
      { id: 'zero-duplicate', station: 'Zero valid - DPCC', latitude: 28.62181, longitude: 77.1944633, updated: stationTime, aqi: 0, pollutants: {} },
      { id: 'second', station: 'Second valid - CPCB', latitude: 28.595528, longitude: 77.225749, updated: stationTime, aqi: 120, pollutants: {} },
    ],
  });
  try {
    const result = await fetchIndiaCpcbStations(28.6139, 77.209, { radiusKm: 25 });
    assert.deepEqual(result.stations.map(station => station.station), ['Zero valid - DPCC', 'Second valid - CPCB']);
    assert.equal(result.stations[0].aqi, 0);
    assert.ok(Math.abs(result.stations[0].distanceKm - 1.67) < 0.02);
    assert.equal(result.stations[0].agency, 'DPCC');
    assert.equal(result.stations[1].aqi, 120, 'valid next-nearest station survives a stale closer station');
    assert.equal(result.source, 'CPCB feed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
