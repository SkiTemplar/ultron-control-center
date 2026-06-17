// skills/hash.rs — Hashing + date helpers (reused by agents.rs for waiver YAML).

use std::fs;
use std::path::Path;

/// Convert a unix timestamp (UTC seconds) into a `YYYY-MM-DD` string.
/// Howard Hinnant's civil-from-days algorithm — pure stdlib, no deps.
/// Made `pub(crate)` so the agents module can reuse it for waiver YAML.
#[allow(dead_code)]
pub(crate) fn format_ymd_local(ts: u64) -> String {
    let days = (ts / 86400) as i64;
    let z = days + 719468;
    let era = if z >= 0 {
        z / 146097
    } else {
        (z - 146096) / 146097
    };
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    if m <= 2 {
        y += 1;
    }
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// SHA1 hash of an on-disk file as a 40-char hex string. `pub(crate)` so
/// the agents module reuses the same hashing engine without dragging in
/// a new crate dep.
#[allow(dead_code)]
pub(crate) fn sha1_of_file(p: &Path) -> Result<String, String> {
    let data = fs::read(p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    let mut hasher = Sha1Engine::new();
    hasher.update(&data);
    Ok(hasher.hex())
}

// Minimal in-tree SHA1 to avoid a new crate dep just for this command.
// `pub(crate)` so the agents module reuses the same engine.
pub(crate) struct Sha1Engine {
    state: [u32; 5],
    buf: Vec<u8>,
    len: u64,
}

impl Sha1Engine {
    pub(crate) fn new() -> Self {
        Self {
            state: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],
            buf: Vec::new(),
            len: 0,
        }
    }
    pub(crate) fn update(&mut self, data: &[u8]) {
        self.len += data.len() as u64;
        self.buf.extend_from_slice(data);
        let mut idx = 0;
        while self.buf.len() - idx >= 64 {
            self.process_block(&self.buf[idx..idx + 64].try_into().unwrap());
            idx += 64;
        }
        self.buf.drain(..idx);
    }
    pub(crate) fn hex(mut self) -> String {
        let bit_len = self.len * 8;
        self.buf.push(0x80);
        while self.buf.len() % 64 != 56 {
            self.buf.push(0);
        }
        self.buf.extend_from_slice(&bit_len.to_be_bytes());
        let mut idx = 0;
        while idx < self.buf.len() {
            let block: [u8; 64] = self.buf[idx..idx + 64].try_into().unwrap();
            self.process_block(&block);
            idx += 64;
        }
        let mut out = String::with_capacity(40);
        for word in self.state {
            out.push_str(&format!("{:08x}", word));
        }
        out
    }
    fn process_block(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            let val = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = val.rotate_left(1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        #[allow(clippy::needless_range_loop)] // i used both in match and w[i]
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
    }
}
