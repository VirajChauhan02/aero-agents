// CPCB live station feed (Government Open Data via api.dharun.dev).
// The feed returns station AQI and pollutant sub-indices, not pollutant concentrations.
const API_URL = 'https://api.dharun.dev/v1/air-quality';
const MAX_CONFIGURABLE_RADIUS_KM = 25;
const DEFAULT_RADIUS_KM = 20;
const DEFAULT_FRESHNESS_MINUTES = 180;

const normalizeName = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculateMedian(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function flagUnusualReadings(stations) {
  if (stations.length < 3) return stations;
  const values = stations.map(station => station.aqi);
  const median = calculateMedian(values);
  const medianDeviation = calculateMedian(values.map(value => Math.abs(value - median)));
  const threshold = Math.max(20, 3 * 1.4826 * (medianDeviation || 0));
  return stations.map(station => ({
    ...station,
    qualityFlags: Math.abs(station.aqi - median) > threshold ? ['AQI differs substantially from nearby readings; retained for inspection.'] : [],
  }));
}

export function selectCpcbAqi(stations, searchMode = 'citywide', radiusKm = MAX_CONFIGURABLE_RADIUS_KM) {
  const radius = Math.min(MAX_CONFIGURABLE_RADIUS_KM, Math.max(1, Number(radiusKm) || MAX_CONFIGURABLE_RADIUS_KM));
  const nearby = flagUnusualReadings(stations.filter(station => station.distanceKm <= radius).slice().sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5));
  const medianAqi = nearby.length >= 3 ? calculateMedian(nearby.map(station => station.aqi)) : null;
  const hyperlocalStation = nearby.find(station => station.distanceKm <= 5);
  let selection = null;
  if (searchMode === 'hyperlocal') {
    if (hyperlocalStation) selection = { source: 'cpcb_station', headlineAqi: hyperlocalStation.aqi, station: hyperlocalStation };
    else if (medianAqi != null) selection = { source: 'cpcb_station_median', headlineAqi: medianAqi, station: null };
    else if (nearby.length) selection = { source: 'cpcb_station', headlineAqi: nearby[0].aqi, station: nearby[0] };
  } else if (medianAqi != null) selection = { source: 'cpcb_station_median', headlineAqi: medianAqi, station: null };
  else if (nearby.length) selection = { source: 'cpcb_station', headlineAqi: nearby[0].aqi, station: nearby[0] };
  return {
    selectedSource: selection?.source || 'open_meteo',
    headlineAqi: selection?.headlineAqi ?? null,
    searchMode,
    stationCount: medianAqi == null ? (selection?.station ? 1 : nearby.length) : nearby.length,
    selectedStations: nearby,
    nearestStation: nearby[0] || null,
    selectedStation: selection?.station || null,
    nearestStationDistanceKm: nearby[0]?.distanceKm ?? null,
    observationTimestamp: selection?.station?.observedAt ?? nearby[0]?.observedAt ?? null,
    regionalMedianAqi: medianAqi,
    regionalMedianStationCount: medianAqi == null ? 0 : nearby.length,
    dataFreshness: {
      thresholdMinutes: configuredFreshnessMinutes(),
      isFresh: Boolean(nearby.length),
      nearestAgeMinutes: nearby[0]?.ageMinutes ?? null,
      oldestAgeMinutes: nearby.length ? Math.max(...nearby.map(station => station.ageMinutes)) : null,
    },
    searchRadiusKm: radius,
  };
}

export function classifyIndianSearchMode(location = {}, requestedMode = '') {
  if (requestedMode === 'citywide' || requestedMode === 'hyperlocal') return requestedMode;
  if (location.searchMode === 'citywide' || location.searchMode === 'hyperlocal') return location.searchMode;
  if (location.isCurrentLocation || String(location.city || '').toLowerCase() === 'my location') return 'hyperlocal';
  const featureCode = String(location.featureCode || location.feature_code || '').toUpperCase();
  if (featureCode === 'PPLX' || featureCode === 'PPLH') return 'hyperlocal';
  if (/^PPLA\d?$/.test(featureCode) || featureCode === 'PPLC') return 'citywide';
  return Number(location.population) >= 100000 ? 'citywide' : 'hyperlocal';
}

function configuredRadiusKm() {
  const value = Number(process.env.CPCB_MAX_STATION_RADIUS_KM || MAX_CONFIGURABLE_RADIUS_KM);
  return Number.isFinite(value) ? Math.min(MAX_CONFIGURABLE_RADIUS_KM, Math.max(1, value)) : MAX_CONFIGURABLE_RADIUS_KM;
}

