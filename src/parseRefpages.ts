import { readFile, readdir, writeFile } from "fs/promises";
import {gfmFromMarkdown, gfmToMarkdown} from 'mdast-util-gfm';
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown, frontmatterToMarkdown } from "mdast-util-frontmatter";
import { parse } from "yaml";
import assert from "assert";
import { parseMarkdown } from '@nuxtjs/mdc/runtime';
import type { MDCParseOptions } from '@nuxtjs/mdc/runtime/types/parser';
import type { MdcThemeOptions  } from '@nuxtjs/mdc/runtime/highlighter/types';
import rehypeHighlight from '@nuxtjs/mdc/runtime/highlighter/rehype';
import { createShikiHighlighter } from '@nuxtjs/mdc/runtime/highlighter/shiki'
import {visitParents} from 'unist-util-visit-parents'
import { Root } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
export const PROSE_TAGS = [
    'p',
    'a',
    'blockquote',
    'code-inline',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'ul',
    'ol',
    'li',
    'strong',
    'table',
    'thead',
    'tbody',
    'td',
    'th',
    'tr'
  ]


import MaterialThemePalenight from 'shiki/themes/material-theme-palenight.mjs';
import MaterialThemeLighter from 'shiki/themes/material-theme-lighter.mjs';
import MaterialTheme from 'shiki/themes/material-theme.mjs';

import CLang from 'shiki/langs/c.mjs'
import RustLang from 'shiki/langs/rust.mjs'
async function parseMd(file: string): Promise<any> {
    const parsed = await parseMarkdown(file, <MDCParseOptions> {
        highlight: {
            theme: {
              light: 'material-theme-lighter',
              default: 'material-theme',
              dark: 'material-theme-palenight'
            },
            highlighter: createShikiHighlighter({
              bundledThemes: {
                'material-theme-palenight': MaterialThemePalenight,
                'material-theme-lighter': MaterialThemeLighter,
                'material-theme': MaterialTheme,
              },
              bundledLangs: {
                rust: RustLang,
                c: CLang,
              },
            })
          },
          remark: { plugins: {
            'remark-math': {
              instance: remarkMath
            }
          } },
          rehype: { options: { handlers: {} }, plugins: {
            highlight: {
                instance: rehypeHighlight,
                options: {
                  
                }
            },
            'rehype-title-id': {
              instance: myRehypePlugin
            },
            'rehype-katex': {
              instance: rehypeKatex
            }
          } },
          toc: undefined
      })
      return parsed;
}

function convertXrefs(file: Root, xrefs: Map<string, { url: string, title: string }>) {
  visitParents(file, 'link', link => {
    if (link.url.startsWith('xref::')) {
      const name = link.url.slice(6);
      if (!xrefs.has(name)) {
        console.log('warning, ', name)
      }
      const xrefUrl = xrefs.get(name)
      link.url = (xrefUrl?.url || '/404') + '#' + name;

      
      if (xrefUrl && link.children.length === 1 && link.children[0].type === 'text' && link.children[0].value.startsWith('xref::name')) {
        link.children[0].value = xrefUrl.title;
      }
    }
  })
}

async function convertRefpages(xrefs: Map<string, { url: string, title: string }>) {
    const metadata: {
        id: string,
        parent: string[],
        type: string,
    }[] = [];
    for (const filename of await readdir('./dist/man/')) {
        if (!filename.endsWith('.md')) {
            continue;
        }
        const path = './dist/man/' + filename;
        const id = filename.slice(0, -3);
        //console.log(id)
        let file = await readFile(path, 'utf-8');

        const tree = fromMarkdown(file, {
            extensions: [gfm(), frontmatter(['yaml', 'toml'])],
            mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])]
          })
        const yamlNode = tree.children[0];
        assert(yamlNode.type === 'yaml');
        const yaml = parse(yamlNode.value);
        assert(yaml.title === id);
        metadata.push({
            id,
            parent: yaml.parent,
            type: yaml.type,
        })

        convertXrefs(tree, xrefs);
        file = toMarkdown(tree, {
          extensions: [gfmToMarkdown(), frontmatterToMarkdown(['yaml', 'toml'])]
        })

        const parsed = await parseMd(file);
          const results = {
            ...parsed.data,
            excerpt: parsed.excerpt,
            body: {
              ...parsed.body,
              toc: parsed.toc
            },
            _type: 'markdown',
            _id: id
          }
        await writeFile(`./dist/man/${id}.json`, JSON.stringify(results));
        await writeFile(`./dist/man/${id}.md`, file);
    }
    await writeFile('./dist/man/index.json', JSON.stringify(metadata));
}

