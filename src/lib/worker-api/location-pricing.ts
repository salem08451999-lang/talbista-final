export type RouteQuote = {
  distance_m: number;
  distance_km: number;
  base_price: number;
  min_price: number;
  max_price: number;
};

const UNITS_PER_DINAR = 1000;

export function shouldRecalculateRouteQuote(role: string, routingReady: boolean, requested: boolean, femaleOnly: boolean): boolean {
  return role === "CUSTOMER" && (routingReady || requested || femaleOnly);
}

export function priceFromRoadDistance(distanceMeters: number, femaleDriver: boolean): RouteQuote {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || distanceMeters > 1_000_000) {
    throw new RangeError("invalid route distance");
  }

  const kilometers = distanceMeters / 1000;
  const base = kilometers <= 5 ? 13 : 13 + (kilometers - 5);
  const baseUnits = Math.round(base * UNITS_PER_DINAR);
  const maxUnits = Math.round(baseUnits * (femaleDriver ? 1.2 : 1));
  const minUnits = Math.max(0, maxUnits - 5 * UNITS_PER_DINAR);

  return {
    distance_m: Math.round(distanceMeters),
    distance_km: Math.round(kilometers * 100) / 100,
    base_price: baseUnits / UNITS_PER_DINAR,
    min_price: minUnits / UNITS_PER_DINAR,
    max_price: maxUnits / UNITS_PER_DINAR,
  };
}
