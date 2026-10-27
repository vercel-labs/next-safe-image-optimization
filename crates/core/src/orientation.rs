//! Rotations and flips as elements of the dihedral group D4.
//!
//! We resize *before* rotating (like sharp), because rotating the smaller image is cheaper. That
//! means resize targets (specified in the output frame) need to be mapped back into the input
//! frame.

use image::metadata::Orientation;

/// A signed permutation matrix acting on centered coordinates (x right, y down):
/// `output = M * input`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transform([[i8; 2]; 2]);

/// Indexed by EXIF orientation value minus one.
const EXIF_TRANSFORMS: [Transform; 8] = [
    Transform([[1, 0], [0, 1]]),   // 1: identity
    Transform([[-1, 0], [0, 1]]),  // 2: flip horizontal
    Transform([[-1, 0], [0, -1]]), // 3: rotate 180
    Transform([[1, 0], [0, -1]]),  // 4: flip vertical
    Transform([[0, 1], [1, 0]]),   // 5: transpose
    Transform([[0, -1], [1, 0]]),  // 6: rotate 90 clockwise
    Transform([[0, -1], [-1, 0]]), // 7: transverse
    Transform([[0, 1], [-1, 0]]),  // 8: rotate 270 clockwise
];

impl Transform {
    pub const IDENTITY: Transform = EXIF_TRANSFORMS[0];

    pub fn from_orientation(orientation: Orientation) -> Self {
        EXIF_TRANSFORMS[orientation.to_exif() as usize - 1]
    }

    /// `angle` must be a multiple of 90 (clockwise, may be negative).
    pub fn from_rotation(angle: i32) -> Self {
        match angle.rem_euclid(360) {
            90 => EXIF_TRANSFORMS[5],
            180 => EXIF_TRANSFORMS[2],
            270 => EXIF_TRANSFORMS[7],
            _ => Self::IDENTITY,
        }
    }

    /// Returns the transform equivalent to applying `self`, then `next`.
    pub fn then(self, next: Transform) -> Self {
        let (a, b) = (next.0, self.0);
        let mut out = [[0; 2]; 2];
        for (i, row) in out.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                *cell = a[i][0] * b[0][j] + a[i][1] * b[1][j];
            }
        }
        Transform(out)
    }

    pub fn swaps_axes(self) -> bool {
        self.0[0][0] == 0
    }

    /// Maps output-frame dimensions to input-frame dimensions.
    pub fn input_dims<T>(self, (width, height): (T, T)) -> (T, T) {
        if self.swaps_axes() {
            (height, width)
        } else {
            (width, height)
        }
    }

    pub fn to_orientation(self) -> Orientation {
        let index = EXIF_TRANSFORMS
            .iter()
            .position(|t| *t == self)
            .expect("D4 is closed under composition");
        Orientation::from_exif(index as u8 + 1).expect("valid EXIF orientation")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_table_matches_image_crate() {
        // `image` defines what each orientation does to pixels; check our matrices agree by
        // applying both to a 2x1 image with distinct pixels.
        for exif in 1..=8 {
            let orientation = Orientation::from_exif(exif).unwrap();
            let transform = Transform::from_orientation(orientation);
            let mut img = image::DynamicImage::ImageLuma8(
                image::GrayImage::from_raw(3, 2, vec![0, 1, 2, 3, 4, 5]).unwrap(),
            );
            img.apply_orientation(orientation);
            let out = img.to_luma8();
            for (in_x, in_y) in [(0u32, 0u32), (2, 0), (1, 1), (2, 1)] {
                let value = in_y * 3 + in_x;
                // Map the pixel center through the transform.
                let (cx, cy) = (in_x as f64 + 0.5 - 1.5, in_y as f64 + 0.5 - 1.0);
                let m = transform.0;
                let ox = f64::from(m[0][0]) * cx + f64::from(m[0][1]) * cy;
                let oy = f64::from(m[1][0]) * cx + f64::from(m[1][1]) * cy;
                let (ow, oh) = (out.width() as f64, out.height() as f64);
                let (px, py) = ((ox + ow / 2.0 - 0.5) as u32, (oy + oh / 2.0 - 0.5) as u32);
                assert_eq!(out.get_pixel(px, py)[0] as u32, value, "exif {exif}");
            }
            assert_eq!(transform.to_orientation(), orientation);
        }
    }

    #[test]
    fn composition() {
        let r90 = Transform::from_rotation(90);
        assert_eq!(r90.then(r90), Transform::from_rotation(180));
        assert_eq!(r90.then(r90).then(r90).then(r90), Transform::IDENTITY);
        assert_eq!(Transform::from_rotation(-90), Transform::from_rotation(270));
    }
}
