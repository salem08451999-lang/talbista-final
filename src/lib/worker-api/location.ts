import { ApiError, asNumber, now, first, run, runtimeBindings } from "./common";
import { ApiContext, apiUser, NO_ROUTE } from "./accounts";
import { priceFromRoadDistance, type RouteQuote } from "./location-pricing";

const BENGHAZI_BIAS = { lat: 32.116, lon: 20.068 };
const PHOTON = "https://photon.komoot.io";
const ORS = "https://api.heigit.org/v2/directions/driving-car/json";

type Coordinates = { pickup_lat: number; pickup_lng: number; dropoff_lat: number; dropoff_lng: number };
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function locationCoordinates(body: Record<string, unknown>): Coordinates {
  const pickupLat = asNumber(body.pickup_lat, "pickup_lat", -90, 90);
  const pickupLng = asNumber(body.pickup_lng, "pickup_lng", -180, 180);
  const dropoffLat = asNumber(body.dropoff_lat, "dropoff_lat", -90, 90);
  const dropoffLng = asNumber(body.dropoff_lng, "dropoff_lng", -180, 180);
  if ([pickupLat, pickupLng, dropoffLat, dropoffLng].some((value) => value == null)) throw new ApiError(400, "اختَر موقعي الاستلام والتسليم من الخريطة");
  return { pickup_lat: pickupLat!, pickup_lng: pickupLng!, dropoff_lat: dropoffLat!, dropoff_lng: dropoffLng! };
}

function labelOf(properties: Record<string, unknown>): string {
  const name = typeof properties.name === "string" ? properties.name.trim() : "";
  const street = typeof properties.street === "string" ? properties.street.trim() : "";
  const city = typeof properties.city === "string" ? properties.city.trim() : "";
  const district = typeof properties.district === "string" ? properties.district.trim() : "";
  const place = [name || street, district, city].filter(Boolean).join("، ");
  return (place || city || "موقع على الخريطة").slice(0, 180);
}

async function photon(url: URL): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new ApiError(502, "خدمة اقتراح المواقع غير متاحة مؤقتًا");
  return await response.json() as Record<string, unknown>;
}

async function suggestions(ctx: ApiContext): Promise<unknown> {
  await apiUser(ctx, ["CUSTOMER", "STORE", "DRIVER"]);
  const url = new URL(ctx.request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 120) throw new ApiError(400, "أدخل اسم منطقة أو شارعًا صحيحًا");
  const endpoint = new URL("/api/", PHOTON);
  endpoint.searchParams.set("q", q);
  endpoint.searchParams.set("lat", String(BENGHAZI_BIAS.lat));
  endpoint.searchParams.set("lon", String(BENGHAZI_BIAS.lon));
  endpoint.searchParams.set("limit", "6");
  endpoint.searchParams.set("lang", "ar");
  const data = await photon(endpoint);
  const source = Array.isArray(data.features) ? data.features : [];
  const features = source.slice(0, 6).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const feature = value as Record<string, unknown>;
    const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | undefined;
    const properties = feature.properties as Record<string, unknown> | undefined;
    const coords = geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2 || !properties) return [];
    const lng = Number(coords[0]), lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];
    return [{ geometry: { type: "Point", coordinates: [lng, lat] }, properties: { name: labelOf(properties), label: labelOf(properties), city: properties.city ?? null, country: properties.country ?? null } }];
  });
  return { features };
}

async function reverse(ctx: ApiContext): Promise<unknown> {
  await apiUser(ctx, ["CUSTOMER", "STORE", "DRIVER"]);
  const url = new URL(ctx.request.url);
  const lat = asNumber(url.searchParams.get("lat"), "lat", -90, 90);
  const lon = asNumber(url.searchParams.get("lng"), "lng", -180, 180);
  if (lat == null || lon == null) throw new ApiError(400, "إحداثيات غير صالحة");
  const endpoint = new URL("/reverse", PHOTON);
  endpoint.searchParams.set("lat", String(lat));
  endpoint.searchParams.set("lon", String(lon));
  endpoint.searchParams.set("limit", "1");
  endpoint.searchParams.set("lang", "ar");
  const data = await photon(endpoint);
  const feature = Array.isArray(data.features) ? data.features[0] as Record<string, unknown> | undefined : undefined;
  const properties = feature?.properties as Record<string, unknown> | undefined;
  const name = properties ? labelOf(properties) : "موقع على الخريطة";
  return { features: [{ properties: { name, label: name } }] };
}

export async function consumeEstimateQuota(userId: number): Promise<void> {
  const bucket = Math.floor(now() / 60);
  await run(`INSERT INTO location_estimate_rate_limits(user_id,minute_bucket,request_count)
    VALUES(?,?,1) ON CONFLICT(user_id,minute_bucket) DO UPDATE SET request_count=request_count+1`, userId, bucket);
  const row = await first<{ request_count: number }>("SELECT request_count FROM location_estimate_rate_limits WHERE user_id=? AND minute_bucket=?", userId, bucket);
  await run("DELETE FROM location_estimate_rate_limits WHERE user_id=? AND minute_bucket<?", userId, bucket - 60);
  if (Number(row?.request_count ?? 0) > 20) throw new ApiError(429, "طلبات حساب المسافة كثيرة؛ انتظر دقيقة");
}

export function routeProviderReady(): boolean {
  const key = runtimeBindings().ORS_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

export async function calculateRouteQuote(coords: Coordinates, femaleDriver: boolean): Promise<RouteQuote> {
  const key = runtimeBindings().ORS_API_KEY;
  if (typeof key !== "string" || !key.trim()) throw new ApiError(503, "التسعير التلقائي ينتظر إعداد خدمة المسارات");
  let response: Response;
  try {
    response = await fetch(ORS, {
      method: "POST",
      headers: { Authorization: key.trim(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ coordinates: [[coords.pickup_lng, coords.pickup_lat], [coords.dropoff_lng, coords.dropoff_lat]], units: "m" }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(502, "تعذر حساب مسافة الطريق مؤقتًا؛ لم يُنشأ أي طلب");
  }
  if (!response.ok) throw new ApiError(502, "تعذر حساب مسافة الطريق مؤقتًا؛ حاول لاحقًا");
  const payload = await response.json() as { routes?: Array<{ summary?: { distance?: number } }> };
  const distance = Number(payload.routes?.[0]?.summary?.distance);
  if (!Number.isFinite(distance) || distance < 0 || distance > 1_000_000) throw new ApiError(502, "لم يرجع مزود المسارات مسافة صالحة");
  return priceFromRoadDistance(distance, femaleDriver);
}

async function estimate(ctx: ApiContext): Promise<unknown> {
  const user = await apiUser(ctx, ["CUSTOMER"]);
  await consumeEstimateQuota(user.id);
  const coords = locationCoordinates(ctx.body);
  const femaleDriver = bool(ctx.body.female_driver_only);
  return { ok: true, provider: "openrouteservice", ...await calculateRouteQuote(coords, femaleDriver) };
}

export async function handleLocationApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const { method, path } = ctx;
  if (method === "GET" && path === "/api/location/status") {
    return { provider: "openrouteservice", routing_ready: routeProviderReady() };
  }
  if (method === "GET" && path === "/api/location/suggest") return suggestions(ctx);
  if (method === "GET" && path === "/api/location/reverse") return reverse(ctx);
  if (method === "POST" && path === "/api/location/estimate") return estimate(ctx);
  return NO_ROUTE;
}
