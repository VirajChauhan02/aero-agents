import { runAgent, skippedTrace } from './baseAgent.js';
import { dataAgent } from './dataAgent.js';
import { weatherAgent } from './weatherAgent.js';
import { aqiAgent } from './aqiAgent.js';
import { explainabilityAgent } from './explainabilityAgent.js';
import { alertAgent } from './alertAgent.js';
import { monitoringAgent } from './monitoringAgent.js';

export const PLAN = ['data', 'weather+aqi', 'explain+alert', 'monitor'];

// Coordinator: decides the order, runs independent agents in parallel, skips dependants of a
// failed agent, and returns every agent's output plus a trace for the UI.
export async function runCoordinator(location, coords, { buildAbstract } = {}) {
  const started = Date.now();
  const traces = [];

  const data = await dataAgent(location, coords);
  traces.push(data.trace);
  if (!data.ok) {
    const err = new Error(data.error.message);
    err.agentTrace = { coordinator: { plan: PLAN, totalMs: Date.now() - started }, agents: traces };
    throw err;
  }
  const aqi = data.output;

  const [weather, aqiRes] = await Promise.all([weatherAgent(aqi), aqiAgent(aqi, location.city, coords)]);
  traces.push(weather.trace, aqiRes.trace);

  let explain, alert, monitor;
  if (aqiRes.ok) {
    [explain, alert, monitor] = await Promise.all([
      explainabilityAgent(aqi, aqiRes.output),
      alertAgent(aqi, aqiRes.output),
      monitoringAgent(location, aqi, aqiRes.output),
    ]);
    traces.push(explain.trace, alert.trace, monitor.trace);
  } else {
    for (const [n, r] of [['Explainability Agent', 'Explain drivers of the forecast'], ['Alert/Recommendation Agent', 'Turn forecast into alerts and precautions'], ['Monitoring Agent', 'Log forecasts and verify them']]) {
      traces.push(skippedTrace(n, r, ['AQI Agent'], 'Skipped: AQI Agent failed.'));
    }
  }

  const predictions = aqiRes.ok ? aqiRes.output : { modelStatus: 'unavailable', error: aqiRes.error?.message, hourlyTrajectory: [], dailySummary: [] };
  const result = {
    meta: { generatedAt: new Date().toISOString(), location, coordinates: coords, timezone: aqi.timezone },
    chemistryData: aqi,
    weatherData: weather.ok ? weather.output : null,
    predictionsData: predictions,
    healthAndOpsData: alert?.ok ? alert.output : null,
    explainability: explain?.ok ? explain.output : null,
    evaluation: monitor?.ok ? monitor.output : null,
    researchAbstract: buildAbstract ? buildAbstract({ location, aqi, predictions }) : null,
    agentTrace: { coordinator: { plan: PLAN, totalMs: Date.now() - started }, agents: traces },
  };
  return result;
}
