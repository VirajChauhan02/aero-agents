import csv
from pathlib import Path

source = Path("ml/data/world-cities/allCountries.txt")
output = Path("ml/data/world-cities/cities.csv")

count = 0
population_places = {
    "PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4",
    "PPLC", "PPLG", "PPLF", "PPLR", "PPLS"
}

with source.open("r", encoding="utf-8", newline="") as fin, \
     output.open("w", encoding="utf-8-sig", newline="") as fout:

    writer = csv.writer(fout)
    writer.writerow([
        "geoname_id", "city", "latitude", "longitude",
        "country_code", "population", "feature_code"
    ])

    for row in csv.reader(fin, delimiter="\t"):
        if len(row) < 19:
            continue

        feature_class = row[6]
        feature_code = row[7]

        if feature_class != "P" or feature_code not in population_places:
            continue

        try:
            latitude = float(row[4])
            longitude = float(row[5])
            population = int(row[14] or 0)
        except ValueError:
            continue

        if not row[1].strip() or not row[8].strip():
            continue

        writer.writerow([
            row[0], row[1], latitude, longitude,
            row[8], population, feature_code
        ])
        count += 1

print(f"City catalog created: {output}")
print(f"Total populated places: {count:,}")
