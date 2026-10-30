// Who is responsible for each request: MapMaker itself, the ArcGIS code, the map's basemap, or the map's data.
export const CATEGORIES_VERSION = "0.1.0";
export const CATEGORY_LABELS = {
  app: "MapMaker app",
  sdk: "ArcGIS code",
  basemap: "Basemap",
  data: "Map data",
};
const BASEMAP_SERVICES = /\/services\/(World_[A-Za-z_]+|Elevation\/World_Hillshade|Canvas\/World_[A-Za-z_]+|Ocean\/World_[A-Za-z_]+|Reference\/World_[A-Za-z_]+|Specialty\/World_[A-Za-z_]+|NatGeo_World_Map|USA_Topo_Maps)\/(MapServer|VectorTileServer|ImageServer)/i;

export function categorise(r, ctx = {}) {
  const host = r.host || "", path = r.path || "";
  if (host === "js.arcgis.com") return "sdk";
  if (host.endsWith("arcgis.com") && (path.startsWith("/apps/instant/") || path.startsWith("/itemdata/"))) return "app";
  if (r.type === "document") return "app";
  // MapMaker's own set-up calls: portal/org info, sign-in check, group and catalogue searches
  if (/\/sharing\/rest\/(portals|community|content\/users|content\/groups|oauth2|search|info)\b/.test(path)) return "app";
  if (ctx.appId && path.includes(ctx.appId)) return "app";
  if (host === "basemaps.arcgis.com" || host === "basemapstyles-api.arcgis.com" || host === "static.arcgis.com") return "basemap";
  if (BASEMAP_SERVICES.test(path)) return "basemap";
  if (/\/resources\/(styles|sprites|fonts)\//.test(path)) return "basemap"; // vector basemap style files
  // everything else — the map's layers, its images (item resources/media), its item JSON — is the map's own content
  return "data";
}
