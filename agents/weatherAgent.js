import { runAgent } from './baseAgent.js';

// Weather forecasts in this system come from Open-Meteo's NWP output. The agent packages
// them with provenance so nobody mistakes them for the project's own ML forecast.
export function weatherAgent(aqi) {
  return runAgent({ name: 'Weather Agent', role: 'Provide current weather and forecast with provenance', dependsOn: ['Data Agent'] }, async () => {
    const m = aqi.current.meteorology;
    const daily = aqi.dailyWeather || [];
    if (!daily.length) throw new Error('No daily weather forecast returned by provider.');
    const output = {
      current: m,
      daily,
      timezone: aqi.timezone || 'UTC',
      source: 'Open-Meteo Forecast API (numerical weather model grid value, ~9-11 km)',
      isProjectMlForecast: false,
      note: 'Grid-model value; differs from station readings and other providers. Daily max/min use the city local calendar day.',
    };
    return { output, summary: `${daily.length}-day forecast, timezone ${output.timezone}.` };
  });
}
