Vulkan documentation transformation pipeline for [VulkanHub](https://vkdoc.net)


## Transformation Pipeline
The transformation can be roughly split into three stages:

### Stage 1: AsciiDoc
This is in `main.ts`. We use `Asciidoctor.js` to convert the official AsciiDocs into Markdown, in the [@nuxtjs/mdc](https://github.com/nuxt-modules/mdc) flavor.

### Stage 2: vk.xml
We additionally need to grab some data from `vk.xml`. This part was written in Rust due to the good work done in [vk_parse](https://github.com/krolli/vk-parse). We grab those information from `vk.xml` and put them in the Markdown frontmatter section.
This is also where we generate the source code sections for both C and Rust.

### Stage 3: parse-refpages
This is where we resolve cross links and turn the markdown files into JSON so that they can be consumed by the frontend without further parsing. The frontend uses Vue.js, so it expects the document tree to be in a vnode tree. [@nuxtjs/mdc](https://github.com/nuxt-modules/mdc)
does this transformation for us.


## Replicate the transformation pipeline
Take a look at `.github/workflows/build.yml` and follow those commands step by step.
