import { readFile, readdir, writeFile } from "fs/promises";
import markdownTransformer from '@nuxt/content/transformers/markdown';
import {gfmFromMarkdown, gfmToMarkdown} from 'mdast-util-gfm';
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { parse } from "yaml";
import assert from "assert";
import { parseMarkdown } from '@nuxtjs/mdc/runtime';
import type { MDCParseOptions } from '@nuxtjs/mdc/runtime/types/parser';
import type { Theme } from '@nuxtjs/mdc/runtime/shiki/types';
import rehypeShiki from '@nuxtjs/mdc/runtime/shiki/index';
import { useShikiHighlighter } from '@nuxtjs/mdc/runtime/shiki/highlighter'

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
  
async function main() {
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
        const file = await readFile(path, 'utf-8');

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

        const shikiTheme = {
            theme: {
                light: 'material-theme-lighter',
                default: 'material-theme',
                dark: 'material-theme-palenight'
              },
              preload: [ 'rust', 'c' ],
        }
        const parsed = await parseMarkdown(file as string, <MDCParseOptions> {
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
    }
    await writeFile('./dist/man/index.json', JSON.stringify(metadata));
}

main();
