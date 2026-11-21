import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeLocation, searchLocations } from '../services/cityLocator.js';

test('Goa resolves to the Indian state center instead of Genoa', async () => {
  const result = await geocodeLocation('Goa');
  assert.equal(result.city, 'Goa');
  assert.equal(result.state, 'Goa');
  assert.equal(result.country, 'India');
  assert.equal(result.lat, 15.4909);
  assert.equal(result.searchMode, 'citywide');
});

test('localities are ranked near real large-city centers and marked hyper-local', async () => {
  const bandra = await geocodeLocation('Bandra');
  assert.ok(bandra.lat > 18.9 && bandra.lat < 19.2, `Bandra should resolve near Mumbai, got ${bandra.lat}`);
  assert.equal(bandra.searchMode, 'hyperlocal');
  const andheri = await geocodeLocation('Andheri East');
  assert.ok(andheri.lat > 18.9 && andheri.lat < 19.2);
  assert.equal(andheri.searchMode, 'hyperlocal');
  assert.equal((await geocodeLocation('Delhi')).searchMode, 'citywide');
});

test('all Indian populated places are available through local search', async () => {
  const results = await searchLocations('Panaji');
  assert.ok(results.length > 0);
  assert.ok(results[0].city.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith('panaji'));
  assert.equal(results[0].country, 'India');
  assert.ok(Number.isFinite(results[0].lat) && Number.isFinite(results[0].lon));
});

test('supported broad city searches resolve to city-wide station mode', async () => {
  for (const city of ['Mumbai', 'Delhi', 'Pune', 'Bengaluru', 'Hyderabad', 'Kolkata', 'Chennai', 'Ahmedabad', 'Surat', 'Lucknow', 'Jaipur']) {
    const location = await geocodeLocation(city);
    assert.equal(location.searchMode, 'citywide', `${city} should use city-wide station median mode`);
    assert.equal(location.country, 'India');
  }
});

test('geocoding prefers an exact match over an earlier prefix result', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({ results: [
        { name: 'XyzPlace987 North', latitude: 15.5, longitude: 73.9, country: 'India', admin1: 'Goa' },
        { name: 'XyzPlace987', latitude: 15.4, longitude: 73.8, country: 'India', admin1: 'Goa' },
      ] }),
    };
  };
  try {
    const result = await geocodeLocation('XyzPlace987, India');
    assert.equal(requestedUrl.searchParams.get('countryCode'), 'IN');
    assert.equal(result.city, 'XyzPlace987');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
