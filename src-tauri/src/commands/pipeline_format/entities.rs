// SPDX-License-Identifier: MIT
//! The one HTML character-reference decoder shared by title extraction,
//! `cs:*` meta values, pane manifests and context-query summaries.
//!
//! Decoding is a single left-to-right pass, so `&amp;#39;` decodes once, to the
//! text `&#39;`. Decimal (`&#39;`) and hex (`&#x27;`) references always decode;
//! the named references decoded depend on the [`NamedSet`]. A reference that
//! is not in the set (or is past Unicode) is kept as written. A numeric
//! reference to a character no title may carry (NUL, a control other than tab,
//! newline or carriage return, a surrogate, or a bidi embedding, override or
//! isolate) decodes to U+FFFD, as HTML replaces NUL, C1 controls and surrogates.

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

/// Code points a numeric reference never yields as themselves: surrogates and
/// the bidi embeddings, overrides (U+202A–U+202E) and isolates (U+2066–U+2069).
const REPLACED: [std::ops::RangeInclusive<u32>; 3] =
    [0xD800..=0xDFFF, 0x202A..=0x202E, 0x2066..=0x2069];

/// What a numeric reference to `code` decodes to (see the module docs).
fn numeric(code: u32) -> Option<char> {
    if REPLACED.iter().any(|range| range.contains(&code)) {
        return Some(char::REPLACEMENT_CHARACTER);
    }
    char::from_u32(code).map(|ch| {
        if ch.is_control() && !matches!(ch, '\t' | '\n' | '\r') {
            char::REPLACEMENT_CHARACTER
        } else {
            ch
        }
    })
}

/// Decode the character references in `text` in one pass (see the module docs).
pub(crate) fn decode_entities(text: &str, set: NamedSet) -> String {
    ENTITY
        .replace_all(text, |c: &Captures| {
            let body = &c[1];
            let ch = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(numeric)
            } else if let Some(dec) = body.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(numeric)
            } else {
                named(set, body)
            };
            ch.map(String::from).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

/// A title's element text (`<title>`, `<h1>`) as one line: references decoded
/// with the [`NamedSet::Text`] set, then whitespace collapsed. `None` when that
/// leaves it blank, so `<title>&#32;</title>` counts as no title.
pub(crate) fn decode_title(text: &str) -> Option<String> {
    let title = decode_entities(text, NamedSet::Text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
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
            decode_entities("&bogus; &#x110000; &#99999999999; & &amp", NamedSet::Text),
            "&bogus; &#x110000; &#99999999999; & &amp"
        );
    }

    #[test]
    fn nul_controls_surrogates_and_bidi_controls_decode_to_the_replacement() {
        for set in [NamedSet::Attribute, NamedSet::Text] {
            for reference in [
                "&#0;", "&#x0;", "&#7;", "&#x1B;", "&#x7F;", "&#x80;", "&#x85;", "&#x9F;",
                "&#xD800;", "&#57343;", "&#x202A;", "&#x202E;", "&#8238;", "&#x2066;", "&#x2069;",
            ] {
                assert_eq!(
                    decode_entities(&format!("a{reference}b"), set),
                    "a\u{FFFD}b",
                    "{reference}"
                );
            }
            // Tab, newline and carriage return are text, and so are the marks
            // that sit beside the overrides.
            assert_eq!(
                decode_entities("&#9;&#10;&#13;&#x200F;&#x2065;&#x206A;", set),
                "\t\n\r\u{200F}\u{2065}\u{206A}"
            );
        }
    }

    #[test]
    fn a_title_decodes_then_collapses_and_a_blank_one_is_none() {
        assert_eq!(
            decode_title("  The clone&#x27;s&#10;paths&nbsp;&mdash; now "),
            Some("The clone's paths — now".to_string())
        );
        for blank in ["", "  ", "&#32;", "&nbsp;", "&#9;&#10;"] {
            assert_eq!(decode_title(blank), None, "{blank:?}");
        }
    }
}
