// SPDX-License-Identifier: MIT
//! The v2 group file: the one shape workspaces, groups and starters share.
//!
//! Its tree is the tiling kit's saved-leaf shape (`SavedMosaicNode` in
//! `src/shared/tiling/mosaic-tree.ts`): a leaf carries both `id` and `workspaceId`, a split its
//! axis, children and sizes. So the kit's `parseMosaicNode` reads a file's `root` as it is, and
//! splits and sizes restore exactly. The TS type in `src/shared/tiling/group-file.generated.ts`
//! is generated from these types ([`ts_type`]); a test fails when it drifts.

use serde::{Deserialize, Serialize};

/// The file version this build reads and writes. A file with any other version can't be read.
pub const VERSION: u32 = 2;

/// A group file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupFile {
    /// Always [`VERSION`].
    pub version: u32,
    /// What the file arranges.
    pub owner: OwnerKind,
    /// The file's revision: stored here, only goes up, never reused for this file id.
    pub rev: u64,
    /// The arrangement, or `null` when nothing is placed.
    pub root: Option<SavedNode>,
}

/// What a group file arranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OwnerKind {
    Workspace,
    Group,
    Starter,
}

/// A node of the saved tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SavedNode {
    /// A tile: its ref under both keys, which must be equal, and its tabs when it holds more
    /// than one.
    Leaf {
        id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        /// The tile's tabs in order, each a tile ref. Empty (and not written) for a tile whose
        /// one tab is its own ref.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tabs: Vec<String>,
        /// The tab the tile shows, one of `tabs`. Empty (and not written) with no `tabs`.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        active: String,
    },
    /// A split: two or more children and one size per child.
    Split {
        axis: Axis,
        children: Vec<SavedNode>,
        sizes: Vec<f64>,
    },
}

/// The direction a split lays its children out in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Row,
    Column,
}

/// What a delete leaves in place of the file, so the next create continues its `rev`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tombstone {
    pub version: u32,
    pub deleted: bool,
    pub rev: u64,
}

/// The generated TS type file's path, from the repo root.
pub const TS_TYPE_FILE: &str = "src/shared/tiling/group-file.generated.ts";

