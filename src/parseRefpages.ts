import { readFile, readdir, writeFile } from "fs/promises";
import markdownTransformer from '@nuxt/content/transformers/markdown';
import {gfmFromMarkdown, gfmToMarkdown} from 'mdast-util-gfm';
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { parse } from "yaml";
import assert from "assert";

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

          
        const results = await markdownTransformer.parse!(id, file, {});
        await writeFile(`./dist/man/${id}.json`, JSON.stringify(results));
    }
    await writeFile('./dist/man/index.json', JSON.stringify(metadata));
}

main();
