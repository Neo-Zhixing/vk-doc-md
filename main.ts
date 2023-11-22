import { fromXml } from "xast-util-from-xml";
import {fromHtml} from 'hast-util-from-html';
import {toMdast} from 'hast-util-to-mdast';
import {toMarkdown} from 'mdast-util-to-markdown';
import {gfmToMarkdown} from 'mdast-util-gfm';
import * as xast from 'xast';
import { readFile, readdir, lstat} from 'fs/promises';
import assert from 'node:assert/strict';
import * as mdast from 'mdast';
import { Node as XastNode, Root as XastRoot } from 'xast';
import { stringify as yamlStringify } from 'yaml'
import {frontmatterToMarkdown} from 'mdast-util-frontmatter';

import discoverRefpages from './discoverRefpages.js';

// @ts-ignore
import Asciidoctor from '@asciidoctor/core'
// @ts-ignore
import docbookConverter from '@asciidoctor/docbook-converter'
import { readFileSync } from "fs";
import { writeFile } from 'fs/promises';

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

function docbookRefblockValidityConvert(node: xast.ElementContent): mdast.RootContent[] {
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
                value: `\n::field{name="${name}"}\n`
            },
            <mdast.Link> {
                type: 'link',
                children: [
                    <mdast.Text> {
                        type: 'text',
                        value: name,
                    }
                ],
                url: '#' + name
            },
            ...rest.flatMap(a => docbookConvertNode(a)),
            <mdast.Text> {
                type: 'text',
                value: '\n::\n'
            },
        ]
    }
    console.log('unknown node in docbookRefblockValidityConvert', node);
    return []
}

function docbookConvertNode(node: xast.ElementContent): mdast.RootContent[] {
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
        if (node.name === 'simpara') {
            return [<mdast.Paragraph>{
                type: 'paragraph',
                children: node.children.flatMap(i => docbookConvertNode(i))
            }]
        }
        if (node.name === 'title') {
            return [<mdast.Heading>{
                type: 'heading',
                children: node.children.flatMap(i => docbookConvertNode(i))
            }]
        }
        if (node.name === 'superscript') {
            return [
                <mdast.Text>{
                    type: 'text',
                    value: `<sup>`
                },
                ...node.children.flatMap(i => docbookConvertNode(i)),
                <mdast.Text>{
                    type: 'text',
                    value: `</sup>`
                },
            ]
        }
        if (node.name === 'subscript') {
            return [
                <mdast.Text>{
                    type: 'text',
                    value: `<sub>`
                },
                ...node.children.flatMap(i => docbookConvertNode(i)),
                <mdast.Text>{
                    type: 'text',
                    value: `</sub>`
                },
            ]
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
        if (node.name === 'emphasis') {
            return [<mdast.Emphasis>{
                type: 'emphasis',
                children: node.children.flatMap(i => docbookConvertNode(i))
            }]
        }
        
        if (node.name === 'quote') {
            return [<mdast.Blockquote>{
                type: 'blockquote',
                children: node.children.flatMap(i => docbookConvertNode(i))
            }]
        }
        if (node.name === 'phrase') {
            return node.children.flatMap(i => docbookConvertNode(i))
        }
        if (node.name === 'literal') {
            if (node.children.length === 1 && node.children[0].type === 'text') {
                return [<mdast.InlineCode> {
                    type: 'inlineCode',
                    value: node.children[0].value
                }]
            }
        }
        if (node.name === 'anchor') {
            return [<mdast.Link> {
                type: 'link',
                children: [
                    <mdast.Text> {
                        type: 'text',
                        value: node.attributes['xml:id'],
                    }
                ],
                url: '#' + node.attributes['xml:id']
            }]
        }
        if (node.name === 'link') {
            if (node.attributes.linkend) {
                // TODO
                return node.children.flatMap(i => docbookConvertNode(i));
            }

            const href = node.attributes['xl:href']
            return [<mdast.Link> {
                type: 'link',
                children: node.children.flatMap(i => docbookConvertNode(i)),
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
                        children: i.children.flatMap(j => docbookConvertNode(j))
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
                ...node.children.flatMap(j => docbookConvertNode(j)),
                <mdast.Text> {
                    type: 'text',
                    value: '\n::\n'
                },
            ]
        }
        if (node.name === 'sidebar') {
            docbookRemovePaddingNewlines(node.children);
            const title = node.children.find(a => a.type === 'element' && a.name === 'title');
            const titleText = ((title as xast.Element).children[0] as xast.Text).value;
            if (titleText === 'Valid Usage') {
                const list = node.children.find(a => a.type === 'element' && a.name === 'itemizedlist');
                if (!list || list.type !== 'element') {
                    return [];
                }
                return [
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::fieldgroup\n'
                    },
                    ...list.children.flatMap(j => docbookRefblockValidityConvert(j)),
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::\n'
                    },
                ]
            } else {
                return [
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::callout\n'
                    },
                    ...node.children.flatMap(j => docbookConvertNode(j)),
                    <mdast.Text> {
                        type: 'text',
                        value: '\n::\n'
                    },
                ]
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
    return rootElement.children.flatMap(children => docbookConvertNode(children));
}

async function main() {
    // @ts-ignore
    const processor = Asciidoctor();
    docbookConverter.register();
    processor.Extensions.register(function() {
        for (const normativeKeyword of ['can', 'cannot', 'may', 'must', 'optional', 'required', 'should']) {
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
            this.named('fname');
            // https://github.com/KhronosGroup/Vulkan-Docs/blob/b4792eab92a1d132ef95b56a7681cc6af69b570e/config/spec-macros/extension.rb#L187C10-L187C24
            this.match(/fname:(\w+)/);
            this.process((parent: any, target: any) => {
                return this.createInline(parent, 'quoted', `:nameref{name="${target}" type="func"}`)
            })
        })
        this.inlineMacro(function() {
            this.named('ename');
            this.match(/ename:(\w+)/);
            this.process((parent: any, target: any) => {
                return this.createInline(parent, 'quoted', `:nameref{name="${target}" type="enum"}`)
            })
        })
        this.includeProcessor(function () {
            this.handles((target: string) => {
              return target.startsWith('{chapters}')
            })
            this.process((doc: any, reader: any, target: string, attrs: any) => {
                const path = target.replace('{chapters}', './Vulkan-Docs/chapters');
                const file = readFileSync(path, 'utf-8');
              return reader.pushInclude([file], target, target, 1, attrs)
            })
        })
    })

    for await (const refpage of discoverRefpages()) {
        const page = processor.convert(refpage.content, {
            backend: 'docbook'
        });
        
        console.log('parsing', refpage.name)
        let contentXast;
        try {
        contentXast = fromXml(`<root>${page}</root>`);
        } catch {
            console.log('parsing', refpage.name, 'errored')
            continue;
        }
        const frontmatter: mdast.RootContent = {
            type: 'yaml',
            value: yamlStringify({
                desc: refpage.desc,
                name: refpage.name,
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
        const md = toMarkdown(mdast, { extensions: [frontmatterToMarkdown(), gfmToMarkdown()] })
        await writeFile(`./dist/${refpage.name}.md`, md);
    }
}
main()
