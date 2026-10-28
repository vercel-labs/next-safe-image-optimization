# Color handling

Images are always output as [8-bit sRGB](https://en.wikipedia.org/wiki/SRGB), with no ICC profile or other color metadata. Inputs with an embedded RGB or grayscale ICC profile (such as Display P3) are converted to sRGB.

## ICC profiles

| Input Format | Converted? |
| --- | --- |
| JPEG, PNG, WebP | Yes |
| TIFF | Yes, unless the profile is large relative to a very small image (e.g. under ~128×128) |
| AVIF | No, [most AVIF images use H.273 CICP values instead](https://bugzilla.mozilla.org/show_bug.cgi?id=1634741#:~:text=The%20bug%20isn%27t,entirely%20appropriate%20here.) |
| AVIF, GIF | No, not widely used |
| SVG | No, rendered directly as sRGB |

- Conversion uses the perceptual rendering intent. Alpha is left unchanged.
- Mismatched, invalid, unsupported, or oversized (>10 MB) profiles are ignored, and the image is treated as sRGB.
- Embedded sRGB ICC profiles perform a transform to sRGB, which is a no-op, but has some performance cost, but [images embedding an sRGB ICC profile are rare](https://almanac.httparchive.org/en/2024/media#image-color-spaces).

## Bit depth

| Input Format | Handling |
| --- | --- |
| 8-bit JPEG, PNG, WebP, GIF, TIFF, AVIF | Decoded as 8-bit |
| 10- and 12-bit AVIF | Reduced to 8-bit |
| 16-bit PNG and TIFF | Reduced to 8-bit |
| 32-bit float TIFF | Clamped to 0–1 and reduced to 8-bit as if gamma-encoded (potentially incorrect) |

Output is always 8 bits per channel. We do not currently use or preserve PNG palettes to improve compression.

## cICP and YUV (AVIF)

CICP (ITU-T H.273) tags describe a color space with code points (primaries, transfer function, matrix, and range) instead of an embedded ICC profile.

- **Color primaries and transfer functions are ignored** in both AVIF (`nclx`) and PNG (`cICP`, as well as `gAMA`, `cHRM`, and `sRGB` chunks).
- **AVIF YUV conversion** uses the AV1 header's matrix coefficients and range. Standard matrices (BT.601, BT.470BG, BT.709, FCC, SMPTE 240, BT.2020, YCgCo, and identity RGB) are supported; chroma-derived, SMPTE 2085, and ICtCp matrices are rejected with `ERR_UNSUPPORTED_FORMAT`.
- **PNG** Third Edition [adds support for CICP](https://www.w3.org/TR/png-3/#cICP-chunk), but it is not currently supported. Most PNG files do not use CICP.

## CMYK (JPEG and TIFF)

CMYK JPEGs and TIFFs are converted to sRGB with a naive formula that ignores any embedded CMYK profile, so colors are noticeably off. CMYK images are designed for print and are not commonly used on the web.

## HDR

There is no HDR support or tone mapping:

- **PQ and HLG** AVIFs and PNGs are decoded as if they were SDR sRGB, so they look flat and washed out.
- **Ultra HDR JPEGs** (with gain maps, as from recent phones): the primary SDR image is decoded and the gain map is dropped.

## Comparison with sharp

Like our defaults, sharp converts images with an embedded profile to 8-bit sRGB and strips all metadata unless configured otherwise.

| Input | Compared to sharp's defaults |
| --- | --- |
| 8-bit JPEG, PNG, WebP, or TIFF with an ICC profile | **Same:** converted to sRGB |
| 16-bit PNG or TIFF with an ICC profile | **Better:** converted to sRGB (sharp converts 16-bit RGB to untagged P3, leaving it desaturated, and skips 16-bit grayscale profiles) |
| AVIF with an ICC profile | **Worse:** profile is ignored |
| CICP-tagged wide-gamut AVIF or PNG | **Same:** CICP is ignored and pixels are treated as sRGB |
| CMYK JPEG or TIFF | **Worse:** naive conversion instead of using an embedded or default CMYK profile |
| Float (scRGB) TIFF | **Worse:** treated as gamma-encoded instead of linear |
| HDR (PQ, HLG, Ultra HDR gain maps) | **Same:** PQ/HLG aren't tone-mapped, and JPEG gain maps are dropped |

### Unsupported sharp options

Because output is always untagged 8-bit sRGB, none of sharp's color or profile options are supported:

- `keepIccProfile()`, `withIccProfile()`, `withMetadata()`, and the `ignoreIcc` input option
- `toColourspace()` and `pipelineColourspace()` (e.g. 16-bit `rgb16` PNG output or `cmyk` output)
- `gamma()` (resizing in linear light)
- `keepGainMap()` and `withGainMap()`
- `metadata()` only includes `hasProfile`, not `space`, `depth`, `bitsPerSample`, `icc`, or `gainMap`

## What Next.js uses

Next.js's image optimizer never sets any of sharp's color or metadata options, so it always produces untagged 8-bit sRGB output—matching our behavior without needing extra color options.