function configuredFreshnessMinutes() {
  const value = Number(process.env.CPCB_STATION_FRESHNESS_MINUTES || DEFAULT_FRESHNESS_MINUTES);
  return Number.isFinite(value) ? Math.min(1440, Math.max(1, value)) : DEFAULT_FRESHNESS_MINUTES;
}

function parseObservedTimestamp(raw) {
  if (!raw) return NaN;
  const text = String(raw).trim();
  // CPCB's provider timestamps are local India time without a timezone suffix.
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}+05:30`);
}

function isProviderInvalid(station) {
  return station.invalid === true || station.is_valid === false || station.valid === false ||
    station.data_valid === false || String(station.status || '').toLowerCase() === 'invalid';
}

function normalizeStation(station, origin, now, freshnessMinutes) {
  const latitude = Number(station.latitude ?? station.lat);
  const longitude = Number(station.longitude ?? station.lon ?? station.lng);
  const aqi = station.aqi == null || station.aqi === '' || !Number.isFinite(Number(station.aqi)) ? null : Number(station.aqi);
  const timestamp = station.updated || station.observed_at || station.timestamp || null;
  const observedAtMs = parseObservedTimestamp(timestamp);
  const ageMinutes = (now - observedAtMs) / 60000;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(aqi) || aqi < 0 || aqi > 500 || !timestamp || !Number.isFinite(ageMinutes) || ageMinutes < -15 || ageMinutes > freshnessMinutes || isProviderInvalid(station)) return null;
  const distanceKm = haversineDistanceKm(origin.lat, origin.lon, latitude, longitude);
  const pollutantSubIndices = Object.fromEntries(Object.entries(station.pollutants || {}).map(([key, value]) => {
    const avg = value?.avg == null || value.avg === '' || !Number.isFinite(Number(value.avg)) ? null : Number(value.avg);
    return [key, avg != null && avg >= 0 && avg <= 500 ? avg : null];
  }));
  const name = station.station || station.name || 'CPCB monitoring station';
  const agency = station.agency || station.agency_name || station.operating_agency || station.monitoring_agency || station.operator || station.owner || name.match(/\s-\s([^,-]+)$/)?.[1]?.trim() || null;
  return {
    id: station.id ?? station.station_id ?? `${normalizeName(name)}:${latitude.toFixed(5)}:${longitude.toFixed(5)}`,
    station: name,
    agency,
    city: station.city || null,
    state: station.state || null,
    latitude,
    longitude,
    distanceKm: Number(distanceKm.toFixed(2)),
    aqi,
    category: station.category || null,
    primaryPollutant: station.main_pollutant || station.primary_pollutant || null,
    observedAt: timestamp,
    ageMinutes: Math.max(0, Math.round(ageMinutes)),
    pollutantSubIndices,
    source: station.source || null,
  };
}

export async function fetchIndiaCpcbStations(lat, lon, { radiusKm = configuredRadiusKm(), freshnessMinutes = configuredFreshnessMinutes(), now = Date.now() } = {}) {
  const origin = { lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(origin.lat) || origin.lat < -90 || origin.lat > 90 || !Number.isFinite(origin.lon) || origin.lon < -180 || origin.lon > 180) return { stations: [], source: null, sourceUrl: null, radiusKm, freshnessMinutes };
  const effectiveRadius = Math.min(configuredRadiusKm(), Math.max(1, Number(radiusKm) || DEFAULT_RADIUS_KM));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${API_URL}?near=${encodeURIComponent(`${origin.lat},${origin.lon}`)}`;
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Aero-Weather-AQI/1.0' } });
    if (!response.ok) throw new Error(`CPCB AQI source HTTP ${response.status}`);
    const payload = await response.json();
    const seen = new Set();
    const stations = (Array.isArray(payload.data) ? payload.data : [])
      .map(station => normalizeStation(station, origin, now, freshnessMinutes))
      .filter(station => station && station.distanceKm <= effectiveRadius)
      .filter(station => {
        const key = `${normalizeName(station.station)}:${station.latitude.toFixed(4)}:${station.longitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);
    const source = payload.meta?.source?.name || 'CPCB monitoring stations (India government open data)';
    const sourceUrl = payload.meta?.source?.url || 'https://www.data.gov.in/resource/real-time-air-quality-index-various-locations';
    for (const station of stations) station.source = source;
    return { stations, source, sourceUrl, radiusKm: effectiveRadius, freshnessMinutes };
  } finally {
    clearTimeout(timeout);
  }
}

// Kept for backward compatibility with callers expecting a single nearby station.
export async function fetchNearestIndiaCpcbAqi(lat, lon, options = {}) {
  const result = await fetchIndiaCpcbStations(lat, lon, options);
  const station = result.stations[0];
  return station ? { ...station, dataQualityVerified: false, source: result.source, sourceUrl: result.sourceUrl } : null;
}