async function convertExtensions(xrefs: Map<string, { url: string, title: string }>) {
  const metadata: {
      id: string,
      parent: string[],
      type: string,
  }[] = [];
  for (const filename of await readdir('./dist/extensions/')) {
      if (!filename.endsWith('.md')) {
          continue;
      }
      const path = './dist/extensions/' + filename;
      const id = filename.slice(0, -3);
      let file = await readFile(path, 'utf-8');
      const tree = fromMarkdown(file, {
          extensions: [gfm(), frontmatter(['yaml', 'toml'])],
          mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])]
        })
      let title = id;
      if (!id.includes('proposal')) {
        title = id.replace('.proposal', '')
        const yamlNode = tree.children[0];
        assert(yamlNode.type === 'yaml');
        const yaml = parse(yamlNode.value);
        assert(yaml.extension === id);
        metadata.push(yaml)
      }

      convertXrefs(tree, xrefs);
      file = toMarkdown(tree, {
        extensions: [gfmToMarkdown(), frontmatterToMarkdown(['yaml', 'toml'])]
      })

      const parsed = await parseMd(file);
        const results = {
          ...parsed.data,
          excerpt: parsed.excerpt,
          body: {
            ...parsed.body,
            toc: parsed.toc
          },
          _type: 'markdown',
          title,
          _id: id
        }
      await writeFile(`./dist/extensions/${id}.json`, JSON.stringify(results));
      await writeFile(`./dist/extensions/${id}.md`, file);
  }
  await writeFile('./dist/extensions/index.json', JSON.stringify(metadata));
}

async function chapters(xrefs: Map<string, { url: string, title: string }>, chapters: { title: string }[]) {
    for (const filename of await readdir('./dist/chapters/')) {
        if (!filename.endsWith('.md')) {
            continue;
        }
        const path = './dist/chapters/' + filename;
        const id = filename.slice(0, -3);
        let file = await readFile(path, 'utf-8');

        const tree = fromMarkdown(file, {
          extensions: [gfm(), frontmatter(['yaml', 'toml'])],
          mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])]
        })
        convertXrefs(tree, xrefs);
        file = toMarkdown(tree, {
          extensions: [gfmToMarkdown(), frontmatterToMarkdown(['yaml', 'toml'])]
        })
        const parsed = await parseMd(file);
          const results = {
            ...parsed.data,
            excerpt: parsed.excerpt,
            body: {
              ...parsed.body,
              toc: parsed.toc
            },
            _type: 'markdown',
            _id: 'chapters-' + id
          }
        await writeFile(`./dist/chapters/${id}.json`, JSON.stringify(results));
        await writeFile(`./dist/chapters/${id}.md`, file);
    }
}

async function main() {
  const c = JSON.parse(await readFile('./dist/chapters/index.json', 'utf-8'))
  let xrefs = JSON.parse(await readFile('./dist/xrefs.json', 'utf-8'))
  let xrefsMap: Map<string, { url: string, title: string }> = new Map(Object.entries(xrefs))

  const allManPages = (await readdir('./dist/man')).filter(a => a.endsWith('.md')).map(a => a.slice(0, -3));
  for (const item of allManPages) {
    if (!xrefsMap.has(item)) {
      xrefsMap.set(item, { url: '/man/' + item, title: item })
    }
  }
  await convertExtensions(xrefsMap);
  await chapters(xrefsMap, c);
  await convertRefpages(xrefsMap);
}

export default function myRehypePlugin (tree, options) {
  return processRehype
}


function processRehype(node) {
  if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
    const firstChildren = node.children[0];
    if (firstChildren && firstChildren.type === 'text' && firstChildren.value.startsWith('#')) {
      const components = firstChildren.value.split(' ');
      const id = components[0].slice(1);
      firstChildren.value = firstChildren.value.slice(id.length + 2);
      node.properties = node.properties || {};
      node.properties.id = id;
    }
    return
  }

  if (node.children) {
    for (const i of node.children) {
      processRehype(i)
    }
  }
}


main();
