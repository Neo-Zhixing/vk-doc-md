use core::fmt;
use heck::ToShoutySnakeCase;
use std::{
    collections::HashMap,
    io::{Read, Seek, Write},
    path::Path,
};

use regex::Regex;
use vk_parse::Registry;

fn main() {
    let (registry, _errors) = vk_parse::parse_file(Path::new("./Vulkan-Docs/xml/vk.xml")).unwrap();
    assert!(_errors.is_empty());
    let converter = Converter::new(registry);

    for mdfile in std::fs::read_dir("./dist").unwrap() {
        let mdfile = mdfile.unwrap();
        let mut file = std::fs::File::open(mdfile.path()).unwrap();
        let mut mdcontent = String::new();
        file.read_to_string(&mut mdcontent).unwrap();

        let changed = converter.convert_file(&mut mdcontent);
        if changed {
            //file.seek(std::io::SeekFrom::Start(0)).unwrap();
            //file.write_all(mdcontent.as_bytes()).unwrap();
        }
    }
}

struct Converter {
    registry: Registry,
    types: HashMap<String, vk_parse::Type>,
    commands: HashMap<String, vk_parse::CommandDefinition>,
    enums: HashMap<String, vk_parse::Enums>,
    consts: HashMap<String, vk_parse::Enum>,
}

