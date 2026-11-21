import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDIA_PLACES_FILE = path.join(__dirname, '..', 'ml', 'data', 'world-cities', 'india_places.csv');
let indiaPrefixIndex = null;
let indiaUrbanCenters = [];

const POPULAR_CITIES = [
  { city: 'Delhi', lat: 28.6139, lon: 77.2090, state: 'Delhi', country: 'India', searchMode: 'citywide' },
  { city: 'Mumbai', lat: 19.0760, lon: 72.8777, state: 'Maharashtra', country: 'India', searchMode: 'citywide' },
  { city: 'Bengaluru', lat: 12.9716, lon: 77.5946, state: 'Karnataka', country: 'India', searchMode: 'citywide' },
  { city: 'Pune', lat: 18.5204, lon: 73.8567, state: 'Maharashtra', country: 'India', searchMode: 'citywide' },
  { city: 'Kolkata', lat: 22.5726, lon: 88.3639, state: 'West Bengal', country: 'India', searchMode: 'citywide' },
  { city: 'Chennai', lat: 13.0827, lon: 80.2707, state: 'Tamil Nadu', country: 'India', searchMode: 'citywide' },
  { city: 'Hyderabad', lat: 17.3850, lon: 78.4867, state: 'Telangana', country: 'India', searchMode: 'citywide' },
  { city: 'Ahmedabad', lat: 23.0225, lon: 72.5714, state: 'Gujarat', country: 'India', searchMode: 'citywide' },
  { city: 'Jaipur', lat: 26.9124, lon: 75.7873, state: 'Rajasthan', country: 'India', searchMode: 'citywide' },
  { city: 'Lucknow', lat: 26.8467, lon: 80.9462, state: 'Uttar Pradesh', country: 'India', searchMode: 'citywide' },
  // Goa is a common search for the Indian state, while global geocoders can
  // rank similarly named European places (Genoa) first.
  { city: 'Goa', lat: 15.4909, lon: 73.8278, state: 'Goa', country: 'India', searchMode: 'citywide' },
  { city: 'London', lat: 51.5072, lon: -0.1276, state: 'England', country: 'United Kingdom', searchMode: 'citywide' },
  { city: 'New York', lat: 40.7128, lon: -74.0060, state: 'New York', country: 'United States', searchMode: 'citywide' },
];

const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function parseCsvLine(line) {
  const values = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}

function getIndiaPrefixIndex() {
  if (indiaPrefixIndex) return indiaPrefixIndex;
  if (!fs.existsSync(INDIA_PLACES_FILE)) return new Map();
  const text = fs.readFileSync(INDIA_PLACES_FILE, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines.shift());
  const col = Object.fromEntries(headers.map((name, index) => [name, index]));
  const index = new Map();
  const urbanCenters = [];
  for (const line of lines) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    const city = cells[col.city]?.trim();
    const key = normalize(city);
    if (!key) continue;
    const place = {
      id: cells[col.geoname_id], city, name: city,
      lat: Number(cells[col.latitude]), lon: Number(cells[col.longitude]),
      country: 'India', countryCode: 'IN',
      population: Number(cells[col.population]) || 0,
      featureCode: cells[col.feature_code] || '',
    };
    if (place.population >= 300000) urbanCenters.push(place);
    const prefix = key.slice(0, 3);
    if (!index.has(prefix)) index.set(prefix, []);
    index.get(prefix).push(place);
  }
  indiaPrefixIndex = index;
  indiaUrbanCenters = urbanCenters;
  return index;
}

