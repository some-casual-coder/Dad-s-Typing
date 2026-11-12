// Offline lookup from a location pin or a typed place to county and area, so
// no geocoder sees the coordinates. The county comes from OpenStreetMap
// county boundaries (ODbL, see data/ke-counties.json); area names come from
// our list of approximate town and neighbourhood centres.
import counties from "./data/ke-counties.json";

export interface Place { area: string; county: string }
type Row = [area: string, county: string, lat: number, lon: number];

const COUNTY_TOWNS: Row[] = [
  ["Mombasa", "Mombasa", -4.04, 39.67], ["Kwale", "Kwale", -4.17, 39.45], ["Kilifi", "Kilifi", -3.63, 39.85], ["Hola", "Tana River", -1.5, 40.03],
  ["Lamu", "Lamu", -2.27, 40.9], ["Voi", "Taita Taveta", -3.4, 38.56], ["Garissa", "Garissa", -0.45, 39.65], ["Wajir", "Wajir", 1.75, 40.06],
  ["Mandera", "Mandera", 3.94, 41.86], ["Marsabit", "Marsabit", 2.33, 37.99], ["Isiolo", "Isiolo", 0.35, 37.58], ["Meru", "Meru", 0.05, 37.65],
  ["Chuka", "Tharaka-Nithi", -0.33, 37.65], ["Embu", "Embu", -0.53, 37.45], ["Kitui", "Kitui", -1.37, 38.01], ["Machakos", "Machakos", -1.52, 37.26],
  ["Wote", "Makueni", -1.78, 37.63], ["Ol Kalou", "Nyandarua", -0.27, 36.38], ["Nyeri", "Nyeri", -0.42, 36.95], ["Kerugoya", "Kirinyaga", -0.5, 37.28],
  ["Murang'a", "Murang'a", -0.72, 37.15], ["Kiambu", "Kiambu", -1.17, 36.83], ["Lodwar", "Turkana", 3.12, 35.6], ["Kapenguria", "West Pokot", 1.24, 35.11],
  ["Maralal", "Samburu", 1.1, 36.7], ["Kitale", "Trans Nzoia", 1.02, 35.0], ["Eldoret", "Uasin Gishu", 0.52, 35.27], ["Iten", "Elgeyo-Marakwet", 0.67, 35.51],
  ["Kapsabet", "Nandi", 0.2, 35.1], ["Kabarnet", "Baringo", 0.49, 35.74], ["Nanyuki", "Laikipia", 0.01, 37.07], ["Nakuru", "Nakuru", -0.3, 36.07],
  ["Naivasha", "Nakuru", -0.72, 36.43], ["Narok", "Narok", -1.08, 35.87], ["Kajiado", "Kajiado", -1.85, 36.78], ["Kericho", "Kericho", -0.37, 35.29],
  ["Bomet", "Bomet", -0.78, 35.34], ["Kakamega", "Kakamega", 0.28, 34.75], ["Mbale", "Vihiga", 0.06, 34.72], ["Bungoma", "Bungoma", 0.56, 34.56],
  ["Busia", "Busia", 0.46, 34.11], ["Siaya", "Siaya", 0.06, 34.29], ["Kisumu", "Kisumu", -0.09, 34.77], ["Homa Bay", "Homa Bay", -0.53, 34.46],
  ["Migori", "Migori", -1.06, 34.47], ["Kisii", "Kisii", -0.68, 34.77], ["Nyamira", "Nyamira", -0.57, 34.94], ["Malindi", "Kilifi", -3.22, 40.12],
];

