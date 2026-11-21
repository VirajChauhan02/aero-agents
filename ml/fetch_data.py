"""
fetch_data.py
=============
Fetches historical hourly weather + AQI data from Open-Meteo archives.
- Weather (ERA5 reanalysis): available from 1940 — we use 2005-present
- AQI (CAMS satellite):      available from 2015-present

Outputs a CSV file per city ready for ML training.
"""

import requests
import pandas as pd
import numpy as np
import os
import sys
import time
import json
import argparse
import random
from datetime import timezone
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
CITY_CONFIGS = {
    "Mumbai":    {"lat": 19.0760, "lon": 72.8777},
    "Delhi":     {"lat": 28.6139, "lon": 77.2090},
    "Bangalore": {"lat": 12.9716, "lon": 77.5946},
    "Bengaluru": {"lat": 13.1980, "lon": 77.7060},
    "Kolkata":   {"lat": 22.5726, "lon": 88.3639},
    "Chennai":   {"lat": 13.0827, "lon": 80.2707},
    "London":    {"lat": 51.5074, "lon": -0.1278},
    "New York":  {"lat": 40.7128, "lon": -74.0060},
}

WEATHER_START = 2015          # Match weather history to the AQI archive window.
AQI_START     = 2015          # Open-Meteo archive requests return available years; actual coverage varies by place.
DATA_DIR      = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

WEATHER_VARS = ",".join([
    "temperature_2m", "relative_humidity_2m",
    "wind_speed_10m", "wind_direction_10m",
    "surface_pressure", "precipitation",
    "cloud_cover", "apparent_temperature",
    "dew_point_2m", "vapour_pressure_deficit",
    "boundary_layer_height", "shortwave_radiation",
])

AQI_VARS = ",".join([
    "pm2_5", "pm10", "nitrogen_dioxide",
    "ozone", "carbon_monoxide", "sulphur_dioxide", "us_aqi",
])

# ── Helpers ───────────────────────────────────────────────────────────────────
def retry_delay(response, attempt):
    retry_after = response.headers.get("Retry-After") if response is not None else None
    if retry_after:
        try:
            return min(300.0, max(1.0, float(retry_after)))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                return min(300.0, max(1.0, (retry_at - datetime.now(timezone.utc)).total_seconds()))
            except (TypeError, ValueError, OverflowError):
                pass
    return min(120.0, 5.0 * (2 ** attempt)) + random.uniform(0.0, 1.0)


def fetch_with_retry(url, retries=6):
    for attempt in range(retries):
        response = None
        try:
            r = requests.get(url, timeout=60)
            response = r
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries - 1:
                raise
            status_code = getattr(response, "status_code", None)
            if status_code is not None and status_code < 500 and status_code != 429:
                raise
            wait = retry_delay(response, attempt)
            print(f"    Retry {attempt+1}/{retries - 1} after {wait:.1f}s (HTTP {status_code or 'network'}: {e})")
            time.sleep(wait)


def fetch_weather_year(lat, lon, year):
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = f"{year}-01-01"
    end   = yesterday if year == datetime.now().year else f"{year}-12-31"

    url = (f"https://archive-api.open-meteo.com/v1/archive?"
           f"latitude={lat}&longitude={lon}"
           f"&start_date={start}&end_date={end}"
           f"&hourly={WEATHER_VARS}&timezone=UTC&wind_speed_unit=kmh")

    data = fetch_with_retry(url)
    return pd.DataFrame(data["hourly"])


def fetch_aqi_year(lat, lon, year):
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = f"{year}-01-01"
    end   = yesterday if year == datetime.now().year else f"{year}-12-31"

    url = (f"https://air-quality-api.open-meteo.com/v1/air-quality?"
           f"latitude={lat}&longitude={lon}"
           f"&start_date={start}&end_date={end}"
           f"&hourly={AQI_VARS}&timezone=UTC")

    data = fetch_with_retry(url)
    return pd.DataFrame(data["hourly"])


