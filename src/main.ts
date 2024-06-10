import { fromXml } from "xast-util-from-xml";
import {toMarkdown} from 'mdast-util-to-markdown';
import {gfmToMarkdown} from 'mdast-util-gfm';
import * as xast from 'xast';
import { readFile } from 'fs/promises';
import assert from 'node:assert/strict';
import * as mdast from 'mdast';
import { stringify as yamlStringify } from 'yaml'
import {frontmatterToMarkdown} from 'mdast-util-frontmatter';

import discoverRefpages from './discoverRefpages.js';

// @ts-ignore
import Asciidoctor from '@asciidoctor/core'
// @ts-ignore
import docbookConverter from '@asciidoctor/docbook-converter'
import { existsSync, readFileSync } from "fs";
import { writeFile, mkdir } from 'fs/promises';
import { visitParents } from "unist-util-visit-parents";

function docbookRemovePaddingNewlines(i: xast.RootContent[]) {
    const first = i[0];
    if (i.length > 1 && first.type === 'text' && first.value === '\n') {
        i.shift();
    }
    const last = i[i.length - 1];
    if (i.length > 1 && last.type === 'text' && last.value === '\n') {
        i.pop();
    }
}

function docbookRefblockValidityConvert(node: xast.ElementContent, level: number): mdast.RootContent[] {
    if (node.type != 'element') {
        return []
    }
    if (node.name === 'listitem') {
        const para = node.children.find(i => i.type === 'element' && i.name === 'simpara');
        if (!para || para.type !== 'element') {
            return []
        }
        
        const anchorIndex = para.children.findIndex(i => i.type === 'element' && i.name === 'anchor');
        const anchor = para.children[anchorIndex];
        if (!anchor) {
            console.log("there's somethign wrong here. ", node)
        }
        if (anchor.type !== 'element') {
            return []
        }
        const rest = para.children.slice(anchorIndex + 1);
        const name = anchor.attributes['xml:id'];
        docbookRemovePaddingNewlines(rest);
        return [
            <mdast.Text> {
                type: 'text',
                value: `\n::validity-field{name="${name}"}\n`
            },
            ...rest.flatMap(a => docbookConvertNode(a, level)),
            <mdast.Text> {
                type: 'text',
                value: '\n::\n'
            },
        ]
    }
    console.log('unknown node in docbookRefblockValidityConvert', node);
    return []
}

