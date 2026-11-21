"""Resumable, sequential AQI/PM2.5 training for eligible Indian cities."""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "ml"
DATA_DIR = ML_DIR / "data"
MODEL_DIR = ML_DIR / "models"
CITY_FILE = DATA_DIR / "world-cities" / "selected_cities.csv"
LOG_DIR = DATA_DIR / "world-cities" / "training_logs"
FETCH_SCRIPT = ML_DIR / "fetch_data.py"
TRAIN_SCRIPT = ML_DIR / "train_model.py"
DEFAULT_STATE = LOG_DIR / "india_training_state.json"
DEFAULT_LOCK = LOG_DIR / "india_training.lock"


def now():
    return datetime.now(timezone.utc).isoformat()


def slug(value):
    value = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"_+", "_", re.sub(r"[^a-zA-Z0-9]+", "_", value.lower())).strip("_")


def target_ready(key, target):
    model = MODEL_DIR / f"{key}_{target}_xgb.joblib"
    metadata = MODEL_DIR / f"{key}_{target}_metadata.json"
    try:
        meta = json.loads(metadata.read_text(encoding="utf-8"))
        return (model.is_file() and model.stat().st_size > 0
                and meta.get("model_version") == 5 and meta.get("target") == target
                and bool(meta.get("feature_names"))
                and isinstance(meta.get("aggregate_validation"), dict))
    except (OSError, ValueError, AttributeError):
        return False


def history_ready(key):
    file = DATA_DIR / f"{key}_historical.csv"
    return file.is_file() and file.stat().st_size > 0


def classify(city):
    key = city["key"]
    aqi = target_ready(key, "us_aqi")
    pm25 = target_ready(key, "pm2_5")
    if aqi and pm25:
        return "both_models_ready"
    if aqi:
        return "pm2_5_model_missing"
    if pm25:
        return "aqi_model_missing"
    return "both_models_missing"


def load_cities(min_population):
    with CITY_FILE.open("r", encoding="utf-8-sig", newline="") as file:
        rows = csv.DictReader(file)
        cities = []
        for row in rows:
            if row.get("country_code", "").strip().upper() != "IN":
                continue
            try:
                population = int(row.get("population") or 0)
                lat, lon = float(row["latitude"]), float(row["longitude"])
            except (ValueError, KeyError, TypeError):
                continue
            if population < min_population:
                continue
            name = row.get("city", "").strip()
            key = slug(name)
            if not name or not key:
                continue
            cities.append({
                "geoname_id": row["geoname_id"].strip(), "city": name,
                "country": "IN", "population": population,
                "latitude": lat, "longitude": lon, "key": key,
            })
    slug_counts = {}
    for city in cities:
        slug_counts[city["key"]] = slug_counts.get(city["key"], 0) + 1
    for city in cities:
        # Name-only inference cannot distinguish duplicate catalogue names.
        # GeoNames suffixes keep both artifacts distinct; prediction resolves
        # the correct one from coordinates.
        if slug_counts[city["key"]] > 1:
            city["key"] = f"{city['key']}_in_{city['geoname_id']}"
    return cities


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def write_log(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps({"time": now(), **record}, ensure_ascii=False) + "\n")


def fresh_state(cities, min_population):
    records = {}
    for city in cities:
        status = classify(city)
        records[city["geoname_id"]] = {
            **city, "status": status, "history_available": history_ready(city["key"]),
            "attempts": 0, "resume_count": 0, "error": None,
            "updated_at": now(),
        }
    return {
        "schema_version": 1, "scope": "IN", "min_population": min_population,
        "eligible_total": len(cities), "created_at": now(), "updated_at": now(),
        "current_city": None, "worker_pid": None, "running": False,
        "completed": sum(1 for city in records.values() if city["status"] == "both_models_ready"),
        "failed": 0, "pending": len(cities), "cities": records,
    }


