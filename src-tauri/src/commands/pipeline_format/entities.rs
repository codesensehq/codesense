// SPDX-License-Identifier: MIT
//! The one HTML character-reference decoder shared by title extraction,
//! `cs:*` meta values, pane manifests and context-query summaries.
//!
//! Decoding is a single left-to-right pass, so `&amp;#39;` decodes once, to the
//! text `&#39;`. Decimal (`&#39;`) and hex (`&#x27;`) references always decode;
//! the named references decoded depend on the [`NamedSet`]. A reference that
//! is not in the set (or is not a valid scalar value) is kept as written.

use regex::{Captures, Regex};
use std::sync::LazyLock;

static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);").unwrap());

/// Which named references [`decode_entities`] resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NamedSet {
    /// `amp lt gt quot`: what an HTML attribute value carries (the write
    /// path's `html_attr_escape` set).
    Attribute,
    /// The attribute set plus `apos nbsp mdash ndash hellip` and the curly
    /// quotes: what hand- or tool-authored text (titles, summaries) carries.
    Text,
}

fn named(set: NamedSet, name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        _ if set == NamedSet::Attribute => None,
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        "mdash" => Some('—'),
        "ndash" => Some('–'),
        "hellip" => Some('…'),
        "rsquo" => Some('’'),
        "lsquo" => Some('‘'),
        "rdquo" => Some('”'),
        "ldquo" => Some('“'),
        _ => None,
    }
}

/// Decode the character references in `text` in one pass (see the module docs).
pub(crate) fn decode_entities(text: &str, set: NamedSet) -> String {
    ENTITY
        .replace_all(text, |c: &Captures| {
            let body = &c[1];
            let ch = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = body.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                named(set, body)
            };
            ch.map(String::from).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_decimal_and_hex_in_both_sets() {
        for set in [NamedSet::Attribute, NamedSet::Text] {
            assert_eq!(
                decode_entities("clone&#x27;s &#39;a&#X27;", set),
                "clone's 'a'"
            );
        }
    }

    #[test]
    fn decodes_once() {
        assert_eq!(
            decode_entities("&amp;#39; &amp;lt; &amp;amp;", NamedSet::Text),
            "&#39; &lt; &amp;"
        );
    }

    #[test]
    fn attribute_set_does_not_widen() {
        assert_eq!(
            decode_entities(
                "&apos;&nbsp;&mdash;&hellip;&quot;&lt;&gt;&amp;",
                NamedSet::Attribute
            ),
            "&apos;&nbsp;&mdash;&hellip;\"<>&"
        );
    }

    #[test]
    fn text_set_adds_apos_and_typography() {
        assert_eq!(
            decode_entities("&apos;&mdash;&hellip;&rsquo;", NamedSet::Text),
            "'—…’"
        );
    }

    #[test]
    fn unknown_or_invalid_references_stay() {
        assert_eq!(
            decode_entities("&bogus; &#xD800; &#99999999999; & &amp", NamedSet::Text),
            "&bogus; &#xD800; &#99999999999; & &amp"
        );
    }
}
