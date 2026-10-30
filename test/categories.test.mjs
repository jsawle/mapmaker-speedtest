import test from "node:test";
import assert from "node:assert/strict";
import { categorise } from "../src/categories.mjs";

const APP = "0cd1cdee853c413a84bfe4b9a6931f0d", MAP = "cdc2ed0afdd8497f97de24a243a318c2";
const c = (host, path, type = "fetch") => categorise({ host, path, type }, { appId: APP, mapId: MAP });

test("MapMaker's own files and set-up calls are the app", () => {
  assert.equal(c("www.arcgis.com", "/apps/instant/_astro/loadUtils.Bg3RBcf3.js", "script"), "app");
  assert.equal(c("www.arcgis.com", "/apps/instant/atlas/index.html", "document"), "app");
  assert.equal(c("www.arcgis.com", `/sharing/rest/content/items/${APP}/data`), "app");
  assert.equal(c("www.arcgis.com", "/sharing/rest/content/groups/36443e9570294a1f883b5d2c5abfe6b5/search"), "app");
  assert.equal(c("www.arcgis.com", "/sharing/rest/portals/self"), "app");
});

test("ArcGIS SDK files are the ArcGIS code", () => {
  assert.equal(c("js.arcgis.com", "/5.1.14/@arcgis/core/layers/ImageryTileLayer.js", "script"), "sdk");
});

test("basemap tiles and styles are the basemap", () => {
  assert.equal(c("basemaps.arcgis.com", "/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/3/2/1.pbf"), "basemap");
  assert.equal(c("server.arcgisonline.com", "/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/1"), "basemap");
  assert.equal(c("services.arcgisonline.com", "/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/3/2/1"), "basemap");
  assert.equal(c("cdn.arcgis.com", "/sharing/rest/content/items/d0d7d6eefdf54400be127647b86531df/resources/sprites/sprite.png", "image"), "basemap");
});

test("the map's layers, images and item JSON are map data", () => {
  assert.equal(c("www.arcgis.com", `/sharing/rest/content/items/${MAP}/data`), "data");
  assert.equal(c("cdn.arcgis.com", `/sharing/rest/content/items/${MAP}/resources/media/a9a3913c.jpeg`), "data");
  assert.equal(c("tiledimageservices.arcgis.com", "/x/arcgis/rest/services/Seafloor_Age_02_WM/ImageServer/tile/3/2/1"), "data");
  assert.equal(c("data-gis.unep-wcmc.org", "/server/rest/services/ProtectedSites/MapServer/export"), "data");
});