function docbookConvertNode(node: xast.ElementContent, level: number): mdast.RootContent[] {
    if (node.type === 'text') {
        if (node.value === '\n') {
            node.value = '\n\n';
        }
        return [<mdast.Text> {
            type: 'text',
            value: node.value
        }]
    }
    if (node.type === 'element') {
        if (node.name === 'figure') {
            const titleNode = node.children.find(x => x.type === 'element' && x.name === 'title') as xast.Element;
            const titleNodeText = (titleNode!.children[0] as xast.Text).value;
            const mediaObject = node.children.find(x => x.type === 'element' && x.name === 'mediaobject') as xast.Element;
            const mediaImageObject = mediaObject.children.find(x => x.type === 'element' && x.name === 'imageobject') as xast.Element;
            const imageData = mediaImageObject.children.find(x => x.type === 'element' && x.name === 'imagedata') as xast.Element;
            const mediaTextObject = mediaObject.children.find(x => x.type === 'element' && x.name === 'textobject') as xast.Element;
            const phraseObject = mediaTextObject.children.find(x => x.type === 'element' && x.name === 'phrase') as xast.Element;
            const alt = phraseObject.children[0] as xast.Text;
            return [<mdast.Image> {
                type: 'image',
                title: titleNodeText,
                url: imageData.attributes.fileref.replace('{images}', 'https://data.vkdoc.net/images'),
                alt: alt.value,
            }]
        }
        if (node.name === 'simpara' || node.name === 'para' || node.name === 'formalpara') {
            if (node.attributes['xml:id']) {
                if (node.children.length === 0) {
                    return [<mdast.Text>{
                        type: 'text',
                        value: `:anchor{id="${node.attributes['xml:id']}"}`
                    }]
                } else {
                    return [
                        <mdast.Text>{
                            type: 'text',
                            value: `\n:anchor{id="${node.attributes['xml:id']}"}\n`
                        },
                        <mdast.Paragraph>{
                            type: 'paragraph',
                            children: node.children.flatMap(i => docbookConvertNode(i, level))
                        },
                    ]
                }
            }
            return [<mdast.Paragraph>{
                type: 'paragraph',
                children: node.children.flatMap(i => docbookConvertNode(i, level))
            }]
        }
        if (node.name === 'title') {
            return [<mdast.Heading>{
                type: 'heading',
                depth: level + 1,
                children: node.children.flatMap(i => docbookConvertNode(i, level))
            }]
        }
        if (node.name === 'xref') {
            return [<mdast.Link> {
                type: 'link',
                children: [
                    <mdast.Text> {
                        type: 'text',
                        value: 'xref::name::' + node.attributes.linkend
                    }
                ],
                url: 'xref::' + node.attributes.linkend
            }]
        }
        if (node.name === 'superscript') {
            if (node.children.length === 1 && node.children[0].type === 'text' && parseInt(node.children[0].value) === 1) {
                // I've only seen at most one footnote being used at any given time.
                return [
                    <mdast.FootnoteReference>{
                        type: 'footnoteReference',
                        identifier: '1'
                    },
                ]
            }
            if (node.children.length === 1 && node.children[0].type === 'text') {
                const value = node.children[0].value;
                return [
                    <mdast.Html>{
                        type: 'html',
                        value: `<sub>${value}</sub>`
                    },
                ]
            }
        }
        if (node.name === 'subscript') {
            if (node.children.length === 1 && node.children[0].type === 'text') {
                const value = node.children[0].value;
                return [
                    <mdast.Html>{
                        type: 'html',
                        value: `<sub>${value}</sub>`
                    },
                ]
            }
        }
        if (node.name === 'programlisting') {
            // cmdProcessAllSequences
            if (node.children.length !== 0) { return [] }
            if (node.children[0].type !== 'text') { return [] }
            const code = node.children[0].value;
            return [<mdast.Code>{
                type: 'code',
                value: code,
                lang: node.attributes.language
            }]
        }
        if (node.name === 'section')  {
            if (node.attributes['xml:id']) {
                for (const i of node.children) {
                    if (i.type === 'text' && i.value.trim().length === 0) {
                        continue;
                    }
                    if (i.type === 'element' && i.name === 'title') {
                        i.children.splice(0, 0, <mdast.Text>{
                            type: 'text',
                            value: '#' + node.attributes['xml:id'] + ' '
                        });
                        return node.children.flatMap(i => docbookConvertNode(i, level+1));
                    }
                }
                return [
                    <mdast.Text>{
                        type: 'text',
                        value: `\n:anchor{id="${node.attributes['xml:id']}"}\n`
                    },
                    ...node.children.flatMap(i => docbookConvertNode(i, level+1)),
                ]
            }
            return node.children.flatMap(i => docbookConvertNode(i, level + 1))
        }
        if (node.name === 'table')  {
            return [] // TODO
        }
        if (node.name === 'emphasis') {
            return [<mdast.Emphasis>{
                type: 'emphasis',
                children: node.children.flatMap(i => docbookConvertNode(i, level))
            }]
        }
        
        if (node.name === 'quote') {
            if (node.children.length === 1 && node.children[0].type === 'text') {
                return [<mdast.InlineCode> {
                    type: 'inlineCode',
                    value: node.children[0].value
                }]
            }
            return node.children.flatMap(i => docbookConvertNode(i, level))
        }
        if (node.name === 'phrase') {
            return node.children.flatMap(i => docbookConvertNode(i, level))
        }
        if (node.name === 'literal') {
            if (node.children.length === 1 && node.children[0].type === 'text') {
                return [<mdast.InlineCode> {
                    type: 'inlineCode',
                    value: node.children[0].value
                }]
            }
            return node.children.flatMap(i => docbookConvertNode(i, level))
        }
        if (node.name === 'anchor') {
            return [<mdast.Text> {
                type: 'text',
                value: `:anchor{id="${node.attributes['xml:id']}"}`,
            }]
        }
        if (node.name === 'link') {
            if (node.attributes.linkend) {
                return [<mdast.Link> {
                    type: 'link',
                    children: node.children.flatMap(i => docbookConvertNode(i, level)),
                    url: 'xref::' + node.attributes.linkend
                }]
            }

            const href = node.attributes['xl:href']
            return [<mdast.Link> {
                type: 'link',
                children: node.children.flatMap(i => docbookConvertNode(i, level)),
                url: href
            }]
        }
        if (node.name === 'itemizedlist' || node.name === 'orderedlist') {
            return [<mdast.List> {
                type: 'list',
                ordered: node.name === 'orderedlist',
                children: node.children.map(i => {
                    if (i.type !== 'element' || i.name !== 'listitem') {
                        return null;
                    }
                    docbookRemovePaddingNewlines(i.children);
                    return <mdast.ListItem> {
                        type: 'listItem',
                        children: i.children.flatMap(j => docbookConvertNode(j, level))
                    }
                }).filter(i => !!i)
            }]
        }
        if (node.name === 'note') {
            docbookRemovePaddingNewlines(node.children);
            if (node.children.length > 1 && node.children[0].type === 'element' && node.children[0].name === 'title') {
                const noteTitle = node.children[0].children[0];
                if (noteTitle && noteTitle.type === 'text' && noteTitle.value === 'Note') {
                    node.children.shift();
                    docbookRemovePaddingNewlines(node.children);
                }
            }
            return [
                <mdast.Text> {
                    type: 'text',
                    value: '\n::note\n'
                },
                ...node.children.flatMap(j => docbookConvertNode(j, level)),
                <mdast.Text> {
                    type: 'text',
                    value: '\n\n::\n'
                },
            ]
        }
        if (node.name === 'varlistentry') {
            const terms = node.children.filter(a => a.type === 'element' && a.name === 'term');
            const listitem = node.children.filter(a => a.type === 'element' && a.name === 'listitem');
            if ((terms.length === 0 || terms.every(a => a.type === 'element' && a.children.length === 0)) && listitem.length === 1) {
                if (listitem[0].type === 'element') {
                    const simpara = listitem[0].children.filter(a => a.type === 'element' && a.name === 'simpara');
                    if (simpara.length === 1 && simpara[0].type === 'element') {
                        const phrase = simpara[0].children.filter(a => a.type === 'element' && a.name === 'phrase');
                        if (phrase.length === 1 && phrase[0].type === 'element') {
                            const results = phrase[0].children.flatMap(a => docbookConvertNode(a, level))
                            return [<mdast.Paragraph> {
                                type: 'paragraph',
                                children: results
                            }];
                        }
                    }
                }
            }
            if (terms.length === 1 &&
                listitem.length === 1 &&
                terms[0].type === 'element' &&
                terms[0].children.length === 1 &&
                terms[0].children[0].type === 'text' &&
                parseInt(terms[0].children[0].value)) {
                const content = listitem[0];
                assert(content.type === 'element');
                return [
                    <mdast.FootnoteDefinition> {
                        type: 'footnoteDefinition',
                        identifier: terms[0].children[0].value,
                        children: content.children.flatMap(a => {
                            if (a.type === 'text' && a.value.trim().length === 0) {
                                return [];
                            }
                            if (a.type === 'element' && a.name === 'simpara') {
                                return a.children.flatMap(b => docbookConvertNode(b, level))
                            }
                            return docbookConvertNode(a, level)
                        })
                    }
                ]
            }
            if (terms.length > 0 && listitem.length === 1 && listitem[0].type === 'element') {
                return [
                    ...terms.map(a => <mdast.Heading> {
                        type: 'heading',
                        depth: 6,
                        children: a.type === 'element' ? a.children.flatMap(b => docbookConvertNode(b, level)) : []
                    }),
                    ...listitem[0].children.flatMap(a => docbookConvertNode(a, level))
                ]
            }
        }
        if (node.name === 'variablelist') {
            const varlists = node.children.filter(a => a.type === 'element' && a.name === 'varlistentry');
            return varlists.flatMap(a => docbookConvertNode(a, level))
        }
        if (node.name === 'literallayout') {
            if (node.attributes.class === 'monospaced' && node.children.length === 1 && node.children[0].type === 'text') {

                return [
                    <mdast.Code> {
                        type: 'code',
                        value: node.children[0].value
                    }
                ]
            }
        }
        if (node.name === 'sidebar') {
            docbookRemovePaddingNewlines(node.children);
            const title = node.children.find(a => a.type === 'element' && a.name === 'title');
            let titleText = ((title as xast.Element).children[0] as xast.Text).value;
            if (titleText === 'Valid Usage' || titleText === 'Valid Usage (Implicit)') {
                const list = node.children.find(a => a.type === 'element' && a.name === 'itemizedlist');
                if (!list || list.type !== 'element') {
                    return [];
                }
                return [
                    <mdast.Text> {
                        type: 'text',
                        value: `\n::validity-group{name="${titleText}"}\n`
                    },
                    ...list.children.flatMap(j => docbookRefblockValidityConvert(j, level)),
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::\n'
                    },
                ]
            } else if (titleText === 'Host Synchronization') {
                const list = node.children.find(a => a.type === 'element' && a.name === 'itemizedlist');
                if (!list || list.type !== 'element') {
                    return [];
                }
                return [
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::validity-box\n'
                    },
                    <mdast.Heading> {
                        type: 'heading',
                        depth: 3,
                        children: [
                            <mdast.Text> {
                                type: 'text',
                                value: 'Host Synchronization'
                            },
                        ]
                    },
                    <mdast.Text> {
                        type: 'text',
                        value: '\n'
                    },
                    ...docbookConvertNode(list, level),
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::\n'
                    },
                ]
            } else {
                return []
            }
        }
    }
    if (node.type === 'instruction') {
        if (node.name === 'asciidoc-pagebreak') {
            return []
        }
        if (node.name === 'asciidoc-br') {
            return [<mdast.Break> {
                type: 'break',
            }]
        }
    }
    console.log('unknown node in docbookConvertNode', node)
    return []
}

