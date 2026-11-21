
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.EVAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqi-eval-'));
process.env.PYTHON_EXECUTABLE = 'definitely-not-python';

const { runCoordinator } = await import('../agents/coordinator.js');
const { addObservation, scoreCity } = await import('../services/evaluationService.js');

// Keep timestamps explicitly in UTC.
const iso = ms => new Date(ms).toISOString();

function mockProvider(nowMs, { pastBias = 0 } = {}) {
  const start = nowMs - 8 * 24 * 3600000;
  const hours = Array.from({ length: 15 * 24 }, (_, i) => start + i * 3600000);
  const f = t => 80 + 10 * Math.sin(t / 3.6e6 / 5);

  const h = {
    time: hours.map(iso),
    pm10: hours.map(() => 40),
    pm2_5: hours.map(t => t <= nowMs ? 30 + pastBias : 30),
    carbon_monoxide: hours.map(() => 300),
    nitrogen_dioxide: hours.map(() => 20),
    sulphur_dioxide: hours.map(() => 5),
    ozone: hours.map(() => 50),
    aerosol_optical_depth: hours.map(() => 0.3),
    us_aqi: hours.map(t => Math.round(f(t) + (t <= nowMs ? pastBias : 0))),
  };

  const aqi = {
    current: {
      time: iso(nowMs),
      pm10: 40,
      pm2_5: 30,
      carbon_monoxide: 300,
      nitrogen_dioxide: 20,
      sulphur_dioxide: 5,
      ozone: 50,
      aerosol_optical_depth: 0.3,
      dust: 1,
      us_aqi: Math.round(f(nowMs)),
      european_aqi: 40,
    },
    hourly: h,
  };

  const wx = {
    current: {
      time: iso(nowMs),
      temperature_2m: 28,
      relative_humidity_2m: 60,
      precipitation: 0,
      cloud_cover: 20,
      shortwave_radiation: 200,
      surface_pressure: 1008,
      wind_speed_10m: 9,
      wind_direction_10m: 200,
      boundary_layer_height: 400,
      weather_code: 1,
    },
    hourly: {
      time: h.time,
      temperature_2m: hours.map(t => 25 + (t <= nowMs ? pastBias : 0)),
      relative_humidity_2m: hours.map(() => 60),
      wind_speed_10m: hours.map(() => 9),
      wind_direction_10m: hours.map(() => 200),
      boundary_layer_height: hours.map(() => 400),
      surface_pressure: hours.map(() => 1008),
      weather_code: hours.map(() => 1),
      precipitation: hours.map(() => 0),
      precipitation_probability: hours.map(() => 10),
      cloud_cover: hours.map(() => 20),
      shortwave_radiation: hours.map(() => 200),
    },
    daily: {
      time: [],
      weather_code: [],
      temperature_2m_max: [],
      temperature_2m_min: [],
      precipitation_probability_max: [],
      wind_speed_10m_max: [],
    },
  };

  const localDate = d =>
    new Date(nowMs + 19800000 + d * 86400000).toISOString().slice(0, 10);

  const local = {
    timezone: 'Asia/Kolkata',
    utc_offset_seconds: 19800,
    current: {
      time: new Date(nowMs + 19800000).toISOString().slice(0, 16),
      temperature_2m: 28,
    },
    daily: {
      time: [0, 1, 2, 3, 4, 5, 6].map(localDate),
      weather_code: Array(7).fill(1),
      temperature_2m_max: Array(7).fill(33),
      temperature_2m_min: Array(7).fill(24),
      precipitation_probability_max: Array(7).fill(10),
      wind_speed_10m_max: Array(7).fill(18),
    },
  };

  return async url => {
    const body = String(url).includes('air-quality-api')
      ? aqi
      : String(url).includes('timezone=auto')
        ? local
        : wx;

    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
}

const coords = { lat: 19.07, lon: 72.87 };
const T0 = Date.UTC(2026, 10, 20, 6, 0, 0);

test('Coordinator runs all agents, uses local-day weather, and logs forecasts', async () => {
  globalThis.fetch = mockProvider(T0);

  const location = {
    city: 'Coordinatorville',
    name: 'Coordinatorville',
    ...coords,
  };

  const result = await runCoordinator(location, coords);

  const names = result.agentTrace.agents.map(a => a.agent);

  assert.deepEqual(names, [
    'Data Agent',
    'Weather Agent',
    'AQI Agent',
    'Explainability Agent',
    'Alert/Recommendation Agent',
    'Monitoring Agent',
  ]);

  assert.ok(
    result.agentTrace.agents.every(a => a.status === 'ok'),
    JSON.stringify(result.agentTrace.agents)
  );

  assert.equal(result.meta.timezone, 'Asia/Kolkata');
  assert.equal(result.chemistryData.dailyWeather[0].tempMax, 33);
  assert.equal(result.predictionsData.modelStatus, 'api_fallback');
  assert.equal(result.explainability.modelDrivers.length, 0);
  assert.ok(result.explainability.meteorologicalContext.length > 0);
  assert.equal(result.evaluation.forecastsLogged, 3);
  assert.equal(result.evaluation.status, 'collecting');
});

test('Accuracy appears once targets pass, and measures the error honestly', async () => {
  const location = {
    city: 'Accuracyville',
    name: 'Accuracyville',
    ...coords,
  };

  globalThis.fetch = mockProvider(T0);
  await runCoordinator(location, coords);

  globalThis.fetch = mockProvider(T0 + 7 * 3600000, { pastBias: 3 });
  const result = await runCoordinator(location, coords);

  const ev = result.evaluation;

  assert.equal(ev.status, 'tracking');
  assert.equal(ev.byHorizon[1].usAqi.n, 1);
  assert.equal(ev.byHorizon[1].usAqi.mae, 3);
  assert.equal(ev.byHorizon[1].usAqi.bias, -3);
  assert.equal(ev.byHorizon[6].usAqi.n, 1);
  assert.equal(ev.byHorizon[24].usAqi.n, 0);
});

test('Observed independent values are compared with Open-Meteo', async () => {
  globalThis.fetch = mockProvider(T0 + 7 * 3600000, { pastBias: 3 });

  const location = {
    city: 'Observedville',
    name: 'Observedville',
    ...coords,
  };

  addObservation({
    city: 'Observedville',
    time: new Date(T0 + 3600000).toISOString(),
    temperature: 30,
    source: 'test METAR',
  });

  const { dataAgent } = await import('../agents/dataAgent.js');
  const data = await dataAgent(location, coords);
  const score = scoreCity('Observedville', data.output);

  assert.equal(score.openMeteoVsObserved.temperatureC.n, 1);
  assert.equal(score.openMeteoVsObserved.temperatureC.bias, -2);
});
