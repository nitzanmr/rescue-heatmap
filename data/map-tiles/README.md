# Offline Map Tiles

## Strategy

The app needs to work offline. Map tiles must be pre-cached for the affected area.

## Recommended Tile Sources

1. **OpenStreetMap** — Free, open license, good coverage in Latin America
2. **Mapbox** — Better styling, free tier available (requires API key)
3. **Stamen/Stadia** — Good for heatmap overlays

## How to Pre-Cache

### Using `tiledownload` or similar tool:

1. Define bounding box for affected area (+ 50km buffer)
2. Download zoom levels 8-16 (balance detail vs. storage)
3. Store in `mbtiles` format for efficient offline access
4. Service worker serves tiles from local cache

### Example Bounding Box (Venezuela — June 2026)

```
North: 11.0
South: 9.5
East: -66.0
West: -68.5
Zoom: 8-16
Estimated size: ~200MB
```

### Example Bounding Box (Colombia — August 2026)

```
North: 7.0
South: 3.5
East: -75.0
West: -78.0
Zoom: 8-16
Estimated size: ~300MB
```

## Storage Considerations

- Zoom 8-12: ~5MB (overview)
- Zoom 13-14: ~50MB (neighborhood level)
- Zoom 15-16: ~500MB+ (building level)

For mobile offline use, zoom 8-14 is a good balance (~55MB).

## Implementation Notes

- Use `idb` (IndexedDB wrapper) for tile storage in browser
- Service worker intercepts tile requests and serves from cache
- Fallback to network when online
- Pre-cache on first load when connectivity is available