impl Converter {
    fn new(registry: Registry) -> Self {
        let mut this = Self {
            registry,
            types: Default::default(),
            commands: Default::default(),
            enums: Default::default(),
            consts: Default::default(),
        };
        for child in this.registry.0.iter() {
            use vk_parse::RegistryChild;
            match child {
                RegistryChild::Enums(enums) => {
                    if enums.name.as_ref().map(|a| a.as_str()) == Some("API Constants") {
                        for const_value in enums.children.iter() {
                            match const_value {
                                vk_parse::EnumsChild::Enum(const_value) => {
                                    this.consts
                                        .insert(const_value.name.clone(), const_value.clone());
                                }
                                vk_parse::EnumsChild::Unused(_) => unimplemented!(),
                                vk_parse::EnumsChild::Comment(_) => unimplemented!(),
                                _ => unimplemented!(),
                            }
                        }
                    }
                    this.enums
                        .insert(enums.name.as_ref().unwrap().clone(), enums.clone());
                }
                RegistryChild::Commands(commands) => {
                    for command in commands.children.iter() {
                        let vk_parse::Command::Definition(command) = command else {
                            continue;
                        };
                        this.commands
                            .insert(command.proto.name.clone(), command.clone());
                    }
                }
                RegistryChild::Types(ty) => {
                    for ty in ty.children.iter() {
                        let vk_parse::TypesChild::Type(ty) = ty else {
                            continue;
                        };
                        if ty.api.is_some() && ty.api.as_ref().map(String::as_str) != Some("vulkan")
                        {
                            continue;
                        }
                        let name = ty
                            .name
                            .as_ref()
                            .cloned()
                            .or_else(|| {
                                if let vk_parse::TypeSpec::Code(code) = &ty.spec {
                                    code.markup
                                        .iter()
                                        .filter_map(|a| match a {
                                            vk_parse::TypeCodeMarkup::Name(a) => Some(a.clone()),
                                            _ => None,
                                        })
                                        .next()
                                } else {
                                    None
                                }
                            })
                            .unwrap();
                        let duplicate = this.types.insert(name, ty.clone());
                        assert!(duplicate.is_none());
                    }
                }
                _ => (),
            }
        }
        this
    }
    fn convert_file(&self, file: &mut String) -> bool {
        let regex = Regex::new(r"\[\{generated\}(.*)\]\(\{generated\}(.*)\)").unwrap();
        let mut replacements = HashMap::new();
        for capture in regex.captures_iter(file) {
            let path = capture.get(1).unwrap().as_str().to_string();
            let path = path.replace("\\_", "_");
            assert_eq!(path, capture.get(2).unwrap().as_str());
            if path.starts_with("/api/structs/") {
                let generated_code = self.generate_api_struct(&path[13..path.len() - 5]);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/flags/") {
                self.generate_flags(&path[11..path.len() - 5]);
            } else if path.starts_with("/api/protos/") {
                self.generate_fn_prototype(&path[12..path.len() - 5]);
            } else if path.starts_with("/api/enums/") {
                self.generate_enum(&path[11..path.len() - 5]);
            } else {
                println!("Unknown path: {:?}", path);
                return false;
            }
        }
        let changed = !replacements.is_empty();
        for (key, replacement) in replacements.into_iter() {
            *file = file.replace(&key, &replacement);
        }
        changed
    }
    fn generate_enum(&self, name: &str) -> String {
        if !self.enums.contains_key(name) {
            let rs_name = &name[3..];
            let val = &self.consts[name];
            match &val.spec {
                vk_parse::EnumSpec::None => todo!(),
                vk_parse::EnumSpec::Value { value, extends } => {
                    assert!(extends.is_none());
                    let (rs_type, rs_value) = convert_c_enum_init_value_to_rust(value);
                    return format!(
                        "::code-group
```c [C]
#define {name} {value}
```
```rs [Rust]
const {rs_name}: {rs_type} = {rs_value};
```
::"
                    );
                }
                _ => unimplemented!(),
            }
        }

        let e = &self.enums[name];
        let rs_name = &name[2..];
        let children = e
            .children
            .iter()
            .map(|a| match a {
                vk_parse::EnumsChild::Enum(d) => match &d.spec {
                    vk_parse::EnumSpec::None => d.name.clone(),
                    vk_parse::EnumSpec::Alias { alias, extends } => {
                        assert!(extends.is_none());
                        format!("{} = {}", d.name, alias)
                    }
                    vk_parse::EnumSpec::Bitpos { bitpos, extends } => {
                        assert!(extends.is_none());
                        let value: u64 = 1 << bitpos;
                        if let Some(bitwidth) = e.bitwidth {
                            assert_eq!(bitwidth, 64);
                            format!("{} = {:#010x}ULL", d.name, value)
                        } else {
                            format!("{} = {:#010x}", d.name, value)
                        }
                    }
                    vk_parse::EnumSpec::Value { value, extends } => {
                        assert!(extends.is_none());
                        format!("{} = {}", d.name, value)
                    }
                    _ => todo!(),
                },
                vk_parse::EnumsChild::Unused(_) => String::new(),
                vk_parse::EnumsChild::Comment(comment) => {
                    format!("// {comment}")
                }
                _ => todo!(),
            })
            .fold(String::new(), |a, b| a + "    " + &b + ",\n")
            .trim_end()
            .to_string();
        let children_rs = e
            .children
            .iter()
            .filter_map(|a| match a {
                vk_parse::EnumsChild::Enum(d) => {
                    if d.deprecated.is_some() {
                        return None;
                    }
                    match &d.spec {
                        vk_parse::EnumSpec::None => Some(variant_ident(name, &d.name)),
                        vk_parse::EnumSpec::Alias { alias, extends } => {
                            let alias = variant_ident(name, &alias);
                            let dname = variant_ident(name, &d.name);
                            assert!(extends.is_none());
                            Some(format!("pub const {}: Self = Self::{};", dname, alias))
                        }
                        vk_parse::EnumSpec::Bitpos { bitpos, extends } => {
                            assert!(extends.is_none());
                            let value: u64 = 1 << bitpos;
                            let dname = variant_ident(name, &d.name);
                            Some(format!("pub const {}: Self = {:#010x};", dname, value))
                        }
                        vk_parse::EnumSpec::Value { value, extends } => {
                            assert!(extends.is_none());
                            let dname = variant_ident(name, &d.name);
                            Some(format!("pub const {}: Self = {};", dname, value))
                        }
                        _ => todo!(),
                    }
                }
                vk_parse::EnumsChild::Unused(_) => None,
                vk_parse::EnumsChild::Comment(comment) => Some(format!("// {comment}")),
                _ => todo!(),
            })
            .fold(String::new(), |a, b| a + "    " + &b + "\n")
            .trim_end()
            .to_string();
        let rust_type = if e.bitwidth.is_some() { "u64" } else { "u32" };
        let result = format!(
            "::code-group
```c [C]
typedef enum {name} {{
{children}
}} {name};
```
```rs [Rust]
pub struct {rs_name}({rust_type});
impl {rs_name} {{
{children_rs}
}}
```
::"
        );
        result
    }
    fn generate_fn_prototype(&self, name: &str) -> String {
        let command = &self.commands[name];
        let return_type = command
            .proto
            .type_name
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or("");
        let fn_name = command.proto.name.as_str();
        let rs_fn_name = &fn_name[2..fn_name.len()];
        let rs_fn_name = rs_fn_name.to_shouty_snake_case();
        let max_type_len = command
            .params
            .iter()
            .map(|a| {
                a.definition
                    .type_name
                    .as_ref()
                    .map(String::len)
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0);
        let params = command
            .params
            .iter()
            .map(|a| {
                let typename = a
                    .definition
                    .type_name
                    .as_ref()
                    .cloned()
                    .unwrap_or(String::new());
                let len = typename.len();
                typename
                    + &(0..max_type_len - len + 8).map(|_| ' ').collect::<String>()
                    + &a.definition.name
            })
            .fold(String::new(), |a, b| a + "    " + &b + ",\n");

        let rs_params = command
            .params
            .iter()
            .map(|a| {
                let typename = a
                    .definition
                    .type_name
                    .as_ref()
                    .map(|a| a.as_str())
                    .unwrap_or("");
                let rs_typename = convert_c_type_to_rust(typename);
                let rs_name = a.definition.name.as_str().to_shouty_snake_case();
                format!("{rs_name}: {rs_typename}")
            })
            .fold(String::new(), |a, b| a + "    " + &b + ",\n");
        let params = params[..params.len() - 2].to_string();
        format!(
            "::code-group
```c [C]
{return_type} {fn_name}(
{params});
```
```rs [Rust]
pub fn {rs_fn_name}(
{rs_params});
```
::"
        )
    }
    fn generate_flags(&self, name: &str) -> String {
        let ty = &self.types[name];
        match &ty.spec {
            vk_parse::TypeSpec::Code(code) => {
                let c_code = code.code.as_str();
                assert_eq!(code.markup.len(), 2);
                let ty = code
                    .markup
                    .iter()
                    .filter_map(|a| match a {
                        vk_parse::TypeCodeMarkup::Type(ty) => Some(ty),
                        _ => None,
                    })
                    .next()
                    .unwrap();
                let ty = if ty.as_str() == "VkFlags" {
                    "u32"
                } else if ty.as_str() == "VkFlags64" {
                    "u64"
                } else {
                    unimplemented!()
                };
                let name = code
                    .markup
                    .iter()
                    .filter_map(|a| match a {
                        vk_parse::TypeCodeMarkup::Name(name) => Some(name),
                        _ => None,
                    })
                    .next()
                    .unwrap();
                let name = &name[2..name.len()];
                format!(
                    "::code-group
```c [C]
{c_code}
```
```rs [Rust]
pub struct {name}({ty}); 
```
::"
                )
            }
            _ => unimplemented!(),
        }
    }

    fn generate_api_struct(&self, name: &str) -> String {
        let ty = &self.types[name];
        if let Some(alias) = &ty.alias {
            let rs_alias = convert_c_type_to_rust(alias);
            let rs_name = convert_c_type_to_rust(name);
            return format!(
                "::code-group
```c [C]
typedef {alias} {name};
```
```rs [Rust]
type {rs_name} = {rs_alias};
```
::"
            );
        }
        match &ty.spec {
            vk_parse::TypeSpec::None => {
                unimplemented!()
            }
            vk_parse::TypeSpec::Code(_) => todo!(),
            vk_parse::TypeSpec::Members(members) => {
                let max_type_len = members
                    .iter()
                    .map(|member| match member {
                        vk_parse::TypeMember::Comment(_) => 0,
                        vk_parse::TypeMember::Definition(def) => def
                            .markup
                            .iter()
                            .filter_map(|a| match a {
                                vk_parse::TypeMemberMarkup::Type(t) => Some(t.len()),
                                _ => None,
                            })
                            .next()
                            .unwrap(),
                        _ => todo!(),
                    })
                    .max()
                    .unwrap();
                let c_members = members
                    .iter()
                    .map(|member| match member {
                        vk_parse::TypeMember::Comment(comment) => format!("// {comment}"),
                        vk_parse::TypeMember::Definition(def) => def
                            .markup
                            .iter()
                            .map(|markup| match markup {
                                vk_parse::TypeMemberMarkup::Type(a) => {
                                    a.clone()
                                        + &(0..max_type_len - a.len() + 4)
                                            .map(|_| ' ')
                                            .collect::<String>()
                                }
                                vk_parse::TypeMemberMarkup::Name(a) => a.clone(),
                                vk_parse::TypeMemberMarkup::Enum(a) => a.clone(),
                                vk_parse::TypeMemberMarkup::Comment(a) => a.clone(),
                                _ => todo!(),
                            })
                            .fold(String::new(), |a, b| a + &b),
                        _ => todo!(),
                    })
                    .fold(String::new(), |a, b| a + "    " + &b + ";\n")
                    .trim_end()
                    .to_string();
                let rs_members = members
                    .iter()
                    .map(|member| match member {
                        vk_parse::TypeMember::Comment(comment) => format!("/// {comment}"),
                        vk_parse::TypeMember::Definition(def) => {
                            let ty = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Type(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("unknown");
                            let ty = convert_c_type_to_rust(ty);
                            let name = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Name(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("unknown");
                            let name = name.to_shouty_snake_case();
                            let e = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Enum(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("unknown");
                            let comment = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Comment(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("");
                            if comment.is_empty() {
                                format!("{name}: {ty}")
                            } else {
                                format!("{name}: {ty} // {comment}")
                            }
                        }
                        _ => todo!(),
                    })
                    .fold(String::new(), |a, b| a + "    " + &b + ",\n")
                    .trim_end()
                    .to_string();
                format!(
                    "::code-group
```c [C]
typedef struct {name} {{
{c_members}
}} {name};
```
```rs [Rust]
pub struct {name} {{
{rs_members}
}}
```
::"
                )
            }
            _ => todo!(),
        }
    }

    fn generate_validity_struct(&self, name: &str) {
        let ty = &self.types[name];
    }
}

fn convert_c_type_to_rust(c_type: &str) -> String {
    if c_type.starts_with("Vk") {
        return "vk::".to_string() + &c_type[2..];
    }
    match c_type {
        "void" => "std::ffi::c_void".to_string(),
        "uint64_t" => "u64".to_string(),
        "uint32_t" => "u32".to_string(),
        "uint16_t" => "u16".to_string(),
        "uint8_t" => "u8".to_string(),
        "int64_t" => "i64".to_string(),
        "int32_t" => "i32".to_string(),
        "int16_t" => "i16".to_string(),
        "int8_t" => "i8".to_string(),
        "int" => "i32".to_string(),
        "float" => "f32".to_string(),
        "size_t" => "usize".to_string(),
        "char" => "std::ffi::c_char".to_string(),
        _ => c_type.to_string(),
    }
}

fn convert_c_enum_init_value_to_rust(c_value: &str) -> (&'static str, String) {
    let inferred_rust_type = if c_value.contains("ULL") {
        "u64"
    } else if c_value.contains("U") {
        "u32"
    } else if c_value.contains("F") {
        "f32"
    } else {
        "usize"
    };
    let rust_value = c_value
        .replace("~", "!")
        .replace("(", "")
        .replace(")", "")
        .replace("ULL", "u64")
        .replace("U", "u32")
        .replace("F", "f32");
    (inferred_rust_type, rust_value)
}

pub fn variant_ident(enum_name: &str, variant_name: &str) -> String {
    let variant_name = variant_name.to_uppercase();
    let name = enum_name.replace("FlagBits", "");
    // TODO: Should be read from vk.xml id:2
    // TODO: Also needs to be more robust, vendor names can be substrings from itself, id:4
    // like NVX and NV
    let vendors = [
        "_AMD",
        "_AMDX",
        "_ANDROID",
        "_ARM",
        "_BRCM",
        "_CHROMIUM",
        "_EXT",
        "_FB",
        "_FSL",
        "_FUCHSIA",
        "_GGP",
        "_GOOGLE",
        "_HUAWEI",
        "_IMG",
        "_INTEL",
        "_JUICE",
        "_KDAB",
        "_KHR",
        "_KHX",
        "_LUNARG",
        "_MESA",
        "_MSFT",
        "_MVK",
        "_NN",
        "_NV",
        "_NVX",
        "_NXP",
        "_NZXT",
        "_QCOM",
        "_QNX",
        "_RASTERGRID",
        "_RENDERDOC",
        "_SAMSUNG",
        "_SEC",
        "_TIZEN",
        "_VALVE",
        "_VIV",
        "_VSI",
    ];
    let struct_name = name.to_shouty_snake_case();
    let vendor = vendors
        .iter()
        .find(|&vendor| struct_name.ends_with(vendor))
        .cloned()
        .unwrap_or("");
    let struct_name = struct_name.strip_suffix(vendor).unwrap();
    let struct_name = Regex::new("(\\d+)$").unwrap().replace(struct_name, "_$1");
    let variant_name = variant_name.strip_suffix(vendor).unwrap_or(&variant_name);

    let new_variant_name = variant_name
        .strip_prefix(struct_name.as_ref())
        .unwrap_or_else(|| {
            if enum_name == "VkResult" {
                variant_name.strip_prefix("VK").unwrap()
            } else {
                panic!("Failed to strip {struct_name} prefix from enum variant {variant_name}")
            }
        });

    // Both of the above strip_prefix leave a leading `_`:
    let new_variant_name = new_variant_name.strip_prefix('_').unwrap();
    // Replace _BIT anywhere in the string, also works when there's a trailing
    // vendor extension in the variant name that's not in the enum/type name:
    let new_variant_name = new_variant_name.replace("_BIT", "");
    let is_digit = new_variant_name
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false);
    if is_digit {
        format!("TYPE_{}", new_variant_name)
    } else {
        format!("{}", new_variant_name)
    }
}