function nearestUrbanCenterKm(place) {
  if (!indiaUrbanCenters.length) return Infinity;
  const rad = value => value * Math.PI / 180;
  return Math.min(...indiaUrbanCenters.map(center => {
    const dLat = rad(center.lat - place.lat);
    const dLon = rad(center.lon - place.lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(place.lat)) * Math.cos(rad(center.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }));
}

function classifyPlaceScope(place) {
  const code = String(place.featureCode || place.feature_code || '').toUpperCase();
  if (code === 'PPLX' || code === 'PPLH') return 'hyperlocal';
  if (code === 'PPLC' || /^PPLA\d?$/.test(code)) return 'citywide';
  return Number(place.population) >= 100000 ? 'citywide' : 'hyperlocal';
}

function rankPlaces(places, query, limit) {
  const normalizedQuery = normalize(query);
  const priority = code => code === 'PPLC' ? 0 : code === 'PPLA' ? 1 : code.startsWith('PPLA') ? 2 : 3;
  getIndiaPrefixIndex();
  return places
    .filter(place => normalize(place.city).startsWith(normalizedQuery))
    .map(place => ({ place, urbanContextKm: nearestUrbanCenterKm(place) }))
    .sort((aItem, bItem) => {
      const a = aItem.place;
      const b = bItem.place;
      const exact = Number(normalize(b.city) === normalizedQuery) - Number(normalize(a.city) === normalizedQuery);
      const feature = priority(a.featureCode) - priority(b.featureCode);
      const population = b.population - a.population;
      const urbanContext = aItem.urbanContextKm - bItem.urbanContextKm;
      return exact || feature || population || urbanContext || a.city.localeCompare(b.city);
    })
    .slice(0, limit)
    .map(({ place }) => ({
      ...place,
      searchMode: classifyPlaceScope(place),
      fullName: `${place.city}, India`,
      state: '',
    }));
}

export function listPopularCities() {
  return POPULAR_CITIES.map(city => ({ ...city, name: city.city }));
}

export async function searchLocations(query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Enter a city name.');

  const parts = q.split(',').map(part => part.trim()).filter(Boolean);
  const searchName = parts[0] || q;
  const qualifier = parts[1]?.toLowerCase();
  const countryCodes = new Map([
    ['india', 'IN'], ['in', 'IN'], ['united states', 'US'], ['usa', 'US'], ['us', 'US'],
    ['united kingdom', 'GB'], ['uk', 'GB'], ['gb', 'GB'],
  ]);
  const countryCode = qualifier ? countryCodes.get(qualifier) : null;
  const local = POPULAR_CITIES.find(item => item.city.toLowerCase() === searchName.toLowerCase() &&
    (!qualifier || (countryCode && item.country.toLowerCase() === qualifier)));
  if (local) return [{ ...local, name: local.city, fullName: `${local.city}, ${local.state}, ${local.country}` }];

  if (!qualifier || countryCode === 'IN') {
    const normalizedQuery = normalize(searchName);
    if (normalizedQuery.length >= 3) {
      const bucket = getIndiaPrefixIndex().get(normalizedQuery.slice(0, 3)) || [];
      const indianResults = rankPlaces(bucket, searchName, limit);
      if (indianResults.length) return indianResults;
    }
  }

  const params = new URLSearchParams({ name: searchName, count: '10', language: 'en', format: 'json' });
  if (countryCode) params.set('countryCode', countryCode);
  else if (qualifier) params.set('name', `${searchName}, ${parts[1]}`);
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AirQualityWeatherResearch/1.0' } });
  if (!res.ok) throw new Error(`Location search failed (HTTP ${res.status}).`);
  const data = await res.json();
  const results = (data.results || []).sort((a, b) =>
    Number(normalize(b.name) === normalize(searchName)) - Number(normalize(a.name) === normalize(searchName)) ||
    (Number(b.population) || 0) - (Number(a.population) || 0));
  if (!results.length) throw new Error(`Location not found: "${q}"`);
  return results.slice(0, limit).map(result => ({
    id: result.id ?? null,
    city: result.name,
    name: result.name,
    fullName: [result.name, result.admin1, result.country].filter(Boolean).join(', '),
    lat: result.latitude,
    lon: result.longitude,
    state: result.admin1 || '',
    country: result.country || '',
    countryCode: result.country_code || '',
    population: result.population ?? null,
    featureCode: result.feature_code || '',
    searchMode: classifyPlaceScope({ population: result.population, featureCode: result.feature_code }),
    elevation: result.elevation ?? null,
  }));
}

export async function geocodeLocation(query) {
  return (await searchLocations(query, 10))[0];
}