# ── Main ──────────────────────────────────────────────────────────────────────
def fetch_all(city="Delhi", lat=None, lon=None, reuse_cache=False):
    if city not in CITY_CONFIGS and (lat is None or lon is None):
        print(f"Unknown city. Options: {list(CITY_CONFIGS.keys())}")
        sys.exit(1)

    # Caller-provided catalogue coordinates are authoritative for background
    # jobs; CITY_CONFIGS remains the fallback for older manual invocations.
    cfg = {"lat": lat, "lon": lon} if lat is not None and lon is not None else CITY_CONFIGS.get(city)
    if not cfg:
        print(f"Unknown city: {city}; provide --lat and --lon")
        sys.exit(1)
    lat, lon = cfg["lat"], cfg["lon"]
    out_path = os.path.join(DATA_DIR, f"{city.lower().replace(' ', '_')}_historical.csv")

    progress_file = os.path.join(DATA_DIR, f"{city.lower().replace(' ', '_')}_progress.json")
    def update_progress(phase, pct, detail):
        try:
            with open(progress_file, "w") as pf:
                json.dump({"phase": phase, "percent": pct, "detail": detail, "updated_at": datetime.utcnow().isoformat()}, pf)
        except Exception:
            pass

    # The background trainer can reuse any non-empty historical cache. Manual
    # fetches retain the previous 24-hour freshness behavior.
    if os.path.exists(out_path):
        age_hours = (time.time() - os.path.getmtime(out_path)) / 3600
        if os.path.getsize(out_path) > 0 and (reuse_cache or age_hours < 24):
            update_progress("cache_found", 75, f"Using existing {out_path}. Ready for training.")
            print(f"[CACHE] Using cached data ({out_path})")
            return out_path


    print(f"\n[DATA] Fetching data for {city} ({lat}, {lon})")
    print(f"   Weather: {WEATHER_START}-present | AQI: {AQI_START}-present\n")

    current_year = datetime.now().year
    all_weather = []
    all_aqi = []

    # Fetch weather (2005 onward)
    total_steps = (current_year - WEATHER_START + 1) + (current_year - AQI_START + 1)
    step_count = 0
    progress_file = os.path.join(DATA_DIR, f"{city.lower().replace(' ', '_')}_progress.json")

    def update_progress(phase, pct, detail):
        try:
            with open(progress_file, "w") as pf:
                json.dump({"phase": phase, "percent": pct, "detail": detail, "updated_at": datetime.utcnow().isoformat()}, pf)
        except Exception:
            pass

    update_progress("fetching_weather", 2, "Starting weather data download...")

    for year in range(WEATHER_START, current_year + 1):
        print(f"  [Weather] {year}...", end="", flush=True)
        try:
            df = fetch_weather_year(lat, lon, year)
            all_weather.append(df)
            print(f" {len(df)} rows")
        except Exception as e:
            print(f" FAILED: {e}")
        step_count += 1
        pct = int((step_count / total_steps) * 45) # 0 to 45% for weather
        update_progress("fetching_weather", pct, f"Downloaded weather records for {year}")
        time.sleep(max(0.5, float(os.environ.get("OPEN_METEO_REQUEST_DELAY_SECONDS", "1.5"))))

    # Fetch AQI (2015 onward)
    for year in range(AQI_START, current_year + 1):
        print(f"  [AQI]     {year}...", end="", flush=True)
        try:
            df = fetch_aqi_year(lat, lon, year)
            all_aqi.append(df)
            print(f" {len(df)} rows")
        except Exception as e:
            print(f" FAILED: {e}")
        step_count += 1
        pct = 45 + int(((step_count - (current_year - WEATHER_START + 1)) / (current_year - AQI_START + 1)) * 25) # 45 to 70%
        update_progress("fetching_aqi", pct, f"Downloaded AQI records for {year}")
        time.sleep(max(0.5, float(os.environ.get("OPEN_METEO_REQUEST_DELAY_SECONDS", "1.5"))))

    # Merge on time
    update_progress("merging", 72, "Aligning and merging 20-year timeseries...")
    weather_df = pd.concat(all_weather, ignore_index=True)
    weather_df["time"] = pd.to_datetime(weather_df["time"])

    aqi_df = pd.concat(all_aqi, ignore_index=True) if all_aqi else pd.DataFrame()
    if not aqi_df.empty:
        aqi_df["time"] = pd.to_datetime(aqi_df["time"])
        merged = pd.merge(weather_df, aqi_df, on="time", how="left")
    else:
        merged = weather_df

    merged.sort_values("time", inplace=True)
    merged.reset_index(drop=True, inplace=True)

    merged.to_csv(out_path, index=False)
    update_progress("fetch_complete", 75, f"Saved {len(merged):,} records. Ready to train.")
    print(f"\n[OK] Total: {len(merged):,} hourly records -> {out_path}")
    return out_path



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("city", nargs="?", default="Delhi")
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--reuse-cache", action="store_true", help="Reuse any existing non-empty historical CSV.")
    args = parser.parse_args()
    fetch_all(args.city, args.lat, args.lon, args.reuse_cache)
