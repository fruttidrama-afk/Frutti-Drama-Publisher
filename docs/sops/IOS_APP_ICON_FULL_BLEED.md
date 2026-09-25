# SOP — iOS APP ICON, FULL-BLEED, NO WHITE MARGIN

Applies to: every Publisher Factory publisher installed/added to iOS Home Screen.

This document is intentionally explicit because iOS icon caching and nested-logo mistakes are easy to misdiagnose.

## A. 25 failure-analysis checks

1. Confirm which exact `<link rel="apple-touch-icon">` URL production HTML serves.
2. Confirm the URL is a concrete PNG endpoint/file, not a webpage.
3. Confirm HTTP status 200.
4. Confirm Content-Type is `image/png`.
5. Confirm dimensions are exactly 180x180 for the touch icon.
6. Inspect the actual returned PNG, not the source logo.
7. Check pixel (0,0): it must be intended background, not white/transparency.
8. Check pixel (179,0).
9. Check pixel (0,179).
10. Check pixel (179,179).
11. Check the full outer top row for unwanted white.
12. Check the full outer bottom row.
13. Check the full outer left column.
14. Check the full outer right column.
15. Check for an internal white rounded rectangle/card around the artwork.
16. Check whether transparent padding in the source was preserved accidentally.
17. Check whether a checkerboard "transparency preview" was baked into the source raster.
18. Check whether trim is using the wrong background color.
19. Check whether the artwork is being resized before trim instead of after trim.
20. Check whether a maskable safe-area rule is unnecessarily shrinking the iOS touch icon.
21. Check whether manifest icons conflict with the apple-touch-icon.
22. Check whether favicon is being shown in the share sheet instead of the intended touch icon.
23. Check whether a CDN/redirect is returning an older asset.
24. Check whether iOS is caching the icon by origin/path despite a query-string change.
25. Check whether production is actually deployed with the commit being inspected.

## B. 25 known-good construction / verification checks

1. Start from the real brand artwork, never from a screenshot of an already padded icon.
2. If the supplied checkerboard is only a transparency preview, remove/ignore it.
3. Create one square canvas.
4. Fill that canvas edge-to-edge with the brand background color or approved pattern.
5. The canvas itself must have no alpha at the outer edge.
6. Trim only source padding, not legitimate white details inside the logo.
7. Scale artwork to the maximum safe size.
8. Prefer roughly 90–98% visual occupancy when the artwork shape permits it.
9. Keep critical details inside the iOS rounded-corner safe region.
10. Do not pre-render a white rounded iOS tile.
11. Do not add a second card behind the logo.
12. Composite artwork directly onto the full-bleed background.
13. Flatten output to an opaque PNG.
14. Export the exact 180x180 icon.
15. Give the corrected icon a brand-new filename, not only a new query string.
16. Reference that filename in `apple-touch-icon`.
17. Reference it in `apple-touch-icon-precomposed`.
18. Ensure manifest does not point to a conflicting padded icon.
19. Keep the icon endpoint public before auth middleware.
20. Serve with no-store while iterating.
21. Deploy the built runtime, not just source.
22. Verify the live PNG byte size/content type/dimensions.
23. Inspect the live icon file visually.
24. On iOS, delete the existing Home Screen shortcut and recreate it.
25. Once visually accepted, freeze the known-good asset and record it as the template for future publishers.

## Proven pattern from previous publisher fixes

The successful historical approach is:
- concrete `apple-touch-icon-*.png` asset;
- full-bleed background inside the PNG;
- no dependence on a small generic favicon;
- explicit iOS link tags;
- new filename when busting iOS cache;
- visual validation of the actual Home Screen preview.

## Dinnie acceptance criteria

PASS only if all are true:
- no white pixel region around the outside of the icon;
- green/leaf background reaches all four sides;
- Dinnie artwork is large, centered, not clipped;
- the preview does not look like a small poster sitting inside a white iOS tile;
- deleting/recreating the shortcut shows the new icon.

If any condition fails, do not call the icon fixed.
