import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMedian, classifyIndianSearchMode, haversineDistanceKm, selectCpcbAqi } from '../services/indiaAqiService.js';

const station = (i, distanceKm, aqi) => ({
  id: `fixture-${i}`, station: `Fixture station ${i}`, agency: 'Fixture board',
  latitude: 19 + i / 1000, longitude: 72 + i / 1000,
  distanceKm, aqi, observedAt: '2026-11-21 12:00', ageMinutes: 30,
  pollutantSubIndices: {}, source: 'deterministic test fixture', qualityFlags: [],
});

test('median handles odd/even inputs, empty inputs and does not mutate values', () => {
  const values = [193, 88, 185, 176, 165];
  assert.equal(calculateMedian(values), 176);
  assert.deepEqual(values, [193, 88, 185, 176, 165]);
  assert.equal(calculateMedian([1, 3, 7, 9]), 5);
  assert.equal(calculateMedian([]), null);
});

test('haversine distance uses station coordinates', () => {
  assert.ok(Math.abs(haversineDistanceKm(28.6139, 77.209, 28.62181, 77.1944633) - 1.67) < 0.02);
});

test('citywide median mode handles zero through more than five stations', () => {
  assert.equal(selectCpcbAqi([], 'citywide').selectedSource, 'open_meteo');
  assert.equal(selectCpcbAqi([station(1, 1, 88)], 'citywide').headlineAqi, 88);
  assert.equal(selectCpcbAqi([station(1, 1, 88), station(2, 2, 165)], 'citywide').selectedSource, 'cpcb_station');
  assert.equal(selectCpcbAqi([station(1, 1, 88), station(2, 2, 165), station(3, 3, 176)], 'citywide').headlineAqi, 165);
  const five = [88, 165, 176, 185, 193].map((aqi, i) => station(i, i + 1, aqi));
  const fiveResult = selectCpcbAqi(five, 'citywide');
  assert.equal(fiveResult.headlineAqi, 176);
  assert.equal(fiveResult.stationCount, 5);
  const many = [...five, station(6, 6, 199), station(7, 7, 212)];
  const manyResult = selectCpcbAqi(many, 'citywide');
  assert.equal(manyResult.stationCount, 5);
  assert.equal(manyResult.headlineAqi, 176);
});

test('hyperlocal chooses nearest within five km and keeps a regional median separate', () => {
  const stations = [station(1, 1.2, 312), station(2, 2.4, 170), station(3, 7, 240), station(4, 15, 164)];
  const result = selectCpcbAqi(stations, 'hyperlocal');
  assert.equal(result.selectedSource, 'cpcb_station');
  assert.equal(result.headlineAqi, 312);
  assert.equal(result.selectedStation.station, 'Fixture station 1');
  assert.equal(result.regionalMedianAqi, 205);
  assert.equal(result.regionalMedianStationCount, 4);
});

test('hyperlocal falls back to regional median when no valid station is within five km', () => {
  const result = selectCpcbAqi([station(1, 6, 88), station(2, 10, 165), station(3, 14, 176)], 'hyperlocal');
  assert.equal(result.selectedSource, 'cpcb_station_median');
  assert.equal(result.headlineAqi, 165);
});

test('unusual valid readings are flagged but never discarded; AQI zero remains valid', () => {
  const result = selectCpcbAqi([station(1, 1, 0), station(2, 2, 10), station(3, 3, 11), station(4, 4, 12), station(5, 5, 500)], 'citywide');
  assert.equal(result.selectedStations.length, 5);
  assert.ok(result.selectedStations.some(item => item.aqi === 0));
  assert.ok(result.selectedStations.find(item => item.aqi === 500).qualityFlags.length > 0);
});

test('place scope uses search intent and geocoder population/feature metadata', () => {
  assert.equal(classifyIndianSearchMode({ city: 'My Location' }), 'hyperlocal');
  assert.equal(classifyIndianSearchMode({ featureCode: 'PPLX', population: 800000 }), 'hyperlocal');
  assert.equal(classifyIndianSearchMode({ featureCode: 'PPLA', population: 15000 }), 'citywide');
  assert.equal(classifyIndianSearchMode({ population: 250000 }), 'citywide');
  assert.equal(classifyIndianSearchMode({ population: 1000 }), 'hyperlocal');
});
