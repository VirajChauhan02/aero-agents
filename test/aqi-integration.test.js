import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAtmosphericChemistry } from '../services/aqiService.js';
import { aqiAgent } from '../agents/aqiAgent.js';

const now = new Date();
const istParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const stationTime = `${istParts.year}-${istParts.month}-${istParts.day} ${istParts.hour}:${istParts.minute}`;

function ok(data) { return { ok: true, status: 200, json: async () => data }; }

test('fresh nearby CPCB overall AQI is primary even with fewer than three pollutant sub-indices', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('air-quality-api.open-meteo.com')) return ok({
      current: { time: new Date().toISOString(), pm2_5: 92.9, pm10: 95.9, nitrogen_dioxide: 12, sulphur_dioxide: 5, carbon_monoxide: 100, ozone: 30, us_aqi: 163 },
      hourly: {
        time: [new Date(Date.now() + 3600000).toISOString()],
        pm2_5: [20], pm10: [30], us_aqi: [70],
      },
    });
    if (url.includes('api.dharun.dev')) return ok({ data: [{
      station: 'Test CPCB station', city: 'Test City', updated: stationTime,
      latitude: 19.073, longitude: 72.873, aqi: 88,
      agency: 'DPCC',
      pollutants: { 'PM2.5': { avg: 88 } },
    }] });
    if (url.includes('timezone=auto')) return ok({ timezone: 'Asia/Kolkata', utc_offset_seconds: 19800, current: { time: new Date().toISOString() }, daily: { time: [] } });
    return ok({
      current: { temperature_2m: 28 },
      hourly: {},
      daily: { time: [] },
    });
  };

  try {
    const data = await fetchAtmosphericChemistry(19.07, 72.87, 'India', { location: { city: 'Mumbai', searchMode: 'citywide' }, searchMode: 'citywide' });
    assert.equal(data.current.indiaAqi, 88);
    assert.equal(data.current.indiaIndicativeAqi, 207);
    assert.equal(data.current.indiaAqiStatus, 'official');
    assert.equal(data.current.indiaReportedCpcbAqi, 88);
    assert.equal(data.current.indiaCpcbDataSufficiency.sufficient, false);
    assert.equal(data.current.indiaCategory.label, 'Satisfactory');
    assert.equal(data.current.indiaAqiAgency, 'DPCC');
    assert.match(data.current.pollutantConcentrationSource, /not CPCB station measurements/);
    assert.equal(data.current.usAqi, 177);

    const before = structuredClone(data.current);
    process.env.PYTHON_EXECUTABLE = 'definitely-not-python';
    const prediction = await aqiAgent(data, 'No Model Test City');
    assert.equal(prediction.output.modelStatus, 'api_fallback');
    assert.deepEqual(data.current, before, 'forecast agent must not modify the live AQI object');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Delhi CPCB headline remains independent of Open-Meteo AQI and XGBoost forecast', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('air-quality-api.open-meteo.com')) return ok({
      current: { time: new Date().toISOString(), pm2_5: 45, pm10: 80, nitrogen_dioxide: 12, us_aqi: 121 },
      hourly: { time: [new Date(Date.now() + 3600000).toISOString()], pm2_5: [20], pm10: [30], us_aqi: [80] },
    });
    if (url.includes('api.dharun.dev')) return ok({ data: [{
      station: 'Talkatora Garden, Delhi - DPCC', agency: 'DPCC', updated: stationTime,
      latitude: 28.62181, longitude: 77.1944633, aqi: 312,
      pollutants: { 'PM2.5': { avg: 312 }, PM10: { avg: 195 }, CO: { avg: 110 } },
    }] });
    if (url.includes('timezone=auto')) return ok({ timezone: 'Asia/Kolkata', current: { time: new Date().toISOString() }, daily: { time: [] } });
    return ok({ current: { temperature_2m: 28 }, hourly: {}, daily: { time: [] } });
  };
  try {
    const data = await fetchAtmosphericChemistry(28.63, 77.21, 'India', { location: { city: 'Delhi', searchMode: 'hyperlocal' }, searchMode: 'hyperlocal' });
    assert.equal(data.current.indiaAqi, 312);
    assert.equal(data.current.indiaCategory.label, 'Very Poor');
    assert.equal(data.current.indiaAqiStation, 'Talkatora Garden, Delhi - DPCC');
    assert.ok(Math.abs(data.current.indiaAqiDistanceKm - 1.7) < 0.1);
    assert.equal(data.current.indiaAqiAgency, 'DPCC');
    assert.equal(data.current.providerUsAqi, 121);
    assert.equal(data.current.liveAqi.selectedSource, 'cpcb_station');
    assert.equal(data.current.liveAqi.searchMode, 'hyperlocal');
    assert.equal(data.current.liveAqi.headlineAqi, 312);
    assert.equal(data.current.liveAqi.nearestStation.station, 'Talkatora Garden, Delhi - DPCC');
    assert.equal(data.current.liveAqi.nearestStation.agency, 'DPCC');
    assert.equal(data.current.liveAqi.fallbackAqi, 121);
    assert.equal(data.current.liveAqi.fallbackSource, 'Open-Meteo Model AQI');
    assert.equal(data.current.liveAqi.selectedStations[0].latitude, 28.62181);
    const forecast = await aqiAgent(data, 'Talkatora Garden');
    assert.ok(['ready', 'api_fallback'].includes(forecast.output.modelStatus));
    assert.equal(data.current.indiaAqi, 312, 'forecast must not override the live station AQI');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('city-wide India selection reports median and all selected station metadata', async () => {
  const originalFetch = globalThis.fetch;
  const stations = [312, 170, 240, 164].map((aqi, i) => ({
    station: `Delhi fixture ${i}`, agency: 'DPCC', updated: stationTime,
    latitude: 28.62 + i * 0.001, longitude: 77.20 + i * 0.001, aqi,
    pollutants: { 'PM2.5': { avg: aqi }, PM10: { avg: 90 + i } },
  }));
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('air-quality-api.open-meteo.com')) return ok({ current: { time: new Date().toISOString(), pm2_5: 30, pm10: 40, us_aqi: 77 }, hourly: { time: [new Date(Date.now() + 3600000).toISOString()], pm2_5: [20], pm10: [30], us_aqi: [70] } });
    if (url.includes('api.dharun.dev')) return ok({ data: stations });
    if (url.includes('timezone=auto')) return ok({ timezone: 'Asia/Kolkata', current: { time: new Date().toISOString() }, daily: { time: [] } });
    return ok({ current: { temperature_2m: 28 }, hourly: {}, daily: { time: [] } });
  };
  try {
    const data = await fetchAtmosphericChemistry(28.6139, 77.209, 'India', { location: { city: 'Delhi', searchMode: 'citywide' }, searchMode: 'citywide' });
    const live = data.current.liveAqi;
    assert.equal(live.selectedSource, 'cpcb_station_median');
    assert.equal(live.headlineAqi, 205);
    assert.equal(live.category.label, 'Poor');
    assert.equal(live.stationCount, 4);
    assert.equal(live.nearestStation.station, 'Delhi fixture 0');
    assert.equal(live.dominantPollutantSubIndices['PM2.5'], 205);
    assert.equal(live.dominantPollutantSubIndices.PM10, 91.5);
    assert.equal(live.pollutantValues, null, 'CPCB feed sub-indices must not be passed off as concentrations');
    assert.match(live.pollutantSources.note, /sub-indices, not concentration/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing, invalid, stale, or distant CPCB AQI falls back to Open-Meteo estimate', async () => {
  const originalFetch = globalThis.fetch;
  const base = { station: 'Test station', updated: stationTime, latitude: 28.62181, longitude: 77.1944633, aqi: 88, pollutants: {} };
  const cases = [
    ['missing', [{ ...base, aqi: null }]],
    ['invalid', [{ ...base, aqi: 501 }]],
    ['stale', [{ ...base, updated: '2020-01-01 10:00' }]],
    ['distant', [{ ...base, latitude: 28.95, longitude: 77.55 }]],
    ['no station', []],
  ];
  try {
    for (const [label, stations] of cases) {
      globalThis.fetch = async input => {
        const url = String(input);
        if (url.includes('air-quality-api.open-meteo.com')) return ok({
          current: { time: new Date().toISOString(), pm2_5: 45, pm10: 80, nitrogen_dioxide: 12, us_aqi: 121 },
          hourly: { time: [new Date(Date.now() + 3600000).toISOString()], pm2_5: [20], pm10: [30], us_aqi: [80] },
        });
        if (url.includes('api.dharun.dev')) return ok({ data: stations });
        if (url.includes('timezone=auto')) return ok({ timezone: 'Asia/Kolkata', current: { time: new Date().toISOString() }, daily: { time: [] } });
        return ok({ current: { temperature_2m: 28 }, hourly: {}, daily: { time: [] } });
      };
      const data = await fetchAtmosphericChemistry(28.63, 77.21, 'India', { location: { city: 'Delhi', searchMode: 'citywide' }, searchMode: 'citywide' });
      assert.equal(data.current.indiaAqi, null, `${label}: invalid CPCB AQI must not be official`);
      assert.equal(data.current.indiaAqiStatus, 'open_meteo_fallback');
      assert.equal(data.current.indiaIndicativeAqi, 80);
      assert.equal(data.current.liveAqi.selectedSource, 'open_meteo');
      assert.equal(data.current.liveAqi.headlineAqi, 121);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('international cities use Open-Meteo as the primary live source without CPCB station details', async () => {
  const originalFetch = globalThis.fetch;
  let cpcbCalls = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('air-quality-api.open-meteo.com')) return ok({
      current: { time: new Date().toISOString(), pm2_5: 12, pm10: 20, us_aqi: 42 },
      hourly: { time: [new Date(Date.now() + 3600000).toISOString()], pm2_5: [10], pm10: [15], us_aqi: [35] },
    });
    if (url.includes('api.dharun.dev')) { cpcbCalls++; return ok({ data: [] }); }
    if (url.includes('timezone=auto')) return ok({ timezone: 'Europe/London', current: { time: new Date().toISOString() }, daily: { time: [] } });
    return ok({ current: { temperature_2m: 18 }, hourly: {}, daily: { time: [] } });
  };
  try {
    for (const country of ['United Kingdom', 'United States']) {
      const data = await fetchAtmosphericChemistry(51.5, -0.12, country);
      assert.equal(data.current.liveAqi.selectedSource, 'open_meteo');
      assert.equal(data.current.liveAqi.headlineAqi, data.current.usAqi);
      assert.equal(data.current.liveAqi.source, 'Open-Meteo Model AQI');
      assert.deepEqual(data.current.liveAqi.selectedStations, []);
    }
    assert.equal(cpcbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