function docbookRefpage(docbook: xast.Root): mdast.RootContent[] {
    assert(docbook.type === 'root');
    const rootElement = docbook.children[0];
    assert(rootElement.type === 'element' && rootElement.name === 'root');
    return rootElement.children.flatMap(children => docbookConvertNode(children, -2));
}

async function main() {
    // read vkdoc.xml to find the list of all extensions
    const xml = fromXml(await readFile('./Vulkan-Docs/xml/vk.xml', 'utf-8'));
    const registry: xast.Element = xml.children.find(x => x.type === 'element' && x.name === 'registry') as xast.Element;
    const extensionNode: xast.Element = registry.children.find(x => x.type === 'element' && x.name === 'extensions') as xast.Element;
    const extensions = extensionNode
        .children
        .filter(x => x.type === 'element' &&
            x.name === 'extension' &&
            (x.attributes.supported || '').split(',').includes('vulkan'))
        .map(x => [(x as xast.Element).attributes.name, true]);
    const attributes = Object.fromEntries(extensions)


    await mkdir('./dist/chapters', { recursive: true });
    await mkdir('./dist/man', { recursive: true });
    let should_skip: boolean = false;


    const processor = Asciidoctor();
    docbookConverter.register();
    processor.Extensions.register(function() {
        this.treeProcessor(function () {
            this.process((document) => {
                document.findBy(block => {
                    if (block.context === 'open' && block.getAttribute('refpage')) {
                        const blocks = block.getBlocks();
                        blocks.length = 0;
                        const lines = [
                            `::refpage{name="${block.getAttribute('refpage')}" type="${block.getAttribute('type')}"}`,
                            block.getAttribute('desc'),
                            '::'
                        ]
                        blocks.push(this.createBlock(document, 'paragraph', lines.join('\n') + '\n'));
                        return true;
                    }
                    return false;
                })
            })
          })
        for (const normativeKeyword of ['can', 'cannot', 'may', 'must', 'optional', 'optionally', 'required', 'should']) {
            this.inlineMacro(function() {
                this.named(normativeKeyword);
                // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L239
                this.match(new RegExp(`${normativeKeyword}:(\\w*)`));
                this.process((parent: any, target: any) => {
                    return this.createInline(parent, 'quoted', `:normative{type="${normativeKeyword}"}`)
                })
            })
        }
        this.inlineMacro(function() {
            this.named('pname');
            // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L239
            this.match(/pname:(\w+((\.|&#8594;)\w+)*)/);
            this.process((parent: any, target: any) => {
                return this.createInline(parent, 'quoted', target, { type: 'monospaced' })
            })
        })
        this.inlineMacro(function() {
            this.named('ptext');
            // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L239
            this.match(/ptext:([\w\*]+((\.|&#8594;)[\w\*]+)*)/);
            this.process((parent: any, target: any) => {
                return this.createInline(parent, 'quoted', target, { type: 'monospaced' })
            })
        })
        this.inlineMacro(function() {
            this.named('code');
            // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L239
            this.match(/code:(\w+([.*]\w+)*\**)/);
            this.process((parent: any, target: any) => {
                return this.createInline(parent, 'quoted', target, { type: 'monospaced' })
            })
        })
        for (const macro of ['ftext', 'stext', 'etext']) {
            this.inlineMacro(function() {
                this.named(macro);
                // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L239
                this.match(new RegExp(macro + ':([\\w\\*]+)'));
                this.process((parent: any, target: any) => {
                    return this.createInline(parent, 'quoted', target, { type: 'monospaced' })
                })
            })
        }
        for (const macro of ['fname', 'sname', 'ename', 'dname', 'tname']) {
            this.inlineMacro(function() {
                this.named(macro);
                // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L187C10-L187C24
                this.match(new RegExp(macro + ':([-\\w]+)'))
                this.process((parent: any, target: any) => {
                    return this.createInline(parent, 'quoted', target, { type: 'monospaced' })
                })
            })
        }
        for (const macro of ['flink', 'slink', 'elink', 'reflink', 'apiext', 'dlink', 'tlink', 'basetype']) {
            this.inlineMacro(function() {
                this.named(macro);
                // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L187C10-L187C24
                this.match(new RegExp(macro + ':(\\w+)'))
                this.process((parent: any, target: any) => {
                    return this.createInline(parent, 'anchor', target, { type: 'link', target: '/man/' + target })
                })
            })
        }
        for (const macro of ['attr', 'tag']) {
            this.inlineMacro(function() {
                this.named(macro);
                // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L187C10-L187C24
                this.match(new RegExp(macro + ':(\\w+)'))
                this.process((parent: any, target: any) => {
                    return this.createInline(parent, 'quoted', target, { type: 'strong' })
                })
            })
        }
        this.includeProcessor(function () {
            this.handles((target: string) => {
              return target.startsWith('{chapters}') || target.startsWith('{generated}/validity/') || target.startsWith('{config}')
            })
            this.process((doc: any, reader: any, target: string, attrs: any) => {
                const path = target.replace('{chapters}', './Vulkan-Docs/chapters')
                .replace('{generated}', './Vulkan-Docs/gen')
                .replace('{config}', './Vulkan-Docs/config');
                if (!existsSync(path)) {
                    console.log("referenced file not found: ", path)
                    should_skip = true;
                    return;
                }
                let file = readFileSync(path, 'utf-8');
                if (attrs.tag) {
                    file = findTaggedImport(file, attrs.tag);
                }
                return reader.pushInclude(file, target, target, 1, attrs)
            })
        })
    })
    const vkspecDocbook = processor.convert(await readFile('./Vulkan-Docs/vkspec.adoc'), {
        backend: 'docbook',
        attributes
    });
    //await writeFile('./dist/vkspec.xml', vkspecDocbook);
    const vkspecDocbookXast = fromXml(`<root>${vkspecDocbook}</root>`);
    const vkspecMdast = docbookRefpage(vkspecDocbookXast) ;
    const xrefs = new Map<string, { url: string, title?: string }>();
    {
        // Chunking
        let currentChunk = []
        let currentChunkIndex = 0;
        let currentName = null;
        const chaptersMeta = [];
        for (const node of vkspecMdast) {
            if (node.type === 'heading' && node.depth === 1) {
                if (currentName) {
                    visitParents(<mdast.Root> { type: 'root', children: currentChunk},'text', (node) => {
                        const match = /:anchor\{id="(.+)"\}/.exec(node.value);
                        if (match) {
                            const name = match[1];
                            xrefs.set(name, { url: '/chapters/' + currentChunkIndex })
                        }
                    })
                    
                    visitParents(<mdast.Root> { type: 'root', children: currentChunk},'heading', (node) => {
                        if (node.children.length > 0 && node.children[0].type === 'text' && node.children[0].value.startsWith('#')) {
                            const id = node.children[0].value.slice(1).trimEnd();
                            xrefs.set(id, { url: '/chapters/' + currentChunkIndex, title: mdHeadingToString(node.children.slice(1)) })
                        }
                    })
                    const md = toMarkdown({
                        type: 'root',
                        children: currentChunk
                    }, { extensions: [gfmToMarkdown()] })
                    await writeFile(`./dist/chapters/${currentChunkIndex}.md`, md);
                    chaptersMeta.push({
                        index: currentChunkIndex,
                        title: currentName,
                    })
                    currentChunkIndex += 1;
                }
                currentChunk = [];
                assert(node.children[0].type === 'text');
                if (node.children[0].value.startsWith('#')) {
                    assert(node.children[1].type === 'text');
                    currentName = node.children[1].value;
                } else {
                    currentName = node.children[0].value;
                }
            }
            currentChunk.push(node);
        }

        // Get xrefs
        visitParents(<mdast.Root> { type: 'root', children: currentChunk},'text', (node) => {
            assert(node.type === 'text');
            const match = /:anchor\{id="(.+)"\}/.exec(node.value);
            if (match) {
                const name = match[1];
                xrefs.set(name, { url: '/chapters/' + currentChunkIndex })
            }
        })
        
        visitParents(<mdast.Root> { type: 'root', children: currentChunk},'heading', (node) => {
            if (node.children.length > 0 && node.children[0].type === 'text' && node.children[0].value.startsWith('#')) {
                const id = node.children[0].value.slice(1).trimEnd();
                xrefs.set(id, { url: '/chapters/' + currentChunkIndex, title: mdHeadingToString(node.children.slice(1)) })
            }
        })

        const md = toMarkdown(<mdast.Root> {
            type: 'root',
            children: currentChunk
        }, { extensions: [gfmToMarkdown()] })
        await writeFile(`./dist/chapters/${currentChunkIndex}.md`, md);
        chaptersMeta.push({
            index: currentChunkIndex,
            title: currentName,
        })
        await writeFile(`./dist/chapters/index.json`, JSON.stringify(chaptersMeta));
    }

    for await (const refpage of discoverRefpages()) {
        console.log('parsing', refpage.name)
        should_skip = false;
        const content = 'include::{config}/attribs.adoc[]\n' + refpage.content;
        const page = processor.convert(content, {
            backend: 'docbook',
            attributes
        });
        //await writeFile(`./dist/man/${refpage.name}.xml`, page);
        if (should_skip) {
            console.log('skipping', refpage.name)
            continue;
        }
        
        let contentXast;
        try {
        contentXast = fromXml(`<root>${page}</root>`);
        } catch {
            console.error('parsing', refpage.name, 'errored')
            continue;
        }
        const frontmatter: mdast.RootContent = {
            type: 'yaml',
            value: yamlStringify({
                description: refpage.desc,
                title: refpage.name,
                type: refpage.type,
                xrefs: refpage.xrefs,
            })
        }
        const mdast: mdast.Root = {
            type: 'root',
            children: [
                frontmatter,
                <mdast.Text>{
                    type: 'text',
                    value: '\n\n',
                },
                ...docbookRefpage(contentXast) 
            ]
        }
        
        // Get xrefs
        visitParents(mdast,'text', (node) => {
            assert(node.type === 'text');
            const match = /:anchor\{id="(.+)"\}/.exec(node.value);
            if (match) {
                const name = match[1];
                xrefs.set(name, { url: '/man/' + refpage.name })
            }
        })
        visitParents(mdast,'heading', (node) => {
            if (node.children.length > 0 && node.children[0].type === 'text' && node.children[0].value.startsWith('#')) {
                const id = node.children[0].value.slice(1).trimEnd();
                xrefs.set(id, { url: '/man/' + refpage.name, title: mdHeadingToString(node.children.slice(1)) })
            }
        })
        const md = toMarkdown(mdast, { extensions: [frontmatterToMarkdown(), gfmToMarkdown()] })
        await writeFile(`./dist/man/${refpage.name}.md`, md);
    }
    await writeFile(`./dist/xrefs.json`, JSON.stringify(Object.fromEntries(xrefs)));
}
main()


function findTaggedImport(haystack: string, tag: string): string {
    const lines = haystack.split('\n');

    const includedLines: string[] = [];
    let inside: boolean = false;
    for (const line of lines) {
        if (line.startsWith(`// tag::${tag}[]`)) {
            inside = true;
            continue;
        }
        if (line.endsWith(`// end::${tag}[]`)) {
            break;
        }
        if (inside) {
            includedLines.push(line);
        }
    }
    return includedLines.join('\n');
}


function mdHeadingToString(children: mdast.PhrasingContent[]): string {
    let str = '';
    for (const i of children) {
        if (i.type === 'text' || i.type === 'inlineCode') {
            str += i.value;
        } else if (i.type !== 'break' &&
        i.type !== 'footnoteReference'&&
        i.type !== 'html' &&
        i.type !== 'image' &&
        i.type !== 'imageReference'
        ) {
            str += mdHeadingToString(i.children)
        }
    }
    return str;
}