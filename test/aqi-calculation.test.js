import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCpcbSubIndexSufficiency,
  calculateEpaSubIndices,
  calculateIndiaNaqiSubIndices,
  getAqiCategory,
  getIndiaAqiCategory,
} from '../services/aqiService.js';

test('CPCB 92.9/95.9 produces partial AQI 207 and is explicitly indicative', () => {
  const result = calculateIndiaNaqiSubIndices({ pm25: 92.9, pm10: 95.9 });
  assert.equal(result.pm25, 207);
  assert.equal(result.pm10, 96);
  assert.equal(result.maxAqi, 207);
  assert.equal(result.officialAqi, null);
  assert.equal(result.indicativeAqi, 207);
  assert.equal(result.status, 'insufficient_data');
  assert.equal(getIndiaAqiCategory(result.indicativeAqi).label, 'Poor');
});

test('CPCB overall AQI requires three pollutants, a PM pollutant, 24-hour averages and valid data', () => {
  const inputs = { pm25: 92.9, pm10: 95.9, no2: 12 };
  const validQuality = { averagingHours: 24, validHours: 16, dataQualityValid: true };
  const sufficient = calculateIndiaNaqiSubIndices(inputs, validQuality);
  assert.equal(sufficient.status, 'official');
  assert.equal(sufficient.officialAqi, 207);

  assert.equal(calculateIndiaNaqiSubIndices({ pm25: 92.9, pm10: 95.9 }, validQuality).officialAqi, null);
  assert.equal(calculateIndiaNaqiSubIndices({ no2: 92.9 }, validQuality).officialAqi, null);
  assert.equal(calculateIndiaNaqiSubIndices(inputs, { ...validQuality, averagingHours: 1 }).officialAqi, null);
  assert.equal(calculateIndiaNaqiSubIndices(inputs, { ...validQuality, validHours: 15 }).officialAqi, null);
  assert.equal(calculateIndiaNaqiSubIndices(inputs, { ...validQuality, dataQualityValid: false }).officialAqi, null);
});

test('CPCB sufficiency checker rejects one/two pollutants and missing PM or averaging proof', () => {
  assert.equal(assessCpcbSubIndexSufficiency({ 'PM2.5': 207, NO2: 50 }).sufficient, false);
  assert.equal(assessCpcbSubIndexSufficiency({ NO2: 50, SO2: 40, O3: 80 }, { averagingHours: 24, validHours: 20, dataQualityValid: true }).sufficient, false);
  assert.equal(assessCpcbSubIndexSufficiency({ 'PM2.5': 207, PM10: 96, NO2: 34 }).sufficient, false);
  assert.equal(assessCpcbSubIndexSufficiency({ 'PM2.5': 207, PM10: 96, NO2: 34 }, { averagingHours: 24, validHours: 16, dataQualityValid: true }).sufficient, true);
});

test('CPCB handles every supplied integer breakpoint and fractional transition without gaps', () => {
  const cases = [
    ['pm25', [[30, 50], [31, 51], [60, 100], [61, 101], [90, 200], [91, 201], [120, 300], [121, 301], [250, 400], [251, 401], [500, 500]]],
    ['pm10', [[50, 50], [51, 51], [100, 100], [101, 101], [250, 200], [251, 201], [350, 300], [351, 301], [430, 400], [431, 402], [600, 500]]],
    ['no2', [[40, 50], [41, 51], [80, 100], [81, 101], [180, 200], [181, 201], [280, 300], [281, 301], [400, 400], [401, 401], [800, 500]]],
  ];
  for (const [pollutant, values] of cases) {
    for (const [concentration, expected] of values) {
      assert.equal(calculateIndiaNaqiSubIndices({ [pollutant]: concentration })[pollutant], expected, `${pollutant} at ${concentration}`);
    }
    const prev = calculateIndiaNaqiSubIndices({ [pollutant]: 30.0 })[pollutant];
    const fractional = calculateIndiaNaqiSubIndices({ [pollutant]: pollutant === 'pm25' ? 30.5 : pollutant === 'pm10' ? 50.5 : 40.5 })[pollutant];
    assert.ok(fractional >= prev, `${pollutant} fractional boundary must not decrease`);
  }
  assert.equal(calculateIndiaNaqiSubIndices({ pm25: -1, pm10: Number.NaN, no2: Infinity }).indicativeAqi, null);
});

test('CPCB categories include the official India labels and badge bands', () => {
  assert.deepEqual([50, 51, 101, 201, 301, 401].map(value => getIndiaAqiCategory(value).label), [
    'Good', 'Satisfactory', 'Moderate', 'Poor', 'Very Poor', 'Severe',
  ]);
  assert.equal(getIndiaAqiCategory(null).label, 'Unavailable');
});

test('EPA truncates PM2.5 to one decimal and applies 2024 breakpoint values', () => {
  const cases = [[0, 0], [9, 50], [9.09, 50], [9.1, 51], [35.4, 100], [35.5, 101], [55.4, 150], [55.5, 151], [125.4, 200], [125.5, 201], [225.4, 300], [225.5, 301], [325.4, 500], [325.5, 500], [600, 500]];
  for (const [concentration, expected] of cases) {
    assert.equal(calculateEpaSubIndices({ pm25: concentration }).pm25, expected, `PM2.5 at ${concentration}`);
  }
  assert.equal(calculateEpaSubIndices({ pm25: 92.9, pm10: 95.9 }).maxAqi, 177);
  assert.equal(calculateEpaSubIndices({ pm25: 325.5 }).pm25CappedAt500, true);
});

test('US AQI category labels follow EPA bands', () => {
  assert.deepEqual([50, 51, 101, 151, 201, 301].map(value => getAqiCategory(value).label), [
    'Good', 'Moderate', 'Unhealthy for Sensitive Groups', 'Unhealthy', 'Very Unhealthy', 'Hazardous',
  ]);
});