/// The TS declarations of [`GroupFile`], rendered from its JSON schema: the root type first, then
/// each referenced type by name. A field the schema doesn't require and that isn't nullable is
/// one serde may leave out, so it is optional (`?`). Formatted as Prettier formats it.
pub fn ts_type() -> String {
    let schema = serde_json::to_value(schemars::schema_for!(GroupFile)).unwrap_or_default();
    let defs = schema
        .get("$defs")
        .or_else(|| schema.get("definitions"))
        .and_then(serde_json::Value::as_object)
        .map(|defs| {
            defs.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<std::collections::BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut out = std::string::String::from(
        "// SPDX-License-Identifier: MIT\n\
         // Generated from the Rust `groups::shape` module by its `ts_type` test. Do not edit.\n",
    );
    out.push_str(&declaration("GroupFile", &schema));
    for (name, def) in &defs {
        out.push_str(&declaration(name, def));
    }
    out
}

const WIDTH: usize = 100;

/// One `export` line (or block) for `name`.
fn declaration(name: &str, schema: &serde_json::Value) -> String {
    let members = union_members(schema);
    if members.len() == 1 && properties(schema).is_some() {
        let mut out = format!("\nexport interface {name} {{\n");
        for (key, value) in properties(schema).into_iter().flatten() {
            let mark = optional_mark(schema, &key, &value);
            out.push_str(&format!("  {key}{mark}: {};\n", render(&value)));
        }
        out.push_str("}\n");
        return out;
    }
    let rendered: Vec<String> = members.iter().map(|m| render(m)).collect();
    let line = format!("export type {name} = {};", rendered.join(" | "));
    if line.len() <= WIDTH {
        return format!("\n{line}\n");
    }
    let mut out = format!("\nexport type {name} =");
    for member in rendered {
        out.push_str(&format!("\n  | {member}"));
    }
    out.push_str(";\n");
    out
}

/// A schema's union members (`oneOf`, `anyOf` or a string `enum`), or the schema alone.
fn union_members(schema: &serde_json::Value) -> Vec<serde_json::Value> {
    for key in ["oneOf", "anyOf"] {
        if let Some(members) = schema.get(key).and_then(serde_json::Value::as_array) {
            return members.clone();
        }
    }
    if let Some(values) = schema.get("enum").and_then(serde_json::Value::as_array) {
        return values
            .iter()
            .map(|v| serde_json::json!({ "const": v }))
            .collect();
    }
    vec![schema.clone()]
}

/// An object schema's properties, sorted by name.
fn properties(
    schema: &serde_json::Value,
) -> Option<std::collections::BTreeMap<String, serde_json::Value>> {
    schema
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .map(|props| props.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// `?` for a property serde may leave out: not required and not nullable. A nullable one that is
/// not required is an `Option` serde writes as `null`, so it stays present.
fn optional_mark(schema: &serde_json::Value, key: &str, value: &serde_json::Value) -> &'static str {
    let required = schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|names| names.iter().any(|name| name == key));
    if required || is_nullable(value) {
        ""
    } else {
        "?"
    }
}

/// Whether a schema admits `null`.
fn is_nullable(schema: &serde_json::Value) -> bool {
    let null = serde_json::Value::from("null");
    match schema.get("type") {
        Some(serde_json::Value::Array(types)) if types.contains(&null) => return true,
        Some(t) if *t == null => return true,
        _ => {}
    }
    ["oneOf", "anyOf"].iter().any(|key| {
        schema
            .get(*key)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|members| members.iter().any(is_nullable))
    })
}

/// A schema as a TS type expression.
fn render(schema: &serde_json::Value) -> String {
    if let Some(value) = schema.get("const") {
        return value.to_string();
    }
    if let Some(target) = schema.get("$ref").and_then(serde_json::Value::as_str) {
        return target.rsplit('/').next().unwrap_or(target).to_string();
    }
    let members = union_members(schema);
    if members.len() > 1 {
        let rendered: Vec<String> = members.iter().map(render).collect();
        return rendered.join(" | ");
    }
    if let Some(props) = properties(schema) {
        let fields: Vec<String> = props
            .iter()
            .map(|(k, v)| format!("{k}{}: {}", optional_mark(schema, k, v), render(v)))
            .collect();
        return format!("{{ {} }}", fields.join("; "));
    }
    match schema.get("type") {
        Some(serde_json::Value::Array(types)) => {
            let rendered: Vec<String> = types.iter().map(|t| primitive(t, schema)).collect();
            rendered.join(" | ")
        }
        Some(t) => primitive(t, schema),
        None => "unknown".into(),
    }
}

fn primitive(name: &serde_json::Value, schema: &serde_json::Value) -> String {
    match serde_json::Value::as_str(name).unwrap_or("") {
        "string" => "string".into(),
        "integer" | "number" => "number".into(),
        "boolean" => "boolean".into(),
        "null" => "null".into(),
        "array" => {
            let item = schema
                .get("items")
                .map(render)
                .unwrap_or_else(|| "unknown".into());
            if item.contains(' ') {
                format!("({item})[]")
            } else {
                format!("{item}[]")
            }
        }
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_file(relative: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative)
    }

    /// The committed TS type is the one rendered from the Rust shape. Set
    /// `CODESENSE_WRITE_GROUP_FILE_TS=1` to rewrite it.
    #[test]
    fn the_ts_type_is_generated_from_the_rust_shape() {
        let expected = ts_type();
        let path = repo_file(TS_TYPE_FILE);
        if std::env::var_os("CODESENSE_WRITE_GROUP_FILE_TS").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == expected,
            "{TS_TYPE_FILE} is stale; it should read:\n{expected}\n--- schema:\n{}",
            serde_json::to_string_pretty(&schemars::schema_for!(GroupFile)).unwrap()
        );
    }

    #[test]
    fn a_file_round_trips_through_its_json() {
        let file = GroupFile {
            version: VERSION,
            owner: OwnerKind::Group,
            rev: 3,
            root: Some(SavedNode::Split {
                axis: Axis::Row,
                children: vec![
                    SavedNode::Leaf {
                        id: "agent:core/dev".into(),
                        workspace_id: "agent:core/dev".into(),
                        tabs: vec!["agent:core/dev".into(), "doc:core/README.md".into()],
                        active: "doc:core/README.md".into(),
                    },
                    SavedNode::Leaf {
                        id: "ws-1".into(),
                        workspace_id: "ws-1".into(),
                        tabs: vec![],
                        active: String::new(),
                    },
                ],
                sizes: vec![25.0, 75.0],
            }),
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains(r#""kind":"leaf","id":"agent:core/dev","workspaceId""#));
        // A one-tab tile writes no tabs and no active tab.
        assert!(json.contains(r#"{"kind":"leaf","id":"ws-1","workspaceId":"ws-1"}"#));
        assert_eq!(serde_json::from_str::<GroupFile>(&json).unwrap(), file);
    }

    #[test]
    fn an_unknown_field_is_not_this_shape() {
        let json = r#"{"version":2,"owner":"group","rev":1,"root":null,"pins":[]}"#;
        assert!(serde_json::from_str::<GroupFile>(json).is_err());
    }
}