def refresh_summary(state):
    records = list(state["cities"].values())
    state["eligible_total"] = len(records)
    state["completed"] = sum(1 for city in records if classify(city) == "both_models_ready")
    state["failed"] = sum(1 for city in records if city.get("status") in ("historical_data_unavailable", "training_failed"))
    state["pending"] = state["eligible_total"] - state["completed"] - state["failed"]
    state["updated_at"] = now()


def run_command(command):
    result = subprocess.run(
        command, cwd=ROOT, text=True, encoding="utf-8", errors="replace",
        capture_output=True,
    )
    if result.stdout:
        print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr, flush=True)
    return result


def command_error(result, fallback):
    details = "\n".join(
        part.strip() for part in (result.stderr, result.stdout) if part and part.strip()
    )
    if not details:
        details = f"process exited with status {result.returncode}"
    return f"{fallback}: {details[-3000:]}"


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def main():
    parser = argparse.ArgumentParser(description="Resumable India-only city model training queue.")
    parser.add_argument("--min-population", type=int, default=100000)
    parser.add_argument("--delay-seconds", type=float, default=2.0, help="Pause between cities.")
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--limit", type=int, default=0, help="Optional small run limit; default processes the full catalogue.")
    parser.add_argument("--checkpoint-and-exit", action="store_true", help="Test recovery by saving one in-progress city and exiting before work.")
    args = parser.parse_args()
    if args.min_population < 0 or args.delay_seconds < 0 or args.max_attempts < 1 or args.limit < 0:
        parser.error("Population, delay, attempts, and limit must be non-negative (attempts at least 1).")
    if not CITY_FILE.exists() or not FETCH_SCRIPT.exists() or not TRAIN_SCRIPT.exists():
        raise FileNotFoundError("India catalogue or required historical fetch/training script is missing.")

    cities = load_cities(args.min_population)
    if args.limit:
        cities = cities[:args.limit]
    args.state_file.parent.mkdir(parents=True, exist_ok=True)
    args.lock_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock_fd = os.open(args.lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            old = json.loads(args.lock_file.read_text(encoding="utf-8"))
        except Exception:
            old = {}
        if pid_alive(old.get("pid")):
            print(f"[BUSY] India training worker is already running (PID {old.get('pid')}).")
            return 2
        args.lock_file.unlink(missing_ok=True)
        lock_fd = os.open(args.lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    with os.fdopen(lock_fd, "w", encoding="utf-8") as lock:
        json.dump({"pid": os.getpid(), "started_at": now()}, lock)

    state = fresh_state(cities, args.min_population)
    if args.state_file.exists():
        try:
            prior = json.loads(args.state_file.read_text(encoding="utf-8"))
            prior_rows = prior.get("cities", {})
            for city in cities:
                old = prior_rows.get(city["geoname_id"], {})
                status = classify(city)
                if status == "both_models_ready":
                    state["cities"][city["geoname_id"]].update({"status": status, "error": None})
                elif old.get("status") == "in_progress":
                    state["cities"][city["geoname_id"]].update(old)
                    state["cities"][city["geoname_id"]].update({
                        **city, "status": "pending", "resume_count": int(old.get("resume_count", 0)) + 1,
                        "attempts": max(0, int(old.get("attempts", 0)) - 1),
                        "history_available": history_ready(city["key"]), "updated_at": now(),
                    })
                    print(f"[RESUME] {city['city']} resumes from its last checkpoint.")
                elif old.get("status") in ("historical_data_unavailable", "training_failed"):
                    state["cities"][city["geoname_id"]].update({
                        **old, **city, "status": "pending", "attempts": 0,
                        "history_available": history_ready(city["key"]),
                    })
                else:
                    state["cities"][city["geoname_id"]].update({
                        **old, **city, "status": status, "history_available": history_ready(city["key"]),
                    })
        except (OSError, ValueError, TypeError) as error:
            print(f"[WARN] Could not load old queue state; rebuilt safely from artifacts: {error}")
    refresh_summary(state)
    state.update({"running": True, "worker_pid": os.getpid(), "started_at": now()})
    atomic_json(args.state_file, state)
    write_log(LOG_DIR / "india_training_events.jsonl", {"event": "worker_started", "pid": os.getpid(), "eligible_total": state["eligible_total"]})
    print(f"Eligible India cities: {state['eligible_total']}; already complete: {state['completed']}; pending: {state['pending']}")

    try:
        processed = 0
        for city in cities:
            record = state["cities"][city["geoname_id"]]
            ready = classify(city) == "both_models_ready"
            if ready or record.get("status") in ("historical_data_unavailable", "training_failed") and int(record.get("attempts", 0)) >= args.max_attempts:
                continue
            state["current_city"] = city["city"]
            record.update({**city, "status": "in_progress", "updated_at": now(), "history_available": history_ready(city["key"])})
            refresh_summary(state)
            state.update({"running": True, "worker_pid": os.getpid(), "current_city": city["city"]})
            atomic_json(args.state_file, state)
            write_log(LOG_DIR / "india_training_events.jsonl", {"event": "city_started", "city": city["city"], "key": city["key"]})
            if args.checkpoint_and_exit:
                print(f"[CHECKPOINT] Saved {city['city']} as in progress; exiting to simulate interruption.")
                state.update({"running": False, "worker_pid": None, "current_city": None, "updated_at": now()})
                atomic_json(args.state_file, state)
                return 75

            error_message = None
            for attempt in range(int(record.get("attempts", 0)) + 1, args.max_attempts + 1):
                record.update({"attempts": attempt, "status": "in_progress", "updated_at": now()})
                state["cities"][city["geoname_id"]] = record
                atomic_json(args.state_file, state)
                try:
                    lat, lon = city["latitude"], city["longitude"]
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        raise ValueError("Invalid catalogue coordinates.")
                    print(f"\n[{processed + 1}] {city['city']} (attempt {attempt}/{args.max_attempts})")
                    fetch_result = run_command([sys.executable, str(FETCH_SCRIPT), city["key"], "--lat", str(lat), "--lon", str(lon), "--reuse-cache"])
                    if fetch_result.returncode != 0:
                        raise RuntimeError(command_error(fetch_result, "Historical data fetch failed"))
                    record["history_available"] = history_ready(city["key"])
                    train_result = run_command([sys.executable, str(TRAIN_SCRIPT), city["key"], "--fast"])
                    if train_result.returncode != 0:
                        raise RuntimeError(command_error(train_result, "XGBoost training failed"))
                    if classify(city) != "both_models_ready":
                        raise RuntimeError("Training finished without both valid target model files and metadata.")
                    record.update({"status": "both_models_ready", "error": None, "updated_at": now()})
                    error_message = None
                    break
                except Exception as error:
                    error_message = str(error)
                    record.update({"error": error_message, "updated_at": now(), "history_available": history_ready(city["key"])})
                    if attempt < args.max_attempts:
                        record["status"] = "retrying"
                        atomic_json(args.state_file, state)
                        delay = min(60, 3 ** attempt)
                        print(f"[RETRY] {error_message}; waiting {delay}s.")
                        time.sleep(delay)
            if error_message:
                record["status"] = "training_failed" if record["history_available"] else "historical_data_unavailable"
            state["cities"][city["geoname_id"]] = record
            refresh_summary(state)
            state.update({"running": True, "worker_pid": os.getpid(), "current_city": city["city"]})
            atomic_json(args.state_file, state)
            write_log(LOG_DIR / "india_training_events.jsonl", {"event": "city_finished", "city": city["city"], "status": record["status"], "error": record.get("error")})
            processed += 1
            time.sleep(args.delay_seconds)
        refresh_summary(state)
        print(f"\nQueue checkpoint: completed={state['completed']} pending={state['pending']} failed={state['failed']} / total={state['eligible_total']}")
        return 0 if state["pending"] == 0 and state["failed"] == 0 else 1
    finally:
        state["running"] = False
        state["worker_pid"] = None
        state["current_city"] = None
        state["updated_at"] = now()
        atomic_json(args.state_file, state)
        args.lock_file.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
