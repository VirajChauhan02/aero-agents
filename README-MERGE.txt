AERO AGENTS - INDIAN CITY AQI FALLBACK PATCH

Purpose:
- Keep existing city-specific XGBoost forecasts when compatible saved models exist.
- If no city model exists (e.g. Pune, Surat, Nashik, Hyderabad, Chennai, Kolkata), use the future hourly US AQI and PM2.5 values already returned by the Open-Meteo Air Quality API.
- Build 168 hourly rows and seven 24-hour summary periods from future timestamps only. Past daily weather rows are not shown as forecast days.
- Clearly label this as an Open-Meteo provider forecast, not a local ML prediction. No ML accuracy metrics or confidence intervals are fabricated for the fallback.

Files to merge into the EXISTING aero-agents-main folder:
1) services/analysisService.js
2) public/index.html
3) public/js/app.js

Before overwrite, back up these three files. Do not replace ml/models, ml/data, package files, or any other project files. Do not run training for this patch.

After merge:
- Restart server: Ctrl+C in the npm start terminal, then npm start.
- Test a trained city (Mumbai) and an untrained Indian city (Pune or Surat).
- For an untrained city, the AQI model card should say API Forecast and daily cards should contain numeric AQI values with a provider-source note.
- Accuracy tab must show no local ML metrics for API fallback.

Note: Open-Meteo forecast coverage and pollutant availability depend on the upstream API and location. This fallback is not a CPCB official forecast and should not be represented as a locally validated ML model.
