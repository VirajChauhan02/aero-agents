import { fetchAtmosphericChemistry } from '../services/aqiService.js';
import { runAgent } from './baseAgent.js';

const MAX_AGE_HOURS = 3;

// Fetches AND validates. Quality flags travel with the data so later agents/UI can show them.
export function validateAtmosphericData(aqi, nowMs = Date.now()) {
  const flags = [];
  const cur = aqi.current;
  const ageHours = (nowMs - Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(cur.time) ? cur.time : `${cur.time}Z`)) / 3600000;
  if (Number.isFinite(ageHours) && ageHours > MAX_AGE_HOURS) flags.push(`Current observation is ${ageHours.toFixed(1)} h old (stale > ${MAX_AGE_HOURS} h).`);
  if (!(cur.usAqi >= 0 && cur.usAqi <= 500)) flags.push(`US AQI ${cur.usAqi} outside 0-500.`);
  const p = cur.pollutants;
  for (const key of ['pm25', 'pm10', 'no2', 'so2', 'co', 'o3']) {
    if (p[key]?.value == null) flags.push(`Pollutant ${key.toUpperCase()} missing.`);
    else if (p[key].value < 0) flags.push(`Pollutant ${key.toUpperCase()} negative.`);
  }
  const hourly = aqi.hourly || {};
  const expected = (hourly.time || []).length;
  const have = (hourly.usAqi || []).filter(v => v != null).length;
  const completeness = expected ? Math.round((have / expected) * 100) : 0;
  return {
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    hourlyAqiCompletenessPercent: completeness,
    timezone: aqi.timezone || 'UTC',
    flags,
    passed: flags.length === 0,
  };
}

export function dataAgent(location, coords) {
  return runAgent({ name: 'Data Agent', role: 'Fetch, validate and align AQI + weather data' }, async () => {
    const aqi = await fetchAtmosphericChemistry(coords.lat, coords.lon, location.countryCode || location.country || '', {
      location,
      searchMode: location.searchMode,
      radiusKm: location.searchRadiusKm,
    });
    const quality = validateAtmosphericData(aqi);
    aqi.dataQuality = quality;
    return {
      output: aqi,
      summary: `Open-Meteo data loaded for ${location.city}; ${quality.flags.length} quality flag(s); hourly AQI completeness ${quality.hourlyAqiCompletenessPercent}%.`,
      notes: quality.flags,
    };
  });
}
