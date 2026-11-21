import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderForecast } from '../services/analysisService.js';

test('provider fallback keeps seven weather days and marks missing AQI as unavailable', () => {
  const base = new Date('2026-11-19T00:00:00Z');
  const time = [];
  const usAqi = [];
  const pm25 = [];
  const temperature = [];
  const relativeHumidity = [];
  const windSpeed = [];
  const precipitation = [];
  const precipProb = [];
  const cloudCover = [];
  const surfacePressure = [];
  const weatherCode = [];
  for (let i = 0; i < 168; i++) {
    time.push(new Date(base.getTime() + i * 3600000).toISOString());
    // Simulate five days of provider AQI, followed by unavailable AQI.
    usAqi.push(i < 120 ? 80 : null);
    pm25.push(i < 120 ? 20 : null);
    temperature.push(25);
    relativeHumidity.push(60);
    windSpeed.push(3);
    precipitation.push(0);
    precipProb.push(0);
    cloudCover.push(20);
    surfacePressure.push(1012);
    weatherCode.push(0);
  }
  const dailyWeather = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    return { date, tempMax: 30, tempMin: 20, rainProb: 0, windMax: 4, weatherCondition: 'Clear Sky', weatherIcon: '☀️' };
  });
  const result = buildProviderForecast({
    current: { time: '2026-11-19T00:00:00Z' },
    hourly: { time, usAqi, pm25, temperature, relativeHumidity, windSpeed, precipitation, precipProb, cloudCover, surfacePressure, weatherCode },
    dailyWeather,
  }, 'Test City');

  assert.equal(result.modelStatus, 'api_fallback');
  assert.equal(result.dailySummary.length, 7);
  assert.equal(result.forecastCoverage.weatherDays, 7);
  assert.equal(result.forecastCoverage.aqiDays, 5);
  assert.equal(result.dailySummary[0].avgAqi, 80);
  assert.equal(result.dailySummary[6].avgAqi, null);
  assert.equal(result.dailySummary[6].aqiCategory, 'AQI unavailable');
  assert.equal(result.hourlyTrajectory.some(row => row.predictedAqi === 0), false);
});
