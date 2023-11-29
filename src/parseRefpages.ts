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
import type { Theme } from '@nuxtjs/mdc/runtime/shiki/types';
import rehypeShiki from '@nuxtjs/mdc/runtime/shiki/index';
import { useShikiHighlighter } from '@nuxtjs/mdc/runtime/shiki/highlighter'
import {visitParents} from 'unist-util-visit-parents'
import { Root } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
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


async function parseMd(file: string): Promise<any> {
    const shikiTheme = {
        theme: {
            light: 'material-theme-lighter',
            default: 'material-theme',
            dark: 'material-theme-palenight'
          },
          preload: [ 'rust', 'c' ],
    }
    const parsed = await parseMarkdown(file, <MDCParseOptions> {
        highlight: {
            ...shikiTheme,
            highlighter: async (code: string, lang: string, theme: Theme, highlights) => {
                const shikiHighlighter = useShikiHighlighter(shikiTheme)
                return await shikiHighlighter.getHighlightedAST(code as string, lang as any, theme as Theme, { highlights })
              }
          },
          remark: { plugins: {} },
          rehype: { options: { handlers: {} }, plugins: {
            highlight: {
                instance: rehypeShiki,
            }
          } },
          toc: undefined
      })
      return parsed;
}

function convertXrefs(file: Root, xrefs: Map<string, string>, chapters: { title: string}[]) {
  visitParents(file, 'link', link => {
    if (link.url.startsWith('xref::')) {
      const name = link.url.slice(6);
      link.url = (xrefs.get(name) || '/404') + '#' + name;
    }
    if (link.children.length === 1 && link.children[0].type === 'text') {
      const name = link.children[0].value.slice(12);
      const xrefUrl = xrefs.get(name) || '/404';
      if (xrefUrl.startsWith('/man/')) {
        link.children[0].value = xrefUrl.slice(5) + '#' + name;
      } else if (xrefUrl.startsWith('/chapters/')) {
        const chapterId = xrefUrl.slice(10);
        const chapter = chapters[chapterId];
        link.children[0].value = chapter.title + '#' + name;
      }
    }
  })
}
  
async function convertRefpages(xrefs: Map<string, string>, chapters: { title: string }[]) {
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
        console.log(id)
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

        convertXrefs(tree, xrefs, chapters);
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

async function chapters(xrefs: Map<string, string>, chapters: { title: string }[]) {
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
        convertXrefs(tree, xrefs, chapters);
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
  xrefs = new Map(Object.entries(xrefs))
  await chapters(xrefs, c);
  await convertRefpages(xrefs, c);
}

main();