const AREAS: Row[] = [
  ["Nairobi CBD", "Nairobi", -1.284, 36.823], ["Westlands", "Nairobi", -1.265, 36.803], ["Parklands", "Nairobi", -1.259, 36.817],
  ["Kilimani", "Nairobi", -1.29, 36.785], ["Kileleshwa", "Nairobi", -1.279, 36.776], ["Lavington", "Nairobi", -1.279, 36.765],
  ["Upper Hill", "Nairobi", -1.298, 36.812], ["Karen", "Nairobi", -1.319, 36.711], ["Lang'ata", "Nairobi", -1.36, 36.75],
  ["South B", "Nairobi", -1.31, 36.84], ["South C", "Nairobi", -1.32, 36.825], ["Embakasi", "Nairobi", -1.32, 36.9],
  ["Eastleigh", "Nairobi", -1.274, 36.85], ["Buruburu", "Nairobi", -1.287, 36.876], ["Donholm", "Nairobi", -1.298, 36.89],
  ["Kasarani", "Nairobi", -1.221, 36.897], ["Roysambu", "Nairobi", -1.218, 36.884], ["Gigiri", "Nairobi", -1.233, 36.803],
  ["Runda", "Nairobi", -1.218, 36.812], ["Kitisuru", "Nairobi", -1.228, 36.781], ["Ruaka", "Kiambu", -1.207, 36.776],
  ["Kikuyu", "Kiambu", -1.246, 36.663], ["Thika", "Kiambu", -1.033, 37.069], ["Juja", "Kiambu", -1.102, 37.014],
  ["Ruiru", "Kiambu", -1.146, 36.961], ["Rongai", "Kajiado", -1.396, 36.759], ["Ngong", "Kajiado", -1.362, 36.656],
  ["Kitengela", "Kajiado", -1.474, 36.961], ["Syokimau", "Machakos", -1.365, 36.93], ["Athi River", "Machakos", -1.456, 36.978],
  ["Nyali", "Mombasa", -4.03, 39.71], ["Bamburi", "Mombasa", -3.99, 39.72],
];

const KENYA = { minLat: -4.9, maxLat: 5.1, minLon: 33.8, maxLon: 42.0 };
const AREA_KM = 4, TOWN_KM = 25;

function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(a));
}

const nearest = (rows: Row[], lat: number, lon: number) =>
  rows.map((p) => ({ p, d: km(lat, lon, p[2], p[3]) })).sort((a, b) => a.d - b.d)[0];

export type PinResult = (Place & { approximate: boolean }) | "outside_kenya" | "invalid";

// The caller must drop the coordinates after this returns
type Ring = number[][];
const inRing = (x: number, y: number, r: Ring) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const COUNTIES = (counties as { counties: { name: string; polygons: Ring[][] }[] }).counties;

export function countyAt(lat: number, lon: number): string | null {
  return COUNTIES.find((k) => k.polygons.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h))))?.name ?? null;
}

export function placeFromPin(lat: unknown, lon: unknown): PinResult {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return "invalid";
  if (lat < KENYA.minLat || lat > KENYA.maxLat || lon < KENYA.minLon || lon > KENYA.maxLon) return "outside_kenya";
  const county = countyAt(lat, lon);
  // Lake or sea edges can miss every polygon; the nearest town decides then
  if (!county) {
    const t = nearest([...COUNTY_TOWNS, ...AREAS], lat, lon);
    return { area: t.d <= TOWN_KM ? `near ${t.p[0]}` : `${t.p[1]} County`, county: t.p[1], approximate: true };
  }
  const inCounty = (rows: Row[]) => rows.filter((r) => r[1] === county);
  const a = inCounty(AREAS).length ? nearest(inCounty(AREAS), lat, lon) : null;
  if (a && a.d <= AREA_KM) return { area: a.p[0], county, approximate: false };
  const t = inCounty([...COUNTY_TOWNS, ...AREAS]).length ? nearest(inCounty([...COUNTY_TOWNS, ...AREAS]), lat, lon) : null;
  return { area: t && t.d <= TOWN_KM ? `near ${t.p[0]}` : `${county} County`, county, approximate: true };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const NAMES = [...AREAS, ...COUNTY_TOWNS].map((r) => ({ key: norm(r[0]), area: r[0], county: r[1] }))
  .concat([...new Set(COUNTY_TOWNS.map((r) => r[1]))].map((c) => ({ key: norm(c), area: c, county: c })))
  .sort((a, b) => b.key.length - a.key.length);

// A typed place name ("Westlands", "in Kisumu please") to county and area
export function placeFromText(text: string): Place | null {
  const t = ` ${norm(text)} `;
  const hit = NAMES.find((n) => t.includes(` ${n.key} `));
  return hit ? { area: hit.area, county: hit.county } : null;
}

export const isKenyanNumber = (sender: string) => /^\+?254\d{9}$/.test(sender.replace(/[\s-]/g, ""));
