# What changed (multi-agent + accuracy + timezone)

## Why Open-Meteo values differed from other websites
- Open-Meteo returns a ~9-11 km **model grid value**, not a station reading. Other sites use other models/stations.
- Daily max/min were computed for the **UTC** day. Now a second call with `timezone=auto` supplies local-day values (hourly series stays UTC for ML alignment).
- Coordinates were rounded to ~1 km; now ~11 m.
- AQI shown is Open-Meteo's modelled **US AQI**. Indian sites show CPCB NAQI (already estimated as `indiaAqi`). The EPA sub-index code for NO2/O3/SO2/CO is an approximation, not official breakpoints.

## Real multi-agent layer (`agents/`)
Coordinator -> Data Agent -> (Weather Agent || AQI Agent) -> (Explainability || Alert/Recommendation || Monitoring).
Each agent returns output + trace (status, ms, summary). A failed agent makes its dependants `skipped`; the app still responds.
`services/analysisService.js#runAnalysisPipeline` now delegates to `agents/coordinator.js`. Response keeps the old fields and adds
`weatherData`, `explainability`, `evaluation`, `agentTrace`.

## Accuracy
- `services/evaluationService.js` logs forecasts for +1/+6/+24 h (`data/prediction_log.jsonl`) and scores them when the target hour passes:
  MAE, RMSE, R2, bias, persistence-baseline MAE and skill. Reference = Open-Meteo analysis (modelled).
- `POST /api/evaluation/observation` stores independent observations (airport METAR, CPCB/OpenAQ, IMD) in `data/observations.jsonl`;
  Open-Meteo is then scored against them (this is the real "which source is right" check).
- Existing holdout metrics in `docs/MODEL_ACCURACY_REVIEW.md` are against Open-Meteo's modelled AQI, not station data.

## Not done / honest limits
- No SHAP: explainability is XGBoost global feature importance + rule-based weather context.
- Live metrics start empty and fill as time passes.
- Weather forecast is Open-Meteo output, not a project-trained model.
- Ablation (E1-E4) and LSTM/GRU are still offline experiments to run in `ml/`.

Run `npm test` (4 tests; Open-Meteo is mocked).
