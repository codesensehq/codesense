// SPDX-License-Identifier: MIT
use std::cell::Cell;

use super::*;

/// A cache over one stamp and one answer that the test moves by hand.
struct Source {
    stamp: Cell<u32>,
    value: Cell<u32>,
}

impl Source {
    fn new() -> Self {
        Source {
            stamp: Cell::new(1),
            value: Cell::new(10),
        }
    }
    fn read(&self, cache: &ConfigCache<&'static str, u32, u32>) -> u32 {
        cache
            .get(&"k", || self.stamp.get(), || Ok::<_, ()>(self.value.get()))
            .unwrap()
    }
}

fn reads(stamps: usize, loads: usize) -> Reads {
    Reads { stamps, loads }
}

#[test]
fn unarmed_every_read_loads() {
    let cache = ConfigCache::new();
    let source = Source::new();
    source.read(&cache);
    source.value.set(11);
    assert_eq!(source.read(&cache), 11);
    assert_eq!(cache.reads(&"k"), reads(0, 0), "nothing kept, nothing counted");
}

#[test]
fn a_kept_answer_is_rechecked_once_per_window_and_reloaded_only_when_its_stamp_moved() {
    let _armed = arm_this_thread();
    let cache = ConfigCache::new();
    let source = Source::new();
    assert_eq!(source.read(&cache), 10);
    assert_eq!(cache.reads(&"k"), reads(1, 1), "stamped, then loaded");

    source.value.set(11);
    assert_eq!(source.read(&cache), 10, "within the window: kept, unread");
    assert_eq!(cache.reads(&"k"), reads(1, 1));

    cache.expire();
    assert_eq!(source.read(&cache), 10, "stamp unchanged: kept");
    assert_eq!(cache.reads(&"k"), reads(2, 1), "re-stamped, not reloaded");

    cache.expire();
    source.stamp.set(2);
    assert_eq!(source.read(&cache), 11, "stamp moved: reloaded");
    assert_eq!(cache.reads(&"k"), reads(3, 2));
    assert_eq!(source.read(&cache), 11);
    assert_eq!(cache.reads(&"k"), reads(3, 2));
}

#[test]
fn an_invalidation_drops_every_entry() {
    let _armed = arm_this_thread();
    let cache = ConfigCache::new();
    let source = Source::new();
    source.read(&cache);
    source.value.set(11);
    cache.invalidate();
    assert_eq!(source.read(&cache), 11);
    assert_eq!(cache.reads(&"k"), reads(2, 2));
}

#[test]
fn a_failed_load_is_not_kept() {
    let _armed = arm_this_thread();
    let cache: ConfigCache<&'static str, u32, u32> = ConfigCache::new();
    assert_eq!(cache.get(&"k", || 1, || Err("unreadable")), Err("unreadable"));
    assert_eq!(cache.get(&"k", || 1, || Ok::<_, ()>(5)), Ok(5));
    assert_eq!(cache.reads(&"k"), reads(2, 2));
}

#[test]
fn a_load_that_raced_an_invalidation_is_answered_but_not_kept() {
    let _armed = arm_this_thread();
    let cache: ConfigCache<&'static str, u32, u32> = ConfigCache::new();
    let value = cache.get(
        &"k",
        || 1,
        || {
            cache.invalidate();
            Ok::<_, ()>(5)
        },
    );
    assert_eq!(value, Ok(5));
    assert_eq!(cache.get(&"k", || 1, || Ok::<_, ()>(6)), Ok(6));
}

#[test]
fn a_dir_stamp_moves_when_an_entry_is_added_or_edited() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.yaml");
    std::fs::write(&file, "id: a\n").unwrap();
    let before = dir_stamp(dir.path());
    std::fs::write(&file, "id: a\nname: longer\n").unwrap();
    let edited = dir_stamp(dir.path());
    assert_ne!(before, edited, "an edit moves the entry's stamp");
    std::fs::write(dir.path().join("b.yaml"), "id: b\n").unwrap();
    assert_ne!(edited, dir_stamp(dir.path()), "a new entry moves the listing");
    assert_eq!(
        dir_stamp(&dir.path().join("missing")),
        (None, Vec::new()),
        "a missing folder stamps as empty"
    );
}
