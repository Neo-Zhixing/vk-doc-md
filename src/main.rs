use heck::{ToShoutySnakeCase, ToSnakeCase};
use std::{
    collections::{hash_map::Entry, HashMap},
    io::{Read, Seek, Write},
    path::Path,
};

use regex::Regex;
use vk_parse::Registry;

fn main() {
    let (registry, _errors) = vk_parse::parse_file(Path::new("./Vulkan-Docs/xml/vk.xml")).unwrap();
    assert!(_errors.is_empty());
    let converter = Converter::new(registry);

    for mdfile in std::fs::read_dir("./dist/man").unwrap() {
        let mdfile = mdfile.unwrap();
        if mdfile.path().extension().map(|a| a.to_str().unwrap()) != Some("md") {
            println!("Skipped {:?}", mdfile.path());
            continue;
        }
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(mdfile.path())
            .unwrap();
        let mut mdcontent = String::new();
        file.read_to_string(&mut mdcontent).unwrap();

        let changed = converter.convert_file(&mut mdcontent);
        if changed {
            file.seek(std::io::SeekFrom::Start(0)).unwrap();
            file.write_all(mdcontent.as_bytes()).unwrap();
            file.set_len(mdcontent.as_bytes().len() as u64).unwrap();
        }
    }
}

struct Converter {
    registry: Registry,
    types: HashMap<String, vk_parse::Type>,
    commands: HashMap<String, vk_parse::Command>,
    enums: HashMap<String, vk_parse::Enums>,
    consts: HashMap<String, vk_parse::Enum>,
    parents: HashMap<String, String>, // mapping from item to [feature, extension]
}

