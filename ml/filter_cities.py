import csv

source = "ml/data/world-cities/cities.csv"
output = "ml/data/world-cities/selected_cities.csv"

count = 0
countries = set()
top = []

with open(source, "r", encoding="utf-8-sig", newline="") as fin, \
     open(output, "w", encoding="utf-8-sig", newline="") as fout:

    reader = csv.DictReader(fin)
    writer = csv.DictWriter(fout, fieldnames=reader.fieldnames)
    writer.writeheader()

    for row in reader:
        try:
            population = int(row["population"])
        except (ValueError, TypeError):
            continue

        if population >= 100000:
            writer.writerow(row)
            count += 1
            countries.add(row["country_code"])
            top.append((population, row["city"], row["country_code"]))

top.sort(reverse=True)

print(f"Selected cities: {count:,}")
print(f"Countries covered: {len(countries)}")
print("\nTop 15 cities:")
for population, city, country in top[:15]:
    print(f"{city}, {country}: {population:,}")
