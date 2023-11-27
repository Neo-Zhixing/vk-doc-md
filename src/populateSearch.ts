import { readdir, readFile } from 'fs/promises';
import { toMarkdown } from 'mdast-util-to-markdown';
import { fromMarkdown } from 'mdast-util-from-markdown';
import {frontmatter} from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import {gfm} from 'micromark-extension-gfm'
import {visitParents} from 'unist-util-visit-parents'
import { MeiliSearch } from 'meilisearch'
import { Yaml } from 'mdast';
import { parse } from 'yaml';


async function main() {
    const rootPath = './dist/';
    const files = await readdir(rootPath);

    const meiliClient = new MeiliSearch({
        host: 'https://search.vkdoc.net',
        apiKey: '4KsPxa8DiQCjAeCyG3MQGABbvUyAqU23',
      });
    const meiliIndex = meiliClient.index('refpages_new')

    for (const fileName of files) {
        if (!fileName.endsWith('md')) {
            continue;
        }
        const mdString = await readFile(rootPath + fileName, 'utf-8');
        const parsed = fromMarkdown(mdString, {
            extensions: [frontmatter(['yaml', 'toml']), gfm()],
            mdastExtensions: [frontmatterFromMarkdown(['yaml', 'toml']), gfmFromMarkdown()]
        });
        let yamlNode: Yaml = null;
        if (parsed.children[0]?.type === 'yaml') {
            yamlNode = parsed.children[0];
            parsed.children.shift();
        }

        visitParents(parsed, 'text', function (node, ancestors) {
            if (node.value.trimStart().startsWith('::')) {
                node.value = ''
            } else if (node.value.trimEnd().endsWith('::')) {
                node.value = node.value.trimEnd().slice(0, -2);
            }
        })

        
        const yaml = parse(yamlNode.value);
        const documents = parsed.children.map((paragraph, i) => {
            const mdString = toMarkdown(paragraph, {
                extensions: [frontmatterToMarkdown(), gfmToMarkdown()]
            });
            const doc: any = {
                content: mdString,
                description: yaml.description,
                title: yaml.title,
                id: yaml.title + '-' + i,
                parent: yaml.parent?.split(',').map(a => a.trim()),
                type: yaml.type, 
            };
            for ( const key of ['cmd_buf_level', 'render_pass_scope', 'supported_queue_types', 'tasks', 'video_coding_scope']) {
                if (yaml[key]) {
                    doc.command = doc.command || {};
                    doc.command[key] = yaml[key];
                }
            }
            return doc;
        })

        const response = await meiliIndex.addDocuments(documents)
        console.log(`${response.type} ${response.taskUid} ${response.status} at ${response.enqueuedAt} for ${response.indexUid}`);
    }

    const swapIndexResponse = await meiliClient.swapIndexes([{
        indexes: ['refpages_new', 'refpages']
    }]);
    console.log(swapIndexResponse);

    const deleteIndexResponse = await meiliClient.deleteIndexIfExists('refpages_new');
    console.log(deleteIndexResponse)
}
main()