fn add_item_parent(parents: &mut HashMap<String, String>, item: &str, parent: &str) {
    match parents.entry(item.to_string()) {
        Entry::Occupied(mut o) => {
            *o.get_mut() += ", ";
            *o.get_mut() += &parent;
        }
        Entry::Vacant(o) => {
            o.insert(parent.to_string());
        }
    };
}
impl Converter {
    fn new(registry: Registry) -> Self {
        let mut this = Self {
            registry,
            types: Default::default(),
            commands: Default::default(),
            enums: Default::default(),
            consts: Default::default(),
            parents: Default::default(),
        };
        for child in this.registry.0.iter() {
            use vk_parse::RegistryChild;
            match child {
                RegistryChild::Feature(feature) => {
                    if feature.name == "VKSC_VERSION_1_0" {
                        continue;
                    }
                    for c in feature.children.iter() {
                        match c {
                            vk_parse::ExtensionChild::Require { items, .. } => {
                                for item in items {
                                    match item {
                                        vk_parse::InterfaceItem::Type { name, comment } => {
                                            add_item_parent(&mut this.parents, name, &feature.name);
                                        }
                                        vk_parse::InterfaceItem::Enum(e) => {
                                            if e.api.as_ref().map(|a| a.as_str())
                                                == Some("vulkansc")
                                            {
                                                continue;
                                            }
                                            add_item_parent(
                                                &mut this.parents,
                                                &e.name,
                                                &feature.name,
                                            );
                                        }
                                        vk_parse::InterfaceItem::Command { name, comment } => {
                                            add_item_parent(
                                                &mut this.parents,
                                                &name,
                                                &feature.name,
                                            );
                                        }
                                        _ => (),
                                    }
                                }
                            }
                            vk_parse::ExtensionChild::Remove {
                                api,
                                profile,
                                comment,
                                items,
                            } => (),
                            _ => unimplemented!(),
                        }
                    }
                }
                RegistryChild::Extensions(s) => {
                    for extension in s.children.iter() {
                        for c in extension.children.iter() {
                            match c {
                                vk_parse::ExtensionChild::Require { items, .. } => {
                                    for item in items {
                                        match item {
                                            vk_parse::InterfaceItem::Type { name, comment } => {
                                                add_item_parent(
                                                    &mut this.parents,
                                                    &name,
                                                    &extension.name,
                                                );
                                            }
                                            vk_parse::InterfaceItem::Enum(e) => {
                                                if e.api.as_ref().map(|a| a.as_str())
                                                    == Some("vulkansc")
                                                {
                                                    continue;
                                                }
                                                add_item_parent(
                                                    &mut this.parents,
                                                    &e.name,
                                                    &extension.name,
                                                );
                                            }
                                            vk_parse::InterfaceItem::Command { name, comment } => {
                                                add_item_parent(
                                                    &mut this.parents,
                                                    &name,
                                                    &extension.name,
                                                );
                                            }
                                            _ => (),
                                        }
                                    }
                                }
                                vk_parse::ExtensionChild::Remove {
                                    api,
                                    profile,
                                    comment,
                                    items,
                                } => (),
                                _ => unimplemented!(),
                            }
                        }
                    }
                }
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
                        let name = match command {
                            vk_parse::Command::Definition(command) => command.proto.name.clone(),
                            vk_parse::Command::Alias { name, alias } => name.clone(),
                            _ => unimplemented!()
                        };
                        this.commands
                            .insert(name, command.clone());
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
        let name = Regex::new(r"\ntitle: (.+)\n")
            .unwrap()
            .captures(file);
        if name.is_none() {
            println!("Missing match: {}", file)
        }
        let name = name
            .unwrap()
            .get(1)
            .unwrap()
            .as_str();

        let mut additional_attributes = String::new();
        if self.parents.contains_key(name) {
            additional_attributes += "parent: ";
            additional_attributes += &self.parents[name];
            additional_attributes += "\n";
        }

        let regex = Regex::new(r"\[\{generated\}(.*)\]\(\{generated\}(.*)\)").unwrap();
        let mut replacements = HashMap::new();
        for capture in regex.captures_iter(file) {
            let path = capture.get(1).unwrap().as_str().to_string();
            let path = path.replace("\\_", "_");
            assert_eq!(path, capture.get(2).unwrap().as_str());
            if path.starts_with("/api/structs/") {
                let n = &path[13..path.len() - 5];
                let generated_code = self.generate_api_struct(n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/flags/") {
                let n = &path[11..path.len() - 5];
                let generated_code = self.generate_flags(n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/protos/") {
                let n = &path[12..path.len() - 5];
                let generated_code = self.generate_fn_prototype(&n);
                additional_attributes += &self.fn_attributes(&n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/enums/") {
                let n = &path[11..path.len() - 5];
                let generated_code = self.generate_enum(n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/basetypes/") {
                let n = path
                    .strip_prefix("/api/basetypes/")
                    .unwrap()
                    .strip_suffix(".adoc")
                    .unwrap();
                let generated_code = self.generate_basetype(&n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/handles/") {
                let n = path
                    .strip_prefix("/api/handles/")
                    .unwrap()
                    .strip_suffix(".adoc")
                    .unwrap();
                let generated_code = self.generate_handles(n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/defines/") {
                let n = path
                    .strip_prefix("/api/defines/")
                    .unwrap()
                    .strip_suffix(".adoc")
                    .unwrap();
                let generated_code = self.generate_define(&n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else if path.starts_with("/api/funcpointers/") {
                let n = path
                    .strip_prefix("/api/funcpointers/")
                    .unwrap()
                    .strip_suffix(".adoc")
                    .unwrap();
                let generated_code = self.generate_fn_ptr(&n);
                replacements.insert(capture.get(0).unwrap().as_str().to_string(), generated_code);
            } else {
                println!("Unknown path: {:?}", path);
                continue;
            };
        }
        let changed = !replacements.is_empty();
        for (key, replacement) in replacements.into_iter() {
            *file = file.replace(&key, &replacement);
        }
        if !additional_attributes.is_empty() {
            *file =
                "---\n".to_string() + &additional_attributes + file.strip_prefix("---\n").unwrap();
        }
        changed
    }
    fn generate_fn_ptr(&self, name: &str) -> String {
        let ty = &self.types[name];
        // pub type PFN_vkDebugReportCallbackEXT =
        //   Option<unsafe extern "system" fn(
        //     flags: DebugReportFlagsEXT,
        // object_type: DebugReportObjectTypeEXT, object: u64, location: usize, message_code: i32, p_layer_prefix: *const c_char, p_message: *const c_char, p_user_data: *mut c_void) -> Bool32>;

        let (code, markup) = match &ty.spec {
            vk_parse::TypeSpec::Code(code) => (code.code.as_str(), code.markup.as_slice()),
            _ => unimplemented!(),
        };
        let return_type = Regex::new(r"typedef +(.+) +\(")
            .unwrap()
            .captures(code)
            .unwrap()
            .get(1)
            .unwrap()
            .as_str();
        let return_type = convert_c_type_to_rust(return_type);
        let members = code
            .split("\n")
            .skip(1)
            .zip(markup.iter().skip(1))
            .map(|(line, markup)| {
                let variable_name = Regex::new(r".* (\w+)[,\);]*")
                    .unwrap()
                    .captures(line)
                    .unwrap()
                    .get(1)
                    .unwrap()
                    .as_str()
                    .trim();
                let type_name = Regex::new(r"(.*) +\w+[,\);]*")
                    .unwrap()
                    .captures(line)
                    .unwrap()
                    .get(1)
                    .unwrap()
                    .as_str()
                    .trim();
                (
                    variable_name.to_snake_case(),
                    convert_c_type_to_rust(type_name),
                )
            })
            .fold(String::new(), |a, (variable_name, type_name)| {
                a + "        " + &variable_name + ": " + &type_name + ",\n"
            })
            .trim_end()
            .to_string();

        format!(
            "::code-group
```c [C]
{code}
```
```rs [Rust]
pub type {name} = Option<
    unsafe extern \"system\" fn(
{members}
    ) -> {return_type}
>;
```
::"
        )
    }
    fn generate_define(&self, name: &str) -> String {
        let ty = &self.types[name];
        let code = match &ty.spec {
            vk_parse::TypeSpec::Code(code) => code.code.as_str(),
            _ => unimplemented!(),
        };
        return format!(
            "```c
{code}
```
"
        );
    }
    fn generate_handles(&self, name: &str) -> String {
        let ty = &self.types[name];
        if let Some(alias) = &ty.alias {
            let rs_name = name.strip_prefix("Vk").unwrap();
            let rs_alias = alias.strip_prefix("Vk").unwrap();
            return format!(
                "::code-group
```c [C]
typedef {alias} {name};
```
```rs [Rust]

```
type {rs_name} = vk::{rs_alias};
"
            );
        }
        let code = match &ty.spec {
            vk_parse::TypeSpec::Code(code) => code.code.as_str(),
            _ =>  {
                println!("{name}");
                unimplemented!()
            },
        };
        let rs_name = name.strip_prefix("Vk").unwrap();
        return format!(
            "::code-group
```c [C]
{code}
```
```rs [Rust]
#[repr(transparent)]
pub struct {rs_name}(_);
```
::
"
        );
    }
    fn generate_basetype(&self, name: &str) -> String {
        let ty = &self.types[name];
        let code = match &ty.spec {
            vk_parse::TypeSpec::Code(code) => code.code.as_str(),
            _ => unimplemented!(),
        };
        return format!(
            "```c
{code}
```"
        );
    }
    fn generate_enum(&self, name: &str) -> String {
        // three cases here: enum def, enum alias, const value
        if !self.enums.contains_key(name) {
            if !self.consts.contains_key(name) {
                // enum alias
                let ty = &self.types[name];
                let alias = ty.alias.as_ref().unwrap();
                let rs_name = name.strip_prefix("Vk").unwrap();
                let rs_alias = alias.strip_prefix("Vk").unwrap();
                return format!(
                    "::code-group
```c [C]
#define {name} {alias}
```
```rs [Rust]
const {rs_name}: _ = vk::{rs_alias};
```
::"
                );
            }
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
                vk_parse::EnumSpec::Alias { alias, extends } => {
                    let rs_alias_name = &alias[3..];
                    let target = &self.consts[alias];
                    let vk_parse::EnumSpec::Value { value, extends } = &target.spec else {
                        panic!()
                    };
                    let (rs_type, rs_value) = convert_c_enum_init_value_to_rust(value);
                    return format!(
                        "::code-group
```c [C]
#define {name} {alias}
```
```rs [Rust]
const {rs_name}: {rs_type} = vk::{rs_alias_name};
```
::"
                    );
                },
                _ => unimplemented!()
            }
        }

        // enum definition

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

    fn fn_attributes(&self, name: &str) -> String {
        let mut attributes = String::new();
        let mut command = &self.commands[name];
        loop {
            match command {
                vk_parse::Command::Alias { name, alias } => command = &self.commands[alias],
                vk_parse::Command::Definition(_) => break,
                _ => todo!(),
            }
        }
        let vk_parse::Command::Definition(command) = command else {
            unreachable!()
        };
        if let Some(cmdbufferlevel) = &command.cmdbufferlevel {
            attributes += &format!("cmd_buf_level: [{cmdbufferlevel}]\n");
        }
        if let Some(render_pass_scope) = &command.renderpass {
            attributes += &format!("render_pass_scope: {render_pass_scope}\n");
        }
        if let Some(video_coding_scope) = &command.videocoding {
            attributes += &format!("video_coding_scope: {video_coding_scope}\n");
        }
        if let Some(supported_queue_types) = &command.queues {
            attributes += &format!("supported_queue_types: [{supported_queue_types}]\n");
        }
        if let Some(tasks) = &command.tasks {
            attributes += &format!("tasks: [{tasks}]\n");
        }
        attributes
    }
    fn generate_fn_prototype(&self, name: &str) -> String {
        let mut command = &self.commands[name];
        loop {
            match command {
                vk_parse::Command::Alias { name, alias } => command = &self.commands[alias],
                vk_parse::Command::Definition(_) => break,
                _ => todo!(),
            }
        }
        let vk_parse::Command::Definition(mut command) = command.clone() else {
            unreachable!()
        };
        command.proto.name = name.to_string();
        let return_type = command
            .proto
            .type_name
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or("");
        let fn_name = command.proto.name.as_str();
        let rs_fn_name = fn_name.strip_prefix("vk").unwrap().to_snake_case();
        let rs_ret_ty = if return_type == "void" {
            String::new()
        } else {
            " -> ".to_string() + convert_c_type_to_rust(return_type).as_str()
        };
        let params = command
            .params
            .iter()
            .map(|a| &a.definition.code)
            .fold(String::new(), |a, b| a + "    " + &b + ",\n");

        let rs_params = command
            .params
            .iter()
            .map(|a| {
                use generator::FieldExt;
                let raw_ty = a.definition.type_name.as_ref().unwrap();
                let rs_type = a.type_tokens(true, None).to_string();
                let mut rs_type = rs_type
                    .replace("* const", "*const")
                    .replace("* mut", "*mut");
                let rs_name = a.param_ident();

                if raw_ty.starts_with("Vk") {
                    let stripped = raw_ty.strip_prefix("Vk").unwrap();
                    rs_type = rs_type.replace(&stripped, &("vk::".to_string() + stripped));
                }

                format!("{rs_name}: {rs_type}")
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
{rs_params}){rs_ret_ty};
```
::"
        )
    }
    fn generate_flags(&self, name: &str) -> String {
        let ty = &self.types[name];
        if let Some(alias) = &ty.alias {
            let rs_name = name.strip_prefix("Vk").unwrap();
            let rs_alias = alias.strip_prefix("Vk").unwrap();
            return format!(
                "::code-group
```c [C]
typedef {alias} {name};
```
```rs [Rust]
pub type {rs_name} = vk::{rs_alias}; 
```
::"
            )
        }
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
            let rs_name = name.strip_prefix("Vk").unwrap();
            let rs_alias = alias.strip_prefix("Vk").unwrap();
            return format!(
                "::code-group
```c [C]
typedef {alias} {name};
```
```rs [Rust]
type {rs_name} = vk::{rs_alias};
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
                let c_members = members
                    .iter()
                    .map(|member| match member {
                        vk_parse::TypeMember::Comment(comment) => format!("// {comment}"),
                        vk_parse::TypeMember::Definition(def) => Regex::new(r" +")
                            .unwrap()
                            .replace_all(&def.code, " ")
                            .to_string(),
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
                            use generator::FieldExt;

                            let element: vkxml::StructElement = member.clone().into();
                            let field = match element {
                                vkxml::StructElement::Member(field) => field,
                                _ => unreachable!(),
                            };

                            let raw_ty = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Type(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("unknown");
                            let name = def
                                .markup
                                .iter()
                                .filter_map(|markup| match markup {
                                    vk_parse::TypeMemberMarkup::Name(a) => Some(a.as_str()),
                                    _ => None,
                                })
                                .next()
                                .unwrap_or("unknown");
                            let name = name.to_snake_case();
                            let ty = field.type_tokens(true, None).to_string();
                            let mut ty = ty.replace("* const", "*const").replace("* mut", "*mut");
                            if raw_ty.starts_with("Vk") {
                                let stripped = raw_ty.strip_prefix("Vk").unwrap();
                                ty = ty.replace(&stripped, &("vk::".to_string() + stripped));
                            }
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
                let rs_name = name.strip_prefix("Vk").unwrap();
                format!(
                    "::code-group
```c [C]
typedef struct {name} {{
{c_members}
}} {name};
```
```rs [Rust]
pub struct {rs_name} {{
{rs_members}
}}
```
::"
                )
            }
            _ => todo!(),
        }
    }
}

fn convert_c_type_to_rust(c_type: &str) -> String {
    if c_type.starts_with("Vk") {
        return "vk::".to_string() + &c_type[2..];
    }
    match c_type {
        "void" => "std::ffi::c_void".to_string(),
        "void*" => "*mut std::ffi::c_void".to_string(),
        "const void*" => "*const std::ffi::c_void".to_string(),
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
        "const char*" => "*const std::ffi::c_char".to_string(),
        "char*" => "*mut std::ffi::c_char".to_string(),
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
