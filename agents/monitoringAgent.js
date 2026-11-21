import { logForecast, scoreCity } from '../services/evaluationService.js';
import { runAgent } from './baseAgent.js';

// Closes the loop from the project plan: store prediction -> actual arrives -> compute error.
export function monitoringAgent(location, aqi, predictions) {
  return runAgent({ name: 'Monitoring Agent', role: 'Log forecasts and verify them against later values', dependsOn: ['AQI Agent'], optional: true }, async () => {
    const city = location.city;
    const { logged } = logForecast({ city, issuedAt: aqi.current.time, aqi, predictions });
    const evaluation = scoreCity(city, aqi);
    return { output: evaluation, summary: `${logged} new forecast(s) logged; ${evaluation.forecastsVerified}/${evaluation.forecastsLogged} verified.` };
  });
}
