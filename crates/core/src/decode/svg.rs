//! SVG via resvg (usvg parses, tiny-skia renders). Built without text support: Next.js's OG images
//! come from Satori, which converts text to paths. Only `data:` URLs are loaded, never files.
//!
//! Like sharp, SVGs are rendered at the size they're being resized to (see
//! [`crate::ops::vector_scale`]), instead of being rasterized at their natural size and resampled.
//!
//! The pixel limit applies to the natural and rendered sizes, but not to embedded raster images:
//! resvg decodes those itself while rendering, without size checks, so only the worker's memory
//! limits and the caller's timeout bound them.

use image::metadata::Orientation;
use image::{DynamicImage, RgbaImage};
use resvg::{tiny_skia, usvg};

use crate::decode::{Header, InputFormat};
use crate::error::{Error, Result};
use crate::limits::Limits;

/// Like libvips: `<svg` (in any case) must be within this many bytes of the start, and everything
/// before it must be valid UTF-8.
const HEADER_SIZE: usize = 1000;

/// Only checked after `image`'s magic bytes, since text-based detection is looser: a GIF comment
/// could contain `<svg`.
pub fn is_svg(input: &[u8]) -> bool {
    let head = &input[..input.len().min(HEADER_SIZE)];
    head.windows(4)
        .position(|window| window.eq_ignore_ascii_case(b"<svg"))
        .is_some_and(|start| std::str::from_utf8(&head[..start]).is_ok())
}

pub struct Svg {
    tree: usvg::Tree,
    /// The natural size, rounded.
    pub width: u32,
    pub height: u32,
}

impl Svg {
    pub fn parse(input: &[u8], limits: &Limits) -> Result<Self> {
        let options = usvg::Options {
            // Like sharp's default density, so that e.g. `1in` is 72 pixels.
            dpi: 72.0,
            image_href_resolver: usvg::ImageHrefResolver {
                resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
                // The default reads files.
                resolve_string: Box::new(|_, _| None),
            },
            ..usvg::Options::default()
        };
        let tree = usvg::Tree::from_data(input, &options)
            .map_err(|err| Error::Decode(format!("invalid SVG: {err}")))?;
        let size = tree.size();
        // Saturating casts, which `check_input_pixels` rejects.
        let width = f64::from(size.width()).round() as u32;
        let height = f64::from(size.height()).round() as u32;
        limits.check_input_pixels(width, height)?;
        Ok(Svg {
            tree,
            width,
            height,
        })
    }

    pub fn header(&self) -> Header {
        Header {
            format: InputFormat::Svg,
            width: self.width,
            height: self.height,
            has_alpha: true,
            orientation: Orientation::NoTransforms,
            icc_profile: None,
        }
    }

    /// Renders at `scale` times the natural size, as straight (non-premultiplied) RGBA.
    pub fn render(&self, scale: f64, limits: &Limits) -> Result<DynamicImage> {
        let size = self.tree.size();
        let width = (f64::from(size.width()) * scale).round().max(1.0);
        let height = (f64::from(size.height()) * scale).round().max(1.0);
        limits.check_output(width, height, 4)?;
        let (width, height) = (width as u32, height as u32);
        // The pixel limit applies to what's rendered, too.
        limits.check_input_pixels(width, height)?;
        let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
            Error::LimitExceeded(format!("SVG can't be rendered at {width}x{height}"))
        })?;
        let transform = tiny_skia::Transform::from_scale(
            width as f32 / size.width(),
            height as f32 / size.height(),
        );
        resvg::render(&self.tree, transform, &mut pixmap.as_mut());
        let data = pixmap.take_demultiplied();
        Ok(RgbaImage::from_raw(width, height, data)
            .expect("pixmap size matches dimensions")
            .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(svg: &str) -> Result<Svg> {
        Svg::parse(svg.as_bytes(), &Limits::default())
    }

    #[test]
    fn detects_svg() {
        assert!(is_svg(b"<svg"));
        assert!(is_svg(
            b"\xEF\xBB\xBF<?xml version=\"1.0\"?>\n<!-- \xC3\xA9 -->\n<SVG"
        ));
        assert!(!is_svg(b"<html><body></body></html>"));
        assert!(!is_svg(b"\xFF<svg"));
        let late = format!("{}<svg", " ".repeat(HEADER_SIZE));
        assert!(!is_svg(late.as_bytes()));
    }

    #[test]
    fn natural_size() {
        let svg = parse(r#"<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="20.6"/>"#);
        let svg = svg.unwrap();
        assert_eq!((svg.width, svg.height), (72, 21));
        let svg = parse(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"/>"#);
        let svg = svg.unwrap();
        assert_eq!((svg.width, svg.height), (30, 10));
    }

    #[test]
    fn renders_at_scale() {
        let svg = parse(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2">
                <rect width="2" height="2" fill="red"/>
            </svg>"#,
        )
        .unwrap();
        let img = svg.render(2.5, &Limits::default()).unwrap().into_rgba8();
        assert_eq!(img.dimensions(), (10, 5));
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(9, 4).0, [0, 0, 0, 0]);
    }

    fn green_png() -> Vec<u8> {
        let mut png = Vec::new();
        RgbaImage::from_pixel(2, 2, image::Rgba([0, 255, 0, 255]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn with_image(href: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">
                <image width="2" height="2" href="{href}"/>
            </svg>"#
        )
    }

    #[test]
    fn renders_data_urls() {
        let encoded: String = green_png().iter().map(|b| format!("%{b:02X}")).collect();
        let svg = parse(&with_image(&format!("data:image/png,{encoded}"))).unwrap();
        let img = svg.render(1.0, &Limits::default()).unwrap().into_rgba8();
        assert_eq!(img.get_pixel(1, 1).0, [0, 255, 0, 255]);
    }

    #[test]
    fn ignores_files() {
        let path = std::env::temp_dir().join(format!("blunt-svg-test-{}.png", std::process::id()));
        std::fs::write(&path, green_png()).unwrap();
        let path_str = path.to_str().unwrap();
        let absolute = parse(&with_image(path_str));
        let url = parse(&with_image(&format!("file://{path_str}")));
        std::fs::remove_file(&path).unwrap();
        for svg in [absolute, url] {
            assert!(!svg.unwrap().tree.root().has_children());
        }
    }

    #[test]
    fn limits_rendered_pixels() {
        let svg =
            parse(r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>"#).unwrap();
        let limits = Limits {
            input_pixels: 400,
            ..Limits::default()
        };
        assert!(svg.render(2.0, &limits).is_ok());
        assert!(matches!(
            svg.render(3.0, &limits),
            Err(Error::LimitExceeded(_))
        ));
    }

    #[test]
    fn rejects_svgz() {
        assert!(matches!(
            Svg::parse(b"\x1f\x8b\x08\0\0\0\0\0", &Limits::default()),
            Err(Error::Decode(_))
        ));
    }

    /// Image crates that resvg uses directly (for embedded images) must be the same versions that
    /// `image` uses, so that we don't ship two copies.
    #[test]
    fn image_crates_are_deduplicated() {
        let lock = include_str!("../../../../Cargo.lock");
        for name in ["zune-jpeg", "png", "gif", "image-webp"] {
            let count = lock.matches(&format!("name = \"{name}\"\n")).count();
            assert_eq!(count, 1, "{name} is in Cargo.lock {count} times");
        }
    }
}
