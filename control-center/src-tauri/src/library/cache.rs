//! In-memory search cache with 10-minute TTL.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::types::RemoteItem;

pub(super) struct CacheEntry {
    pub(super) items: Vec<RemoteItem>,
    pub(super) inserted_at: Instant,
}

pub(super) static CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);
pub(super) const CACHE_TTL: Duration = Duration::from_secs(600);

pub(super) fn cache_get(key: &str) -> Option<Vec<RemoteItem>> {
    let mut guard = CACHE.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(entry) = map.get(key) {
        if entry.inserted_at.elapsed() < CACHE_TTL {
            return Some(entry.items.clone());
        }
    }
    None
}

pub(super) fn cache_put(key: String, items: Vec<RemoteItem>) {
    if let Ok(mut guard) = CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            key,
            CacheEntry {
                items,
                inserted_at: Instant::now(),
            },
        );
    }
}
